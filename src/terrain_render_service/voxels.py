"""Voxel column tiles: per-cell mean heights that the browser quantises into cube-sized blocks."""

from __future__ import annotations

import gzip
import math

import numpy as np

from .dem import Grid
from .tiling import GeoBounds, TileId

VOXEL_TILE = 64
"""Columns per tile edge; the browser meshes each tile as 64 x 64 voxel columns."""
EARTH_RADIUS_M = 6_371_008.8
HEIGHT_RANGE = (-11_000, 9_000)


def voxel_size_m(z: int) -> float:
    """Edge length of one voxel at zoom `z`: the north-south extent of a column, so blocks are cubes."""
    return EARTH_RADIUS_M * math.radians(TileId(z, 0, 0).size_degrees / VOXEL_TILE)


def column_centres(tile: TileId) -> GeoBounds:
    """Bounds whose edge-inclusive `VOXEL_TILE` grid lands on the column centres of `tile`."""
    b = tile.bounds
    half = tile.size_degrees / VOXEL_TILE / 2
    return GeoBounds(b.west + half, b.south + half, b.east - half, b.north - half)


def encode_columns(heights: Grid) -> bytes:
    """Gzip the column heights as little-endian int16 metres, row 0 at the north edge."""
    if heights.shape != (VOXEL_TILE, VOXEL_TILE):
        msg = f"expected {VOXEL_TILE} x {VOXEL_TILE} columns, got {heights.shape}"
        raise ValueError(msg)
    data = np.clip(np.rint(heights), *HEIGHT_RANGE).astype("<i2")
    return gzip.compress(data.tobytes(), mtime=0)
