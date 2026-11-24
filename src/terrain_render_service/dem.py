"""Elevation sources: Copernicus DEM cloud-optimised GeoTIFFs and Terrarium overview tiles, read on demand over HTTP."""

from __future__ import annotations

import io
import math
import urllib.request
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Protocol

import numpy as np
import numpy.typing as npt
import rasterio
from affine import Affine
from PIL import Image
from rasterio.errors import RasterioIOError
from rasterio.warp import Resampling, reproject

from .tiling import GeoBounds

Grid = npt.NDArray[np.float32]

GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_MAX_RETRY": "3",
    "VSI_CACHE": "TRUE",
}


class ElevationSource(Protocol):
    """Something that can sample heights (metres) over an area or at points."""

    name: str

    def grid(self, bounds: GeoBounds, size: int) -> Grid:
        """Return `size` x `size` samples, edges inclusive, row 0 at the north edge."""
        ...

    def points(self, lonlats: list[tuple[float, float]]) -> list[float]:
        """Return the height at each `(lon, lat)`."""
        ...


class FlatSource:
    """Sea-level everywhere."""

    name = "ellipsoid"

    def grid(self, bounds: GeoBounds, size: int) -> Grid:  # noqa: ARG002
        """Return a grid of zeros."""
        return np.zeros((size, size), dtype=np.float32)

    def points(self, lonlats: list[tuple[float, float]]) -> list[float]:
        """Return zero for every point."""
        return [0.0] * len(lonlats)


@dataclass(frozen=True, slots=True)
class Cell:
    """One 1 x 1 degree Copernicus DEM file, named by its south-west corner."""

    lat: int
    lon: int

    @classmethod
    def containing(cls, lon: float, lat: float) -> Cell:
        """Return the cell a point falls in (the north/east edges belong to the next cell)."""
        return cls(min(math.floor(lat), 89), min(math.floor(lon), 179))

    def key(self, arcsec: int) -> str:
        """Return the dataset key, e.g. `Copernicus_DSM_COG_10_N48_00_E011_00_DEM`."""
        ns = f"{'N' if self.lat >= 0 else 'S'}{abs(self.lat):02d}"
        ew = f"{'E' if self.lon >= 0 else 'W'}{abs(self.lon):03d}"
        return f"Copernicus_DSM_COG_{arcsec}_{ns}_00_{ew}_00_DEM"


def cells_covering(bounds: GeoBounds) -> list[Cell]:
    """All 1-degree cells intersecting `bounds`."""
    lats = range(math.floor(bounds.south), min(math.ceil(bounds.north), 90))
    lons = range(math.floor(bounds.west), min(math.ceil(bounds.east), 180))
    return [Cell(lat, lon) for lat in lats for lon in lons]


