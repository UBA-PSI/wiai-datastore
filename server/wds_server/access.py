"""Dashboard identity and authorisation: sessions, staff rule, operators, scope admins (PLAN 6).

Sessions live in the `sessions` table. The cookie holds 32 random bytes (base64url); only their SHA-256 is stored. A
session ends after `session_idle` seconds without a request or `session_absolute` seconds after login. Authorisation is
computed per request from the stored identity and the current configuration and tables, never cached in the session.
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass

from .util import b64u_encode, sha256

STAFF_DOMAIN = "@uni-bamberg.de"
TOUCH_INTERVAL = 60  # last_seen is written at most once a minute

UNI_ID_RE = re.compile(r"[a-z0-9][a-z0-9._-]{1,63}")
ADMIN_EMAIL_RE = re.compile(r"[^@\s<>\"',;]+@[^@\s<>\"',;]+\.[^@\s<>\"',;]+")


def staff_rule(email: str, matriculation_number: str | None) -> bool:
    """Staff = e-mail ends exactly in @uni-bamberg.de (no subdomain such as stud.) and no matriculation number."""
    email = (email or "").strip().lower()
    local, sep, domain = email.rpartition("@")
    if not sep or not local or "@" in local or any(c.isspace() for c in email):
        return False
    return email.endswith(STAFF_DOMAIN) and not (matriculation_number or "").strip()


def is_operator(config, username: str, email: str) -> bool:
    ops = {o.strip().lower() for o in config.operators}
    return bool(ops) and ((username or "").strip().lower() in ops or (email or "").strip().lower() in ops)


def normalise_admin(value: str) -> str | None:
    """Co-admin entry: a Uni ID or an e-mail address, lower case; None when it is neither."""
    value = (value or "").strip().lower()
    if len(value) > 254:
        return None
    if "@" in value:
        return value if ADMIN_EMAIL_RE.fullmatch(value) else None
    return value if UNI_ID_RE.fullmatch(value) else None


@dataclass
class Identity:
    username: str
    name: str
    email: str
    staff: bool
    operator: bool
    csrf: str
    token_hash: bytes

    @property
    def keys(self) -> tuple[str, str]:
        """Strings under which scope_admins may list this person."""
        return self.username, (self.email or "").strip().lower()

    @property
    def can_create(self) -> bool:
        return self.staff or self.operator


def is_blocked(conn, username: str) -> bool:
    return conn.execute("SELECT 1 FROM blocked_users WHERE username=?", (username.lower(),)).fetchone() is not None


def is_listed_admin(conn, username: str, email: str) -> bool:
    keys = (username.lower(), (email or "").strip().lower() or "-")
    return conn.execute("SELECT 1 FROM scope_admins a JOIN scopes s ON s.scope_id=a.scope_id"
                        " WHERE s.deleted IS NULL AND a.admin IN (?,?) LIMIT 1", keys).fetchone() is not None


def may_log_in(svc, conn, username: str, email: str, staff: bool) -> str | None:
    """None when the person may enter the dashboard, else the reason: blocked or not_allowed."""
    if is_operator(svc.config, username, email):
        return None
    if is_blocked(conn, username):
        return "blocked"
    if staff or is_listed_admin(conn, username, email):
        return None
    return "not_allowed"


def create_session(svc, conn, username: str, name: str, email: str, staff: bool) -> str:
    """Store a new session and return the cookie value."""
    token = b64u_encode(secrets.token_bytes(32))
    now = svc.now()
    conn.execute("INSERT INTO sessions (token_hash, username, name, email, staff, csrf, created, last_seen)"
                 " VALUES (?,?,?,?,?,?,?,?)",
                 (sha256(token.encode()), username.lower(), name, email, int(staff), b64u_encode(secrets.token_bytes(24)),
                  now, now))
    return token


def load_identity(svc, conn, token: str | None) -> Identity | None:
    if not token or len(token) > 64:
        return None
    digest = sha256(token.encode("utf-8", "replace"))
    row = conn.execute("SELECT * FROM sessions WHERE token_hash=?", (digest,)).fetchone()
    if row is None:
        return None
    now = svc.now()
    cfg = svc.config
    operator = is_operator(cfg, row["username"], row["email"])
    if (now - row["last_seen"] > cfg.session_idle or now - row["created"] > cfg.session_absolute
            or (not operator and is_blocked(conn, row["username"]))):
        conn.execute("DELETE FROM sessions WHERE token_hash=?", (digest,))
        return None
    if now - row["last_seen"] >= TOUCH_INTERVAL:
        conn.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (now, digest))
    return Identity(row["username"], row["name"], row["email"], bool(row["staff"]), operator, row["csrf"], digest)


def end_session(conn, token_hash: bytes) -> None:
    conn.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))


def scope_admin_role(conn, ident: Identity, scope_id: str) -> str | None:
    """'creator', 'admin' or None."""
    row = conn.execute("SELECT role FROM scope_admins WHERE scope_id=? AND admin IN (?,?)",
                       (scope_id, ident.keys[0], ident.keys[1] or "-")).fetchone()
    return row["role"] if row else None


def my_scopes(conn, ident: Identity):
    return conn.execute(
        "SELECT DISTINCT s.* FROM scopes s JOIN scope_admins a ON a.scope_id=s.scope_id"
        " WHERE s.deleted IS NULL AND a.admin IN (?,?) ORDER BY s.name COLLATE NOCASE, s.scope_id",
        (ident.keys[0], ident.keys[1] or "-")).fetchall()
