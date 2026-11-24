import gzip

import numpy as np
import pytest

from terrain_render_service.voxels import (
    FAR_SAMPLES,
    FAR_SIZE_M,
    METRES_PER_DEGREE,
    PATCH_COLUMNS,
    PATCH_SIZE_M,
    Origin,
    Patch,
    encode_columns,
)


def test_origin_snaps_and_wraps() -> None:
    assert Origin.around(45.8326, 6.8652) == Origin(45.83, 6.87)
    assert Origin.around(89, 179.999) == Origin(84.0, -180.0)
    assert Patch(Origin(45.83, 6.87), 1, -2).key == "patch/+45.83_+006.87/1_-2.bin"


def test_patch_samples_are_column_centres_with_a_border() -> None:
    patch = Patch(Origin(0, 10), 0, 0)
    lons, lats = patch.sample_points
    assert lons.shape == lats.shape == (PATCH_COLUMNS + 2, PATCH_COLUMNS + 2)
    assert patch.cell_m == pytest.approx(PATCH_SIZE_M / PATCH_COLUMNS)
    span = (lats[0, 0] - lats[-1, 0]) * METRES_PER_DEGREE
    assert span == pytest.approx(PATCH_SIZE_M + patch.cell_m)
    assert lats[0, 0] > lats[-1, 0]
    assert (lons[0, 0] + lons[0, -1]) / 2 == pytest.approx(10)
    wide, _ = Patch(Origin(60, 0), 0, 0).sample_points
    assert wide[0, -1] - wide[0, 0] == pytest.approx(2 * (lons[0, -1] - lons[0, 0]), rel=1e-6)


def test_neighbouring_patches_overlap_by_their_borders() -> None:
    o = Origin(45.83, 6.87)
    lons, lats = Patch(o, 0, 0).sample_points
    east, south = Patch(o, 1, 0).sample_points, Patch(o, 0, 1).sample_points
    assert np.allclose(east[0][:, 0], lons[:, -2])
    assert np.allclose(east[0][:, 1], lons[:, -1])
    assert np.allclose(south[1][0], lats[-2])
    assert np.allclose(south[1][1], lats[-1])


def test_far_field_spans_its_size_on_its_own_grid() -> None:
    far = Patch(Origin(0, 0), 1, 0, "far")
    lons, lats = far.sample_points
    assert lons.shape == (FAR_SAMPLES, FAR_SAMPLES)
    assert (lats[0, 0] - lats[-1, 0]) * METRES_PER_DEGREE == pytest.approx(FAR_SIZE_M)
    assert (lons[0, 0] + lons[0, -1]) / 2 * METRES_PER_DEGREE == pytest.approx(far.step_m)


def test_patches_wrap_the_antimeridian() -> None:
    lons, _ = Patch(Origin(-17.0, 179.99), 0, 0).sample_points
    assert lons.max() < 180
    assert lons.min() >= -180
    assert lons[0, 0] > 179
    assert lons[0, -1] < -179
    steps = np.diff(lons[0]) % 360
    assert np.allclose(steps, steps[0])


@pytest.mark.parametrize(("lat", "i", "j"), [(0, 401, 0), (83.99, 0, -3)])
def test_patch_limits(lat: float, i: int, j: int) -> None:
    with pytest.raises(ValueError, match="beyond"):
        Patch(Origin(lat, 0), i, j)


def test_encode_clips_rounds_and_keeps_north_row_first() -> None:
    heights = np.zeros((4, 4), dtype=np.float32)
    heights[0, 0], heights[3, 3], heights[1, 1] = 99_999, -99_999, 12.6
    out = np.frombuffer(gzip.decompress(encode_columns(heights)), dtype="<i2").reshape(4, 4)
    assert (out[0, 0], out[3, 3], out[1, 1]) == (9_000, -11_000, 13)


def test_encode_rejects_non_square() -> None:
    with pytest.raises(ValueError, match="square"):
        encode_columns(np.zeros((4, 5), dtype=np.float32))
