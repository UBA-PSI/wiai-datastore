"""SQLite access: connection pool, transactions, schema migrations (PLAN.md 11)."""

from __future__ import annotations

import queue
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

MIGRATIONS: dict[int, list[str]] = {
    1: [
        """CREATE TABLE scopes (
            scope_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            enrollment TEXT NOT NULL,
            join_code TEXT,
            hibp INTEGER NOT NULL DEFAULT 1,
            limits TEXT NOT NULL DEFAULT '{}',
            created INTEGER NOT NULL,
            deleted INTEGER
        )""",
        """CREATE TABLE vaults (
            vault_id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
            created INTEGER NOT NULL,
            deleted INTEGER,
            epoch INTEGER NOT NULL,
            roster_version INTEGER NOT NULL,
            head_hash TEXT NOT NULL,
            escrow_slot TEXT NOT NULL,
            recovery_hash TEXT NOT NULL,
            recovery_contact TEXT,
            bytes INTEGER NOT NULL DEFAULT 0,
            last_write INTEGER
        )""",
        "CREATE INDEX vaults_scope ON vaults(scope_id)",
        """CREATE TABLE rosters (
            vault_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            body TEXT NOT NULL,
            sig TEXT NOT NULL,
            hash TEXT NOT NULL,
            created INTEGER NOT NULL,
            PRIMARY KEY (vault_id, version)
        )""",
        """CREATE TABLE slot_ids (
            vault_id TEXT NOT NULL,
            slot_id TEXT NOT NULL,
            PRIMARY KEY (vault_id, slot_id)
        )""",
        """CREATE TABLE slots (
            access_id TEXT PRIMARY KEY,
            vault_id TEXT NOT NULL,
            slot_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            role TEXT NOT NULL,
            kdf TEXT NOT NULL,
            token_hash BLOB NOT NULL,
            wrapped TEXT NOT NULL,
            sv INTEGER NOT NULL DEFAULT 1,
            expires INTEGER,
            used INTEGER NOT NULL DEFAULT 0,
            redeemed INTEGER,
            renewal TEXT,
            created INTEGER NOT NULL,
            revoked INTEGER,
            UNIQUE (vault_id, slot_id)
        )""",
        """CREATE TABLE keyring (
            vault_id TEXT NOT NULL,
            slot_id TEXT NOT NULL,
            roster_version INTEGER NOT NULL,
            entry TEXT NOT NULL,
            PRIMARY KEY (vault_id, slot_id)
        )""",
        """CREATE TABLE records (
            vault_id TEXT NOT NULL,
            record_id TEXT NOT NULL,
            latest INTEGER NOT NULL,
            updated INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (vault_id, record_id)
        )""",
        """CREATE TABLE record_versions (
            vault_id TEXT NOT NULL,
            record_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            epoch INTEGER,
            size INTEGER NOT NULL,
            created INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            commit_mac TEXT,
            blob BLOB,
            PRIMARY KEY (vault_id, record_id, version)
        )""",
        "CREATE INDEX record_versions_epoch ON record_versions(vault_id, epoch)",
        """CREATE TABLE recoveries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vault_id TEXT NOT NULL,
            method TEXT NOT NULL,
            requested INTEGER NOT NULL,
            ready_at INTEGER NOT NULL,
            state TEXT NOT NULL,
            finished INTEGER
        )""",
        "CREATE INDEX recoveries_vault ON recoveries(vault_id, state)",
        """CREATE TABLE audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            scope_id TEXT,
            vault_id TEXT,
            detail TEXT
        )""",
        "CREATE INDEX audit_scope ON audit(scope_id, ts)",
    ],
    2: [
        # Access IDs are never reused globally, not even after a vault has been purged (PROTOCOL 2).
        "CREATE TABLE access_ids (access_id TEXT PRIMARY KEY)",
        "INSERT INTO access_ids (access_id) SELECT access_id FROM slots",
        # Roster history is never pruned; its size is tracked separately from record bytes and bounded (PROTOCOL 7.1).
        "ALTER TABLE vaults ADD COLUMN roster_bytes INTEGER NOT NULL DEFAULT 0",
        "UPDATE vaults SET roster_bytes = (SELECT COALESCE(SUM(length(r.body) + length(r.sig)), 0) FROM rosters r"
        " WHERE r.vault_id = vaults.vault_id)",
    ],
}

