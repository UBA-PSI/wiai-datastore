"""Operator API (PROTOCOL.md 9). Every call is written to the audit table."""

from __future__ import annotations

import json

from .api_public import scope_doc
from .db import transaction
from .errors import ApiError, bad_request, not_found, read_only, rate_limited, sandbox_no_recovery
from .roster import apply_roster, parse_keyring, parse_new_slots, parse_roster
from .routing import authenticate_op, endpoint, svc_of
from .scopes import create_scope, patch_scope
from .service import RECOVERY_WAIT
from .util import b32c_decode, b64u_encode, sha256
from .validate import valid_vault_id
from .web import client_ip, expect_keys, json_response, read_json
import hmac

PREFIX = "/datastore/api/v1/admin"


def _create_scope(svc, body):
    expect_keys(body, {"slug", "name"}, {"join_code", "limits"})
    if svc.read_only():
        raise read_only()
    with svc.db.connection() as conn:
        with transaction(conn):
            row = create_scope(svc, conn, slug=body["slug"], name=body["name"], join_code=body.get("join_code"),
                               limits=body.get("limits"))
            svc.audit(conn, "operator", "scope_created", row["scope_id"])
            return scope_doc(svc, row, admin=True)


async def post_scope(request):
    svc = svc_of(request)
    await authenticate_op(request)
    body = await read_json(request)
    return json_response(await svc.run(_create_scope, svc, body), 201)


def _patch_scope(svc, scope_id, body):
    expect_keys(body, set(), {"status", "join_code", "limits", "name"})
    with svc.db.connection() as conn:
        with transaction(conn):
            row = patch_scope(svc, conn, scope_id, body)
            svc.audit(conn, "operator", "scope_updated", scope_id, None, ",".join(sorted(body)))
            return scope_doc(svc, row, admin=True)


async def patch_scope_handler(request):
    svc = svc_of(request)
    await authenticate_op(request)
    body = await read_json(request)
    return json_response(await svc.run(_patch_scope, svc, request.path_params["scope"], body))


def _audit_failure(svc, action, vault_id, err):
    """Operator calls that fail are audited too: their transaction rolled back, so the row goes in its own."""
    try:
        with svc.db.connection() as conn:
            with transaction(conn):
                scope_id = None
                if valid_vault_id(vault_id):
                    row = conn.execute("SELECT scope_id FROM vaults WHERE vault_id=?", (vault_id,)).fetchone()
                    scope_id = row["scope_id"] if row else None
                    svc.audit(conn, "operator", action, scope_id, vault_id, err.code)
                else:
                    svc.audit(conn, "operator", action, None, None, err.code)
    except Exception:
        pass  # never hide the original error


async def _audited(svc, action, vault_id, fn, *args):
    try:
        return await svc.run(fn, svc, *args)
    except ApiError as err:
        await svc.run(_audit_failure, svc, action, vault_id, err)
        raise


def _vault_row(conn, vault_id):
    if not valid_vault_id(vault_id):
        raise bad_request("Malformed vault ID.")
    row = conn.execute("SELECT * FROM vaults WHERE vault_id=?", (vault_id,)).fetchone()
    if row is None:
        raise not_found("Unknown vault.")
    return row


def _no_sandbox(svc, vault_row):
    """Vaults of the sandbox have no recovery: the faculty key is not used there (PLAN 17)."""
    if svc.is_sandbox(vault_row["scope_id"]):
        raise sandbox_no_recovery()


def _pending(conn, vault_id):
    return conn.execute("SELECT * FROM recoveries WHERE vault_id=? AND state='pending' ORDER BY id DESC LIMIT 1",
                        (vault_id,)).fetchone()


def _recovery_doc(r):
    return {"requested": r["requested"], "ready_at": r["ready_at"]} if r else None


def _get_vault(svc, vault_id):
    with svc.db.connection() as conn:
        with transaction(conn):
            v = _vault_row(conn, vault_id)
            svc.audit(conn, "operator", "vault_status", v["scope_id"], vault_id)
            return {"vault": vault_id, "scope": v["scope_id"], "created": v["created"], "deleted": v["deleted"],
                    "epoch": v["epoch"], "roster_version": v["roster_version"], "bytes": v["bytes"],
                    "recovery": _recovery_doc(_pending(conn, vault_id))}


async def get_vault(request):
    svc = svc_of(request)
    await authenticate_op(request)
    vault_id = request.path_params["vault"]
    return json_response(await _audited(svc, "vault_status_failed", vault_id, _get_vault, vault_id))


def _recovery_start(svc, ip, vault_id, body):
    expect_keys(body, {"recovery_code"})
    try:
        code_bytes = b32c_decode(body["recovery_code"], 17)
    except ValueError:
        raise bad_request("Malformed recovery code.") from None
    now = svc.now()
    with svc.db.connection() as conn:
        with transaction(conn):
            v = _vault_row(conn, vault_id)
            _no_sandbox(svc, v)
            if v["deleted"] is not None:
                raise ApiError(410, "vault_deleted", "This vault has been deleted.")
            retry = svc.limiter.blocked(ip, None, now)
            if retry:
                raise rate_limited(retry)
            if not hmac.compare_digest(b64u_encode(sha256(code_bytes)).encode(), v["recovery_hash"].encode()):
                svc.limiter.failure(ip, None, now)
                raise ApiError(403, "recovery_code_invalid", "The emergency code is wrong.")
            if _pending(conn, vault_id):
                raise ApiError(409, "recovery_pending", "A recovery is already pending.")
            ready = now + RECOVERY_WAIT
            conn.execute("INSERT INTO recoveries (vault_id, requested, ready_at, state) VALUES (?,?,?,'pending')",
                         (vault_id, now, ready))
            svc.audit(conn, "operator", "recovery_started", v["scope_id"], vault_id)
            return {"requested": now, "ready_at": ready}


