# Terrain-Render-Service

[![CI](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/ci.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/ci.yml)
[![Security](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/security.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/security.yml)
[![CodeQL](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/codeql.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/codeql.yml)
[![Image](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/image.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/image.yml)

A zoomable 3D Earth. A CesiumJS globe streams terrain from a FastAPI service, which builds
[quantized-mesh](https://github.com/CesiumGS/quantized-mesh) tiles on demand from the
[Copernicus DEM](https://registry.opendata.aws/copernicus-dem/) on AWS Open Data and caches them on disk.
The same data is exposed to AI agents as MCP tools (FastMCP).

```
browser (CesiumJS) ── /terrain/{z}/{x}/{y}.terrain ──► FastAPI ──► tile cache (volume)
                    ── /api/elevation, /api/profile ─►    │          │ miss
AI agent ────────────── /mcp (FastMCP, HTTP) ──────────►   │          ▼
                                                           └──► Copernicus DEM COGs (HTTP range reads)
```

## How tiles are made

| Zoom | Source | Why |
|---|---|---|
| 0–4 | flat ellipsoid | relief is invisible from orbit; the globe opens instantly |
| 5–8 | Copernicus GLO-90 | one tile spans up to ~6°, 90 m is plenty |
| 9–14 | Copernicus GLO-30 | full 30 m detail |

Each tile is a 65×65 height grid read only from the 1° DEM cells it touches (GDAL `/vsicurl`, so only the needed
bytes are fetched; ocean cells have no file and read as 0 m). [pydelatin](https://github.com/kylebarron/pydelatin)
simplifies it to a TIN with an error budget that halves per zoom level, and
[quantized-mesh-encoder](https://github.com/kylebarron/quantized-mesh-encoder) writes it with vertex normals for lighting.
The gzipped tile is stored under `$TERRAIN_CACHE_DIR/<version>/z/x/y.terrain`, so every tile is built once.

## API

| Endpoint | |
|---|---|
| `GET /` | CesiumJS globe (click for elevation, vertical exaggeration slider, OSM imagery toggle) |
| `GET /terrain/layer.json`, `GET /terrain/{z}/{x}/{y}.terrain` | Cesium terrain provider |
| `GET /api/elevation?lat&lon` | height at a point (GLO-30) |
| `GET /api/profile?from_lat&from_lon&to_lat&to_lon&samples` | heights along a line |
| `POST /mcp` | MCP (streamable HTTP): `elevation_at`, `elevation_profile`, `area_stats`, `render_preview` (hillshaded PNG) |
| `GET /healthz` | liveness |

## Develop

```sh
uv sync
uv run uvicorn terrain_render_service.api:create_app --factory --reload   # API on :8000
cd web && npm ci && npm run dev                                           # globe on :5173, proxied to :8000
```

Checks (same as CI): `uv run ruff format --check . && uv run ruff check . && uv run mypy src tests && uv run pytest`.
`uv run pytest -m network` also reads the real DEM. Pre-commit: `pre-commit install`.

Configuration is via `TERRAIN_*` environment variables (see `src/terrain_render_service/settings.py`), e.g.
`TERRAIN_CACHE_DIR`, `TERRAIN_MAX_ZOOM`, `TERRAIN_ALLOWED_HOSTS` (Host headers the MCP endpoint accepts).

## Deploy

Pushing a `v*` tag builds a multi-arch (amd64 + arm64) image `ghcr.io/hawuawu/terrain-render-service:<version>`
with SBOM and provenance. [K8S-Homelab](https://github.com/Hawuawu/K8S-Homelab) runs it from `apps/base/terrain`
at http://terrain.localhost:8080 with a 10 GiB tile-cache volume; MCP clients use `http://terrain.localhost:8080/mcp`.

## Attribution

Elevation: Copernicus DEM GLO-30 and GLO-90, © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018,
provided under COPERNICUS by the European Union and ESA; all rights reserved.
Imagery: © OpenStreetMap contributors; Natural Earth II (bundled with CesiumJS).
