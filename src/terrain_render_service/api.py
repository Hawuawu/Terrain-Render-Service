"""FastAPI application: Cesium terrain tiles, elevation API, MCP endpoint and the globe UI."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import FastAPI, HTTPException, Path, Query
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from .cache import TileCache
from .dem import CopernicusSource, FlatSource, SourceLadder
from .headers import SecurityHeadersMiddleware
from .mcp_server import build_mcp
from .service import TerrainService
from .settings import Settings
from .tiling import TileId, layer_availability

ATTRIBUTION = "Copernicus DEM GLO-30/GLO-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018"
Lat = Annotated[float, Query(ge=-90, le=90)]
Lon = Annotated[float, Query(ge=-180, le=180)]


def build_service(settings: Settings) -> TerrainService:
    """Wire the elevation sources and tile cache from settings."""
    coarse = CopernicusSource(settings.glo90_url, 30, "copernicus-glo90")
    ladder = SourceLadder(
        flat=FlatSource(),
        coarse=coarse,
        fine=CopernicusSource(settings.glo30_url, 10, "copernicus-glo30", fallback=coarse),
        coarse_from_zoom=settings.coarse_from_zoom,
        fine_from_zoom=settings.fine_from_zoom,
    )
    return TerrainService(ladder, TileCache(settings.cache_dir, settings.cache_version))


def layer_json(max_zoom: int) -> dict[str, Any]:
    """Cesium terrain metadata (TileJSON 2.1 with quantized-mesh fields)."""
    return {
        "tilejson": "2.1.0",
        "name": "copernicus-dem",
        "attribution": ATTRIBUTION,
        "format": "quantized-mesh-1.0",
        "version": "1.0.0",
        "scheme": "tms",
        "projection": "EPSG:4326",
        "tiles": ["{z}/{x}/{y}.terrain?v={version}"],
        "bounds": [-180, -90, 180, 90],
        "minzoom": 0,
        "maxzoom": max_zoom,
        "extensions": ["octvertexnormals"],
        "available": layer_availability(max_zoom),
    }


def create_app(settings: Settings | None = None, service: TerrainService | None = None) -> FastAPI:
    """Build the ASGI app; `uvicorn terrain_render_service.api:create_app --factory`."""
    settings = settings or Settings()
    service = service or build_service(settings)
    # Stateless: no per-worker session memory, so any uvicorn worker can answer any MCP request.
    mcp_app = build_mcp(service).http_app(path="/mcp", stateless_http=True, allowed_hosts=settings.allowed_hosts)
    app = FastAPI(title="Terrain Render Service", lifespan=mcp_app.lifespan)
    app.add_middleware(SecurityHeadersMiddleware)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/terrain/layer.json")
    def layer() -> dict[str, Any]:
        return layer_json(settings.max_zoom)

    @app.get("/terrain/{z}/{x}/{y}.terrain")
    def terrain_tile(z: Annotated[int, Path(ge=0)], x: int, y: int) -> Response:
        if z > settings.max_zoom:
            raise HTTPException(404, "beyond max zoom")
        try:
            tile = TileId(z, x, y)
        except ValueError as e:
            raise HTTPException(404, str(e)) from e
        return Response(
            service.tile(tile),
            media_type="application/vnd.quantized-mesh",
            headers={"Content-Encoding": "gzip", "Cache-Control": "public, max-age=604800"},
        )

    @app.get("/api/elevation")
    def elevation(lat: Lat, lon: Lon) -> dict[str, float]:
        return {"lat": lat, "lon": lon, "elevation_m": service.elevation(lon, lat)}

    @app.get("/api/profile")
    def profile(
        from_lat: Lat, from_lon: Lon, to_lat: Lat, to_lon: Lon, samples: Annotated[int, Query(ge=2, le=500)] = 100
    ) -> list[dict[str, float]]:
        return service.profile((from_lon, from_lat), (to_lon, to_lat), samples)

    app.router.routes.extend(mcp_app.routes)
    if settings.web_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.web_dir, html=True), name="web")
    return app
