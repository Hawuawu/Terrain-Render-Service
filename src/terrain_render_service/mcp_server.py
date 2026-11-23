"""MCP tools exposing the terrain service to agents."""

from __future__ import annotations

from dataclasses import asdict

from fastmcp import FastMCP
from fastmcp.utilities.types import Image

from .service import TerrainService
from .tiling import GeoBounds


def build_mcp(service: TerrainService) -> FastMCP:
    """Create the MCP server with elevation, profile, stats and preview tools."""
    mcp = FastMCP("terrain")

    @mcp.tool
    def elevation_at(lat: float, lon: float) -> float:
        """Terrain height in metres (Copernicus GLO-30) at a WGS84 point."""
        return service.elevation(lon, lat)

    @mcp.tool
    def elevation_profile(
        from_lat: float, from_lon: float, to_lat: float, to_lon: float, samples: int = 100
    ) -> list[dict[str, float]]:
        """Heights along a straight line between two points, with distance from the start."""
        return service.profile((from_lon, from_lat), (to_lon, to_lat), samples)

    @mcp.tool
    def area_stats(west: float, south: float, east: float, north: float) -> dict[str, float | str]:
        """Min / max / mean terrain height in a lon/lat box of at most 2 x 2 degrees."""
        return asdict(service.area_stats(GeoBounds(west, south, east, north)))

    @mcp.tool
    def render_preview(west: float, south: float, east: float, north: float) -> Image:
        """Hillshaded, elevation-tinted PNG of a lon/lat box of at most 2 x 2 degrees."""
        return Image(data=service.preview(GeoBounds(west, south, east, north)), format="png")

    return mcp
