"""Shared server state: configuration, database, limiter, clock, disk probe."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Callable

from starlette.concurrency import run_in_threadpool

from .config import Config, LIMIT_KEYS
from .db import Database
from .ratelimit import RateLimiter
from .util import b64u_decode, max_envelope_bytes

HISTORY_FLOOR_SECONDS = 600
INVITE_MAX_SECONDS = 15 * 86400
# Roster versions per vault (PROTOCOL 7.1/8.6): ordinary changes stop at the soft cap; versions that remove a slot, drop
# an epoch, adopt a renewal or switch escrow may continue up to the hard cap so that revocations stay possible.
ROSTER_SOFT_CAP = 1000
ROSTER_HARD_CAP = 1100
ROSTER_BYTES_CAP = 16 * 1024 * 1024  # roster history per vault (rosters and slot blobs), also limited by vault_bytes
RECOVERY_WAIT_CODE = 259200
RECOVERY_WAIT_CONTACT = 604800
EMPTY_VAULT_TTL = 7 * 86400
DELETED_VAULT_TTL = 2592000
JSON_BODY_LIMIT = 1048576
AUDIT_RETENTION = 365 * 86400  # audit entries are kept one year (privacy page)


class Service:
    def __init__(self, config: Config, db_path: str | Path, *, clock: Callable[[], float] | None = None,
                 disk_probe: Callable[[], float] | None = None, validate: bool = True):
        if validate:
            config.validate()
        self.config = config
        self.db_path = str(db_path)
        self.db = Database(db_path)
        self.limiter = RateLimiter(config)
        self.clock = clock or time.time
        self._probe = disk_probe
        app_root = Path(__file__).resolve().parents[2]  # the repository, or /opt/wiai-datastore/app on the VM
        self.client_dir = Path(config.client_dir) if config.client_dir else app_root / "client" / "dist"
        self.docs_dir = Path(config.docs_dir) if config.docs_dir else app_root / "docs" / "site"
        self.disk_total_override: int | None = None
        self.escrow_by_pubs = {(e.e_pub, e.s_pub): e for e in config.escrow}

    # -- time and disk ---------------------------------------------------------------------------------------------

    def now(self) -> int:
        return int(self.clock())

    def disk_fraction(self) -> float:
        if self._probe is not None:
            return float(self._probe())
        path = self.config.disk_path or str(Path(self.db_path).resolve().parent)
        st = os.statvfs(path)
        used = st.f_blocks - st.f_bfree
        denominator = used + st.f_bavail  # the same figure `df` reports as Use%
        return used / denominator if denominator else 0.0

    def disk_total_bytes(self) -> int:
        """Size of the data disk (for the 70 % budget of PLAN 10.1); tests set `disk_total_override`."""
        if self.disk_total_override is not None:
            return int(self.disk_total_override)
        path = self.config.disk_path or str(Path(self.db_path).resolve().parent)
        st = os.statvfs(path)
        return st.f_blocks * st.f_frsize

    def read_only(self) -> bool:
        return self.disk_fraction() >= self.config.read_only_threshold

    # -- helpers ---------------------------------------------------------------------------------------------------

    async def run(self, fn, *args, **kwargs):
        return await run_in_threadpool(fn, *args, **kwargs)

    def scope_limits(self, scope_row) -> dict:
        """Effective limits of a scope: operator defaults overlaid by the scope's own settings, clamped to ceilings."""
        own = json.loads(scope_row["limits"] or "{}")
        out = {}
        for key in LIMIT_KEYS:
            value = own.get(key, self.config.limit_defaults[key])
            out[key] = min(int(value), self.config.limit_ceilings[key])
        out["max_envelope_bytes"] = max_envelope_bytes(out["max_value_bytes"])
        return out

    def ceiling_envelope_bytes(self) -> int:
        """Largest record envelope any scope can ever hold (derived from the max_value_bytes ceiling)."""
        return max_envelope_bytes(self.config.limit_ceilings["max_value_bytes"])

    def library_latest(self) -> str:
        if self.config.library_latest:
            return self.config.library_latest
        best = None
        try:
            for p in self.client_dir.glob("wds-*.js"):
                version = p.name[len("wds-"):-len(".js")]
                key = tuple(int(x) if x.isdigit() else 0 for x in version.replace("-", ".").split("."))
                if best is None or key > best[0]:
                    best = (key, version)
        except OSError:
            pass
        return best[1] if best else "1.0.0"

    def is_sandbox(self, scope_id: str) -> bool:
        sb = self.config.sandbox
        return sb is not None and scope_id == sb.scope_id

    def operator_hashes(self) -> list[bytes]:
        return self.config.operator_token_hashes

    def audit(self, conn, actor: str, action: str, scope_id: str | None = None, vault_id: str | None = None,
              detail: str | None = None) -> None:
        conn.execute(
            "INSERT INTO audit (ts, actor, action, scope_id, vault_id, detail) VALUES (?,?,?,?,?,?)",
            (self.now(), actor, action, scope_id, vault_id, detail),
        )

    def close(self) -> None:
        self.db.close()
