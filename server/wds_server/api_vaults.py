"""Vault creation, roster, usage, recovery cancellation and vault deletion (PROTOCOL.md 8.3, 8.5)."""

from __future__ import annotations

import hmac
import json

from .auth import reverify
from .db import transaction
from .errors import ApiError, bad_request, forbidden, not_found, rate_limited, read_only, sandbox_busy, sandbox_disabled
from .roster import apply_roster, parse_keyring, parse_new_slots, parse_roster, store_keyring
from .purge import purge_vault
from .routing import authenticate, endpoint, svc_of
from .sandbox import evict_until
from .scopes import soft_delete_vault
from .service import DELETED_VAULT_TTL
from .util import b64u_decode
from .validate import (TYPE_SLOT, decode_envelope, normalise_join_code, valid_access_id, valid_b64u, valid_scope_id,
                       valid_vault_id, validate_kdf, validate_recovery_contact)
from .web import client_ip, expect_keys, json_response, query_int, read_json

PREFIX = "/datastore/api/v1"


# --- create vault -------------------------------------------------------------------------------------------------


def _scope_for_create(svc, scope_id):
    with svc.db.connection() as conn:
        row = conn.execute("SELECT * FROM scopes WHERE scope_id=? AND deleted IS NULL", (scope_id,)).fetchone()
    if row is None:
        raise not_found("Unknown scope.")
    if svc.is_sandbox(scope_id) and not svc.config.sandbox.enabled:
        raise sandbox_disabled()
    if row["status"] != "active":
        raise ApiError(403, "scope_suspended", "This scope is suspended.")
    if svc.read_only():
        raise read_only()
    if row["enrollment"] == "closed":
        raise ApiError(403, "enrollment_closed", "This scope does not accept new vaults.")


