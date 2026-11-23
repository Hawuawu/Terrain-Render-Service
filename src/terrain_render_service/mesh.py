"""Turn a height grid into a gzipped Cesium quantized-mesh tile."""

from __future__ import annotations

import gzip
import io
import math

import numpy as np
import numpy.typing as npt
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


def ellipsoid_sag(bounds: GeoBounds, size: int) -> Grid:
    """Return how far the globe drops below the tile centre's tangent plane, row 0 at the north edge.

    Delatin only measures height error; adding this keeps enough vertices for the mesh to follow the
    curvature, so flat (sea-level) tiles do not collapse to a chord through the globe.
    """
    lon = np.radians(np.linspace(bounds.west, bounds.east, size))
    lat = np.radians(np.linspace(bounds.north, bounds.south, size))[:, None]
    lon0, lat0 = math.radians((bounds.west + bounds.east) / 2), math.radians((bounds.south + bounds.north) / 2)
    cos_d = np.sin(lat) * math.sin(lat0) + np.cos(lat) * math.cos(lat0) * np.cos(lon - lon0)
    return (WGS84.a * (np.clip(cos_d, -1, 1) - 1)).astype(np.float32)


def tile_mesh(heights: Grid, bounds: GeoBounds, z: int) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.uint32]]:
    """Simplify `heights` (row 0 north) into lon/lat/height vertices and counter-clockwise triangles."""
    size = heights.shape[0]
    grid = np.ascontiguousarray(heights + ellipsoid_sag(bounds, size), dtype=np.float32)
    tin = Delatin(grid, max_error=max_error(z))
    # Delatin puts array row 0 at y = size - 1, so y already grows northwards.
    positions = rescale_positions(tin.vertices, bounds.as_tuple())
    cols, rows = tin.vertices[:, 0].astype(int), size - 1 - tin.vertices[:, 1].astype(int)
    positions[:, 2] = heights[rows, cols]
    return positions, tin.triangles.flatten().astype(np.uint32)


def encode_tile(heights: Grid, bounds: GeoBounds, z: int) -> bytes:
    """Mesh `heights`, encode it as quantized-mesh with normals, gzip it."""
    positions, indices = tile_mesh(heights, bounds, z)
    buffer = io.BytesIO()
    encode(
        buffer,
        positions,
        indices,
        bounds=bounds.as_tuple(),
        extensions=[VertexNormalsExtension(indices=indices, positions=positions)],
    )
    return gzip.compress(buffer.getvalue(), mtime=0)
