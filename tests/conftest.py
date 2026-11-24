from __future__ import annotations

from pathlib import Path

import numpy as np
import numpy.typing as npt
import pytest

from terrain_render_service.cache import TileCache
from terrain_render_service.dem import Grid, SourceLadder
from terrain_render_service.service import TerrainService
from terrain_render_service.tiling import GeoBounds


class SlopeSource:
    """Height = 1000 m per degree of longitude east of 0, plus a calls counter."""

    name = "slope"

    def __init__(self) -> None:
        self.calls = 0

    def grid(self, bounds: GeoBounds, size: int) -> Grid:
        self.calls += 1
        lons = np.linspace(bounds.west, bounds.east, size, dtype=np.float32)
        return np.tile(lons * 1000, (size, 1)).astype(np.float32)

    def grid_at(self, lons: npt.NDArray[np.float64], lats: npt.NDArray[np.float64]) -> Grid:  # noqa: ARG002
        self.calls += 1
        return (lons * 1000).astype(np.float32)

    def tile(self, z: int, x: int, y: int) -> Grid:  # noqa: ARG002
        self.calls += 1
        return np.tile(np.linspace(0, 2000, 256, dtype=np.float32), (256, 1))

    def points(self, lonlats: list[tuple[float, float]]) -> list[float]:
        return [lon * 1000 for lon, _ in lonlats]


@pytest.fixture
def slope() -> SlopeSource:
    return SlopeSource()


@pytest.fixture
def service(tmp_path: Path, slope: SlopeSource) -> TerrainService:
    return TerrainService(SourceLadder(slope, slope), slope, TileCache(tmp_path, "test"))
