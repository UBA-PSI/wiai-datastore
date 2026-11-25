"""Encodings and primitives of PROTOCOL.md section 1 (b64u, b32c, cjson, padme) and small helpers."""

from __future__ import annotations

import hashlib
import json
import re

B64U_RE = re.compile(r"[A-Za-z0-9_-]*")
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_CROCKFORD_INDEX = {c: i for i, c in enumerate(CROCKFORD)}
MAX_SAFE_INT = 2**53 - 1

import base64


def b64u_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_decode(text: object, length: int | None = None) -> bytes:
    """Strict base64url without padding; rejects non-canonical encodings. Raises ValueError."""
    if not isinstance(text, str) or not B64U_RE.fullmatch(text):
        raise ValueError("not base64url")
    if len(text) % 4 == 1:
        raise ValueError("bad base64url length")
    raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    if b64u_encode(raw) != text:
        raise ValueError("non-canonical base64url")
    if length is not None and len(raw) != length:
        raise ValueError("wrong decoded length")
    return raw


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def b32c_symbols(nbytes: int) -> int:
    k = (5 - (8 * nbytes) % 5) % 5
    return (8 * nbytes + k) // 5


def b32c_encode(data: bytes) -> str:
    n = len(data)
    k = (5 - (8 * n) % 5) % 5
    value = int.from_bytes(data, "big")
    if k:
        value = (value << k) | (sha256(data)[0] >> (8 - k))
    symbols = (8 * n + k) // 5
    return "".join(CROCKFORD[(value >> (5 * (symbols - 1 - i))) & 31] for i in range(symbols))


def b32c_decode(text: object, nbytes: int) -> bytes:
    """Decode the canonical wire form (uppercase, no separators) and verify the check bits."""
    if not isinstance(text, str) or len(text) != b32c_symbols(nbytes):
        raise ValueError("wrong length")
    value = 0
    for ch in text:
        if ch not in _CROCKFORD_INDEX:
            raise ValueError("bad symbol")
        value = (value << 5) | _CROCKFORD_INDEX[ch]
    k = (5 - (8 * nbytes) % 5) % 5
    check = value & ((1 << k) - 1)
    data = (value >> k).to_bytes(nbytes, "big")
    expected = (sha256(data)[0] >> (8 - k)) if k else 0
    if check != expected:
        raise ValueError("check bits do not match")
    return data


def crockford_plain(data: bytes, symbols: int) -> str:
    """Plain Crockford encoding (5-bit groups, MSB first, no check bits), first `symbols` symbols."""
    total = len(data) * 8
    value = int.from_bytes(data, "big")
    out = []
    for i in range(symbols):
        shift = total - 5 * (i + 1)
        group = (value >> shift) & 31 if shift >= 0 else (value << -shift) & 31
        out.append(CROCKFORD[group])
    return "".join(out)


def vault_id_from_pub(s_pub: bytes) -> str:
    return crockford_plain(sha256(s_pub), 26)


def padme(length: int) -> int:
    e = length.bit_length() - 1
    s = e.bit_length()
    z = e - s
    unit = 1 << z
    return -(-length // unit) * unit


def max_envelope_bytes(max_value_bytes: int) -> int:
    return padme(4 + 2048 + max_value_bytes) + 38


# --- canonical JSON ------------------------------------------------------------------------------------------


def _cjson_string(value: str) -> str:
    for ch in value:
        if not (0x20 <= ord(ch) <= 0x7E) or ch in '"\\':
            raise ValueError("string not allowed in canonical JSON")
    return '"' + value + '"'


def _cjson(value: object) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if not 0 <= value <= MAX_SAFE_INT:
            raise ValueError("integer out of range")
        return str(value)
    if isinstance(value, str):
        return _cjson_string(value)
    if isinstance(value, list):
        return "[" + ",".join(_cjson(v) for v in value) + "]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise ValueError("object keys must be strings")
        return "{" + ",".join(_cjson_string(k) + ":" + _cjson(value[k]) for k in sorted(value)) + "}"
    raise ValueError("type not allowed in canonical JSON")


def cjson(value: object) -> bytes:
    """Canonical JSON (PROTOCOL.md 1.3). Raises ValueError for values that break the rules."""
    try:
        return _cjson(value).encode("ascii")
    except RecursionError as exc:
        raise ValueError("nesting too deep") from exc


def cjson_text(value: object) -> str:
    return cjson(value).decode("ascii")


def _reject(_text: str):
    raise ValueError("floats and non-finite numbers are not allowed")


def _unique_pairs(pairs):
    out: dict = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate key")
        out[key] = value
    return out


def loads_strict(data: bytes | str):
    """Parse JSON rejecting duplicate keys, floats, NaN/Infinity and invalid UTF-8. Raises ValueError."""
    try:
        text = data.decode("utf-8") if isinstance(data, (bytes, bytearray)) else data
        return json.loads(text, object_pairs_hook=_unique_pairs, parse_float=_reject, parse_constant=_reject)
    except RecursionError as exc:
        raise ValueError("nesting too deep") from exc


def is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def u32(n: int) -> bytes:
    return n.to_bytes(4, "big")
