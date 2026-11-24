"""Voxel detail areas: a fixed square of column heights around a clicked point, meshed by the browser."""

from __future__ import annotations

import gzip
import math
from dataclasses import dataclass

import numpy as np

from .dem import Grid
from .tiling import GeoBounds

EARTH_RADIUS_M = 6_371_008.8
METRES_PER_DEGREE = EARTH_RADIUS_M * math.pi / 180
HEIGHT_RANGE = (-11_000, 9_000)
AREA_SIZE_M = 20_000.0
AREA_COLUMNS = 512
"""Columns per area edge: 20 km / 512, about 39 m per voxel."""
SNAP_DEGREES = 0.01
"""Area centres snap to this grid (about 1 km) so nearby clicks share one cached area."""
MAX_AREA_LAT = 84.0


def _snap(v: float) -> float:
    return round(round(v / SNAP_DEGREES) * SNAP_DEGREES, 2)


@dataclass(frozen=True, slots=True)
class Area:
    """A square `AREA_SIZE_M` wide centred on a snapped point."""

    lat: float
    lon: float

    @classmethod
    def around(cls, lat: float, lon: float) -> Area:
        """Return the area whose snapped centre is nearest to `(lat, lon)`."""
        lat = max(-MAX_AREA_LAT, min(MAX_AREA_LAT, _snap(lat)))
        lon = _snap(lon)
        if lon >= 180:  # noqa: PLR2004
            lon -= 360
        return cls(lat, lon)

    @property
    def cell_m(self) -> float:
        """Edge of one voxel column in metres."""
        return AREA_SIZE_M / AREA_COLUMNS

    @property
    def key(self) -> str:
        """Cache key, e.g. `area/+45.83_+006.86.bin`."""
        return f"area/{self.lat:+06.2f}_{self.lon:+07.2f}.bin"

    @property
    def column_centres(self) -> GeoBounds:
        """Bounds whose edge-inclusive `AREA_COLUMNS` grid lands on the column centres."""
        half_m = AREA_SIZE_M / 2 - self.cell_m / 2
        dlat = half_m / METRES_PER_DEGREE
        dlon = dlat / math.cos(math.radians(self.lat))
        west = max(-180.0, self.lon - dlon)
        east = min(180.0, self.lon + dlon)
        return GeoBounds(west, self.lat - dlat, east, self.lat + dlat)


def encode_columns(heights: Grid) -> bytes:
    """Gzip square column heights as little-endian int16 metres, row 0 at the north edge."""
    if heights.ndim != 2 or heights.shape[0] != heights.shape[1]:  # noqa: PLR2004
        msg = f"expected square columns, got {heights.shape}"
        raise ValueError(msg)
    data = np.clip(np.rint(heights), *HEIGHT_RANGE).astype("<i2")
    return gzip.compress(data.tobytes(), mtime=0)
