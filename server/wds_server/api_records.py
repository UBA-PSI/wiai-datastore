"""Record endpoints: CAS writes, history, tombstones, rekey (PROTOCOL.md 5, 8.5)."""

from __future__ import annotations

import re

from starlette.responses import Response

from .auth import reverify
from .db import transaction
from .errors import ApiError, bad_request, not_found
from .routing import authenticate, endpoint, svc_of
from .sandbox import evict_until
from .service import HISTORY_FLOOR_SECONDS
from .util import b64u_decode, b64u_encode
from .validate import TYPE_RECORD, check_envelope, envelope_epoch, valid_record_id
from .web import (content_length, json_response, parse_commit_header, parse_if_match_epoch, parse_if_match_version,
                  parse_preconditions, query_int, read_body, require_octet_type)

PREFIX = "/datastore/api/v1"
VERSION_RE = re.compile(r"[1-9][0-9]{0,15}")
WRITERS = ("owner", "write")


def prune_record(conn, vault_id: str, record_id: str, keep: int, now: int) -> int:
    """Drop versions beyond the newest `keep`, except those younger than the floor. Returns freed bytes."""
    rows = conn.execute("SELECT version, size, created FROM record_versions WHERE vault_id=? AND record_id=?"
                        " ORDER BY version DESC", (vault_id, record_id)).fetchall()
    freed = 0
    for r in rows[keep:]:
        if r["created"] > now - HISTORY_FLOOR_SECONDS:
            continue
        conn.execute("DELETE FROM record_versions WHERE vault_id=? AND record_id=? AND version=?",
                     (vault_id, record_id, r["version"]))
        freed += r["size"]
    return freed


def check_rid(rid: str) -> None:
    if not valid_record_id(rid):
        raise bad_request("Malformed record ID.")


def check_version(text: str) -> int:
    if not VERSION_RE.fullmatch(text):
        raise bad_request("Malformed version.")
    return int(text)


def blob_response(row, version: int, status: int = 200) -> Response:
    return Response(bytes(row["blob"]), status_code=status, media_type="application/octet-stream",
                    headers={"ETag": f'"{version}"', "WDS-Commit": row["commit_mac"] or ""})


# --- list / read ---------------------------------------------------------------------------------------------------------


def _list_records(svc, auth, after, limit):
    with svc.db.connection() as conn:
        with transaction(conn, write=False):
            rows = conn.execute(
                "SELECT r.record_id, r.latest, r.updated, r.deleted, rv.epoch, rv.size FROM records r"
                " JOIN record_versions rv ON rv.vault_id=r.vault_id AND rv.record_id=r.record_id AND rv.version=r.latest"
                " WHERE r.vault_id=? AND r.record_id>? ORDER BY r.record_id LIMIT ?",
                (auth.vault_id, after, limit + 1)).fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    records = [{"id": r["record_id"], "version": r["latest"], "epoch": None if r["deleted"] else r["epoch"],
                "size": 0 if r["deleted"] else r["size"], "updated": r["updated"], "deleted": bool(r["deleted"])} for r in rows]
    return {"records": records, "next": rows[-1]["record_id"] if more and rows else None}


