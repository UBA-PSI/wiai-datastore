"""Scope management shared by the operator API, the dev CLI and (later) the dashboard."""

from __future__ import annotations

import json
import re
import secrets

from .config import LIMIT_KEYS
from .errors import ApiError, bad_request
from .util import CROCKFORD, is_int, max_envelope_bytes
from .validate import SLUG_RE, normalise_join_code

SCOPE_SUFFIX_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
ENROLLMENTS = ("join_code", "open", "closed")
STATUSES = ("active", "suspended")
EMAIL_RE = re.compile(r"[^@\s<>\"',;]+@[^@\s<>\"',;]+\.[^@\s<>\"',;]+")


def new_join_code() -> str:
    return "".join(secrets.choice(CROCKFORD) for _ in range(8))


def validate_name(name: object) -> str:
    if not isinstance(name, str):
        raise bad_request("name must be a string.")
    name = name.strip()
    if not 1 <= len(name) <= 100 or any(ord(c) < 0x20 or ord(c) == 0x7F or 0xD800 <= ord(c) <= 0xDFFF for c in name):
        raise bad_request("name must be 1 to 100 printable characters.")
    return name


def validate_description(value: object) -> str:
    if not isinstance(value, str):
        raise bad_request("description must be a string.")
    value = value.strip()
    if len(value) > 1000 or any((ord(c) < 0x20 and c not in "\n\t") or ord(c) == 0x7F or 0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise bad_request("description must be at most 1000 printable characters.")
    return value


def validate_contact_email(value: object, *, required: bool = False) -> str:
    if not isinstance(value, str):
        raise bad_request("contact e-mail must be a string.")
    value = value.strip()
    if not value and not required:
        return ""
    if not EMAIL_RE.fullmatch(value) or len(value) > 254:
        raise bad_request("contact e-mail must be an e-mail address.")
    return value


def validate_join_code(value: object) -> str:
    if not isinstance(value, str):
        raise bad_request("join_code must be a string or null.")
    code = normalise_join_code(value)
    if not 6 <= len(code) <= 32 or not code.isascii() or not code.isalnum():
        raise bad_request("join_code must be 6 to 32 letters and digits.")
    return code


def validate_limits(svc, limits: object, *, allow_reset: bool) -> dict:
    if not isinstance(limits, dict):
        raise bad_request("limits must be an object.")
    out = {}
    for key, value in limits.items():
        if key not in LIMIT_KEYS:
            raise bad_request(f"Unknown limit {key}.")
        if value is None and allow_reset:
            out[key] = None
            continue
        if not is_int(value) or not 1 <= value <= svc.config.limit_ceilings[key]:
            raise bad_request(f"{key} must be an integer between 1 and {svc.config.limit_ceilings[key]}.")
        out[key] = value
    return out


def create_scope(svc, conn, *, slug: str, name: str, enrollment: str = "join_code", join_code: str | None = None,
                 hibp: bool = True, limits: dict | None = None, description: str = "", contact_email: str = "",
                 creator: str | None = None):
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug) or len(slug) > 41:
        raise bad_request("slug must be lowercase letters, digits and hyphens, starting with a letter (at most 41 characters).")
    name = validate_name(name)
    if enrollment not in ENROLLMENTS:
        raise bad_request("enrollment must be join_code, open or closed.")
    if not isinstance(hibp, bool):
        raise bad_request("hibp must be a boolean.")
    code = validate_join_code(join_code) if join_code is not None else None
    if enrollment == "join_code" and code is None:
        code = new_join_code()
    own = validate_limits(svc, limits, allow_reset=False) if limits is not None else {}
    description = validate_description(description)
    contact_email = validate_contact_email(contact_email)
    now = svc.now()
    for _ in range(20):
        scope_id = slug + "-" + "".join(secrets.choice(SCOPE_SUFFIX_ALPHABET) for _ in range(6))
        if not conn.execute("SELECT 1 FROM scopes WHERE scope_id=?", (scope_id,)).fetchone():
            break
    else:
        raise ApiError(500, "internal", "Could not allocate a scope ID.")
    conn.execute("INSERT INTO scopes (scope_id, name, status, enrollment, join_code, hibp, limits, created, description,"
                 " contact_email, creator) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                 (scope_id, name, "active", enrollment, code, int(hibp), json.dumps(own), now, description, contact_email,
                  creator))
    return conn.execute("SELECT * FROM scopes WHERE scope_id=?", (scope_id,)).fetchone()


def _check_value_limit(svc, conn, scope_id: str, limits: dict) -> None:
    """Refuse a max_value_bytes below the largest envelope stored in the scope (PLAN 8.3: a server change must never
    make stored data unreadable or impossible to re-encrypt). Versions in history and deleted-but-not-purged vaults count."""
    effective = svc.scope_limits({"limits": json.dumps(limits)})["max_envelope_bytes"]
    largest = conn.execute("SELECT COALESCE(MAX(rv.size), 0) FROM record_versions rv JOIN vaults v ON v.vault_id=rv.vault_id"
                           " WHERE v.scope_id=?", (scope_id,)).fetchone()[0]
    if largest <= effective:
        return
    low, high = 1, svc.config.limit_ceilings["max_value_bytes"]
    while low < high:  # smallest max_value_bytes whose envelope limit still holds the largest stored envelope
        mid = (low + high) // 2
        if max_envelope_bytes(mid) >= largest:
            high = mid
        else:
            low = mid + 1
    raise ApiError(409, "limit_below_stored_value", "max_value_bytes is below the largest value stored in this scope.",
                   extra={"limit": "max_value_bytes", "largest_envelope_bytes": largest, "minimum_max_value_bytes": low})


