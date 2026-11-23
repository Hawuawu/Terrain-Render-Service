import gzip
import struct

import numpy as np
import pytest

from terrain_render_service.mesh import max_error, tile_mesh
from terrain_render_service.service import TerrainService, haversine_m
from terrain_render_service.tiling import GeoBounds, TileId

from .conftest import SlopeSource


def header_heights(tile: bytes) -> tuple[float, float]:
    # quantized-mesh header: center (3 doubles), then min/max height floats.
    return struct.unpack_from("<2f", gzip.decompress(tile), 24)


def test_tile_is_gzipped_quantized_mesh_with_source_heights(service: TerrainService) -> None:
    lo, hi = header_heights(service.tile(TileId(4, 17, 8)))
    bounds = TileId(4, 17, 8).bounds
    assert lo == pytest.approx(bounds.west * 1000, abs=1)
    assert hi == pytest.approx(bounds.east * 1000, abs=1)


def test_coarse_zooms_are_flat(service: TerrainService) -> None:
    assert header_heights(service.tile(TileId(1, 0, 0))) == (0, 0)


def test_tiles_are_cached(service: TerrainService, slope: SlopeSource) -> None:
    first = service.tile(TileId(5, 40, 20))
    assert service.tile(TileId(5, 40, 20)) == first
    assert slope.calls == 1


def test_max_error_halves_per_level_with_floor() -> None:
    assert max_error(1) == pytest.approx(max_error(0) / 2)
    assert max_error(20) == 0.5


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


def test_mesh_keeps_north_up_and_counter_clockwise() -> None:
    heights = np.zeros((65, 65), dtype=np.float32)
    heights[0, :] = 1000  # row 0 is the north edge
    positions, indices = tile_mesh(heights, GeoBounds(10, 40, 11, 41), 10)
    assert set(positions[positions[:, 2] == 1000][:, 1].round(6)) == {41}
    tri = positions[indices.reshape(-1, 3)]
    cross = (tri[:, 1, 0] - tri[:, 0, 0]) * (tri[:, 2, 1] - tri[:, 0, 1]) - (tri[:, 2, 0] - tri[:, 0, 0]) * (
        tri[:, 1, 1] - tri[:, 0, 1]
    )
    assert (cross > 0).all()


def test_flat_root_tile_follows_the_globe() -> None:
    positions, _ = tile_mesh(np.zeros((65, 65), dtype=np.float32), TileId(0, 0, 0).bounds, 0)
    assert len(positions) > 4
    assert not positions[:, 2].any()
