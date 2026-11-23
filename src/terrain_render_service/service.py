"""Terrain domain service shared by the REST API and the MCP tools."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .cache import TileCache
from .dem import SourceLadder
from .mesh import TILE_SAMPLES, encode_tile
from .preview import render_png
from .tiling import GeoBounds, TileId

EARTH_RADIUS_M = 6_371_008.8
MAX_AREA_DEGREES = 2.0
MAX_PROFILE_SAMPLES = 500


@dataclass(frozen=True, slots=True)
class AreaStats:
    """Summary of the terrain inside a rectangle."""

    min_m: float
    max_m: float
    mean_m: float
    source: str


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance between two `(lon, lat)` points."""
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


class TerrainService:
    """Generates cached terrain tiles and answers elevation queries."""

    def __init__(self, sources: SourceLadder, cache: TileCache) -> None:
        """Read heights from `sources`, keep generated tiles in `cache`."""
        self.sources = sources
        self.cache = cache

    def tile(self, tile: TileId) -> bytes:
        """Return the gzipped quantized-mesh tile, generated on first request."""
        cached = self.cache.get(tile)
        if cached is not None:
            return cached
        bounds = tile.bounds
        heights = self.sources.for_zoom(tile.z).grid(bounds, TILE_SAMPLES)
        data = encode_tile(heights, bounds, tile.z)
        self.cache.put(tile, data)
        return data

    def elevation(self, lon: float, lat: float) -> float:
        """Height in metres at one point (GLO-30)."""
        return self.sources.fine.points([(lon, lat)])[0]

    def profile(self, start: tuple[float, float], end: tuple[float, float], samples: int) -> list[dict[str, float]]:
        """Evenly spaced `(distance, lon, lat, elevation)` samples between two `(lon, lat)` points."""
        if not 2 <= samples <= MAX_PROFILE_SAMPLES:  # noqa: PLR2004
            msg = f"samples must be 2..{MAX_PROFILE_SAMPLES}"
            raise ValueError(msg)
        lons = np.linspace(start[0], end[0], samples)
        lats = np.linspace(start[1], end[1], samples)
        points = [(float(lo), float(la)) for lo, la in zip(lons, lats, strict=True)]
        heights = self.sources.fine.points(points)
        return [
            {"distance_m": haversine_m(start, p), "lon": p[0], "lat": p[1], "elevation_m": h}
            for p, h in zip(points, heights, strict=True)
        ]

    def _area(self, bounds: GeoBounds, size: int) -> tuple[np.ndarray, str]:
        span = max(bounds.width, bounds.height)
        if span > MAX_AREA_DEGREES:
            msg = f"area spans {span:.2f} degrees, limit is {MAX_AREA_DEGREES}"
            raise ValueError(msg)
        source = self.sources.for_span(span)
        return source.grid(bounds, size), source.name

    def area_stats(self, bounds: GeoBounds) -> AreaStats:
        """Min / max / mean height inside `bounds` (at most 2 x 2 degrees)."""
        heights, source = self._area(bounds, 256)
        return AreaStats(float(heights.min()), float(heights.max()), float(heights.mean()), source)

    def preview(self, bounds: GeoBounds, size: int = 512) -> bytes:
        """Hillshaded PNG of `bounds` (at most 2 x 2 degrees)."""
        heights, _ = self._area(bounds, size)
        mid_lat = math.radians((bounds.south + bounds.north) / 2)
        cell_m = EARTH_RADIUS_M * math.radians(bounds.width) * math.cos(mid_lat) / (size - 1)
        return render_png(heights, cell_m)
