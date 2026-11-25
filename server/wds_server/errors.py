"""API errors (PROTOCOL.md 8.9)."""

from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str | None = None, *, extra: dict | None = None,
                 headers: dict | None = None):
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message or code.replace("_", " ")
        self.extra = extra or {}
        self.headers = headers or {}

    def body(self) -> dict:
        out = {"error": self.code, "message": self.message}
        out.update(self.extra)
        return out


def bad_request(message: str = "Bad request.") -> ApiError:
    return ApiError(400, "bad_request", message)


def unauthorized() -> ApiError:
    return ApiError(401, "unauthorized", "Missing or invalid credentials.",
                    headers={"WWW-Authenticate": 'Bearer realm="wds"'})


def forbidden(message: str = "Not allowed.") -> ApiError:
    return ApiError(403, "forbidden", message)


def not_found(message: str = "Not found.") -> ApiError:
    return ApiError(404, "not_found", message)


def rate_limited(retry_after: int) -> ApiError:
    retry_after = max(1, int(retry_after))
    return ApiError(429, "rate_limited", "Too many failed attempts.", headers={"Retry-After": str(retry_after)})


def sandbox_disabled() -> ApiError:
    return ApiError(503, "sandbox_disabled", "The sandbox is switched off on this server.")


def sandbox_busy(retry_after: int) -> ApiError:
    retry_after = max(1, int(retry_after))
    return ApiError(503, "sandbox_busy", "The sandbox is very busy at the moment; try again in a few minutes.",
                    headers={"Retry-After": str(retry_after)})


def sandbox_no_recovery() -> ApiError:
    return ApiError(409, "sandbox_no_recovery", "Vaults in the sandbox have no recovery.")


def read_only() -> ApiError:
    return ApiError(503, "read_only", "The server is in read-only mode.", headers={"Retry-After": "3600"})
