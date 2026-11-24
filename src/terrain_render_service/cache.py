"""On-disk cache: every generated tile or area is built once, then served from the volume."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path, PurePosixPath


class TileCache:
    """Stores blobs under `<root>/<version>/<key>`, e.g. `relief/3/4/2.png`."""

    def __init__(self, root: Path, version: str) -> None:
        """Use `root`; bump `version` to invalidate everything cached."""
        self.root = root / version

    def path(self, key: str) -> Path:
        """Where `key` lives on disk; keys are relative POSIX paths without `..`."""
        rel = PurePosixPath(key)
        if rel.is_absolute() or ".." in rel.parts:
            msg = f"invalid cache key {key!r}"
            raise ValueError(msg)
        return self.root.joinpath(*rel.parts)

    def get(self, key: str) -> bytes | None:
        """Return the cached blob, if any."""
        path = self.path(key)
        return path.read_bytes() if path.is_file() else None

    def put(self, key: str, data: bytes) -> None:
        """Write atomically so concurrent readers never see a partial blob."""
        path = self.path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        Path(tmp).replace(path)
