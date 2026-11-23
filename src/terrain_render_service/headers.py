"""ASGI middleware: browser security headers and sub-app dispatch."""

from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send

OSM_TILES = "https://tile.openstreetmap.org"
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; "
    f"style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: {OSM_TILES}; connect-src 'self' {OSM_TILES}; "
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
)
SECURITY_HEADERS = {
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    # OSM tile policy requires a Referer; send only the origin cross-site.
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
}


class SecurityHeadersMiddleware:
    """Pure ASGI middleware, so streamed MCP responses pass through untouched."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap `app`."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Append the headers to the `http.response.start` message."""
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers += [(k.encode(), v.encode()) for k, v in SECURITY_HEADERS.items()]
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_headers)


class PathDispatchMiddleware:
    """Send requests under `prefix` to `target` with the path unchanged; everything else to the wrapped app."""

    def __init__(self, app: ASGIApp, prefix: str, target: ASGIApp) -> None:
        """Wrap `app`."""
        self.app = app
        self.prefix = prefix
        self.target = target

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Route by path prefix."""
        path = scope.get("path", "")
        if scope["type"] == "http" and (path == self.prefix or path.startswith(self.prefix + "/")):
            await self.target(scope, receive, send)
            return
        await self.app(scope, receive, send)
