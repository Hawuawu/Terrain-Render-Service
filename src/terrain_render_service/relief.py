"""Relief map tiles for the globe: Terrarium heights tinted by elevation and hillshaded."""

from __future__ import annotations

import math

from .dem import TERRARIUM_TILE, Grid
from .preview import render_png
from .tiling import TileId
from .voxels import EARTH_RADIUS_M

DETAIL_ZOOM = 12
"""Zoom at which hillshade uses true slopes; coarser tiles exaggerate relief so mountains stay visible."""


def relief_png(tile: TileId, heights: Grid) -> bytes:
    """Render one 256 x 256 Web Mercator tile."""
    cell_m = 2 * math.pi * EARTH_RADIUS_M * math.cos(math.radians(tile.centre_lat)) / (TERRARIUM_TILE << tile.z)
    shade_exaggeration = 2 ** (max(DETAIL_ZOOM - tile.z, 0) / 2)
    return render_png(heights, max(cell_m, 1.0), shade_exaggeration)
