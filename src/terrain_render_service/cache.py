"""On-disk tile cache: every tile is generated once, then served from the volume."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from .tiling import TileId


class TileCache:
    """Stores tiles under `<root>/<version>/<z>/<x>/<y>.terrain`."""

    def __init__(self, root: Path, version: str) -> None:
        """Use `root`; bump `version` to invalidate every cached tile."""
        self.root = root / version

    def path(self, tile: TileId) -> Path:
        """Where a tile lives on disk."""
        return self.root / str(tile.z) / str(tile.x) / f"{tile.y}.terrain"

    def get(self, tile: TileId) -> bytes | None:
        """Return the cached tile, if any."""
        path = self.path(tile)
        return path.read_bytes() if path.is_file() else None

    def put(self, tile: TileId, data: bytes) -> None:
        """Write atomically so concurrent readers never see a partial tile."""
        path = self.path(tile)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        Path(tmp).replace(path)