async def start_recovery(request):
    svc = svc_of(request)
    await authenticate_op(request)
    body = await read_json(request)
    vault_id = request.path_params["vault"]
    return json_response(await _audited(svc, "recovery_start_failed", vault_id, _recovery_start, client_ip(request),
                                        vault_id, body), 201)


def _recovery_cancel(svc, vault_id):
    now = svc.now()
    with svc.db.connection() as conn:
        with transaction(conn):
            v = _vault_row(conn, vault_id)
            _no_sandbox(svc, v)
            n = conn.execute("UPDATE recoveries SET state='cancelled', finished=? WHERE vault_id=? AND state='pending'",
                             (now, vault_id)).rowcount
            if not n:
                raise not_found("No recovery is pending.")
            svc.audit(conn, "operator", "recovery_cancelled", v["scope_id"], vault_id)
    return {"cancelled": True}


async def cancel_recovery(request):
    svc = svc_of(request)
    await authenticate_op(request)
    vault_id = request.path_params["vault"]
    return json_response(await _audited(svc, "recovery_cancel_failed", vault_id, _recovery_cancel, vault_id))


def _ready_recovery(svc, conn, vault_id):
    r = _pending(conn, vault_id)
    if r is None or svc.now() < r["ready_at"]:
        raise ApiError(409, "recovery_not_ready", "No recovery is ready.")
    return r


def _escrow(svc, vault_id):
    with svc.db.connection() as conn:
        with transaction(conn):
            v = _vault_row(conn, vault_id)
            _no_sandbox(svc, v)
            if v["deleted"] is not None:
                raise ApiError(410, "vault_deleted", "This vault has been deleted.")
            _ready_recovery(svc, conn, vault_id)
            versions = [{"body": json.loads(r["body"]), "sig": r["sig"]} for r in conn.execute(
                "SELECT body, sig FROM rosters WHERE vault_id=? ORDER BY version", (vault_id,))]
            k = conn.execute("SELECT entry FROM keyring WHERE vault_id=? AND slot_id=?", (vault_id, v["escrow_slot"])).fetchone()
            svc.audit(conn, "operator", "escrow_fetched", v["scope_id"], vault_id)
            return {"vault": vault_id, "scope": v["scope_id"], "epoch": v["epoch"],
                    "roster": {"head": v["roster_version"], "head_hash": v["head_hash"], "versions": versions},
                    "escrow_slot": v["escrow_slot"], "keyring_entry": k["entry"]}


async def get_escrow(request):
    svc = svc_of(request)
    await authenticate_op(request)
    vault_id = request.path_params["vault"]
    return json_response(await _audited(svc, "escrow_fetch_failed", vault_id, _escrow, vault_id))


def _complete(svc, vault_id, body):
    expect_keys(body, {"roster", "keyring"}, {"new_slots"})
    now = svc.now()
    with svc.db.connection() as conn:
        with transaction(conn):
            v = _vault_row(conn, vault_id)
            _no_sandbox(svc, v)
            if v["deleted"] is not None:
                raise ApiError(410, "vault_deleted", "This vault has been deleted.")
            rec = _ready_recovery(svc, conn, vault_id)
            roster = parse_roster(body["roster"], scope=v["scope_id"], vault=vault_id, escrow_sets=svc.escrow_by_pubs)
            keyring = parse_keyring(body["keyring"], roster)
            new_slots = parse_new_slots(body.get("new_slots", []))
            apply_roster(svc, conn, v, roster, keyring, new_slots, mode="recovery", now=now)
            conn.execute("UPDATE recoveries SET state='completed', finished=? WHERE id=?", (now, rec["id"]))
            svc.audit(conn, "operator", "recovery_completed", v["scope_id"], vault_id, f"version={roster.version}")
            return {"version": roster.version, "head": roster.hash, "epoch": roster.epoch}


async def complete_recovery(request):
    svc = svc_of(request)
    await authenticate_op(request)
    body = await read_json(request)
    vault_id = request.path_params["vault"]
    return json_response(await _audited(svc, "recovery_complete_failed", vault_id, _complete, vault_id, body))


def routes():
    v = PREFIX + "/vaults/{vault}"
    return [
        endpoint(PREFIX + "/scopes", POST=post_scope),
        endpoint(PREFIX + "/scopes/{scope}", PATCH=patch_scope_handler),
        endpoint(v, GET=get_vault),
        endpoint(v + "/recovery", POST=start_recovery, DELETE=cancel_recovery),
        endpoint(v + "/escrow", GET=get_escrow),
        endpoint(v + "/recovery/complete", POST=complete_recovery),
    ]
