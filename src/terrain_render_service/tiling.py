"""Geographic rectangles and the Web Mercator tile pyramid of the relief globe."""

from __future__ import annotations

import math
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
    """A Web Mercator (XYZ) tile of the relief globe: `y` counts from the north."""

    z: int
    x: int
    y: int

    def __post_init__(self) -> None:
        """Reject tiles outside the pyramid."""
        if not 0 <= self.z <= MAX_ZOOM:
            msg = f"zoom {self.z} outside 0..{MAX_ZOOM}"
            raise ValueError(msg)
        if not (0 <= self.x < 2**self.z and 0 <= self.y < 2**self.z):
            msg = f"tile {self.x}/{self.y} outside level {self.z}"
            raise ValueError(msg)

    @property
    def centre_lat(self) -> float:
        """Latitude of the tile's centre row in degrees."""
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (self.y + 0.5) / 2**self.z))))
