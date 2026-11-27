"""Breach check for passphrases through this server (GET /datastore/api/v1/pwned/<5 uppercase hex characters>).

The library sends the first five hexadecimal characters of the SHA-1 of a passphrase to this server, which asks the Pwned
Passwords range service (api.pwnedpasswords.com, USA) on its behalf, so that service sees the server and never the person's IP
address. The answer is the list of hash suffixes with counts (padded by the service); the library compares the rest locally.

What this module promises:
- the prefix is never written to a log, and never next to an IP address (there is no access log; failures log only the kind of error);
- answers are cached in memory for 24 hours (bounded), so the same prefix reaches the service at most once a day;
- a server that cannot reach the service still works: the answer is 503, and for a minute after a failure the server does not try
  again (no thread waits for a blocked outbound connection); the library then falls back to its local estimator.
"""

from __future__ import annotations

import logging
import re
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict

from .errors import ApiError

log = logging.getLogger("wds_server")

PREFIX_RE = re.compile(r"[0-9A-F]{5}")
LINE_RE = re.compile(r"[0-9A-F]{35}:[0-9]{1,12}")
CACHE_SECONDS = 24 * 3600
CACHE_ENTRIES = 500  # a padded answer is about 40 KB: at most about 20 MB
RETRY_AFTER = 60  # seconds without a new attempt after a failure
MAX_PARALLEL = 8  # upstream requests at the same time
TIMEOUT = 4  # seconds per socket operation
TOTAL_SECONDS = 8  # the whole answer, however slowly it arrives
MAX_BYTES = 2_000_000
LOG_EVERY = 600  # seconds between two log lines about an unreachable service


def unavailable() -> ApiError:
    return ApiError(503, "pwned_unavailable", "The breach check is not available right now.", headers={"Retry-After": str(RETRY_AFTER)})


class PwnedProxy:
    def __init__(self, url: str, clock):
        self.url = url  # "" switches the proxy off (every answer is 503)
        self.clock = clock
        self.fetch = self._fetch_http  # tests replace it: fetch(prefix) -> bytes, or raises
        self._cache: OrderedDict[str, tuple[int, bytes]] = OrderedDict()
        self._lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(MAX_PARALLEL)
        self._down_until = 0
        self._last_log = 0

    def _fetch_http(self, prefix: str) -> bytes:
        request = urllib.request.Request(self.url + prefix, headers={"Add-Padding": "true", "User-Agent": "wiai-datastore"})
        deadline = time.monotonic() + TOTAL_SECONDS
        chunks, size = [], 0
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            while size <= MAX_BYTES:
                if time.monotonic() > deadline:
                    raise TimeoutError("too slow")  # a slow sender never holds a slot or a thread for long
                chunk = response.read(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
        return b"".join(chunks)

    @staticmethod
    def _clean(raw: bytes) -> bytes:
        """The service's answer as lines SUFFIX:COUNT; anything else is not an answer of the service."""
        if len(raw) > MAX_BYTES:
            raise ValueError("too large")
        lines = [line.strip() for line in raw.decode("ascii").splitlines() if line.strip()]
        if not lines or not all(LINE_RE.fullmatch(line) for line in lines):
            raise ValueError("unexpected format")
        return ("\r\n".join(lines) + "\r\n").encode("ascii")

    def range(self, prefix: str) -> bytes:
        """The cached or fresh answer for a prefix (blocking: call it in a thread). Raises the 503 ApiError."""
        now = self.clock()
        with self._lock:
            hit = self._cache.get(prefix)
            if hit and hit[0] > now:
                self._cache.move_to_end(prefix)
                return hit[1]
            if not self.url or now < self._down_until:
                raise unavailable()
        if not self._slots.acquire(blocking=False):
            raise unavailable()
        try:
            body = self._clean(self.fetch(prefix))
        except Exception as err:  # unreachable, refused, timed out, not the service's format: all the same for the caller
            self._failed(err, now)
            raise unavailable() from None
        finally:
            self._slots.release()
        with self._lock:
            self._cache[prefix] = (now + CACHE_SECONDS, body)
            self._cache.move_to_end(prefix)
            while len(self._cache) > CACHE_ENTRIES:
                self._cache.popitem(last=False)
        return body

    def _failed(self, err: Exception, now: int) -> None:
        with self._lock:
            self._down_until = now + RETRY_AFTER
            quiet = now - self._last_log < LOG_EVERY
            self._last_log = self._last_log if quiet else now
        if not quiet:  # only the kind of error: never the prefix, never an address
            reason = err.reason.__class__.__name__ if isinstance(err, urllib.error.URLError) else err.__class__.__name__
            log.warning("breach check: the Pwned Passwords service is not reachable (%s); answering 503 and retrying in %d seconds",
                        reason, RETRY_AFTER)