def patch_scope(svc, conn, scope_id: str, changes: dict, *, suspended_by: str | None = None):
    """Apply `changes`. `suspended_by` ("admin" or "operator") is recorded when the status becomes suspended; the
    operator API passes none, which counts as the operator (a scope admin may only resume what an admin suspended)."""
    row = conn.execute("SELECT * FROM scopes WHERE scope_id=? AND deleted IS NULL", (scope_id,)).fetchone()
    if row is None:
        raise ApiError(404, "not_found", "Unknown scope.")
    if svc.is_sandbox(scope_id):
        raise ApiError(403, "sandbox_config", "The sandbox is configured in the [sandbox] section of the server configuration.")
    status, enrollment, join_code = row["status"], row["enrollment"], row["join_code"]
    name, hibp, limits = row["name"], bool(row["hibp"]), json.loads(row["limits"])
    description, contact_email, by = row["description"], row["contact_email"], row["suspended_by"]
    if "status" in changes:
        if changes["status"] not in STATUSES:
            raise bad_request("status must be active or suspended.")
        status = changes["status"]
        by = suspended_by if status == "suspended" else None
    if "description" in changes:
        description = validate_description(changes["description"])
    if "contact_email" in changes:
        contact_email = validate_contact_email(changes["contact_email"])
    if "enrollment" in changes:
        if changes["enrollment"] not in ENROLLMENTS:
            raise bad_request("enrollment must be join_code, open or closed.")
        enrollment = changes["enrollment"]
    if "join_code" in changes:
        join_code = validate_join_code(changes["join_code"]) if changes["join_code"] is not None else None
    if enrollment == "join_code" and join_code is None:
        join_code = new_join_code()
    if "name" in changes:
        name = validate_name(changes["name"])
    if "hibp" in changes:
        if not isinstance(changes["hibp"], bool):
            raise bad_request("hibp must be a boolean.")
        hibp = changes["hibp"]
    if "limits" in changes:
        for key, value in validate_limits(svc, changes["limits"], allow_reset=True).items():
            if value is None:
                limits.pop(key, None)
            else:
                limits[key] = value
    if "limits" in changes and "max_value_bytes" in changes["limits"]:
        _check_value_limit(svc, conn, scope_id, limits)
    conn.execute("UPDATE scopes SET status=?, enrollment=?, join_code=?, name=?, hibp=?, limits=?, description=?,"
                 " contact_email=?, suspended_by=? WHERE scope_id=?",
                 (status, enrollment, join_code, name, int(hibp), json.dumps(limits), description, contact_email, by,
                  scope_id))
    return conn.execute("SELECT * FROM scopes WHERE scope_id=?", (scope_id,)).fetchone()


# --- shared by the dashboard and the vault API ---------------------------------------------------------------------------


def soft_delete_vault(svc, conn, vault_id: str, scope_id: str, actor: str, now: int | None = None) -> int:
    """Mark a vault deleted (purged by maintenance after DELETED_VAULT_TTL); audited under `actor`."""
    now = svc.now() if now is None else now
    conn.execute("UPDATE vaults SET deleted=? WHERE vault_id=? AND deleted IS NULL", (now, vault_id))
    svc.audit(conn, actor, "vault_deleted", scope_id, vault_id)
    return now


def delete_scope(svc, conn, scope_id: str, actor: str) -> int:
    """Soft-delete a scope: all its vaults are soft-deleted, description, contact and join code are wiped, the scope
    disappears from the API. Maintenance removes the scope row once its vaults are purged."""
    now = svc.now()
    for v in conn.execute("SELECT vault_id FROM vaults WHERE scope_id=? AND deleted IS NULL", (scope_id,)).fetchall():
        soft_delete_vault(svc, conn, v["vault_id"], scope_id, actor, now)
    conn.execute("UPDATE scopes SET deleted=?, join_code=NULL, description='', contact_email='' WHERE scope_id=?",
                 (now, scope_id))
    svc.audit(conn, actor, "scope_deleted", scope_id)
    return now


DISK_BUDGET_FRACTION = 0.7
MAX_SCOPES_PER_CREATOR = 5  # active (not deleted) scopes one person may create in the dashboard; operators are exempt


def check_disk_budget(svc, conn, scope_id: str | None, new_limits: dict) -> None:
    """PLAN 10.1: the byte limits of all scopes together must stay below 70 % of the data disk. Refuses a change that
    would exceed the budget and raises the sum; lowering is always allowed. `scope_id` None means a new scope."""
    total = svc.disk_total_bytes()
    if not total:
        return
    others = 0
    own_before = 0
    for row in conn.execute("SELECT * FROM scopes WHERE deleted IS NULL").fetchall():
        limit = svc.scope_limits(row)["scope_bytes"]
        if row["scope_id"] == scope_id:
            own_before = limit
        else:
            others += limit
    after = svc.scope_limits({"limits": json.dumps(new_limits)})["scope_bytes"]
    budget = int(total * DISK_BUDGET_FRACTION)
    if others + after > budget and after > own_before:
        raise ApiError(409, "disk_budget_exceeded",
                       "The byte limits of all scopes together would exceed 70 % of the data disk.",
                       extra={"budget_bytes": budget, "committed_bytes": others + own_before})
