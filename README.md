# Terrain-Render-Service

[![CI](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/ci.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/ci.yml)
[![Security](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/security.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/security.yml)
[![CodeQL](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/codeql.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/codeql.yml)
[![Image](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/image.yml/badge.svg)](https://github.com/Hawuawu/Terrain-Render-Service/actions/workflows/image.yml)

A terrain explorer in two views. A smooth **relief globe** (elevation colours and hillshade, rendered and cached by
this FastAPI service) lets you fly anywhere; clicking a place opens a **voxel view** around it in the style of
[VXLEngine](https://github.com/Hawuawu/VXLEngine): about 40 m cubes streamed in 5 km pieces as you move, and a
coarse far field that curves with the Earth out to the horizon.
The same elevation data is exposed to AI agents as MCP tools (FastMCP).

```
browser (three.js)
  ├ relief globe ── /relief/{z}/{x}/{y}.png ──► FastAPI ──► cache (volume) ──miss──► AWS Terrain Tiles (Terrarium)
  ├ voxel view ──── /voxels/{patch,far}.bin ──►    │
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

A voxel scene has a flat local frame (x east, z south, metres) around an origin snapped to a 0.01° grid, so nearby
visits share cached pieces. Its ground streams in as square pieces:

- `GET /voxels/patch.bin?lat&lon&i&j` is the 5×5 km patch `i` steps east and `j` south of the origin: 130×130
  little-endian `int16` heights (row 0 north, one per 39 m column centre), the inner 128×128 plus a one-column
  border shared with the neighbours, so walls match across patch seams.
- `GET /voxels/far.bin?lat&lon&i&j` is the far field centred `i`, `j` steps of 50 km from the origin: 257×257
  heights 1.6 km apart covering 400×400 km.

`X-Origin-Lat`, `X-Origin-Lon`, `X-Samples` and `X-Cell-M` describe each response. Both are sampled from Terrarium
tiles at the zoom matching their spacing (fetched in parallel), then served from `$TERRAIN_CACHE_DIR/<version>/`.

The browser keeps the patches within 13 km of the viewer, requesting the nearest and those ahead of the direction of
travel first (six at a time) and dropping those that fall behind, so the ground grows into view while walking. Four
Web Workers port VXLEngine's `computeLevels` and `voxelChunk` over each patch: heights × exaggeration are quantised
into cube levels (sea flattened to level 0), equal top faces within one tint band are greedy-merged into rectangles,
and side walls into runs. The shader draws VXLEngine's block outlines.

Past the voxels the smooth far field, sunk slightly so the voxels win where both overlap, takes over to the horizon.
Both are bent down by the Earth's curvature around the viewer (d²/2R, about 3 km at 200 km) and fade into haze, so
zooming out shows a curved horizon. After 100 km of walking the scene re-centres under the viewer.

## API

| Endpoint | |
|---|---|
| `GET /` | relief globe (drag, wheel, right-drag to tilt; click to open the voxel view, with exaggeration, outline and back controls). The URL hash `#lat,lon,altitude_m,tilt,heading` or `#area=lat,lon` is a shareable view. |
| `GET /relief/meta.json`, `GET /relief/{z}/{x}/{y}.png` | relief map tiles |
| `GET /voxels/patch.bin?lat&lon&i&j` | 5×5 km voxel patch |
| `GET /voxels/far.bin?lat&lon&i&j` | 400×400 km far field |
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
