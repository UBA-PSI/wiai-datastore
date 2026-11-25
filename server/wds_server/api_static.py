"""Static client files under /datastore/client/ (PROTOCOL.md 8.8) and the /datastore redirect."""

from __future__ import annotations

import re

from starlette.responses import RedirectResponse, Response

from .errors import not_found
from .routing import endpoint, svc_of

NAME_RE = re.compile(r"wds-[0-9A-Za-z][0-9A-Za-z.+-]*\.js(\.sri)?")


def _read(path):
    try:
        return path.read_bytes()
    except OSError:
        return None


async def client_file(request):
    svc = svc_of(request)
    name = request.path_params["name"]
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Cache-Control": "public, max-age=31536000, immutable",
    }
    if request.method == "OPTIONS":
        return Response(status_code=204, headers=headers)
    if name == "hashes.json":
        # The published hashes of every library version: wds-verify reads them without a clone of the repository.
        data = await svc.run(_read, svc.client_dir / name)
        if data is None:
            raise not_found("No such file.")
        return Response(data, media_type=None, headers={**headers, "Cache-Control": "no-cache",
                                                         "Content-Type": "application/json"})
    if not NAME_RE.fullmatch(name):
        raise not_found("No such file.")
    data = await svc.run(_read, svc.client_dir / name)
    if data is None:
        raise not_found("No such file.")
    media = "text/plain; charset=utf-8" if name.endswith(".sri") else "text/javascript; charset=utf-8"
    return Response(data, media_type=None, headers={**headers, "Content-Type": media})


async def redirect_root(request):
    return RedirectResponse("/datastore/", status_code=308)


def routes():
    return [
        endpoint("/datastore/client/{name}", GET=client_file, OPTIONS=client_file),
        endpoint("/datastore", GET=redirect_root),
    ]
