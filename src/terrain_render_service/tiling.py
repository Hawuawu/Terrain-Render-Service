"""Geographic (EPSG:4326, TMS) tile pyramid used by Cesium quantized-mesh terrain."""

from __future__ import annotations

from dataclasses import dataclass

MAX_ZOOM = 20
MAX_LON = 180.0
MAX_LAT = 90.0


@dataclass(frozen=True, slots=True)
class GeoBounds:
    """A lon/lat rectangle in degrees."""

    west: float
    south: float
    east: float
    north: float

    def __post_init__(self) -> None:
        """Reject inverted or out-of-range rectangles."""
        if not (-MAX_LON <= self.west < self.east <= MAX_LON and -MAX_LAT <= self.south < self.north <= MAX_LAT):
            msg = f"invalid bounds {self}"
            raise ValueError(msg)

    @property
    def width(self) -> float:
        """Width in degrees."""
        return self.east - self.west

    @property
    def height(self) -> float:
        """Height in degrees."""
        return self.north - self.south

    def as_tuple(self) -> tuple[float, float, float, float]:
        """Return `(west, south, east, north)`."""
        return (self.west, self.south, self.east, self.north)


@dataclass(frozen=True, slots=True)
class TileId:
    """A tile in the geographic scheme: 2 x 1 tiles at level 0, `y` counted from the south."""

    z: int
    x: int
    y: int

    def __post_init__(self) -> None:
        """Reject tiles outside the pyramid."""
        if not 0 <= self.z <= MAX_ZOOM:
            msg = f"zoom {self.z} outside 0..{MAX_ZOOM}"
            raise ValueError(msg)
        if not (0 <= self.x < 2 ** (self.z + 1) and 0 <= self.y < 2**self.z):
            msg = f"tile {self.x}/{self.y} outside level {self.z}"
            raise ValueError(msg)

    @property
    def size_degrees(self) -> float:
        """Edge length of the tile in degrees."""
        return MAX_LON / (1 << self.z)

    @property
    def bounds(self) -> GeoBounds:
        """The tile's lon/lat rectangle."""
        size = self.size_degrees
        west = -180.0 + self.x * size
        south = -90.0 + self.y * size
        return GeoBounds(west, south, west + size, south + size)


def layer_availability(max_zoom: int) -> list[list[dict[str, int]]]:
    """Cesium `layer.json` availability: every tile of every level up to `max_zoom`."""
    return [[{"startX": 0, "startY": 0, "endX": 2 ** (z + 1) - 1, "endY": 2**z - 1}] for z in range(max_zoom + 1)]
