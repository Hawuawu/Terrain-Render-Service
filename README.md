# Terrain-Render-Service

[![CI](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/ci.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/ci.yml)
[![Security](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/security.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/security.yml)
[![CodeQL](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/codeql.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/codeql.yml)
[![Image](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/image.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/image.yml)

A terrain explorer in two views. A smooth **relief globe** (elevation colours and hillshade, rendered and cached by
this FastAPI service) lets you fly anywhere; clicking a place opens a **voxel view** of the 20×20 km around it in the
style of [VXLEngine](https://github.com/Hawuawu/VXLEngine), with about 40 m cubes fading into fog at the edge.
The same elevation data is exposed to AI agents as MCP tools (FastMCP).

```
browser (three.js)
  ├ relief globe ── /relief/{z}/{x}/{y}.png ──► FastAPI ──► cache (volume) ──miss──► AWS Terrain Tiles (Terrarium)
  ├ voxel view ──── /voxels/area.bin?lat&lon ─►    │
  │   └ Web Workers: levels, greedy mesh           │
  └──────────────── /api/elevation, /api/profile ─►└──► Copernicus DEM GLO-30/90 COGs (HTTP range reads)
AI agent ────────── /mcp (FastMCP, HTTP) ───────►
```

## Relief globe

`GET /relief/{z}/{x}/{y}.png` is a 256×256 Web Mercator (XYZ) tile, zoom 0–12 (about 38 m per pixel at zoom 12).
It is one [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) Terrarium tile, tinted by elevation and
hillshaded (relief is exaggerated at coarse zooms so mountains stay visible), rendered on first request in about
0.4 s and then served from `$TERRAIN_CACHE_DIR/<version>/relief/`. The browser drapes the tiles on sphere patches,
picks the zoom whose pixels match the screen, and draws coarser levels under finer ones, so a region keeps its
parent imagery until the sharper tile arrives. Nothing on this path touches Copernicus.

## Voxel view

`GET /voxels/area.bin?lat&lon` returns 512×512 little-endian `int16` heights in metres (row 0 at the north edge,
one sample per column centre) for a 20×20 km square, so a column is 39 m. The centre snaps to a 0.01° grid so nearby
clicks share one cached area; `X-Area-Lat`, `X-Area-Lon`, `X-Area-Columns` and `X-Area-Cell-M` describe it.
It is sampled from zoom-12 Terrarium tiles (up to 16, fetched in parallel), about 1 s on first request, then served
from `$TERRAIN_CACHE_DIR/<version>/area/`.

Four Web Workers port VXLEngine's `computeLevels` and `voxelChunk` over 8×8 chunks of 64×64 columns: heights ×
exaggeration are quantised into cube levels (sea flattened to level 0), equal top faces within one tint band are
greedy-merged into rectangles, and side walls into runs. The scene is flat, so merged faces leave no gaps; walls at
chunk borders look at the neighbouring chunk's columns. The shader draws VXLEngine's block outlines and fades the
terrain into fog from 6 km out to the 10 km edge.

## API

| Endpoint | |
|---|---|
| `GET /` | relief globe (drag, wheel, right-drag to tilt; click to open the voxel view, with exaggeration, outline and back controls). The URL hash `#lat,lon,altitude_m,tilt,heading` or `#area=lat,lon` is a shareable view. |
| `GET /relief/meta.json`, `GET /relief/{z}/{x}/{y}.png` | relief map tiles |
| `GET /voxels/area.bin?lat&lon` | 20×20 km voxel area |
| `GET /api/elevation?lat&lon` | height at a point (GLO-30) |
| `GET /api/profile?from_lat&from_lon&to_lat&to_lon&samples` | heights along a line |
| `POST /mcp` | MCP (streamable HTTP): `elevation_at`, `elevation_profile`, `area_stats`, `render_preview` (hillshaded PNG) |
| `GET /healthz` | liveness |

## Develop

```sh
uv sync
uv run uvicorn terrain_render_service.api:create_app --factory --reload   # API on :8000
cd web && npm ci && npm run dev                                           # globe on :5173, proxied to :8000
cd web && npm test                                                        # mesher tests (node:test)
```

Checks (same as CI): `uv run ruff format --check . && uv run ruff check . && uv run mypy src tests && uv run pytest`.
`uv run pytest -m network` also reads the real DEM. Pre-commit: `pre-commit install`.

Configuration is via `TERRAIN_*` environment variables (see `src/terrain_render_service/settings.py`), e.g.
`TERRAIN_CACHE_DIR`, `TERRAIN_RELIEF_MAX_ZOOM`, `TERRAIN_ALLOWED_HOSTS` (Host headers the MCP endpoint accepts).

## Deploy

Pushing a `v*` tag builds a multi-arch (amd64 + arm64) image `ghcr.io/hawuawu/terrain-render-service:<version>`
with SBOM and provenance. [K8S-Homelab](https://github.com/Hawuawu/K8S-Homelab) runs it from `apps/base/terrain`
at http://terrain.localhost:8080 with a 10 GiB cache volume; MCP clients use `http://terrain.localhost:8080/mcp`.

Pull requests from this repo also push `ghcr.io/hawuawu/terrain-render-service:pr-<number>` (overwritten on each push),
so a branch can be tried in the lab before merge. The `GHCR cleanup` workflow deletes that tag when the PR closes and
weekly sweeps untagged and orphaned versions; release tags and `edge` are kept.

## Attribution

Elevation queries (REST and MCP): Copernicus DEM GLO-30 and GLO-90, © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018,
provided under COPERNICUS by the European Union and ESA; all rights reserved.
Relief globe and voxel view: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen and the data sources
listed in its [attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)).