class CopernicusSource:
    """Copernicus GLO-30 / GLO-90 on AWS Open Data; ocean cells have no file and read as 0 m."""

    def __init__(
        self, base_url: str, arcsec: int, name: str, max_cells: int = 64, fallback: CopernicusSource | None = None
    ) -> None:
        """Read `<base_url>/<key>/<key>.tif`, refusing requests spanning more than `max_cells`.

        Cells missing here are read from `fallback` (GLO-30 omits some land that GLO-90 has).
        """
        self.fallback = fallback
        self.base_url = base_url.rstrip("/")
        self.arcsec = arcsec
        self.name = name
        self.max_cells = max_cells

    def url(self, cell: Cell) -> str:
        """GDAL path of a cell's GeoTIFF."""
        key = cell.key(self.arcsec)
        return f"/vsicurl/{self.base_url}/{key}/{key}.tif"

    def grid(self, bounds: GeoBounds, size: int) -> Grid:
        """Mosaic every intersecting cell into one grid (GDAL picks overviews when downsampling)."""
        cells = cells_covering(bounds)
        if len(cells) > self.max_cells:
            msg = f"{len(cells)} DEM cells requested, limit is {self.max_cells}"
            raise ValueError(msg)
        step_x = bounds.width / (size - 1)
        step_y = bounds.height / (size - 1)
        transform = Affine(step_x, 0, bounds.west - step_x / 2, 0, -step_y, bounds.north + step_y / 2)
        out = np.full((size, size), np.nan, dtype=np.float32)
        with rasterio.Env(**GDAL_ENV):
            for cell in cells:
                self._warp_into(cell, out, transform)
        return np.nan_to_num(out, nan=0.0)

    def _warp_into(self, cell: Cell, out: Grid, transform: Affine) -> None:
        try:
            src = rasterio.open(self.url(cell))
        except RasterioIOError:
            if self.fallback:
                self.fallback._warp_into(cell, out, transform)  # noqa: SLF001
            return
        with src:
            reproject(
                source=rasterio.band(src, 1),
                destination=out,
                dst_transform=transform,
                dst_crs="EPSG:4326",
                dst_nodata=np.nan,
                init_dest_nodata=False,
                resampling=Resampling.bilinear,
            )

    def points(self, lonlats: list[tuple[float, float]]) -> list[float]:
        """Sample each point, opening every cell once."""
        heights = [0.0] * len(lonlats)
        by_cell: dict[Cell, list[int]] = {}
        for i, (lon, lat) in enumerate(lonlats):
            by_cell.setdefault(Cell.containing(lon, lat), []).append(i)
        with rasterio.Env(**GDAL_ENV):
            for cell, indices in by_cell.items():
                for i, value in zip(indices, self._sample(cell, [lonlats[i] for i in indices]), strict=True):
                    heights[i] = value
        return heights

    def _sample(self, cell: Cell, lonlats: list[tuple[float, float]]) -> list[float]:
        try:
            src = rasterio.open(self.url(cell))
        except RasterioIOError:
            return self.fallback._sample(cell, lonlats) if self.fallback else [0.0] * len(lonlats)  # noqa: SLF001
        with src:
            return [float(v[0]) for v in src.sample(lonlats)]


MERCATOR_MAX_LAT = 85.05112878
TERRARIUM_TILE = 256


