"""FastAPI application: relief tiles, voxel areas, elevation API, MCP endpoint and the web UI."""

from __future__ import annotations

from typing import Annotated

from fastapi import FastAPI, HTTPException, Path, Query
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from .cache import TileCache
from .dem import CopernicusSource, SourceLadder, TerrariumSource
from .headers import PathDispatchMiddleware, SecurityHeadersMiddleware
from .mcp_server import build_mcp
from .service import TerrainService
from .settings import Settings
from .tiling import TileId
from .voxels import AREA_COLUMNS, AREA_SIZE_M, Area

Lat = Annotated[float, Query(ge=-90, le=90)]
Lon = Annotated[float, Query(ge=-180, le=180)]


def build_service(settings: Settings) -> TerrainService:
    """Wire the elevation sources and tile cache from settings."""
    coarse = CopernicusSource(settings.glo90_url, 30, "copernicus-glo90")
    ladder = SourceLadder(
        coarse=coarse, fine=CopernicusSource(settings.glo30_url, 10, "copernicus-glo30", fallback=coarse)
    )
    return TerrainService(
        ladder, TerrariumSource(settings.terrarium_url), TileCache(settings.cache_dir, settings.cache_version)
    )


def create_app(settings: Settings | None = None, service: TerrainService | None = None) -> FastAPI:
    """Build the ASGI app; `uvicorn terrain_render_service.api:create_app --factory`."""
    settings = settings or Settings()
    service = service or build_service(settings)
    # Stateless: no per-worker session memory, so any uvicorn worker can answer any MCP request.
    mcp_app = build_mcp(service).http_app(
        path="/mcp", stateless_http=True, host_origin_protection=True, allowed_hosts=settings.allowed_hosts
    )
    app = FastAPI(title="Terrain Render Service", lifespan=mcp_app.lifespan)
    # Dispatch to the whole MCP app (not just its routes) so FastMCP's host/origin guard runs.
    app.add_middleware(PathDispatchMiddleware, prefix="/mcp", target=mcp_app)
    app.add_middleware(SecurityHeadersMiddleware)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    cached = {"Cache-Control": "public, max-age=604800"}

    @app.get("/relief/meta.json")
    def relief_meta() -> dict[str, int | float]:
        return {"max_zoom": settings.relief_max_zoom, "area_size_m": AREA_SIZE_M, "area_columns": AREA_COLUMNS}

    @app.get("/relief/{z}/{x}/{y}.png")
    def relief_tile(z: Annotated[int, Path(ge=0)], x: int, y: int) -> Response:
        if z > settings.relief_max_zoom:
            raise HTTPException(404, "beyond max zoom")
        try:
            tile = TileId(z, x, y)
        except ValueError as e:
            raise HTTPException(404, str(e)) from e
        return Response(service.relief(tile), media_type="image/png", headers=cached)

    @app.get("/voxels/area.bin")
    def voxel_area(lat: Lat, lon: Lon) -> Response:
        area = Area.around(lat, lon)
        headers = {
            **cached,
            "Content-Encoding": "gzip",
            "X-Area-Lat": str(area.lat),
            "X-Area-Lon": str(area.lon),
            "X-Area-Columns": str(AREA_COLUMNS),
            "X-Area-Cell-M": f"{area.cell_m:.4f}",
        }
        return Response(service.area(area), media_type="application/octet-stream", headers=headers)

    @app.get("/api/elevation")
    def elevation(lat: Lat, lon: Lon) -> dict[str, float]:
        return {"lat": lat, "lon": lon, "elevation_m": service.elevation(lon, lat)}

    @app.get("/api/profile")
    def profile(
        from_lat: Lat, from_lon: Lon, to_lat: Lat, to_lon: Lon, samples: Annotated[int, Query(ge=2, le=500)] = 100
    ) -> list[dict[str, float]]:
        return service.profile((from_lon, from_lat), (to_lon, to_lat), samples)

    if settings.web_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.web_dir, html=True), name="web")
    return app
