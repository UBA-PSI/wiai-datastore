"""login.psi single sign-on (the login.psi loginapi protocol).

1. The app sends the browser to `<login.psi>/loginapi/request?app=<app>&token=<b64(SecretBox({session_key, next}))>`.
2. login.psi authenticates the person and redirects to `<app URL>/_lpmiddleware/login?token=<b64(SecretBox({username,
   first_name, last_name, email, [matriculation_number,] session_key, next}))>`.

`session_key` is a nonce that the app also puts into a cookie of the browser that started the login, so a response only
counts in that browser (login CSRF, session fixation). The nonce is `<unix time>.<random>`: it is valid for ten minutes
and for one response only. The 32-byte SecretBox key is shared with login.psi and read from a file (base64).
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import secrets
import threading
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

from nacl.exceptions import CryptoError
from nacl.secret import SecretBox

log = logging.getLogger("wds_server")

NONCE_LIFETIME = 600  # seconds the browser has to come back from login.psi


class LoginRejected(Exception):
    """The response from login.psi does not count (unreadable, wrong browser, expired, replayed)."""


@dataclass(frozen=True)
class LoginResponse:
    username: str
    email: str
    first_name: str
    last_name: str
    matriculation_number: str
    next: str

    @property
    def name(self) -> str:
        return (self.first_name + " " + self.last_name).strip()


def read_key(path: str | Path) -> bytes:
    key = base64.b64decode(Path(path).expanduser().read_text(encoding="utf-8").strip(), validate=True)
    if len(key) != SecretBox.KEY_SIZE:
        raise ValueError(f"the login.psi key must have {SecretBox.KEY_SIZE} bytes")
    return key


class LoginPsi:
    def __init__(self, key: bytes, url: str, app: str, clock=None):
        if len(key) != SecretBox.KEY_SIZE:
            raise ValueError(f"the login.psi key must have {SecretBox.KEY_SIZE} bytes")
        self._box = SecretBox(key)
        self.url = url.rstrip("/")
        self.app = app
        self._clock = clock or time.time
        self._used: dict[str, int] = {}  # nonce -> expiry; only nonces that login.psi really answered end up here
        self._lock = threading.Lock()

    @classmethod
    def from_config(cls, config, clock=None) -> "LoginPsi | None":
        """None without a key file; an unreadable key file also gives None (the dashboard then says login is not
        configured) and logs why, so that a broken key never stops the data API."""
        if not config.loginpsi_key_file:
            return None
        try:
            return cls(read_key(config.loginpsi_key_file), config.loginpsi_url, config.loginpsi_app, clock)
        except (OSError, ValueError, binascii.Error) as err:
            log.error("login.psi key file unusable (%s); dashboard login is off", err)
            return None

    def begin(self, next_path: str) -> tuple[str, str]:
        """New nonce for the cookie and the address to send the browser to."""
        nonce = f"{int(self._clock())}.{secrets.token_urlsafe(24)}"
        token = base64.b64encode(self._box.encrypt(json.dumps({"session_key": nonce, "next": next_path}).encode()))
        return nonce, (f"{self.url}/loginapi/request?app={urllib.parse.quote(self.app, safe='')}"
                       f"&token={urllib.parse.quote(token.decode(), safe='')}")

    def parse(self, token: str, cookie_nonce: str | None) -> LoginResponse:
        """Decrypt the response, check that it belongs to this browser and is fresh, and consume the nonce."""
        try:
            data = json.loads(self._box.decrypt(base64.b64decode(token.replace(" ", "+"), validate=True)).decode("utf-8"))
        except (ValueError, binascii.Error, CryptoError, UnicodeDecodeError) as err:
            raise LoginRejected("unreadable") from err
        if not isinstance(data, dict):
            raise LoginRejected("unreadable")
        sent = data.get("session_key")
        if not cookie_nonce or not isinstance(sent, str) or not secrets.compare_digest(sent.encode(), cookie_nonce.encode()):
            raise LoginRejected("wrong_browser")
        now = int(self._clock())
        try:
            issued = int(sent.split(".", 1)[0])
        except ValueError:
            raise LoginRejected("wrong_browser") from None
        if not 0 <= now - issued <= NONCE_LIFETIME:
            raise LoginRejected("expired")
        with self._lock:
            self._used = {n: exp for n, exp in self._used.items() if exp > now}
            if sent in self._used:
                raise LoginRejected("replayed")
            self._used[sent] = issued + NONCE_LIFETIME

        def text(key):
            value = data.get(key)
            return value.strip() if isinstance(value, str) else ""

        username = text("username")
        if not username:
            raise LoginRejected("no_username")
        matriculation = data.get("matriculation_number")
        return LoginResponse(username=username.lower(), email=text("email"), first_name=text("first_name"),
                             last_name=text("last_name"),
                             matriculation_number=str(matriculation).strip() if matriculation else "",
                             next=text("next"))
