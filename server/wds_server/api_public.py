"""Endpoints without a token: scope info, KDF lookup, health (PROTOCOL.md 8.3, 10)."""

from __future__ import annotations

import json

from starlette.responses import Response

from .config import KDF_DEFAULT
from .errors import ApiError, bad_request, not_found, rate_limited
from .routing import endpoint, svc_of
from .sandbox import sandbox_doc
from .validate import valid_access_id
from .pwned import PREFIX_RE
from .web import client_ip, json_response

PREFIX = "/datastore/api/v1"


def scope_doc(svc, row, *, admin: bool = False, conn=None) -> dict:
    limits = svc.scope_limits(row)
    public_limits = {k: limits[k] for k in ("history_versions", "max_envelope_bytes", "max_value_bytes", "vault_bytes")}
    doc = {
        "scope": row["scope_id"],
        "name": row["name"],
        "status": row["status"],
        "enrollment": "open" if svc.is_sandbox(row["scope_id"]) else "join_code",  # only the sandbox is open
        "read_only": svc.read_only(),
        "limits": limits if admin else public_limits,
        "kdf": dict(KDF_DEFAULT),
        "escrow": [{"id": e.key_id, "e_pub": e.e_pub, "s_pub": e.s_pub, "status": e.status} for e in svc.config.escrow],
        "library": {"latest": svc.library_latest(), "deprecated": list(svc.config.library_deprecated)},
        "privacy_url": svc.config.privacy_link,
        "sandbox": sandbox_doc(svc, row["scope_id"], conn),
    }
    if admin:
        doc["join_code"] = row["join_code"]
    return doc


def _get_scope(svc, scope_id):
    with svc.db.connection() as conn:
        row = conn.execute("SELECT * FROM scopes WHERE scope_id=? AND deleted IS NULL", (scope_id,)).fetchone()
        if row is None:
            raise not_found("Unknown scope.")
        return scope_doc(svc, row, conn=conn)


async def get_scope(request):
    svc = svc_of(request)
    return json_response(await svc.run(_get_scope, svc, request.path_params["scope"]))


def _get_kdf(svc, ip, access_id):
    now = svc.now()
    with svc.db.connection() as conn:
        row = conn.execute("SELECT s.kind, s.kdf, s.revoked, v.deleted FROM slots s LEFT JOIN vaults v ON v.vault_id=s.vault_id"
                           " WHERE s.access_id=?", (access_id,)).fetchone()
    if row is not None and row["revoked"] is None:
        # The descriptor is public and the existence of an access ID is not secret (PROTOCOL 2.1), so lookups of
        # existing IDs are never throttled and never counted: one noisy client behind a shared NAT must not stop
        # others from unlocking, and a deleted vault answers 410 without counting as an authentication failure.
        if row["deleted"] is not None:
            raise ApiError(410, "vault_deleted", "This vault has been deleted.")
    else:
        retry = svc.limiter.blocked(ip, access_id, now)
        if retry:
            raise rate_limited(retry)
        svc.limiter.failure(ip, access_id, now)
        raise not_found("Unknown access ID.")
    return {"kind": row["kind"], "kdf": json.loads(row["kdf"])}


async def get_kdf(request):
    svc = svc_of(request)
    access_id = request.path_params["access_id"]
    if not valid_access_id(access_id):
        raise bad_request("Malformed access ID.")
    return json_response(await svc.run(_get_kdf, svc, client_ip(request), access_id))


async def get_pwned(request):
    """Breach check (pwned.py): the answer of the Pwned Passwords range service for a five-character prefix of a SHA-1 hash."""
    svc = svc_of(request)
    prefix = request.path_params["prefix"]
    if not PREFIX_RE.fullmatch(prefix):
        raise bad_request("The prefix is five uppercase hexadecimal characters.")
    retry = svc.limiter.pwned(client_ip(request), svc.now())
    if retry:
        raise rate_limited(retry)
    body = await svc.run(svc.pwned.range, prefix)
    return Response(body, media_type="text/plain; charset=utf-8")


async def healthz(request):
    svc = svc_of(request)

    def check():
        with svc.db.connection() as conn:
            conn.execute("SELECT 1").fetchone()
        return svc.read_only()

    try:
        ro = await svc.run(check)
    except Exception:
        return json_response({"status": "error"}, 503, {"Cache-Control": "no-store"})
    return json_response({"status": "ok", "read_only": ro}, headers={"Cache-Control": "no-store"})


def routes():
    return [
        endpoint(PREFIX + "/scopes/{scope}", GET=get_scope),
        endpoint(PREFIX + "/slots/{access_id}/kdf", GET=get_kdf),
        endpoint(PREFIX + "/pwned/{prefix}", GET=get_pwned),
        endpoint("/datastore/healthz", GET=healthz),
    ]
