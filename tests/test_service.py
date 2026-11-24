import gzip

import numpy as np
import pytest

from terrain_render_service.service import TerrainService, haversine_m
from terrain_render_service.tiling import GeoBounds, TileId
from terrain_render_service.voxels import AREA_COLUMNS, Area

from .conftest import SlopeSource


def test_area_holds_source_heights_at_column_centres(service: TerrainService) -> None:
    area = Area.around(45.832, 6.865)
    cols = np.frombuffer(gzip.decompress(service.area(area)), dtype="<i2").reshape(AREA_COLUMNS, AREA_COLUMNS)
    b = area.column_centres
    assert cols[0, 0] == round(b.west * 1000)
    assert cols[-1, -1] == round(b.east * 1000)


def test_area_is_cached(service: TerrainService, slope: SlopeSource) -> None:
    first = service.area(Area.around(10, 10))
    assert service.area(Area.around(10.004, 9.996)) == first
    assert slope.calls == 1


def test_relief_is_cached_png(service: TerrainService, slope: SlopeSource) -> None:
    png = service.relief(TileId(3, 4, 2))
    assert png.startswith(b"\x89PNG")
    assert service.relief(TileId(3, 4, 2)) == png
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
