"""Structural validation of protocol objects (PROTOCOL.md sections 2, 3, 4)."""

from __future__ import annotations

import re

from .errors import ApiError, bad_request
from .util import b32c_decode, b64u_decode, cjson_text, is_int

MAGIC = b"WDS1"
TYPE_RECORD, TYPE_SLOT, TYPE_KEYRING = 1, 2, 3

SCOPE_RE = re.compile(r"[a-z][a-z0-9]*(-[a-z0-9]+)*-[0-9a-hjkmnp-tv-z]{6}")
SLUG_RE = re.compile(r"[a-z][a-z0-9]*(-[a-z0-9]+)*")
VAULT_RE = re.compile(r"[0-9A-HJKMNP-TV-Z]{26}")
SLOT_ID_RE = re.compile(r"[A-Za-z0-9_-]{16}")
RECORD_ID_RE = re.compile(r"[A-Za-z0-9_-]{43}")


def valid_scope_id(value: object) -> bool:
    return isinstance(value, str) and len(value) <= 48 and SCOPE_RE.fullmatch(value) is not None


def valid_vault_id(value: object) -> bool:
    return isinstance(value, str) and VAULT_RE.fullmatch(value) is not None


def valid_slot_id(value: object) -> bool:
    if not isinstance(value, str) or not SLOT_ID_RE.fullmatch(value):
        return False
    try:
        b64u_decode(value, 12)
    except ValueError:
        return False
    return True


def valid_record_id(value: object) -> bool:
    if not isinstance(value, str) or not RECORD_ID_RE.fullmatch(value):
        return False
    try:
        b64u_decode(value, 32)
    except ValueError:
        return False
    return True


def valid_access_id(value: object) -> bool:
    try:
        b32c_decode(value, 12)
    except ValueError:
        return False
    return True


def valid_b64u(value: object, length: int) -> bool:
    try:
        b64u_decode(value, length)
    except ValueError:
        return False
    return True


def valid_pub(value: object) -> bool:
    try:
        raw = b64u_decode(value, 65)
    except ValueError:
        return False
    return raw[0] == 4


def decode_envelope(value: object, etype: int) -> bytes:
    """Structural check of an envelope given as a b64u string inside JSON; returns the raw bytes."""
    try:
        raw = b64u_decode(value)
    except ValueError:
        raise ApiError(400, "malformed_envelope", "Envelope is not canonical base64url.") from None
    check_envelope(raw, etype)
    return raw


def check_envelope(raw: bytes, etype: int, max_len: int | None = None) -> None:
    minimum, maximum = {TYPE_RECORD: (38, None), TYPE_SLOT: (38, 4096), TYPE_KEYRING: (103, 16384)}[etype]
    if max_len is not None:
        maximum = max_len
    if len(raw) < minimum or (maximum is not None and len(raw) > maximum):
        raise ApiError(400, "malformed_envelope", "Envelope length is out of range.")
    if raw[:4] != MAGIC:
        raise ApiError(400, "malformed_envelope", "Bad envelope magic.")
    if raw[4] != etype:
        raise ApiError(400, "malformed_envelope", "Wrong envelope type for this endpoint.")
    if raw[5] != 0:
        raise ApiError(400, "malformed_envelope", "Envelope flags must be zero.")
    epoch = int.from_bytes(raw[6:10], "big")
    if etype != TYPE_RECORD and epoch != 0:
        raise ApiError(400, "malformed_envelope", "Epoch must be zero for this envelope type.")
    if etype == TYPE_KEYRING and raw[10] != 4:
        raise ApiError(400, "malformed_envelope", "Ephemeral public key must be an uncompressed point.")


def envelope_epoch(raw: bytes) -> int:
    return int.from_bytes(raw[6:10], "big")


def validate_kdf(obj: object, *, kind: str) -> str:
    """kind is 'passphrase' or 'invite'; returns the canonical JSON text to store."""
    if not isinstance(obj, dict):
        raise bad_request("kdf must be an object.")
    if kind == "invite":
        if obj != {"alg": "invite"}:
            raise bad_request('kdf must be {"alg":"invite"}.')
        return cjson_text(obj)
    if set(obj) != {"alg", "m", "p", "salt", "t", "v"} or obj["alg"] != "argon2id":
        raise bad_request("kdf must be an argon2id descriptor.")
    m, t, p, v = obj["m"], obj["t"], obj["p"], obj["v"]
    if not all(is_int(x) for x in (m, t, p, v)):
        raise bad_request("kdf parameters must be integers.")
    if not (65536 <= m <= 262144 and 3 <= t <= 10 and p == 1 and v == 19):
        raise bad_request("kdf parameters are outside the accepted window.")
    if not valid_b64u(obj["salt"], 16):
        raise bad_request("kdf salt must be 16 bytes in base64url.")
    return cjson_text(obj)


def normalise_join_code(value: str) -> str:
    return value.strip().upper().replace(" ", "").replace("-", "")
