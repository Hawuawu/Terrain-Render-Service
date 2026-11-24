# Terrain-Render-Service

[![CI](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/ci.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/ci.yml)
[![Security](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/security.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/security.yml)
[![CodeQL](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/codeql.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/codeql.yml)
[![Image](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/image.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/image.yml)

A zoomable voxel Earth in the style of [VXLEngine](https://github.com/Hawuawu/VXLEngine). A three.js globe
streams voxel column tiles from a FastAPI service, which samples the
[Copernicus DEM](https://registry.opendata.aws/copernicus-dem/) on AWS Open Data on demand and caches every tile on disk.
Web Workers turn the columns into greedy-merged block meshes in the browser. The same data is exposed to AI agents as
MCP tools (FastMCP).

```
browser (three.js) ── /voxels/{z}/{x}/{y}.bin ──► FastAPI ──► tile cache (volume)
  └ Web Workers: levels, greedy mesh             │          │ miss
                   ── /api/elevation, /api/profile ─►       ▼
AI agent ────────────── /mcp (FastMCP, HTTP) ──►  └──► Copernicus DEM COGs (HTTP range reads)
                                                       AWS Terrain Tiles (zoom 0-4 overview)
```

## Voxel tiles

The globe uses a geographic quadtree: two tiles at zoom 0, each split into four per zoom level, down to zoom 14.
A tile is 64×64 **columns**, and a voxel is a cube as tall as its column is long north-south: about 310 km at zoom 0
and 19 m at zoom 14.

`GET /voxels/{z}/{x}/{y}.bin` returns 64×64 little-endian `int16` heights in metres (row 0 at the north edge, one
sample per column centre), gzip-encoded, about 1–7 KB per tile. It is generated once and stored under
`$TERRAIN_CACHE_DIR/<version>/z/x/y.bin`.

| Zoom | Source | Why |
|---|---|---|
| 0–4 | AWS Terrain Tiles (Terrarium PNG) | a whole-continent tile needs one cheap global overview, not thousands of DEM reads |
| 5–8 | Copernicus GLO-90 | one tile spans up to ~6°, 90 m is plenty |
| 9–14 | Copernicus GLO-30 (GLO-90 where a cell is missing) | full 30 m detail |

Copernicus is read only from the 1° cells a tile touches (GDAL `/vsicurl`, so only the needed bytes are fetched;
ocean cells have no file and read as 0 m).

In the browser, a worker ports VXLEngine's `computeLevels` and `voxelChunk`: heights × exaggeration are quantised
into voxel levels (sea flattened to level 0), equal top faces are greedy-merged into rectangles, and side walls into
runs. Runs stop at 8 columns so merged faces still follow the curvature. Tile edges get walls down to below the
lowest column, which hide gaps between tiles of different zoom. The shader tints by real elevation and draws the
block outlines. Tiles split while a voxel covers more than 5 px on screen; a parent stays visible until all four
children are meshed, and off-screen or beyond-horizon tiles are skipped.

## API

| Endpoint | |
|---|---|
| `GET /` | voxel globe (drag, wheel, right-drag to tilt; click for elevation; exaggeration and outline controls). The URL hash `#lat,lon,altitude_m,tilt,heading` links to a view. |
| `GET /voxels/meta.json`, `GET /voxels/{z}/{x}/{y}.bin` | voxel column tiles |
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
`TERRAIN_CACHE_DIR`, `TERRAIN_MAX_ZOOM`, `TERRAIN_ALLOWED_HOSTS` (Host headers the MCP endpoint accepts).

## Deploy

Pushing a `v*` tag builds a multi-arch (amd64 + arm64) image `ghcr.io/hawuawu/terrain-render-service:<version>`
with SBOM and provenance. [K8S-Homelab](https://github.com/Hawuawu/K8S-Homelab) runs it from `apps/base/terrain`
at http://terrain.localhost:8080 with a 10 GiB tile-cache volume; MCP clients use `http://terrain.localhost:8080/mcp`.

Pull requests from this repo also push `ghcr.io/hawuawu/terrain-render-service:pr-<number>` (overwritten on each push),
so a branch can be tried in the lab before merge. The `GHCR cleanup` workflow deletes that tag when the PR closes and
weekly sweeps untagged and orphaned versions; release tags and `edge` are kept.

## Attribution

Elevation: Copernicus DEM GLO-30 and GLO-90, © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018,
provided under COPERNICUS by the European Union and ESA; all rights reserved.
Overview zooms: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen and the data sources
listed in its [attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)).
