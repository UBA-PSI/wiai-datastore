"""Authentication and the early request checks (PROTOCOL.md 8.1, 8.2, 8.7)."""

from __future__ import annotations

import hmac
from dataclasses import dataclass

from .errors import ApiError, forbidden, rate_limited, read_only, unauthorized
from .util import b32c_decode, b64u_decode, sha256
from .validate import valid_access_id


@dataclass
class SlotAuth:
    access_id: str
    slot_id: str
    vault_id: str
    scope_id: str
    role: str
    kind: str  # server view: passphrase | invite
    sv: int
    limits: dict


def _bearer(header: str | None) -> str | None:
    if header is None:
        return None
    scheme, _, rest = header.partition(" ")
    if scheme.lower() != "bearer" or not rest.strip():
        return ""
    return rest.strip()


def parse_slot_token(value: str) -> tuple[str, bytes] | None:
    parts = value.split(".")
    if len(parts) != 3 or parts[0] != "wds1":
        return None
    if not valid_access_id(parts[1]):
        return None
    try:
        token = b64u_decode(parts[2], 32)
    except ValueError:
        return None
    return parts[1], token


def _fail(svc, ip: str, access_id: str | None, error: ApiError, count: bool = True) -> ApiError:
    """Turn an authentication failure into the answer: 429 when over budget, else count it and answer `error`."""
    now = svc.now()
    retry = svc.limiter.blocked(ip, access_id, now)
    if retry:
        return rate_limited(retry)
    if count:
        svc.limiter.failure(ip, access_id, now)
    return error


def authenticate_slot(svc, conn, ip: str, header: str | None, *, vault: str | None = None,
                      access_id: str | None = None, roles: tuple[str, ...] | None = None,
                      mutates: bool = False, blocks_suspended: bool = False,
                      allow_unredeemed: bool = False) -> SlotAuth:
    """Token → vault/scope state → role → read-only, in the order of PROTOCOL.md 8.1.

    An unredeemed invite token only works where the handler opts in with allow_unredeemed (slot read, redeem, roster
    read, and the slot endpoints that answer 409 not_redeemed themselves); everywhere else it answers 403 forbidden.
    """
    bearer = _bearer(header)
    if bearer is None:
        raise _fail(svc, ip, None, unauthorized(), count=False)
    parsed = parse_slot_token(bearer) if bearer else None
    if parsed is None:
        raise _fail(svc, ip, None, unauthorized())
    aid, token = parsed
    row = conn.execute("SELECT * FROM slots WHERE access_id=?", (aid,)).fetchone()
    if row is None:
        raise _fail(svc, ip, aid, unauthorized())
    if row["revoked"] is not None:
        raise _fail(svc, ip, aid, ApiError(401, "revoked", "This access has been revoked."))
    if not hmac.compare_digest(sha256(token), bytes(row["token_hash"])):
        raise _fail(svc, ip, aid, unauthorized())
    now = svc.now()
    if row["kind"] == "invite" and row["redeemed"] is None and row["expires"] is not None and now >= row["expires"]:
        raise ApiError(410, "invite_expired", "This invite has expired.")
    if not row["used"]:
        conn.execute("UPDATE slots SET used=1 WHERE access_id=? AND used=0", (aid,))

    if access_id is not None and access_id != aid:
        raise forbidden("The token belongs to a different access ID.")
    if vault is not None and vault != row["vault_id"]:
        raise forbidden("The token belongs to a different vault.")
    vrow = conn.execute("SELECT scope_id, deleted FROM vaults WHERE vault_id=?", (row["vault_id"],)).fetchone()
    if vrow is None or vrow["deleted"] is not None:
        raise ApiError(410, "vault_deleted", "This vault has been deleted.")
    scope = conn.execute("SELECT * FROM scopes WHERE scope_id=?", (vrow["scope_id"],)).fetchone()
    if blocks_suspended and (scope is None or scope["status"] != "active"):
        raise ApiError(403, "scope_suspended", "This scope is suspended.")
    if not allow_unredeemed and _unredeemed(row):
        raise forbidden("This invite has not been redeemed yet.")
    if roles is not None and row["role"] not in roles:
        raise forbidden("Your role does not allow this.")
    if mutates and svc.read_only():
        raise read_only()
    return SlotAuth(aid, row["slot_id"], row["vault_id"], vrow["scope_id"], row["role"], row["kind"], row["sv"],
                    svc.scope_limits(scope))


def _unredeemed(row) -> bool:
    return row["kind"] == "invite" and row["redeemed"] is None


def reverify(conn, auth: SlotAuth, roles: tuple[str, ...] | None = None, *, allow_unredeemed: bool = False) -> None:
    """Inside the transaction: the slot must still exist unchanged (not revoked, same slot version and role)."""
    row = conn.execute("SELECT revoked, sv, role, kind, redeemed FROM slots WHERE access_id=?",
                       (auth.access_id,)).fetchone()
    if row is None or row["revoked"] is not None:
        raise ApiError(401, "revoked", "This access has been revoked.")
    if not allow_unredeemed and _unredeemed(row):
        raise forbidden("This invite has not been redeemed yet.")
    if roles is not None and row["role"] not in roles:
        raise forbidden("Your role does not allow this.")
    vrow = conn.execute("SELECT deleted FROM vaults WHERE vault_id=?", (auth.vault_id,)).fetchone()
    if vrow is None or vrow["deleted"] is not None:
        raise ApiError(410, "vault_deleted", "This vault has been deleted.")


def authenticate_operator(svc, ip: str, header: str | None) -> None:
    bearer = _bearer(header)
    if bearer is None:
        raise _fail(svc, ip, None, unauthorized(), count=False)
    ok = False
    if bearer.startswith("wdsop."):
        try:
            b64u_decode(bearer[6:], 32)
            digest = sha256(bearer.encode("ascii"))
            for known in svc.operator_hashes():
                if hmac.compare_digest(digest, known):
                    ok = True
        except (ValueError, UnicodeEncodeError):
            pass
    if not ok:
        raise _fail(svc, ip, None, unauthorized())