def _create_vault(svc, ip, scope_id, body):
    expect_keys(body, {"vault", "roster", "slots", "keyring", "recovery_hash"}, {"recovery_contact", "join_code"})
    vault = body["vault"]
    if not valid_vault_id(vault):
        raise bad_request("Malformed vault ID.")
    escrow_sets = svc.escrow_by_pubs
    roster = parse_roster(body["roster"], scope=scope_id, vault=vault, escrow_sets=escrow_sets)
    if roster.version != 1:
        raise ApiError(400, "invalid_roster", "Vault creation needs roster version 1.", extra={"detail": "version must be 1"})
    slots = body["slots"]
    if not isinstance(slots, list) or len(slots) != 1 or not isinstance(slots[0], dict):
        raise bad_request("slots must hold exactly the founder slot.")
    s = slots[0]
    expect_keys(s, {"slot", "access_id", "kdf", "token_hash", "wrapped"})
    if s["slot"] != roster.signer:
        raise bad_request("slots must hold exactly the founder slot.")
    if not valid_access_id(s["access_id"]):
        raise bad_request("Malformed access ID.")
    if not valid_b64u(s["token_hash"], 32):
        raise bad_request("token_hash must be 32 bytes in base64url.")
    kdf_text = validate_kdf(s["kdf"], kind="passphrase")
    decode_envelope(s["wrapped"], TYPE_SLOT)
    keyring = parse_keyring(body["keyring"], roster)
    if not valid_b64u(body["recovery_hash"], 32):
        raise bad_request("recovery_hash must be 32 bytes in base64url.")
    contact = validate_recovery_contact(body.get("recovery_contact"))
    sandbox = svc.is_sandbox(scope_id)
    if sandbox:
        contact = None  # accepted and discarded: the sandbox has no recovery
    join_code = body.get("join_code")
    if join_code is not None and not isinstance(join_code, str):
        raise bad_request("join_code must be a string or null.")

    now = svc.now()
    with svc.db.connection() as conn:
        with transaction(conn):
            scope = conn.execute("SELECT * FROM scopes WHERE scope_id=? AND deleted IS NULL", (scope_id,)).fetchone()
            if scope is None:
                raise not_found("Unknown scope.")
            if sandbox and not svc.config.sandbox.enabled:
                raise sandbox_disabled()
            if scope["status"] != "active":
                raise ApiError(403, "scope_suspended", "This scope is suspended.")
            if scope["enrollment"] == "closed":
                raise ApiError(403, "enrollment_closed", "This scope does not accept new vaults.")
            if scope["enrollment"] == "join_code":
                retry = svc.limiter.blocked(ip, None, now)
                if retry:
                    raise rate_limited(retry)
                expected = (scope["join_code"] or "").encode("ascii", "replace")
                given = normalise_join_code(join_code or "").encode("ascii", "replace")
                if not scope["join_code"] or not hmac.compare_digest(expected, given):
                    svc.limiter.failure(ip, None, now)
                    raise ApiError(403, "join_code_invalid", "The join code is wrong.")
            limits = svc.scope_limits(scope)
            roster_size = len(roster.canonical) + len(roster.sig) + len(s["wrapped"])

            def active_vaults():
                return conn.execute("SELECT COUNT(*) FROM vaults WHERE scope_id=? AND deleted IS NULL", (scope_id,)).fetchone()[0]

            def scope_bytes():
                return conn.execute("SELECT COALESCE(SUM(bytes + roster_bytes),0) FROM vaults WHERE scope_id=?",
                                    (scope_id,)).fetchone()[0]

            if sandbox:
                # a full sandbox makes room (oldest vaults first, never young ones) instead of turning people away
                fits = evict_until(svc, conn, scope_id, lambda: active_vaults() < limits["max_vaults"]
                                   and scope_bytes() + roster_size <= limits["scope_bytes"])
                if not fits:
                    raise ApiError(403, "vault_limit_reached", "The sandbox is full; try again later.")
            elif active_vaults() >= limits["max_vaults"]:
                raise ApiError(403, "vault_limit_reached", "This scope has reached its vault limit.")
            if conn.execute("SELECT 1 FROM vaults WHERE vault_id=?", (vault,)).fetchone():
                raise ApiError(409, "vault_exists", "This vault ID is already in use.")
            if conn.execute("SELECT 1 FROM access_ids WHERE access_id=?", (s["access_id"],)).fetchone():
                raise ApiError(409, "access_id_taken", "This access ID is already in use.")
            escrow_slot = roster.escrow_slot
            conn.execute(
                "INSERT INTO vaults (vault_id, scope_id, created, epoch, roster_version, head_hash, escrow_slot, recovery_hash,"
                " recovery_contact, roster_bytes) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (vault, scope_id, now, 1, 1, roster.hash, escrow_slot, body["recovery_hash"], contact, roster_size))
            conn.execute("INSERT INTO access_ids (access_id) VALUES (?)", (s["access_id"],))
            conn.execute("INSERT INTO rosters (vault_id, version, body, sig, hash, created) VALUES (?,?,?,?,?,?)",
                         (vault, 1, roster.canonical.decode("ascii"), roster.sig, roster.hash, now))
            for sid in roster.slots:
                conn.execute("INSERT INTO slot_ids (vault_id, slot_id) VALUES (?,?)", (vault, sid))
            conn.execute(
                "INSERT INTO slots (access_id, vault_id, slot_id, kind, role, kdf, token_hash, wrapped, sv, created)"
                " VALUES (?,?,?,?,?,?,?,?,1,?)",
                (s["access_id"], vault, s["slot"], "passphrase", "owner", kdf_text, b64u_decode(s["token_hash"], 32),
                 s["wrapped"], now))
            store_keyring(conn, vault, 1, keyring)
            svc.audit(conn, "slot", "vault_created", scope_id, vault)
    return {"vault": vault, "epoch": 1, "roster_version": 1, "head": roster.hash}


async def create_vault(request):
    svc = svc_of(request)
    scope_id = request.path_params["scope"]
    ip = client_ip(request)
    if not valid_scope_id(scope_id):
        raise not_found("Unknown scope.")
    await svc.run(_scope_for_create, svc, scope_id)
    body = await read_json(request)
    retry = svc.limiter.creation(ip, svc.now())
    if retry:
        raise rate_limited(retry)
    if svc.is_sandbox(scope_id):
        retry, busy = svc.limiter.sandbox_creation(ip, svc.now())
        if retry:
            raise rate_limited(retry)
        if busy:
            raise sandbox_busy(busy)
    return json_response(await svc.run(_create_vault, svc, ip, scope_id, body), 201)


# --- roster ---------------------------------------------------------------------------------------------------------


def roster_slot_state(conn, vault_id, now):
    out = {}
    for r in conn.execute("SELECT * FROM slots WHERE vault_id=? AND revoked IS NULL", (vault_id,)):
        expired = (r["kind"] == "invite" and r["redeemed"] is None and r["expires"] is not None and now >= r["expires"])
        out[r["slot_id"]] = {"used": bool(r["used"]), "redeemed": r["redeemed"], "expired": expired,
                             "renewal": json.loads(r["renewal"]) if r["renewal"] else None}
    return out


def _get_roster(svc, auth, since):
    with svc.db.connection() as conn:
        with transaction(conn, write=False):
            v = conn.execute("SELECT * FROM vaults WHERE vault_id=?", (auth.vault_id,)).fetchone()
            versions = [{"body": json.loads(r["body"]), "sig": r["sig"]} for r in conn.execute(
                "SELECT body, sig FROM rosters WHERE vault_id=? AND version>? ORDER BY version", (auth.vault_id, since))]
            return {"head": v["roster_version"], "head_hash": v["head_hash"], "epoch": v["epoch"], "versions": versions,
                    "slots": roster_slot_state(conn, auth.vault_id, svc.now())}


async def get_roster(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"], allow_unredeemed=True)  # redeem flow, 11
    since = query_int(request, "since", 0, 0, 2**31)
    return json_response(await svc.run(_get_roster, svc, auth, since))


def _post_roster(svc, auth, body):
    expect_keys(body, {"roster", "keyring"}, {"new_slots"})
    roster = parse_roster(body["roster"], scope=auth.scope_id, vault=auth.vault_id, escrow_sets=svc.escrow_by_pubs)
    keyring = parse_keyring(body["keyring"], roster)
    new_slots = parse_new_slots(body.get("new_slots", []))
    if new_slots and svc.read_only():
        raise read_only()
    now = svc.now()
    with svc.db.connection() as conn:
        with transaction(conn):
            reverify(conn, auth, ("owner",))
            vrow = conn.execute("SELECT * FROM vaults WHERE vault_id=?", (auth.vault_id,)).fetchone()
            change = apply_roster(svc, conn, vrow, roster, keyring, new_slots, mode="owner", now=now)
            action = "revocation" if change["removed"] and change["bump"] else "roster_updated"
            svc.audit(conn, "slot", action, auth.scope_id, auth.vault_id, f"version={roster.version}")
    return {"version": roster.version, "head": roster.hash, "epoch": roster.epoch}


async def post_roster(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"], roles=("owner",))
    body = await read_json(request)
    return json_response(await svc.run(_post_roster, svc, auth, body))


# --- usage, deletion, recovery cancel ----------------------------------------------------------------------------------


def _usage(svc, auth):
    with svc.db.connection() as conn:
        with transaction(conn, write=False):
            v = conn.execute("SELECT bytes, epoch, scope_id FROM vaults WHERE vault_id=?", (auth.vault_id,)).fetchone()
            scope = conn.execute("SELECT * FROM scopes WHERE scope_id=?", (v["scope_id"],)).fetchone()
            records = conn.execute(
                "SELECT COUNT(*) FROM records r JOIN record_versions rv ON rv.vault_id=r.vault_id AND rv.record_id=r.record_id"
                " AND rv.version=r.latest WHERE r.vault_id=? AND rv.deleted=0", (auth.vault_id,)).fetchone()[0]
            versions = conn.execute("SELECT COUNT(*) FROM record_versions WHERE vault_id=?", (auth.vault_id,)).fetchone()[0]
            old = conn.execute("SELECT COUNT(*) FROM record_versions WHERE vault_id=? AND epoch IS NOT NULL AND epoch<?",
                               (auth.vault_id, v["epoch"])).fetchone()[0]
            limits = svc.scope_limits(scope)
    return {"bytes": v["bytes"], "records": records, "versions": versions, "old_epoch_blobs": old,
            "read_only": svc.read_only(),
            "limits": {k: limits[k] for k in ("history_versions", "max_envelope_bytes", "max_value_bytes", "vault_bytes")}}


async def get_usage(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"])
    return json_response(await svc.run(_usage, svc, auth))


def _delete_vault(svc, auth, ip):
    now = svc.now()
    with svc.db.connection() as conn:
        with transaction(conn):
            reverify(conn, auth, ("owner",))
            if svc.is_sandbox(auth.scope_id):  # nothing to keep for 30 days: the vault goes now and frees count and bytes
                row = conn.execute("SELECT created FROM vaults WHERE vault_id=?", (auth.vault_id,)).fetchone()
                purge_vault(svc, conn, auth.vault_id, "owner", "vault_deleted")
                if row is not None and now - row["created"] < svc.config.sandbox.create_window:
                    svc.limiter.sandbox_refund(ip, now)  # a verifier run that cleans up after itself does not use up the budget
                return {"deleted": now, "purge_after": now}
            soft_delete_vault(svc, conn, auth.vault_id, auth.scope_id, "slot", now)
    return {"deleted": now, "purge_after": now + DELETED_VAULT_TTL}


async def delete_vault(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"], roles=("owner",))
    return json_response(await svc.run(_delete_vault, svc, auth, client_ip(request)))


def _cancel_recovery(svc, auth):
    now = svc.now()
    with svc.db.connection() as conn:
        with transaction(conn):
            reverify(conn, auth, ("owner",))
            n = conn.execute("UPDATE recoveries SET state='cancelled', finished=? WHERE vault_id=? AND state='pending'",
                             (now, auth.vault_id)).rowcount
            if not n:
                raise not_found("No recovery is pending.")
            svc.audit(conn, "slot", "recovery_cancelled", auth.scope_id, auth.vault_id)
    return {"cancelled": True}


async def cancel_recovery(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"], roles=("owner",))
    return json_response(await svc.run(_cancel_recovery, svc, auth))


def routes():
    v = PREFIX + "/vaults/{vault}"
    return [
        endpoint(PREFIX + "/scopes/{scope}/vaults", POST=create_vault),
        endpoint(v, DELETE=delete_vault),
        endpoint(v + "/roster", GET=get_roster, POST=post_roster),
        endpoint(v + "/usage", GET=get_usage),
        endpoint(v + "/recovery", DELETE=cancel_recovery),
    ]
