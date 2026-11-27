"""In-memory sliding-window rate limits (PROTOCOL.md 8.7). Only authentication failures count."""

from __future__ import annotations

import ipaddress
import math
import threading
from collections import deque


def bucket(ip: str, v6_prefix: int = 64) -> str:
    """Per-IP counters bucket IPv6 clients by /64 (one household or NAT66 site shares a prefix of that size); the sandbox
    uses a shorter prefix because a home connection owns a /56 and could otherwise spread over 256 buckets."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if addr.version == 6 and addr.ipv4_mapped is None:
        return str(ipaddress.ip_network((addr, v6_prefix), strict=False))
    return str(addr.ipv4_mapped) if addr.version == 6 else ip


class RateLimiter:
    def __init__(self, config):
        self.cfg = config
        self._events: dict[tuple, deque] = {}
        self._lock = threading.Lock()
        self._last_gc = 0.0

    # -- internals -------------------------------------------------------------------------------------------

    def _prune(self, key: tuple, now: float, window: int) -> deque:
        q = self._events.get(key)
        if q is None:
            q = self._events[key] = deque()
        while q and q[0] <= now - window:
            q.popleft()
        return q

    def _retry_after(self, key: tuple, now: float, window: int, limit: int) -> int:
        """Seconds until the counter drops below the limit; 0 when it is not over it."""
        with self._lock:
            q = self._prune(key, now, window)
            if len(q) < limit:
                return 0
            # The (len - limit + 1)-th oldest event must leave the window.
            oldest = q[len(q) - limit]
            return max(1, math.ceil(oldest + window - now))

    def _gc(self, now: float) -> None:
        if now - self._last_gc < 60 and len(self._events) < 10000:
            return
        self._last_gc = now
        horizon = max(self.cfg.rate_ip_window, self.cfg.rate_id_window, self.cfg.rate_create_window, self.cfg.rate_pwned_window)
        if self.cfg.sandbox is not None:
            horizon = max(horizon, self.cfg.sandbox.create_window, self.cfg.sandbox.create_global_window)
        for key in [k for k, q in self._events.items() if not q or q[-1] <= now - horizon]:
            del self._events[key]

    # -- failures ----------------------------------------------------------------------------------------------

    def blocked(self, ip: str, access_id: str | None, now: float) -> int:
        """Retry-After seconds when this IP (or this IP and access ID) is over its failure budget, else 0."""
        ip = bucket(ip)
        a = self._retry_after(("ip", ip), now, self.cfg.rate_ip_window, self.cfg.rate_ip_failures)
        b = 0
        if access_id is not None:
            b = self._retry_after(("id", ip, access_id), now, self.cfg.rate_id_window, self.cfg.rate_id_failures)
        return max(a, b)

    def failure(self, ip: str, access_id: str | None, now: float) -> None:
        ip = bucket(ip)
        with self._lock:
            self._gc(now)
            self._prune(("ip", ip), now, self.cfg.rate_ip_window).append(now)
            if access_id is not None:
                self._prune(("id", ip, access_id), now, self.cfg.rate_id_window).append(now)

    # -- vault creation ------------------------------------------------------------------------------------------

    def creation(self, ip: str, now: float) -> int:
        """Count one creation attempt; returns Retry-After seconds when over the limit, else 0."""
        ip = bucket(ip)
        with self._lock:
            self._gc(now)
            q = self._prune(("create", ip), now, self.cfg.rate_create_window)
            if len(q) >= self.cfg.rate_create:
                return max(1, math.ceil(q[len(q) - self.cfg.rate_create] + self.cfg.rate_create_window - now))
            q.append(now)
            return 0

    # -- breach check ----------------------------------------------------------------------------------------------

    def pwned(self, ip: str, now: float) -> int:
        """Count one breach-check request (cache hits too); returns Retry-After seconds when over the limit, else 0."""
        ip = bucket(ip)
        with self._lock:
            self._gc(now)
            q = self._prune(("pwned", ip), now, self.cfg.rate_pwned_window)
            if len(q) >= self.cfg.rate_pwned:
                return max(1, math.ceil(q[len(q) - self.cfg.rate_pwned] + self.cfg.rate_pwned_window - now))
            q.append(now)
            return 0

    def sandbox_creation(self, ip: str, now: float) -> tuple[int, int]:
        """Sandbox only, on top of creation(): counts one vault creation against the IP bucket (IPv6 by create_ipv6_prefix)
        and against the whole sandbox (create_global per create_global_window). The sandbox is open to anybody, so neither
        one address nor a burst may fill it. Returns (retry_after_ip, retry_after_global) in seconds; (0, 0) when the
        creation may go on (and was counted)."""
        sb = self.cfg.sandbox
        if sb is None:
            return 0, 0
        ip = bucket(ip, sb.create_ipv6_prefix)
        with self._lock:
            self._gc(now)
            q = self._prune(("sandbox-create", ip), now, sb.create_window)
            g = self._prune(("sandbox-create-all",), now, sb.create_global_window)
            if len(q) >= sb.create_per_ip:
                return max(1, math.ceil(q[len(q) - sb.create_per_ip] + sb.create_window - now)), 0
            if len(g) >= sb.create_global:
                return 0, max(1, math.ceil(g[len(g) - sb.create_global] + sb.create_global_window - now))
            q.append(now)
            g.append(now)
            return 0, 0

    def sandbox_refund(self, ip: str, now: float) -> None:
        """A sandbox vault that its owner deleted again (a verifier run, a test) gives its creation back to both counters."""
        sb = self.cfg.sandbox
        if sb is None:
            return
        ip = bucket(ip, sb.create_ipv6_prefix)
        with self._lock:
            for key, window in ((("sandbox-create", ip), sb.create_window), (("sandbox-create-all",), sb.create_global_window)):
                q = self._prune(key, now, window)
                if q:
                    q.pop()
