from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from terrain_render_service.dem import Cell, CopernicusSource, FlatSource, SourceLadder, cells_covering
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


def test_ladder_picks_by_zoom_and_span() -> None:
    flat, coarse, fine = FlatSource(), FlatSource(), FlatSource()
    ladder = SourceLadder(flat, coarse, fine, coarse_from_zoom=5, fine_from_zoom=9)
    assert [ladder.for_zoom(z) for z in (0, 5, 9)] == [flat, coarse, fine]
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
