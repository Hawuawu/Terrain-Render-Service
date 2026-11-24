from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from terrain_render_service.dem import (
    Cell,
    CopernicusSource,
    FlatSource,
    SourceLadder,
    TerrariumSource,
    cells_covering,
    mercator_pixels,
)
from terrain_render_service.tiling import GeoBounds


def test_cell_keys_use_hemisphere_prefixes() -> None:
    assert Cell(48, 11).key(10) == "Copernicus_DSM_COG_10_N48_00_E011_00_DEM"
    assert Cell(-1, -71).key(30) == "Copernicus_DSM_COG_30_S01_00_W071_00_DEM"


def test_containing_clamps_the_antimeridian_and_pole() -> None:
    assert Cell.containing(180, 90) == Cell(89, 179)
    assert Cell.containing(-0.5, -0.5) == Cell(-1, -1)


def test_cells_covering() -> None:
    assert cells_covering(GeoBounds(10.5, 47.5, 12, 48.2)) == [Cell(47, 10), Cell(47, 11), Cell(48, 10), Cell(48, 11)]


def test_flat_source() -> None:
    assert FlatSource().grid(GeoBounds(0, 0, 1, 1), 3).sum() == 0
    assert FlatSource().points([(0, 0), (1, 1)]) == [0.0, 0.0]


def write_cell(root: Path, cell: Cell, value: float) -> None:
    key = cell.key(10)
    (root / key).mkdir(parents=True)
    profile = {"driver": "GTiff", "width": 10, "height": 10, "count": 1, "dtype": "float32", "crs": "EPSG:4326"}
    transform = from_origin(cell.lon, cell.lat + 1, 0.1, 0.1)
    with rasterio.open(root / key / f"{key}.tif", "w", transform=transform, **profile) as dst:
        dst.write(np.full((1, 10, 10), value, dtype=np.float32))


@pytest.fixture
def local_source(tmp_path: Path) -> CopernicusSource:
    write_cell(tmp_path, Cell(48, 11), 500)
    source = CopernicusSource(str(tmp_path), 10, "local", max_cells=4)
    source.url = lambda cell: str(tmp_path / cell.key(10) / f"{cell.key(10)}.tif")  # type: ignore[method-assign]
    return source


def test_grid_mosaics_cells_and_treats_missing_as_sea(local_source: CopernicusSource) -> None:
    grid = local_source.grid(GeoBounds(10.5, 48.1, 11.9, 48.9), 15)
    assert grid[:, -1].min() == 500
    assert grid[:, 0].max() == 0


def test_grid_refuses_huge_areas(local_source: CopernicusSource) -> None:
    with pytest.raises(ValueError, match="limit"):
        local_source.grid(GeoBounds(0, 0, 3, 3), 5)


def test_points(local_source: CopernicusSource) -> None:
    assert local_source.points([(11.5, 48.5), (20.5, 10.5)]) == [500, 0]


def test_url_points_at_vsicurl() -> None:
    url = CopernicusSource("https://bucket/", 10, "x").url(Cell(48, 11))
    assert (
        url
        == "/vsicurl/https://bucket/Copernicus_DSM_COG_10_N48_00_E011_00_DEM/Copernicus_DSM_COG_10_N48_00_E011_00_DEM.tif"
    )


def test_ladder_picks_by_span() -> None:
    coarse, fine = FlatSource(), FlatSource()
    ladder = SourceLadder(coarse, fine)
    assert ladder.for_span(0.2) is fine
    assert ladder.for_span(1.5) is coarse


@pytest.mark.network
def test_real_copernicus_zugspitze() -> None:
    source = CopernicusSource("https://copernicus-dem-30m.s3.amazonaws.com", 10, "glo30")
    assert 2800 < source.points([(10.9863, 47.4211)])[0] < 3000


def test_missing_cells_fall_back_to_coarser_source(tmp_path: Path, local_source: CopernicusSource) -> None:
    fine = CopernicusSource(str(tmp_path / "fine"), 10, "fine", max_cells=4, fallback=local_source)
    fine.url = lambda cell: str(tmp_path / "fine" / cell.key(10) / f"{cell.key(10)}.tif")  # type: ignore[method-assign]
    assert fine.points([(11.5, 48.5), (20.5, 10.5)]) == [500, 0]
    assert fine.grid(GeoBounds(11.1, 48.1, 11.9, 48.9), 5).min() == 500


class FakeTerrarium(TerrariumSource):
    """Each pixel's height is its tile's x index times 1000; counts fetches."""

    def __init__(self) -> None:
        super().__init__("https://tiles.example", max_tiles=4, cache_size=4)
        self.fetched: list[tuple[int, int, int]] = []

    def fetch(self, z: int, x: int, y: int) -> np.ndarray:
        self.fetched.append((z, x, y))
        return np.full((256, 256), x * 1000, dtype=np.float32)


def test_mercator_pixels_equator_and_clamp() -> None:
    x, y = mercator_pixels(np.array([0.0, 180.0]), np.array([0.0, 89.9]), 0)
    assert x.tolist() == [128, 256]
    assert y[0] == pytest.approx(128)
    assert y[1] == pytest.approx(0, abs=1e-6)


def test_terrarium_grid_samples_tiles_and_caches() -> None:
    src = FakeTerrarium()
    bounds = GeoBounds(-180, -90, -1, 90)
    assert src.zoom_for(bounds, 512) == 1
    grid = src.grid(bounds, 512)
    assert grid.shape == (512, 512)
    assert not grid.any()
    src.grid(bounds, 512)
    assert sorted(src.fetched) == [(1, 0, 0), (1, 0, 1)]


def test_terrarium_prefetches_each_missing_tile_once() -> None:
    src = FakeTerrarium()
    src.tile(2, 0, 0)
    src.prefetch([(2, 0, 0), (2, 1, 0), (2, 1, 1)])
    assert sorted(src.fetched) == [(2, 0, 0), (2, 1, 0), (2, 1, 1)]
    assert src.tile(2, 1, 1).shape == (256, 256)
    assert len(src.fetched) == 3


def test_terrarium_tile_budget_lowers_zoom() -> None:
    assert FakeTerrarium().zoom_for(GeoBounds(-180, -90, 180, 90), 512) == 1
    assert FakeTerrarium().zoom_for(GeoBounds(-180, -90, 180, 90), 1024) == 1


def test_terrarium_points_use_zoom_10() -> None:
    src = FakeTerrarium()
    assert src.points([(0.1, 0.0)]) == [512_000.0]
    assert src.fetched[0][0] == 10


def test_terrarium_refuses_plain_http() -> None:
    with pytest.raises(ValueError, match="https"):
        TerrariumSource("http://tiles.example").fetch(0, 0, 0)