class TerrariumSource:
    """Global Terrarium PNG tiles (AWS Terrain Tiles, Web Mercator): cheap whole-world heights for coarse zooms.

    Copernicus has no global overview, so a continent-sized tile would need thousands of COG reads.
    """

    name = "terrarium"

    def __init__(self, base_url: str, max_tiles: int = 16, cache_size: int = 256) -> None:
        """Read `<base_url>/{z}/{x}/{y}.png`, using at most `max_tiles` PNGs per grid."""
        self.base_url = base_url.rstrip("/")
        self.max_tiles = max_tiles
        self.cache_size = cache_size
        self._tiles: OrderedDict[tuple[int, int, int], Grid] = OrderedDict()

    def fetch(self, z: int, x: int, y: int) -> Grid:
        """Decode one Terrarium tile into metres: `R * 256 + G + B / 256 - 32768`."""
        url = f"{self.base_url}/{z}/{x}/{y}.png"
        if not url.startswith("https://"):
            msg = f"refusing non-https Terrarium URL {url}"
            raise ValueError(msg)
        with urllib.request.urlopen(url, timeout=30) as r:  # noqa: S310 - https only, checked above
            rgb = np.asarray(Image.open(io.BytesIO(r.read())).convert("RGB"), dtype=np.float32)
        heights: Grid = (rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768).astype(np.float32)
        return heights

    def prefetch(self, keys: list[tuple[int, int, int]]) -> None:
        """Download the uncached tiles among `keys` in parallel."""
        missing = [k for k in keys if k not in self._tiles]
        if len(missing) > 1:
            with ThreadPoolExecutor(max_workers=min(len(missing), 8)) as pool:
                for key, tile in zip(missing, pool.map(lambda k: self.fetch(*k), missing), strict=True):
                    self._store(key, tile)

    def _store(self, key: tuple[int, int, int], tile: Grid) -> None:
        self._tiles[key] = tile
        if len(self._tiles) > self.cache_size:
            self._tiles.popitem(last=False)

    def tile(self, z: int, x: int, y: int) -> Grid:
        """One decoded 256 x 256 tile, cached in memory."""
        return self._tile((z, x, y))

    def _tile(self, key: tuple[int, int, int]) -> Grid:
        tile = self._tiles.get(key)
        if tile is None:
            tile = self.fetch(*key)
            self._store(key, tile)
        self._tiles.move_to_end(key)
        return tile

    def zoom_for(self, bounds: GeoBounds, size: int) -> int:
        """Deepest Mercator zoom whose tiles covering `bounds` stay within `max_tiles`, capped at the grid's detail."""
        detail = math.ceil(math.log2(max(size * 360 / bounds.width / TERRARIUM_TILE, 1)))
        for z in range(min(detail, 15), -1, -1):
            px, py = mercator_pixels(np.array([bounds.west, bounds.east]), np.array([bounds.north, bounds.south]), z)
            tx = np.clip(px // TERRARIUM_TILE, 0, (1 << z) - 1)
            ty = np.clip(py // TERRARIUM_TILE, 0, (1 << z) - 1)
            nx, ny = int(tx[1] - tx[0]) + 1, int(ty[1] - ty[0]) + 1
            if nx * ny <= self.max_tiles:
                return z
        return 0

    def sample(self, lons: npt.NDArray[np.float64], lats: npt.NDArray[np.float64], z: int) -> Grid:
        """Nearest-pixel heights at the given points; latitudes beyond Mercator's limit use the edge row."""
        px, py = mercator_pixels(lons, lats, z)
        limit = TERRARIUM_TILE * (1 << z) - 1
        px = np.mod(np.floor(px), limit + 1).astype(np.int64)
        py = np.clip(py.astype(np.int64), 0, limit)
        out = np.empty(px.shape, dtype=np.float32)
        tx, ty = px // TERRARIUM_TILE, py // TERRARIUM_TILE
        keys = {(int(a), int(b)) for a, b in zip(tx.ravel(), ty.ravel(), strict=True)}
        self.prefetch([(z, *key) for key in keys])
        for key in keys:
            mask = (tx == key[0]) & (ty == key[1])
            tile = self._tile((z, *key))
            out[mask] = tile[py[mask] % TERRARIUM_TILE, px[mask] % TERRARIUM_TILE]
        return out

    def grid(self, bounds: GeoBounds, size: int) -> Grid:
        """Return `size` x `size` samples, edges inclusive, row 0 at the north edge."""
        lons, lats = np.meshgrid(
            np.linspace(bounds.west, bounds.east, size), np.linspace(bounds.north, bounds.south, size)
        )
        return self.sample(lons, lats, self.zoom_for(bounds, size))

    def grid_at(
        self, lons: npt.NDArray[np.float64], lats: npt.NDArray[np.float64], ref_lat: float | None = None
    ) -> Grid:
        """Heights on a regular `(lons, lats)` mesh (row 0 north), from the zoom whose pixels match its spacing.

        The zoom is chosen at `ref_lat` (default: the mesh's mean latitude); grids sharing it share a zoom, so their
        overlapping samples agree.
        """
        dlat = abs(float(lats[0, 0] - lats[1, 0]))
        dlon = dlat / math.cos(math.radians(float(lats.mean()) if ref_lat is None else ref_lat))
        z = int(np.clip(math.ceil(math.log2(360 / (TERRARIUM_TILE * dlon))), 0, 15))
        return self.sample(lons, lats, z)

    def points(self, lonlats: list[tuple[float, float]]) -> list[float]:
        """Return the height at each `(lon, lat)` from zoom-10 tiles (about 150 m)."""
        lons = np.array([p[0] for p in lonlats], dtype=np.float64)
        lats = np.array([p[1] for p in lonlats], dtype=np.float64)
        return [float(v) for v in self.sample(lons, lats, 10)]


def mercator_pixels(
    lons: npt.NDArray[np.float64], lats: npt.NDArray[np.float64], z: int
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    """Global Web Mercator pixel coordinates at zoom `z` (256-pixel tiles)."""
    scale = TERRARIUM_TILE * (1 << z)
    lat = np.radians(np.clip(lats, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT))
    x = (lons + 180) / 360 * scale
    y = (1 - np.log(np.tan(lat) + 1 / np.cos(lat)) / math.pi) / 2 * scale
    return x, y


@dataclass(frozen=True, slots=True)
class SourceLadder:
    """Copernicus sources for REST/MCP queries: GLO-30 for points and small areas, GLO-90 for large ones."""

    coarse: ElevationSource
    fine: ElevationSource

    def for_span(self, degrees: float) -> ElevationSource:
        """Source for an area query spanning `degrees`: fine below 0.5 degrees, else coarse."""
        return self.fine if degrees <= 0.5 else self.coarse  # noqa: PLR2004
