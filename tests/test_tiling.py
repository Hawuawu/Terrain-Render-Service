import pytest

from terrain_render_service.tiling import GeoBounds, TileId, layer_availability


def test_level_zero_has_two_tiles() -> None:
    assert TileId(0, 0, 0).bounds == GeoBounds(-180, -90, 0, 90)
    assert TileId(0, 1, 0).bounds == GeoBounds(0, -90, 180, 90)


def test_y_counts_from_south() -> None:
    assert TileId(1, 0, 1).bounds.south == 0
    assert TileId(1, 0, 0).bounds.north == 0


@pytest.mark.parametrize(("z", "x", "y"), [(-1, 0, 0), (21, 0, 0), (0, 2, 0), (0, 0, 1), (3, 0, -1)])
def test_rejects_tiles_outside_pyramid(z: int, x: int, y: int) -> None:
    with pytest.raises(ValueError, match="outside"):
        TileId(z, x, y)


def test_rejects_inverted_bounds() -> None:
    with pytest.raises(ValueError, match="invalid bounds"):
        GeoBounds(10, 0, 5, 1)


def test_bounds_size_and_tuple() -> None:
    b = GeoBounds(1, 2, 4, 3)
    assert (b.width, b.height, b.as_tuple()) == (3, 1, (1, 2, 4, 3))


def test_availability_covers_every_level() -> None:
    levels = layer_availability(2)
    assert len(levels) == 3
    assert levels[2] == [{"startX": 0, "startY": 0, "endX": 7, "endY": 3}]