MIGRATIONS[3] = [
    # Dashboard (PLAN 10): scope description and contact, who created a scope, who suspended it, co-admins, sessions,
    # blocked Uni IDs. Audit entries are swept after one year (maintenance), hence the index.
    "ALTER TABLE scopes ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE scopes ADD COLUMN contact_email TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE scopes ADD COLUMN creator TEXT",
    "ALTER TABLE scopes ADD COLUMN suspended_by TEXT",
    """CREATE TABLE scope_admins (
        scope_id TEXT NOT NULL,
        admin TEXT NOT NULL,
        role TEXT NOT NULL,
        added_by TEXT,
        added INTEGER NOT NULL,
        PRIMARY KEY (scope_id, admin)
    )""",
    """CREATE TABLE sessions (
        token_hash BLOB PRIMARY KEY,
        username TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        staff INTEGER NOT NULL,
        csrf TEXT NOT NULL,
        created INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
    )""",
    "CREATE INDEX sessions_user ON sessions(username)",
    """CREATE TABLE blocked_users (
        username TEXT PRIMARY KEY,
        reason TEXT NOT NULL DEFAULT '',
        blocked_by TEXT NOT NULL,
        created INTEGER NOT NULL
    )""",
    "CREATE INDEX audit_ts ON audit(ts)",
]

MIGRATIONS[4] = [
    # Small key/value table for server state that is not tied to a scope (the sandbox wipe marker, PLAN 17).
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
]

SCHEMA_VERSION = max(MIGRATIONS)


class Database:
    """A small pool of sqlite3 connections; every connection is configured identically."""

    def __init__(self, path: str | Path, pool_size: int = 16):
        self.path = str(path)
        self._idle: queue.LifoQueue[sqlite3.Connection] = queue.LifoQueue()
        self._lock = threading.Lock()
        self._created = 0
        self._pool_size = pool_size
        self._all: list[sqlite3.Connection] = []
        self._closed = False
        self.migrate()

    def _open(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("PRAGMA secure_delete=ON")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def migrate(self) -> None:
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        try:
            current = conn.execute("PRAGMA user_version").fetchone()[0]
            if current > SCHEMA_VERSION:
                raise RuntimeError(f"database schema version {current} is newer than this server ({SCHEMA_VERSION})")
            if current == 0:
                # Only effective before the first table exists.
                conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
            conn.execute("PRAGMA journal_mode=WAL")
            for version in range(current + 1, SCHEMA_VERSION + 1):
                conn.execute("BEGIN IMMEDIATE")
                try:
                    for statement in MIGRATIONS[version]:
                        conn.execute(statement)
                    conn.execute(f"PRAGMA user_version = {version}")
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
        finally:
            conn.close()

    @contextmanager
    def connection(self):
        conn = None
        try:
            conn = self._idle.get_nowait()
        except queue.Empty:
            with self._lock:
                if self._created < self._pool_size:
                    self._created += 1
                    conn = self._open()
                    self._all.append(conn)
            if conn is None:
                conn = self._idle.get()
        try:
            yield conn
        finally:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            self._idle.put(conn)

    def close(self) -> None:
        with self._lock:
            for conn in self._all:
                try:
                    conn.close()
                except sqlite3.Error:
                    pass
            self._all.clear()
            self._closed = True


@contextmanager
def transaction(conn: sqlite3.Connection, write: bool = True):
    """BEGIN IMMEDIATE (writers) or BEGIN (consistent read snapshot); rolls back on any exception."""
    conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
