import gzip

import numpy as np
import pytest

from terrain_render_service.service import TerrainService, haversine_m
from terrain_render_service.tiling import GeoBounds, TileId
from terrain_render_service.voxels import VOXEL_TILE

from .conftest import SlopeSource


def columns(tile: bytes) -> np.ndarray:
    return np.frombuffer(gzip.decompress(tile), dtype="<i2").reshape(VOXEL_TILE, VOXEL_TILE)


def test_tile_holds_source_heights_at_column_centres(service: TerrainService) -> None:
    cols = columns(service.tile(TileId(5, 32, 16)))
    bounds, cell = TileId(5, 32, 16).bounds, TileId(5, 32, 16).size_degrees / VOXEL_TILE
    assert cols[0, 0] == pytest.approx((bounds.west + cell / 2) * 1000, abs=1)
    assert cols[-1, -1] == pytest.approx((bounds.east - cell / 2) * 1000, abs=1)
    assert (cols[:, 1:] > cols[:, :-1]).all()


def test_overview_zooms_use_the_overview_source(service: TerrainService) -> None:
    assert not columns(service.tile(TileId(1, 0, 0))).any()


def test_tiles_are_cached(service: TerrainService, slope: SlopeSource) -> None:
    first = service.tile(TileId(5, 40, 20))
    assert service.tile(TileId(5, 40, 20)) == first
    assert slope.calls == 1


def test_elevation_and_profile(service: TerrainService) -> None:
    assert service.elevation(2.5, 10) == 2500
    profile = service.profile((0, 0), (1, 0), 3)
    assert [p["elevation_m"] for p in profile] == [0, 500, 1000]
    assert profile[-1]["distance_m"] == pytest.approx(111_195, rel=1e-3)


def test_profile_rejects_bad_sample_counts(service: TerrainService) -> None:
    with pytest.raises(ValueError, match="samples"):
        service.profile((0, 0), (1, 0), 1)


def test_area_stats_and_limits(service: TerrainService) -> None:
    stats = service.area_stats(GeoBounds(1, 0, 2, 1))
    assert (stats.min_m, stats.max_m, stats.source) == (1000, 2000, "slope")
    with pytest.raises(ValueError, match="limit"):
        service.area_stats(GeoBounds(0, 0, 3, 1))


def test_preview_is_png(service: TerrainService) -> None:
    assert service.preview(GeoBounds(1, 47, 1.5, 47.5), 64).startswith(b"\x89PNG")


def test_haversine_quarter_meridian() -> None:
    assert haversine_m((0, 0), (0, 90)) == pytest.approx(10_007_543, rel=1e-4)