async def list_records(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"])
    after = request.query_params.get("after", "")
    if after:
        check_rid(after)
    limit = query_int(request, "limit", 1000, 1, 1000)
    return json_response(await svc.run(_list_records, svc, auth, after, limit))


def _get_record(svc, auth, rid):
    with svc.db.connection() as conn:
        with transaction(conn, write=False):
            rec = conn.execute("SELECT latest, deleted FROM records WHERE vault_id=? AND record_id=?",
                               (auth.vault_id, rid)).fetchone()
            if rec is None:
                raise not_found("No such record.")
            if rec["deleted"]:
                raise ApiError(404, "deleted", "The record has been deleted.", extra={"version": rec["latest"]})
            row = conn.execute("SELECT blob, commit_mac FROM record_versions WHERE vault_id=? AND record_id=? AND version=?",
                               (auth.vault_id, rid, rec["latest"])).fetchone()
            return rec["latest"], row


async def get_record(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"])
    rid = request.path_params["rid"]
    check_rid(rid)
    version, row = await svc.run(_get_record, svc, auth, rid)
    return blob_response(row, version)


# --- write ------------------------------------------------------------------------------------------------------------------


def _current(rec):
    return {"current": rec["latest"] if rec else None, "deleted": bool(rec["deleted"]) if rec else False}


def _precondition_failed(rec, extra=None):
    return ApiError(412, "precondition_failed", "The record has changed.", extra=_current(rec))


def _put_record(svc, auth, rid, mode, expected, raw, commit):
    now = svc.now()
    size = len(raw)
    with svc.db.connection() as conn:
        with transaction(conn):
            reverify(conn, auth, WRITERS)
            vault = conn.execute("SELECT * FROM vaults WHERE vault_id=?", (auth.vault_id,)).fetchone()
            limits = auth.limits
            if envelope_epoch(raw) != vault["epoch"]:
                raise ApiError(409, "epoch_changed", "The vault epoch has changed.", extra={"epoch": vault["epoch"]})
            rec = conn.execute("SELECT latest, deleted FROM records WHERE vault_id=? AND record_id=?",
                               (auth.vault_id, rid)).fetchone()
            if mode == "none-match":
                if rec is not None:
                    raise _precondition_failed(rec)
                version = 1
            else:
                if rec is None or rec["latest"] != expected:
                    raise _precondition_failed(rec)
                version = rec["latest"] + 1
            conn.execute(
                "INSERT INTO record_versions (vault_id, record_id, version, epoch, size, created, deleted, commit_mac, blob)"
                " VALUES (?,?,?,?,?,?,0,?,?)", (auth.vault_id, rid, version, vault["epoch"], size, now, commit, raw))
            if rec is None:
                conn.execute("INSERT INTO records (vault_id, record_id, latest, updated, deleted) VALUES (?,?,?,?,0)",
                             (auth.vault_id, rid, version, now))
            else:
                conn.execute("UPDATE records SET latest=?, updated=?, deleted=0 WHERE vault_id=? AND record_id=?",
                             (version, now, auth.vault_id, rid))
            freed = prune_record(conn, auth.vault_id, rid, limits["history_versions"], now)
            total = vault["bytes"] + size - freed
            conn.execute("UPDATE vaults SET bytes=?, last_write=? WHERE vault_id=?", (total, now, auth.vault_id))
            # Roster history counts like record bytes (PROTOCOL 7.1), as it does for POST /roster.
            if total + vault["roster_bytes"] > limits["vault_bytes"]:
                raise ApiError(507, "quota_exceeded", "The vault quota is exhausted.", extra={"limit": "vault_bytes"})
            def scope_total():
                return conn.execute("SELECT COALESCE(SUM(bytes + roster_bytes),0) FROM vaults WHERE scope_id=?",
                                    (auth.scope_id,)).fetchone()[0]

            fits = scope_total() <= limits["scope_bytes"]
            if not fits and svc.is_sandbox(auth.scope_id):  # the sandbox makes room by evicting its oldest vaults
                fits = evict_until(svc, conn, auth.scope_id, lambda: scope_total() <= limits["scope_bytes"],
                                   exclude=auth.vault_id)
            if not fits:
                raise ApiError(507, "quota_exceeded", "The scope quota is exhausted.", extra={"limit": "scope_bytes"})
            return version, vault["epoch"], size


async def put_record(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"], roles=WRITERS, mutates=True,
                              blocks_suspended=True)
    rid = request.path_params["rid"]
    check_rid(rid)
    mode, expected = parse_preconditions(request)
    commit = parse_commit_header(request)
    require_octet_type(request)
    maximum = auth.limits["max_envelope_bytes"]
    declared = content_length(request, maximum)
    raw = await read_body(request, declared, maximum)
    check_envelope(raw, TYPE_RECORD, maximum)
    version, epoch, size = await svc.run(_put_record, svc, auth, rid, mode, expected, raw, commit)
    return json_response({"version": version, "epoch": epoch, "size": size}, 201 if version == 1 else 200,
                         {"ETag": f'"{version}"'})


def _delete_record(svc, auth, rid, expected):
    now = svc.now()
    with svc.db.connection() as conn:
        with transaction(conn):
            reverify(conn, auth, WRITERS)
            rec = conn.execute("SELECT latest, deleted FROM records WHERE vault_id=? AND record_id=?",
                               (auth.vault_id, rid)).fetchone()
            if rec is None or rec["latest"] != expected or rec["deleted"]:
                raise _precondition_failed(rec)
            version = rec["latest"] + 1
            conn.execute("INSERT INTO record_versions (vault_id, record_id, version, epoch, size, created, deleted)"
                         " VALUES (?,?,?,NULL,0,?,1)", (auth.vault_id, rid, version, now))
            conn.execute("UPDATE records SET latest=?, updated=?, deleted=1 WHERE vault_id=? AND record_id=?",
                         (version, now, auth.vault_id, rid))
            freed = prune_record(conn, auth.vault_id, rid, auth.limits["history_versions"], now)
            conn.execute("UPDATE vaults SET bytes=bytes-?, last_write=? WHERE vault_id=?", (freed, now, auth.vault_id))
            return version


async def delete_record(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"], roles=WRITERS)
    rid = request.path_params["rid"]
    check_rid(rid)
    expected = parse_if_match_version(request)
    version = await svc.run(_delete_record, svc, auth, rid, expected)
    return json_response({"version": version}, headers={"ETag": f'"{version}"'})


# --- history ------------------------------------------------------------------------------------------------------------------


def _history(svc, auth, rid):
    with svc.db.connection() as conn:
        with transaction(conn, write=False):
            rec = conn.execute("SELECT latest FROM records WHERE vault_id=? AND record_id=?", (auth.vault_id, rid)).fetchone()
            if rec is None:
                raise not_found("No such record.")
            rows = conn.execute("SELECT version, epoch, size, created, deleted, commit_mac FROM record_versions"
                                " WHERE vault_id=? AND record_id=? ORDER BY version DESC", (auth.vault_id, rid)).fetchall()
    return {"id": rid, "current": rec["latest"], "versions": [
        {"version": r["version"], "epoch": r["epoch"], "size": r["size"], "created": r["created"],
         "deleted": bool(r["deleted"]), "commit": r["commit_mac"]} for r in rows]}


async def list_versions(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"])
    rid = request.path_params["rid"]
    check_rid(rid)
    return json_response(await svc.run(_history, svc, auth, rid))


def _get_version(svc, auth, rid, n):
    with svc.db.connection() as conn:
        row = conn.execute("SELECT blob, commit_mac, deleted FROM record_versions WHERE vault_id=? AND record_id=? AND version=?",
                           (auth.vault_id, rid, n)).fetchone()
    if row is None:
        raise not_found("No such version.")
    if row["deleted"]:
        raise ApiError(404, "deleted", "This version is a deletion.", extra={"version": n})
    return row


async def get_version(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"])
    rid = request.path_params["rid"]
    check_rid(rid)
    n = check_version(request.path_params["n"])
    return blob_response(await svc.run(_get_version, svc, auth, rid, n), n)


def _purge_history(svc, auth, rid):
    with svc.db.connection() as conn:
        with transaction(conn):
            reverify(conn, auth, ("owner",))
            rec = conn.execute("SELECT latest FROM records WHERE vault_id=? AND record_id=?", (auth.vault_id, rid)).fetchone()
            if rec is None:
                raise not_found("No such record.")
            freed = conn.execute("SELECT COALESCE(SUM(size),0) FROM record_versions WHERE vault_id=? AND record_id=?"
                                 " AND version<?", (auth.vault_id, rid, rec["latest"])).fetchone()[0]
            conn.execute("DELETE FROM record_versions WHERE vault_id=? AND record_id=? AND version<?",
                         (auth.vault_id, rid, rec["latest"]))
            conn.execute("UPDATE vaults SET bytes=bytes-? WHERE vault_id=?", (freed, auth.vault_id))
    return {"freed": freed}


async def purge_history(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"], roles=("owner",))
    rid = request.path_params["rid"]
    check_rid(rid)
    return json_response(await svc.run(_purge_history, svc, auth, rid))


# --- rekey ------------------------------------------------------------------------------------------------------------------------


def _decode_cursor(text: str) -> tuple[str, int]:
    try:
        raw = b64u_decode(text).decode("ascii")
        rid, _, version = raw.partition(":")
        if not valid_record_id(rid) or not VERSION_RE.fullmatch(version):
            raise ValueError
        return rid, int(version)
    except (ValueError, UnicodeDecodeError):
        raise bad_request("Malformed cursor.") from None


def _rekey_list(svc, auth, cursor, limit):
    with svc.db.connection() as conn:
        with transaction(conn, write=False):
            epoch = conn.execute("SELECT epoch FROM vaults WHERE vault_id=?", (auth.vault_id,)).fetchone()[0]
            remaining = conn.execute("SELECT COUNT(*) FROM record_versions WHERE vault_id=? AND epoch IS NOT NULL AND epoch<?",
                                     (auth.vault_id, epoch)).fetchone()[0]
            rid, ver = cursor if cursor else ("", 0)
            rows = conn.execute(
                "SELECT record_id, version, epoch, size FROM record_versions WHERE vault_id=? AND epoch IS NOT NULL AND epoch<?"
                " AND (record_id>? OR (record_id=? AND version>?)) ORDER BY record_id, version LIMIT ?",
                (auth.vault_id, epoch, rid, rid, ver, limit + 1)).fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    nxt = b64u_encode(f"{rows[-1]['record_id']}:{rows[-1]['version']}".encode("ascii")) if more and rows else None
    return {"epoch": epoch, "remaining": remaining, "next": nxt, "items": [
        {"id": r["record_id"], "version": r["version"], "epoch": r["epoch"], "size": r["size"]} for r in rows]}


async def rekey_list(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"], roles=("owner",))
    after = request.query_params.get("after")
    cursor = _decode_cursor(after) if after else None
    limit = query_int(request, "limit", 500, 1, 500)
    return json_response(await svc.run(_rekey_list, svc, auth, cursor, limit))


def _rekey_put(svc, auth, rid, n, k, raw):
    with svc.db.connection() as conn:
        with transaction(conn):
            reverify(conn, auth, ("owner",))
            current = conn.execute("SELECT epoch FROM vaults WHERE vault_id=?", (auth.vault_id,)).fetchone()[0]
            if envelope_epoch(raw) != current:
                raise ApiError(409, "epoch_changed", "The vault epoch has changed.", extra={"epoch": current})
            if k >= current:
                raise bad_request("The precondition epoch must be older than the current epoch.")
            row = conn.execute("SELECT epoch, size, deleted FROM record_versions WHERE vault_id=? AND record_id=? AND version=?",
                               (auth.vault_id, rid, n)).fetchone()
            if row is None:
                raise not_found("No such version.")
            if row["deleted"]:
                raise ApiError(404, "deleted", "This version is a deletion.", extra={"version": n})
            if row["epoch"] != k:
                raise ApiError(412, "precondition_failed", "The blob is no longer under that epoch.",
                               extra={"epoch": row["epoch"]})
            if row["size"] != len(raw):
                raise ApiError(400, "rekey_size_mismatch", "The new envelope must have the stored length.")
            conn.execute("UPDATE record_versions SET blob=?, epoch=? WHERE vault_id=? AND record_id=? AND version=?",
                         (raw, current, auth.vault_id, rid, n))
            return {"version": n, "epoch": current}


async def rekey_put(request):
    svc = svc_of(request)
    auth = await authenticate(request, vault=request.path_params["vault"], roles=("owner",))
    rid = request.path_params["rid"]
    check_rid(rid)
    n = check_version(request.path_params["n"])
    k = parse_if_match_epoch(request)
    require_octet_type(request)
    # A stored blob may be larger than the scope's current limit (the operator lowered it later): re-encryption is
    # bounded by the ceiling and by the stored length (rekey_size_mismatch), never by the current limit (PLAN 8.3).
    maximum = svc.ceiling_envelope_bytes()
    declared = content_length(request, maximum)
    raw = await read_body(request, declared, maximum)
    check_envelope(raw, TYPE_RECORD, maximum)
    return json_response(await svc.run(_rekey_put, svc, auth, rid, n, k, raw))


def routes():
    v = PREFIX + "/vaults/{vault}"
    return [
        endpoint(v + "/records", GET=list_records),
        endpoint(v + "/records/{rid}", GET=get_record, PUT=put_record, DELETE=delete_record),
        endpoint(v + "/records/{rid}/versions", GET=list_versions, DELETE=purge_history),
        endpoint(v + "/records/{rid}/versions/{n}", GET=get_version),
        endpoint(v + "/records/{rid}/versions/{n}/rekey", PUT=rekey_put),
        endpoint(v + "/rekey", GET=rekey_list),
    ]
