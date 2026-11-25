"""Starlette application factory."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from starlette.applications import Starlette
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.responses import JSONResponse

from . import api_admin, api_public, api_records, api_slots, api_static, api_vaults, dashboard, docs
from .config import Config
from .errors import ApiError
from .maintenance import run_maintenance
from .sandbox import ensure_sandbox
from .service import Service

log = logging.getLogger("wds_server")

API_PREFIX = "/datastore/api/"
COMMON_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000",
}
API_HEADERS = {
    **COMMON_HEADERS,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "ETag, Retry-After, WDS-Commit",
}
PREFLIGHT_HEADERS = {
    **API_HEADERS,
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, If-None-Match, WDS-Commit",
    "Access-Control-Max-Age": "600",
}


class ApiMiddleware:
    """Outermost layer: CORS and security headers on API responses, preflight, last-resort 500."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        is_api = scope["path"].startswith(API_PREFIX)
        if is_api and scope["method"] == "OPTIONS":
            headers = [(k.lower().encode(), v.encode()) for k, v in PREFLIGHT_HEADERS.items()]
            headers.append((b"content-length", b"0"))
            await send({"type": "http.response.start", "status": 204, "headers": headers})
            await send({"type": "http.response.body", "body": b""})
            return
        started = False

        async def send_wrapper(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                headers = MutableHeaders(raw=message["headers"]) if isinstance(message.get("headers"), list) else \
                    MutableHeaders(raw=list(message.get("headers", [])))
                message = {**message, "headers": headers.raw}
                if is_api:
                    for k, v in API_HEADERS.items():
                        headers[k] = v
                else:
                    for k, v in COMMON_HEADERS.items():
                        if k.lower() not in headers:
                            headers[k] = v
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            log.exception("unhandled error")
            if started:
                return
            response = JSONResponse({"error": "internal", "message": "Internal server error."}, status_code=500)
            await response(scope, receive, send_wrapper)


async def api_error_handler(request, exc: ApiError):
    return JSONResponse(exc.body(), status_code=exc.status, headers=exc.headers)


async def http_exception_handler(request, exc: HTTPException):
    codes = {400: "bad_request", 404: "not_found", 405: "method_not_allowed"}
    code = codes.get(exc.status_code, "bad_request" if exc.status_code < 500 else "internal")
    messages = {404: "Not found.", 405: "Method not allowed."}
    return JSONResponse({"error": code, "message": messages.get(exc.status_code, str(exc.detail))},
                        status_code=exc.status_code, headers=getattr(exc, "headers", None))


def create_app(config: Config, db_path, *, clock=None, disk_probe=None, service: Service | None = None) -> Starlette:
    svc = service or Service(config, db_path, clock=clock, disk_probe=disk_probe)
    try:
        ensure_sandbox(svc)  # the [sandbox] section owns that scope row; refuses to start on a foreign scope with its ID
    except Exception:
        if service is None:
            svc.close()
        raise

    @asynccontextmanager
    async def lifespan(app):
        task = None
        if svc.config.sweep_interval > 0:
            async def sweeper():
                while True:
                    await asyncio.sleep(svc.config.sweep_interval)
                    try:
                        await svc.run(run_maintenance, svc)
                    except Exception:
                        log.exception("maintenance failed")
            task = asyncio.create_task(sweeper())
        try:
            yield
        finally:
            if task:
                task.cancel()
            svc.close()

    routes = (api_public.routes() + api_vaults.routes() + api_slots.routes() + api_records.routes()
              + api_admin.routes() + api_static.routes() + docs.routes() + dashboard.routes(svc))
    app = Starlette(
        routes=routes,
        middleware=[Middleware(ApiMiddleware)],
        exception_handlers={ApiError: api_error_handler, HTTPException: http_exception_handler},
        lifespan=lifespan,
    )
    app.router.redirect_slashes = False
    app.state.svc = svc
    return app
