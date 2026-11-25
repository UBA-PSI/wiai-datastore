"""Maintenance: purge empty and deleted vaults, history sweep, incremental vacuum (PROTOCOL.md 5.3, 8.3, 8.5)."""

from __future__ import annotations

from .api_records import prune_record
from .db import transaction
from .purge import VAULT_TABLES, purge_vault  # noqa: F401 (re-exported)
from .sandbox import wipe_if_due
from .service import AUDIT_RETENTION, DELETED_VAULT_TTL, EMPTY_VAULT_TTL

SANDBOX_VACUUM_PAGES = 4096  # after a sandbox wipe: free at most this many pages per sweep (the rest follows in later sweeps)


def run_maintenance(svc) -> dict:
    now = svc.now()
    stats = {"empty_vaults": 0, "deleted_vaults": 0, "pruned_versions": 0, "freed_bytes": 0, "audit_rows": 0,
             "sessions": 0, "scopes": 0, "sandbox_vaults": 0}
    with svc.db.connection() as conn:
        for v in conn.execute("SELECT vault_id, created, deleted FROM vaults").fetchall():
            vid = v["vault_id"]
            if v["deleted"] is not None:
                if v["deleted"] <= now - DELETED_VAULT_TTL:
                    with transaction(conn):
                        purge_vault(svc, conn, vid, "deleted")
                    stats["deleted_vaults"] += 1
                continue
            if v["created"] <= now - EMPTY_VAULT_TTL:
                with transaction(conn):
                    empty = conn.execute("SELECT 1 FROM records WHERE vault_id=? LIMIT 1", (vid,)).fetchone() is None
                    if empty:
                        purge_vault(svc, conn, vid, "empty")
                if empty:
                    stats["empty_vaults"] += 1
                    continue
        for v in conn.execute("SELECT v.vault_id, s.* FROM vaults v JOIN scopes s ON s.scope_id=v.scope_id"
                              " WHERE v.deleted IS NULL").fetchall():
            keep = svc.scope_limits(v)["history_versions"]
            with transaction(conn):
                for r in conn.execute("SELECT record_id, COUNT(*) AS n FROM record_versions WHERE vault_id=?"
                                      " GROUP BY record_id HAVING n>?", (v["vault_id"], keep)).fetchall():
                    freed = prune_record(conn, v["vault_id"], r["record_id"], keep, now)
                    if freed:
                        conn.execute("UPDATE vaults SET bytes=bytes-? WHERE vault_id=?", (freed, v["vault_id"]))
                        stats["freed_bytes"] += freed
                        stats["pruned_versions"] += 1
        # Scopes deleted in the dashboard: the row goes once every vault of it has been purged.
        for s in conn.execute("SELECT scope_id FROM scopes WHERE deleted IS NOT NULL").fetchall():
            with transaction(conn):
                if conn.execute("SELECT 1 FROM vaults WHERE scope_id=? LIMIT 1", (s["scope_id"],)).fetchone() is None:
                    conn.execute("DELETE FROM scope_admins WHERE scope_id=?", (s["scope_id"],))
                    conn.execute("DELETE FROM scopes WHERE scope_id=?", (s["scope_id"],))
                    stats["scopes"] += 1
        with transaction(conn):
            stats["audit_rows"] = conn.execute("DELETE FROM audit WHERE ts < ?", (now - AUDIT_RETENTION,)).rowcount
            stats["sessions"] = conn.execute("DELETE FROM sessions WHERE last_seen < ? OR created < ?",
                                             (now - svc.config.session_idle, now - svc.config.session_absolute)).rowcount
        stats["sandbox_vaults"] = wipe_if_due(svc, conn, now)
        conn.execute(f"PRAGMA incremental_vacuum({SANDBOX_VACUUM_PAGES})" if stats["sandbox_vaults"] else "PRAGMA incremental_vacuum")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return stats
