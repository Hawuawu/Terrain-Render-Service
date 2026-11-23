from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from fastmcp import Client

from terrain_render_service.api import build_service, create_app
from terrain_render_service.mcp_server import build_mcp
from terrain_render_service.service import TerrainService
from terrain_render_service.settings import Settings


@pytest.fixture
def client(tmp_path: Path, service: TerrainService) -> TestClient:
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<title>globe</title>")
    return TestClient(create_app(Settings(web_dir=web, max_zoom=6), service))


def test_health_and_index(client: TestClient) -> None:
    assert client.get("/healthz").json() == {"status": "ok"}
    index = client.get("/")
    assert "globe" in index.text
    assert "frame-ancestors 'none'" in index.headers["content-security-policy"]
    assert index.headers["x-content-type-options"] == "nosniff"


def test_layer_json(client: TestClient) -> None:
    layer = client.get("/terrain/layer.json").json()
    assert layer["format"] == "quantized-mesh-1.0"
    assert layer["maxzoom"] == 6
    assert len(layer["available"]) == 7


def test_terrain_tile(client: TestClient) -> None:
    r = client.get("/terrain/4/17/8.terrain")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/vnd.quantized-mesh"
    assert "max-age" in r.headers["cache-control"]


@pytest.mark.parametrize("path", ["/terrain/7/0/0.terrain", "/terrain/0/5/0.terrain"])
def test_terrain_tile_not_found(client: TestClient, path: str) -> None:
    assert client.get(path).status_code == 404


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


@pytest.mark.parametrize(
    "headers", [{"host": "evil.example"}, {"host": "localhost:8000", "origin": "http://evil.example"}]
)
def test_mcp_rejects_untrusted_host_and_origin(client: TestClient, headers: dict[str, str]) -> None:
    with client:
        r = client.post("/mcp", json={}, headers={"accept": "application/json, text/event-stream", **headers})
    assert r.status_code in {400, 403, 421}
