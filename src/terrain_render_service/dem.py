"""Elevation sources: Copernicus DEM cloud-optimised GeoTIFFs read on demand over HTTP."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

import numpy as np
import numpy.typing as npt
import rasterio
from affine import Affine
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
    """Sea-level everywhere: used for the coarsest zoom levels, where relief is invisible."""

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


@dataclass(frozen=True, slots=True)
class SourceLadder:
    """Pick the cheapest source that still has enough detail for a zoom level."""

    flat: ElevationSource
    coarse: ElevationSource
    fine: ElevationSource
    coarse_from_zoom: int
    fine_from_zoom: int

    def for_zoom(self, z: int) -> ElevationSource:
        """Source for a tile at level `z`."""
        if z >= self.fine_from_zoom:
            return self.fine
        if z >= self.coarse_from_zoom:
            return self.coarse
        return self.flat

    def for_span(self, degrees: float) -> ElevationSource:
        """Source for an area query spanning `degrees`: fine below 0.5 degrees, else coarse."""
        return self.fine if degrees <= 0.5 else self.coarse  # noqa: PLR2004
