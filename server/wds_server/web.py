"""HTTP plumbing: JSON bodies, header checks, responses (PROTOCOL.md 8.1)."""

from __future__ import annotations

import re

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .errors import ApiError, bad_request
from .util import loads_strict, b64u_decode, is_int


def json_response(data, status: int = 200, headers: dict | None = None) -> Response:
    return JSONResponse(data, status_code=status, headers=headers)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _media_type(request: Request) -> tuple[str, list[str]]:
    raw = request.headers.get("content-type", "")
    parts = [p.strip() for p in raw.split(";")]
    return parts[0].lower(), [p for p in parts[1:] if p]


def require_json_type(request: Request) -> None:
    media, params = _media_type(request)
    if media != "application/json":
        raise ApiError(415, "unsupported_media_type", "Content-Type must be application/json.")
    for p in params:
        k, _, v = p.partition("=")
        if k.strip().lower() != "charset" or v.strip().strip('"').lower() != "utf-8":
            raise ApiError(415, "unsupported_media_type", "Only charset=utf-8 is accepted.")


def require_octet_type(request: Request) -> None:
    media, params = _media_type(request)
    if media != "application/octet-stream" or params:
        raise ApiError(415, "unsupported_media_type", "Content-Type must be application/octet-stream.")


def content_length(request: Request, limit: int) -> int:
    if "transfer-encoding" in request.headers and "content-length" not in request.headers:
        raise ApiError(411, "length_required", "Content-Length is required.")
    raw = request.headers.get("content-length")
    if raw is None or not raw.isascii() or not raw.isdigit():
        raise ApiError(411, "length_required", "Content-Length is required.")
    length = int(raw)
    if length > limit:
        raise ApiError(413, "value_too_large", "Request body too large.", extra={"limit": limit})
    return length


async def read_body(request: Request, declared: int, limit: int) -> bytes:
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit or total > declared:
            raise ApiError(413, "value_too_large", "Request body too large.", extra={"limit": limit})
        chunks.append(chunk)
    body = b"".join(chunks)
    if len(body) != declared:
        raise bad_request("Body length does not match Content-Length.")
    return body


async def read_json(request: Request, limit: int = 1048576) -> dict:
    """Content-Type (415) → Content-Length (411/413) → body → strict parse (400); returns a JSON object."""
    require_json_type(request)
    declared = content_length(request, limit)
    raw = await read_body(request, declared, limit)
    try:
        obj = loads_strict(raw)
    except (ValueError, UnicodeDecodeError):
        raise bad_request("Body is not valid JSON.") from None
    if not isinstance(obj, dict):
        raise bad_request("Body must be a JSON object.")
    return obj


_ETAG_RE = re.compile(r'"([1-9][0-9]{0,15})"')
_REKEY_RE = re.compile(r'"e([0-9]{1,10})"')


def parse_preconditions(request: Request) -> tuple[str, int | None]:
    """Returns ("match", n) or ("none-match", None). 428 when absent; 400 for malformed values."""
    if_match = request.headers.get("if-match")
    if_none = request.headers.get("if-none-match")
    if if_match is None and if_none is None:
        raise ApiError(428, "precondition_required", "If-Match or If-None-Match is required.")
    if if_match is not None and if_none is not None:
        raise bad_request("Send either If-Match or If-None-Match.")
    if if_match is not None:
        m = _ETAG_RE.fullmatch(if_match.strip())
        if not m:
            raise bad_request('If-Match must be exactly one strong ETag such as "7".')
        return "match", int(m.group(1))
    if if_none.strip() != "*":
        raise bad_request("If-None-Match accepts only *.")
    return "none-match", None


def parse_if_match_version(request: Request) -> int:
    if "if-match" not in request.headers:
        raise ApiError(428, "precondition_required", "If-Match is required.")
    if "if-none-match" in request.headers:
        raise bad_request("If-None-Match is not accepted here.")
    m = _ETAG_RE.fullmatch(request.headers["if-match"].strip())
    if not m:
        raise bad_request('If-Match must be exactly one strong ETag such as "7".')
    return int(m.group(1))


def parse_if_match_epoch(request: Request) -> int:
    if "if-match" not in request.headers:
        raise ApiError(428, "precondition_required", "If-Match is required.")
    if "if-none-match" in request.headers:
        raise bad_request("If-None-Match is not accepted here.")
    m = _REKEY_RE.fullmatch(request.headers["if-match"].strip())
    if not m:
        raise bad_request('If-Match must have the form "e3".')
    return int(m.group(1))


def parse_commit_header(request: Request) -> str:
    value = request.headers.get("wds-commit")
    if value is None:
        raise bad_request("WDS-Commit header is required.")
    try:
        b64u_decode(value, 32)
    except ValueError:
        raise bad_request("WDS-Commit must be 32 bytes in base64url.") from None
    return value


def expect_keys(obj: dict, required: set[str], optional: set[str] = frozenset()) -> None:
    keys = set(obj)
    if not required <= keys or not keys <= (required | optional):
        raise bad_request("Unknown or missing keys in request.")


def query_int(request: Request, name: str, default: int, low: int, high: int, clamp: bool = True) -> int:
    raw = request.query_params.get(name)
    if raw is None:
        return default
    if not raw.isascii() or not raw.isdigit() or len(raw) > 12:
        raise bad_request(f"{name} must be a non-negative integer.")
    value = int(raw)
    if value < low:
        raise bad_request(f"{name} is too small.")
    if value > high:
        if clamp:
            return high
        raise bad_request(f"{name} is too large.")
    return value
