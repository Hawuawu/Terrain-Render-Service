"""Render a height grid as a hillshaded, hypsometric-tinted PNG."""

from __future__ import annotations

import io

import numpy as np
import numpy.typing as npt
from PIL import Image

from .dem import Grid

# (elevation m, RGB) stops from sea level to high mountains.
TINT_STOPS = (
    (-6000.0, (12, 34, 80)),
    (-200.0, (40, 90, 150)),
    (-1.0, (70, 125, 170)),
    (0.0, (70, 130, 90)),
    (500.0, (150, 170, 100)),
    (1500.0, (180, 140, 90)),
    (3000.0, (150, 120, 110)),
    (5000.0, (245, 245, 245)),
)


def hillshade(heights: Grid, cell_m: float, azimuth: float = 315.0, altitude: float = 45.0) -> npt.NDArray[np.float64]:
    """Lambertian shading in 0..1 for a sun at `azimuth`/`altitude` degrees."""
    dy, dx = np.gradient(heights.astype(np.float64), cell_m)
    slope = np.arctan(np.hypot(dx, dy))
    aspect = np.arctan2(-dx, dy)
    az, alt = np.radians(azimuth), np.radians(altitude)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    clipped: npt.NDArray[np.float64] = np.clip(shade, 0.0, 1.0)
    return clipped


def tint(heights: Grid) -> npt.NDArray[np.float64]:
    """Map elevation to colour by linear interpolation between `TINT_STOPS`."""
    levels = np.array([s[0] for s in TINT_STOPS])
    colours = np.array([s[1] for s in TINT_STOPS], dtype=np.float64)
    rgb: npt.NDArray[np.float64] = np.stack([np.interp(heights, levels, colours[:, c]) for c in range(3)], axis=-1)
    return rgb


def render_png(heights: Grid, cell_m: float, shade_exaggeration: float = 1.0) -> bytes:
    """Combine tint and hillshade (of land only, slopes scaled by `shade_exaggeration`) into a PNG."""
    land = heights.clip(min=0) * shade_exaggeration
    shade = 0.35 + 0.65 * hillshade(land.astype(heights.dtype), cell_m)
    rgb = np.clip(tint(heights) * shade[..., None], 0, 255).astype(np.uint8)
    buffer = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buffer, "PNG", optimize=True)
    return buffer.getvalue()
