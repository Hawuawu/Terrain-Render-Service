"""Voxel scenes: square patches of column heights streamed around the viewer, plus a coarse far field to the horizon."""

from __future__ import annotations

import gzip
import math
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from .dem import Grid

EARTH_RADIUS_M = 6_371_008.8
METRES_PER_DEGREE = EARTH_RADIUS_M * math.pi / 180
HEIGHT_RANGE = (-11_000, 9_000)
PATCH_SIZE_M = 5_000.0
PATCH_COLUMNS = 128
"""Columns per patch edge: 5 km / 128, about 39 m per voxel. Patches carry one extra column of border on each side."""
FAR_SIZE_M = 400_000.0
FAR_SAMPLES = 257
"""Height samples per far-field edge (vertices, edges inclusive): about 1.6 km apart."""
FAR_STEP_M = 50_000.0
"""Far fields are centred on this grid of the scene's frame."""
SNAP_DEGREES = 0.01
"""Scene origins snap to this grid (about 1 km) so nearby visits share cached patches."""
MAX_AREA_LAT = 84.0
MAX_INDEX = 400
"""Patches reach at most 2,000 km from their scene origin."""


def _snap(v: float) -> float:
    return round(round(v / SNAP_DEGREES) * SNAP_DEGREES, 2)


@dataclass(frozen=True, slots=True)
class Origin:
    """Centre of a voxel scene's flat local frame (x east, z south, in metres), snapped to `SNAP_DEGREES`."""

    lat: float
    lon: float

    @classmethod
    def around(cls, lat: float, lon: float) -> Origin:
        """Return the snapped origin nearest to `(lat, lon)`."""
        lat = max(-MAX_AREA_LAT, min(MAX_AREA_LAT, _snap(lat)))
        lon = _snap(lon)
        if lon >= 180:  # noqa: PLR2004
            lon -= 360
        return cls(lat, lon)

    @property
    def key(self) -> str:
        """Cache prefix, e.g. `+45.83_+006.87`."""
        return f"{self.lat:+06.2f}_{self.lon:+07.2f}"

    def lonlat(
        self, x: npt.NDArray[np.float64], z: npt.NDArray[np.float64]
    ) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
        """`(lons, lats)` of local points; longitudes wrap across the antimeridian."""
        lats = self.lat - z / METRES_PER_DEGREE
        lons = self.lon + x / (METRES_PER_DEGREE * math.cos(math.radians(self.lat)))
        return (lons + 180) % 360 - 180, lats


@dataclass(frozen=True, slots=True)
class Patch:
    """Square `kind` piece `(i, j)` of a scene: `i` steps east and `j` south, from the origin."""

    origin: Origin
    i: int
    j: int
    kind: str = "patch"

    def __post_init__(self) -> None:
        """Reject patches far from the origin or beyond the voxel view's latitude range."""
        if max(abs(self.i), abs(self.j)) > MAX_INDEX:
            msg = f"patch index beyond {MAX_INDEX}"
            raise ValueError(msg)
        _, lat = self.origin.lonlat(np.zeros(1), np.array([self.j * self.step_m]))
        if abs(lat[0]) > MAX_AREA_LAT + 0.1:
            msg = f"patch latitude {lat[0]:.2f} is beyond {MAX_AREA_LAT}"
            raise ValueError(msg)

    @property
    def step_m(self) -> float:
        """Distance between neighbouring patch centres."""
        return PATCH_SIZE_M if self.kind == "patch" else FAR_STEP_M

    @property
    def cell_m(self) -> float:
        """Spacing between neighbouring samples."""
        return PATCH_SIZE_M / PATCH_COLUMNS if self.kind == "patch" else FAR_SIZE_M / (FAR_SAMPLES - 1)

    @property
    def samples(self) -> int:
        """Samples per edge: patch columns plus a one-column border, or far-field vertices."""
        return PATCH_COLUMNS + 2 if self.kind == "patch" else FAR_SAMPLES

    @property
    def key(self) -> str:
        """Cache key, e.g. `patch/+45.83_+006.87/1_-2.bin`."""
        return f"{self.kind}/{self.origin.key}/{self.i}_{self.j}.bin"

    @property
    def sample_points(self) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
        """`(lons, lats)` of every sample, row 0 north: column centres for patches, vertices for far fields."""
        half = (self.samples - 1) / 2 * self.cell_m
        offsets = np.linspace(-half, half, self.samples)
        x, z = np.meshgrid(self.i * self.step_m + offsets, self.j * self.step_m + offsets)
        return self.origin.lonlat(x, z)


def encode_columns(heights: Grid) -> bytes:
    """Gzip square column heights as little-endian int16 metres, row 0 at the north edge."""
    if heights.ndim != 2 or heights.shape[0] != heights.shape[1]:  # noqa: PLR2004
        msg = f"expected square columns, got {heights.shape}"
        raise ValueError(msg)
    data = np.clip(np.rint(heights), *HEIGHT_RANGE).astype("<i2")
    return gzip.compress(data.tobytes(), mtime=0)
