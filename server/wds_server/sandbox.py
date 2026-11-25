"""The public sandbox scope (PLAN 17): configured in the server's [sandbox] section, open enrollment, small quotas,
every vault deleted nightly. Everything that is specific to it lives here: the scope row, the wipe schedule, the nightly
wipe, eviction when it is full, and the scope-document field the library and wds-verify read."""

from __future__ import annotations

import datetime
import json

from .config import SANDBOX_CREATOR, SandboxConfig
from .db import transaction
from .purge import purge_vault
from .scopes import delete_scope

META_LAST_WIPE = "sandbox_last_wipe"
DESCRIPTION = "Public sandbox (server config)"


# -- meta table ------------------------------------------------------------------------------------------------------


def meta_get(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def meta_set(conn, key: str, value: str) -> None:
    conn.execute("INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


# -- schedule --------------------------------------------------------------------------------------------------------


def wipe_instants(sb: SandboxConfig, now: int) -> tuple[int, int]:
    """(latest scheduled wipe instant <= now, next one > now) as Unix seconds; wipe_time is local time in sb.timezone,
    so the instants follow daylight saving time."""
    tz = sb.tz
    hour, minute = sb.wipe_hm
    today = datetime.datetime.fromtimestamp(now, tz).date()
    instants = []
    for delta in (-1, 0, 1):
        day = today + datetime.timedelta(days=delta)
        instants.append(int(datetime.datetime(day.year, day.month, day.day, hour, minute, tzinfo=tz).timestamp()))
    return max(t for t in instants if t <= now), min(t for t in instants if t > now)


def last_wipe(conn) -> int | None:
    value = meta_get(conn, META_LAST_WIPE)
    return int(value) if value and value.isdigit() else None


def sandbox_doc(svc, scope_id: str, conn=None) -> dict | None:
    """The `sandbox` field of the public scope document: null for every scope except the sandbox."""
    sb = svc.config.sandbox
    if sb is None or scope_id != sb.scope_id:
        return None
    if conn is None:
        with svc.db.connection() as c:
            last = last_wipe(c)
    else:
        last = last_wipe(conn)
    return {"enabled": sb.enabled, "wipe_at": sb.wipe_time, "timezone": sb.timezone,
            "next_wipe": wipe_instants(sb, svc.now())[1], "last_wipe": last}


# -- the scope row ---------------------------------------------------------------------------------------------------


def ensure_sandbox(svc) -> None:
    """Make the scopes table match the configuration (server start and the maintenance command). The row is created or
    updated from [sandbox]; a row with that ID that the configuration did not create stops the start (ValueError). When
    the section is gone the rows it created are soft-deleted like any deleted scope."""
    sb = svc.config.sandbox
    now = svc.now()
    with svc.db.connection() as conn:
        with transaction(conn):
            if sb is None:
                for row in conn.execute("SELECT scope_id FROM scopes WHERE creator=? AND deleted IS NULL",
                                        (SANDBOX_CREATOR,)).fetchall():
                    delete_scope(svc, conn, row["scope_id"], "system")
                return
            row = conn.execute("SELECT * FROM scopes WHERE scope_id=?", (sb.scope_id,)).fetchone()
            limits = json.dumps(sb.limits())
            if row is None:
                conn.execute(
                    "INSERT INTO scopes (scope_id, name, status, enrollment, join_code, hibp, limits, created, description,"
                    " contact_email, creator) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (sb.scope_id, sb.name, "active", "open", None, int(sb.hibp), limits, now, DESCRIPTION, "", SANDBOX_CREATOR))
                svc.audit(conn, "system", "scope_created", sb.scope_id, None, "sandbox")
                return
            if row["creator"] != SANDBOX_CREATOR:
                raise ValueError(f"config: the scope {sb.scope_id} already exists and was not created by the [sandbox] section;"
                                 " choose another scope_id or remove that scope")
            conn.execute("UPDATE scopes SET name=?, status='active', suspended_by=NULL, enrollment='open', join_code=NULL,"
                         " hibp=?, limits=?, description=?, contact_email='', deleted=NULL WHERE scope_id=?",
                         (sb.name, int(sb.hibp), limits, DESCRIPTION, sb.scope_id))


# -- capacity --------------------------------------------------------------------------------------------------------


def evict_until(svc, conn, scope_id: str, fits, exclude: str | None = None) -> bool:
    """Purge the oldest sandbox vaults until `fits()` is true. Returns whether it fits. A vault is only evictable when it was
    created and last written at least evict_min_age ago: one that somebody is working in is never taken away. Runs in the
    caller's write transaction; `exclude` is never touched."""
    sb = svc.config.sandbox
    cutoff = svc.now() - sb.evict_min_age
    while not fits():
        row = conn.execute("SELECT vault_id FROM vaults WHERE scope_id=? AND created<=? AND COALESCE(last_write, 0)<=? AND vault_id<>?"
                           " ORDER BY created, vault_id LIMIT 1", (scope_id, cutoff, cutoff, exclude or "")).fetchone()
        if row is None:
            return False
        purge_vault(svc, conn, row["vault_id"], "capacity", "sandbox_evicted")
    return True


# -- nightly wipe ----------------------------------------------------------------------------------------------------


def _wipe(svc, conn, sb: SandboxConfig, before: int, marker: int) -> int:
    ids = [r["vault_id"] for r in conn.execute("SELECT vault_id FROM vaults WHERE scope_id=? AND created<?",
                                               (sb.scope_id, before)).fetchall()]
    for vault_id in ids:  # one transaction per vault: a long wipe never holds the database for long
        with transaction(conn):
            purge_vault(svc, conn, vault_id, "wipe", None)
    with transaction(conn):
        meta_set(conn, META_LAST_WIPE, str(marker))
        svc.audit(conn, "system", "sandbox_wiped", sb.scope_id, None, str(len(ids)))
    return len(ids)


def wipe_if_due(svc, conn, now: int) -> int:
    """Maintenance step: when the latest scheduled wipe instant T is newer than the marker, purge every sandbox vault
    created before T (soft-deleted ones too). Vaults created after T stay until the next night. Returns the count, 0
    when nothing was due."""
    sb = svc.config.sandbox
    if sb is None:
        return 0
    latest, _ = wipe_instants(sb, now)
    if (last_wipe(conn) or 0) >= latest:
        return 0
    return _wipe(svc, conn, sb, latest, latest)


def wipe_now(svc) -> int:
    """CLI: purge every sandbox vault now and set the marker to now."""
    sb = svc.config.sandbox
    if sb is None:
        raise ValueError("no [sandbox] section in the configuration")
    now = svc.now()
    with svc.db.connection() as conn:
        return _wipe(svc, conn, sb, now + 1, now)


def status(svc) -> dict:
    sb = svc.config.sandbox
    if sb is None:
        return {"configured": False}
    now = svc.now()
    with svc.db.connection() as conn:
        n, size = conn.execute("SELECT COUNT(*), COALESCE(SUM(bytes + roster_bytes), 0) FROM vaults WHERE scope_id=?",
                               (sb.scope_id,)).fetchone()
        return {"configured": True, "scope": sb.scope_id, "enabled": sb.enabled, "vaults": n, "bytes": size,
                "wipe_at": sb.wipe_time, "timezone": sb.timezone, "next_wipe": wipe_instants(sb, now)[1],
                "last_wipe": last_wipe(conn)}
