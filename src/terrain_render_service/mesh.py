"""Turn a height grid into a gzipped Cesium quantized-mesh tile."""

from __future__ import annotations

import gzip
import io
import math

import numpy as np
from pydelatin import Delatin
from pydelatin.util import rescale_positions
from quantized_mesh_encoder.constants import WGS84
from quantized_mesh_encoder.encode import encode
from quantized_mesh_encoder.extensions import VertexNormalsExtension

from .dem import Grid
from .tiling import GeoBounds

TILE_SAMPLES = 65
# Cesium's level-0 geometric error for a 65-sample heightmap on WGS84, halved per level.
LEVEL_ZERO_ERROR: float = WGS84.a * 2 * math.pi * 0.25 / (TILE_SAMPLES * 2)


def max_error(z: int) -> float:
    """Return the allowed mesh simplification error (metres) at zoom `z`."""
    return max(LEVEL_ZERO_ERROR / (1 << z), 0.5)


def encode_tile(heights: Grid, bounds: GeoBounds, z: int) -> bytes:
    """Simplify `heights` into a TIN, encode it as quantized-mesh with normals, gzip it."""
    tin = Delatin(np.ascontiguousarray(heights, dtype=np.float32), max_error=max_error(z))
    positions = rescale_positions(tin.vertices, bounds.as_tuple(), flip_y=True)
    indices = tin.triangles.flatten()
    buffer = io.BytesIO()
    encode(
        buffer,
        positions,
        indices,
        bounds=bounds.as_tuple(),
        extensions=[VertexNormalsExtension(indices=indices, positions=positions)],
    )
    return gzip.compress(buffer.getvalue(), mtime=0)
