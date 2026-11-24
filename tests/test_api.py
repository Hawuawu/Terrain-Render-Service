from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from fastmcp import Client
from pydantic import ValidationError

from terrain_render_service.api import build_service, create_app
from terrain_render_service.mcp_server import build_mcp
from terrain_render_service.service import TerrainService
from terrain_render_service.settings import Settings


@pytest.fixture
def client(tmp_path: Path, service: TerrainService) -> TestClient:
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<title>globe</title>")
    return TestClient(create_app(Settings(web_dir=web, relief_max_zoom=6), service))


def test_health_and_index(client: TestClient) -> None:
    assert client.get("/healthz").json() == {"status": "ok"}
    index = client.get("/")
    assert "globe" in index.text
    csp = index.headers["content-security-policy"]
    assert "frame-ancestors 'none'" in csp
    assert "unsafe" not in csp
    assert index.headers["x-content-type-options"] == "nosniff"


def test_relief_meta(client: TestClient) -> None:
    meta = client.get("/relief/meta.json").json()
    assert meta == {"max_zoom": 6, "patch_size_m": 5_000, "far_size_m": 400_000}


def test_relief_tile(client: TestClient) -> None:
    r = client.get("/relief/3/4/2.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert "max-age" in r.headers["cache-control"]


@pytest.mark.parametrize("path", ["/relief/7/0/0.png", "/relief/0/1/0.png", "/voxels/4/17/8.bin"])
def test_relief_tile_not_found(client: TestClient, path: str) -> None:
    assert client.get(path).status_code == 404


def test_voxel_patch(client: TestClient) -> None:
    r = client.get("/voxels/patch.bin", params={"lat": 45.8326, "lon": 6.8652, "i": 1, "j": -1})
    assert r.status_code == 200
    assert r.headers["content-encoding"] == "gzip"
    assert (r.headers["x-origin-lat"], r.headers["x-origin-lon"], r.headers["x-samples"]) == ("45.83", "6.87", "130")
    assert float(r.headers["x-cell-m"]) == pytest.approx(39.0625)
    assert len(r.content) == 130 * 130 * 2
    assert client.get("/voxels/patch.bin", params={"lat": 95, "lon": 0}).status_code == 422
    assert client.get("/voxels/patch.bin", params={"lat": 84, "lon": 0, "j": -5}).status_code == 404


def test_voxel_far_field(client: TestClient) -> None:
    r = client.get("/voxels/far.bin", params={"lat": 45.83, "lon": 6.87})
    assert r.status_code == 200
    assert r.headers["x-samples"] == "257"
    assert len(r.content) == 257 * 257 * 2


def test_elevation_endpoints(client: TestClient) -> None:
    assert client.get("/api/elevation", params={"lat": 1, "lon": 2}).json()["elevation_m"] == 2000
    profile = client.get("/api/profile", params={"from_lat": 0, "from_lon": 0, "to_lat": 0, "to_lon": 1, "samples": 2})
    assert len(profile.json()) == 2
    assert client.get("/api/elevation", params={"lat": 91, "lon": 0}).status_code == 422


def test_mcp_endpoint_is_mounted(client: TestClient) -> None:
    with client:
        r = client.post("/mcp", json={}, headers={"accept": "application/json, text/event-stream"})
    assert r.status_code != 404


def test_build_service_uses_copernicus(tmp_path: Path) -> None:
    service = build_service(Settings(cache_dir=tmp_path))
    assert service.sources.fine.name == "copernicus-glo30"
    assert service.sources.coarse.name == "copernicus-glo90"


async def test_mcp_tools(service: TerrainService) -> None:
    async with Client(build_mcp(service)) as mcp:
        names = {t.name for t in await mcp.list_tools()}
        assert names == {"elevation_at", "elevation_profile", "area_stats", "render_preview"}
        assert (await mcp.call_tool("elevation_at", {"lat": 0, "lon": 3})).data == 3000
        stats = await mcp.call_tool("area_stats", {"west": 1, "south": 0, "east": 2, "north": 1})
        assert stats.data["max_m"] == 2000
        profile = await mcp.call_tool(
            "elevation_profile", {"from_lat": 0, "from_lon": 0, "to_lat": 0, "to_lon": 1, "samples": 2}
        )
        assert len(profile.structured_content["result"]) == 2
        preview = await mcp.call_tool("render_preview", {"west": 1, "south": 47, "east": 1.2, "north": 47.2})
        assert preview.content[0].mime_type == "image/png"


INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}},
}


@pytest.mark.parametrize(
    ("headers", "status"),
    [
        ({"host": "terrain.localhost:8080"}, 200),
        ({"host": "evil.example"}, 421),
        ({"host": "terrain.localhost:8080", "origin": "http://evil.example"}, 403),
    ],
)
def test_mcp_guards_host_and_origin(client: TestClient, headers: dict[str, str], status: int) -> None:
    with client:
        r = client.post("/mcp", json=INITIALIZE, headers={"accept": "application/json, text/event-stream", **headers})
    assert r.status_code == status


def test_relief_max_zoom_must_cover_the_globe_base() -> None:
    with pytest.raises(ValidationError):
        Settings(relief_max_zoom=1)
