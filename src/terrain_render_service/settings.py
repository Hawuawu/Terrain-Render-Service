"""Runtime configuration from `TERRAIN_*` environment variables."""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Service settings; defaults suit the K8S-Homelab deployment."""

    model_config = SettingsConfigDict(env_prefix="TERRAIN_")

    cache_dir: Path = Path("/data/cache")
    web_dir: Path = Path(__file__).resolve().parents[2] / "web" / "dist"
    cache_version: str = "v2"
    glo30_url: str = "https://copernicus-dem-30m.s3.amazonaws.com"
    glo90_url: str = "https://copernicus-dem-90m.s3.amazonaws.com"
    terrarium_url: str = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"
    coarse_from_zoom: int = 5
    fine_from_zoom: int = 9
    max_zoom: int = 14
    allowed_hosts: list[str] = ["localhost:*", "127.0.0.1:*", "terrain.localhost:*"]
