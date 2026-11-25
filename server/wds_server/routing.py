"""Small helpers to build Starlette routes with per-method handlers, and the shared authentication wrapper."""

from __future__ import annotations

from starlette.routing import Route

from .auth import authenticate_operator, authenticate_slot
from .web import client_ip


def endpoint(path: str, **handlers):
    """endpoint("/x/{id}", GET=get_x, PUT=put_x) → one Route that dispatches on the HTTP method."""
    methods = list(handlers)

    async def dispatch(request):
        return await (handlers.get(request.method) or handlers["GET"])(request)

    return Route(path, dispatch, methods=methods)


def svc_of(request):
    return request.app.state.svc


async def authenticate(request, **kwargs):
    """Slot token → vault/scope state → role → read-only (see auth.authenticate_slot), in a worker thread."""
    svc = svc_of(request)
    ip = client_ip(request)
    header = request.headers.get("authorization")

    def work():
        with svc.db.connection() as conn:
            return authenticate_slot(svc, conn, ip, header, **kwargs)

    return await svc.run(work)


async def authenticate_op(request):
    svc = svc_of(request)
    ip = client_ip(request)
    header = request.headers.get("authorization")
    await svc.run(authenticate_operator, svc, ip, header)
