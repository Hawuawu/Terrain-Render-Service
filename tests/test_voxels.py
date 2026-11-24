import gzip

import numpy as np
import pytest

from terrain_render_service.tiling import TileId
from terrain_render_service.voxels import VOXEL_TILE, column_centres, encode_columns, voxel_size_m


def test_voxel_size_halves_per_zoom() -> None:
    assert voxel_size_m(0) == pytest.approx(312_700, rel=1e-3)
    assert voxel_size_m(14) == pytest.approx(voxel_size_m(0) / 2**14)


def test_column_centres_are_half_a_cell_inside_the_tile() -> None:
    tile = TileId(2, 3, 1)
    half = tile.size_degrees / VOXEL_TILE / 2
    c, b = column_centres(tile), tile.bounds
    assert c.west - b.west == pytest.approx(half)
    assert b.north - c.north == pytest.approx(half)


def test_encode_rounds_clips_and_keeps_north_row_first() -> None:
    heights = np.zeros((VOXEL_TILE, VOXEL_TILE), dtype=np.float32)
    heights[0, 0], heights[0, 1], heights[1, 0] = 1234.6, 20_000, -20_000
    out = np.frombuffer(gzip.decompress(encode_columns(heights)), dtype="<i2").reshape(VOXEL_TILE, VOXEL_TILE)
    assert (out[0, 0], out[0, 1], out[1, 0]) == (1235, 9000, -11000)


def test_encode_rejects_wrong_shape() -> None:
    with pytest.raises(ValueError, match="columns"):
        encode_columns(np.zeros((65, 65), dtype=np.float32))
