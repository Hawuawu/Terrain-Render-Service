import gzip

import numpy as np
import pytest

from terrain_render_service.voxels import AREA_COLUMNS, AREA_SIZE_M, METRES_PER_DEGREE, Area, encode_columns


def test_area_snaps_and_wraps() -> None:
    assert Area.around(45.8326, 6.8652) == Area(45.83, 6.87)
    assert Area.around(89, 179.999) == Area(84.0, -180.0)
    assert Area.around(45.83, 6.87).key == "area/+45.83_+006.87.bin"


def test_area_column_centres_span_the_square() -> None:
    area = Area(0, 10)
    lons, lats = area.column_centres
    assert lons.shape == lats.shape == (AREA_COLUMNS, AREA_COLUMNS)
    assert area.cell_m == pytest.approx(AREA_SIZE_M / AREA_COLUMNS)
    assert (lats[0, 0] - lats[-1, 0]) * METRES_PER_DEGREE == pytest.approx(AREA_SIZE_M - area.cell_m)
    assert lats[0, 0] > lats[-1, 0]
    assert (lons[0, 0] + lons[0, -1]) / 2 == pytest.approx(10)
    width = lons[0, -1] - lons[0, 0]
    wide, _ = Area(60, 0).column_centres
    assert wide[0, -1] - wide[0, 0] == pytest.approx(2 * width, rel=1e-6)


def test_area_columns_wrap_the_antimeridian() -> None:
    lons, _ = Area(-17.0, 179.99).column_centres
    assert lons.max() < 180
    assert lons.min() >= -180
    assert lons[0, 0] > 179
    assert lons[0, -1] < -179
    steps = np.diff(lons[0]) % 360
    assert np.allclose(steps, steps[0])


def test_encode_clips_rounds_and_keeps_north_row_first() -> None:
    heights = np.zeros((4, 4), dtype=np.float32)
    heights[0, 0], heights[3, 3], heights[1, 1] = 99_999, -99_999, 12.6
    out = np.frombuffer(gzip.decompress(encode_columns(heights)), dtype="<i2").reshape(4, 4)
    assert (out[0, 0], out[3, 3], out[1, 1]) == (9_000, -11_000, 13)


def test_encode_rejects_non_square() -> None:
    with pytest.raises(ValueError, match="square"):
        encode_columns(np.zeros((4, 5), dtype=np.float32))
