"""Slot endpoints with a token (PROTOCOL.md 8.4)."""

from __future__ import annotations

import json

from .auth import reverify
from .db import transaction
from .errors import ApiError, bad_request, sandbox_disabled
from .routing import authenticate, endpoint, svc_of
from .util import b64u_decode, cjson_text, is_int
from .validate import TYPE_SLOT, decode_envelope, valid_b64u, valid_pub, valid_slot_id, validate_kdf
from .web import expect_keys, json_response, parse_if_match_version, read_json

PREFIX = "/datastore/api/v1"


def parse_renewal(obj, *, scope, vault, slot_id, head_version) -> str:
    """Structure of a renewal statement (7.2); signatures are verified by clients only. Returns canonical JSON."""
    if not isinstance(obj, dict) or set(obj) != {"body", "sig"} or not valid_b64u(obj["sig"], 64):
        raise bad_request("renewal must be {body, sig}.")
    body = obj["body"]
    if not isinstance(body, dict) or set(body) != {"e_pub", "rv", "s_pub", "scope", "slot", "type", "v", "vault"}:
        raise bad_request("renewal body has missing or unknown keys.")
    if body["type"] != "renewal" or body["v"] != 1 or not is_int(body["v"]):
        raise bad_request("renewal type or version is wrong.")
    if body["scope"] != scope or body["vault"] != vault or body["slot"] != slot_id:
        raise bad_request("renewal names a different slot, vault or scope.")
    if not valid_pub(body["e_pub"]) or not valid_pub(body["s_pub"]):
        raise bad_request("renewal public keys are malformed.")
    if not is_int(body["rv"]) or not 1 <= body["rv"] <= head_version:
        raise bad_request("renewal rv must be at most the head roster version.")
    try:
        return cjson_text(obj)
    except ValueError:
        raise bad_request("renewal is not canonical JSON.") from None


def _get_slot(svc, auth):
    with svc.db.connection() as conn:
        with transaction(conn, write=False):
            s = conn.execute("SELECT * FROM slots WHERE access_id=?", (auth.access_id,)).fetchone()
            v = conn.execute("SELECT * FROM vaults WHERE vault_id=?", (auth.vault_id,)).fetchone()
            k = conn.execute("SELECT roster_version, entry FROM keyring WHERE vault_id=? AND slot_id=?",
                             (auth.vault_id, s["slot_id"])).fetchone()
            recovery = None
            if s["role"] == "owner":
                r = conn.execute("SELECT * FROM recoveries WHERE vault_id=? AND state='pending' ORDER BY id DESC LIMIT 1",
                                 (auth.vault_id,)).fetchone()
                if r:
                    recovery = {"requested": r["requested"], "ready_at": r["ready_at"]}
    return {
        "access_id": s["access_id"], "slot": s["slot_id"], "vault": s["vault_id"], "scope": v["scope_id"],
        "kind": s["kind"], "role": s["role"], "sv": s["sv"], "kdf": json.loads(s["kdf"]), "wrapped": s["wrapped"],
        "expires": s["expires"] if s["kind"] == "invite" else None,
        "keyring": {"rv": k["roster_version"], "entry": k["entry"]} if k else None,
        "epoch": v["epoch"], "roster": {"version": v["roster_version"], "head": v["head_hash"]},
        "renewal_pending": s["renewal"] is not None, "recovery": recovery,
    }


async def get_slot(request):
    svc = svc_of(request)
    auth = await authenticate(request, access_id=request.path_params["access_id"], allow_unredeemed=True)
    return json_response(await svc.run(_get_slot, svc, auth))


def _check_sv(row, expected):
    if row["sv"] != expected:
        raise ApiError(412, "precondition_failed", "The slot has changed.", extra={"current": row["sv"]})


def _put_slot(svc, auth, expected_sv, kdf_text, token_hash, wrapped):
    with svc.db.connection() as conn:
        with transaction(conn):
            reverify(conn, auth, allow_unredeemed=True)
            row = conn.execute("SELECT * FROM slots WHERE access_id=?", (auth.access_id,)).fetchone()
            if row["kind"] != "passphrase":
                raise ApiError(409, "not_redeemed", "Invite slots must be redeemed first.")
            _check_sv(row, expected_sv)
            conn.execute("UPDATE slots SET kdf=?, token_hash=?, wrapped=?, sv=sv+1 WHERE access_id=?",
                         (kdf_text, token_hash, wrapped, auth.access_id))
            return {"sv": row["sv"] + 1}


async def put_slot(request):
    svc = svc_of(request)
    auth = await authenticate(request, access_id=request.path_params["access_id"], allow_unredeemed=True)
    expected = parse_if_match_version(request)
    body = await read_json(request)
    expect_keys(body, {"kdf", "token_hash", "wrapped"})
    kdf_text = validate_kdf(body["kdf"], kind="passphrase")
    if not valid_b64u(body["token_hash"], 32):
        raise bad_request("token_hash must be 32 bytes in base64url.")
    decode_envelope(body["wrapped"], TYPE_SLOT)
    return json_response(await svc.run(_put_slot, svc, auth, expected, kdf_text, b64u_decode(body["token_hash"], 32),
                                       body["wrapped"]))


def _redeem(svc, auth, kdf_text, token_hash, wrapped, renewal):
    now = svc.now()
    if svc.is_sandbox(auth.scope_id) and not svc.config.sandbox.enabled:
        raise sandbox_disabled()
    with svc.db.connection() as conn:
        with transaction(conn):
            reverify(conn, auth, allow_unredeemed=True)
            row = conn.execute("SELECT * FROM slots WHERE access_id=?", (auth.access_id,)).fetchone()
            if row["kind"] != "invite" or row["redeemed"] is not None:
                raise ApiError(409, "already_redeemed", "This invite has already been redeemed.")
            if row["expires"] is not None and now >= row["expires"]:
                raise ApiError(410, "invite_expired", "This invite has expired.")
            vault = conn.execute("SELECT roster_version FROM vaults WHERE vault_id=?", (auth.vault_id,)).fetchone()
            renewal_text = parse_renewal(renewal, scope=auth.scope_id, vault=auth.vault_id, slot_id=row["slot_id"],
                                         head_version=vault["roster_version"])
            conn.execute(
                "UPDATE slots SET kind='passphrase', kdf=?, token_hash=?, wrapped=?, renewal=?, redeemed=?, sv=sv+1"
                " WHERE access_id=?", (kdf_text, token_hash, wrapped, renewal_text, now, auth.access_id))
            return {"sv": row["sv"] + 1}


async def redeem(request):
    svc = svc_of(request)
    auth = await authenticate(request, access_id=request.path_params["access_id"], allow_unredeemed=True)
    body = await read_json(request)
    expect_keys(body, {"kdf", "token_hash", "wrapped", "renewal"})
    kdf_text = validate_kdf(body["kdf"], kind="passphrase")
    if not valid_b64u(body["token_hash"], 32):
        raise bad_request("token_hash must be 32 bytes in base64url.")
    decode_envelope(body["wrapped"], TYPE_SLOT)
    return json_response(await svc.run(_redeem, svc, auth, kdf_text, b64u_decode(body["token_hash"], 32), body["wrapped"],
                                       body["renewal"]))


def routes():
    s = PREFIX + "/slots/{access_id}"
    return [
        endpoint(s, GET=get_slot, PUT=put_slot),
        endpoint(s + "/redeem", POST=redeem),
    ]
