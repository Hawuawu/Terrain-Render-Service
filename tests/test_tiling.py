import pytest

from terrain_render_service.tiling import GeoBounds, TileId


def test_tile_centre_latitude() -> None:
    assert TileId(0, 0, 0).centre_lat == 0
    assert TileId(1, 0, 0).centre_lat == pytest.approx(66.513, abs=1e-3)
    assert TileId(1, 1, 1).centre_lat == pytest.approx(-66.513, abs=1e-3)


@pytest.mark.parametrize(("z", "x", "y"), [(-1, 0, 0), (21, 0, 0), (0, 1, 0), (0, 0, 1), (3, 0, -1), (2, 4, 0)])
def test_rejects_tiles_outside_pyramid(z: int, x: int, y: int) -> None:
    with pytest.raises(ValueError, match="outside"):
        TileId(z, x, y)


def test_rejects_inverted_bounds() -> None:
    with pytest.raises(ValueError, match="invalid bounds"):
        GeoBounds(10, 0, 5, 1)


def test_bounds_size_and_tuple() -> None:
    b = GeoBounds(1, 2, 4, 3)
    assert (b.width, b.height, b.as_tuple()) == (3, 1, (1, 2, 4, 3))
