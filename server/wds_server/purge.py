"""Removing a vault for good (shared by maintenance, the sandbox and the vault API)."""

from __future__ import annotations

VAULT_TABLES = ("record_versions", "records", "keyring", "slots", "slot_ids", "rosters", "recoveries")


def purge_vault(svc, conn, vault_id: str, reason: str, action: str | None = "vault_purged") -> None:
    """Delete every row of a vault. `action` is the audit entry written for it (None: no entry, the caller audits).
    The access_ids rows stay: access IDs are never reused (PROTOCOL 2). Runs inside the caller's transaction."""
    row = conn.execute("SELECT scope_id FROM vaults WHERE vault_id=?", (vault_id,)).fetchone()
    for table in VAULT_TABLES:
        conn.execute(f"DELETE FROM {table} WHERE vault_id=?", (vault_id,))
    conn.execute("DELETE FROM vaults WHERE vault_id=?", (vault_id,))
    if action:
        svc.audit(conn, "system", action, row["scope_id"] if row else None, vault_id, reason)
