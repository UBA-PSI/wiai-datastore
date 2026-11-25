"""Configuration: dataclass plus INI loader (PLAN.md 6, 10.1, 12)."""

from __future__ import annotations

import configparser
import re
from dataclasses import dataclass, field
from pathlib import Path

from .util import b64u_decode, b64u_encode, sha256

LIMIT_KEYS = ("max_value_bytes", "vault_bytes", "scope_bytes", "max_vaults", "history_versions")

DEFAULT_LIMITS = {
    "max_value_bytes": 10485760,
    "vault_bytes": 209715200,
    "scope_bytes": 2147483648,
    "max_vaults": 50,
    "history_versions": 10,
}
CEILING_LIMITS = {
    "max_value_bytes": 26214400,
    "vault_bytes": 1073741824,
    "scope_bytes": 10737418240,
    "max_vaults": 500,
    "history_versions": 50,
}

BACKUP_RETENTION_DE = "Sicherungen der virtuellen Maschine: Aufbewahrungsfrist wird festgelegt."
BACKUP_RETENTION_EN = "Backups of the virtual machine: the retention period is being determined."

KDF_DEFAULT = {"alg": "argon2id", "m": 65536, "p": 1, "t": 3, "v": 19}


@dataclass(frozen=True)
class EscrowSet:
    e_pub: str  # b64u, 65 bytes
    s_pub: str  # b64u, 65 bytes
    status: str  # "current" | "spare"

    @property
    def key_id(self) -> str:
        return b64u_encode(sha256(b64u_decode(self.e_pub, 65) + b64u_decode(self.s_pub, 65)))


SANDBOX_CREATOR = "config:sandbox"


@dataclass
class SandboxConfig:
    """The [sandbox] section (operator decision, PLAN 17): a public scope with open enrollment, small quotas and a nightly wipe."""
    scope_id: str
    enabled: bool = True
    name: str = "WIAI Datastore sandbox"
    wipe_time: str = "03:30"  # local time of the nightly wipe, HH:MM
    timezone: str = "Europe/Berlin"
    hibp: bool = False
    max_value_bytes: int = 524288
    vault_bytes: int = 2097152
    scope_bytes: int = 1073741824
    max_vaults: int = 500
    history_versions: int = 2
    evict_min_age: int = 1800  # seconds; vaults younger than this are never evicted
    create_per_ip: int = 20  # vault creations per IP bucket in create_window (on top of [ratelimit] create)
    create_window: int = 3600
    invite_slots: int = 3  # invite slots per vault (open plus redeemed)
    create_ipv6_prefix: int = 56  # IPv6 clients are counted per prefix of this length (a home connection owns a /56)
    create_global: int = 60  # vault creations of the whole sandbox per create_global_window; beyond it: 503 sandbox_busy
    create_global_window: int = 600

    def limits(self) -> dict:
        return {k: getattr(self, k) for k in LIMIT_KEYS}

    @property
    def wipe_hm(self) -> tuple[int, int]:
        return int(self.wipe_time[:2]), int(self.wipe_time[3:])

    @property
    def tz(self):
        from zoneinfo import ZoneInfo
        return ZoneInfo(self.timezone)

    def validate(self, ceilings: dict) -> None:
        from .validate import valid_scope_id
        if not valid_scope_id(self.scope_id):
            raise ValueError("config: [sandbox] scope_id is not a valid scope ID")
        if not 1 <= len(self.name.strip()) <= 100:
            raise ValueError("config: [sandbox] name must be 1 to 100 characters")
        m = re.fullmatch(r"([01][0-9]|2[0-3]):([0-5][0-9])", self.wipe_time)
        if not m:
            raise ValueError("config: [sandbox] wipe_time must be HH:MM (24 hours)")
        try:
            self.tz
        except Exception:
            raise ValueError(f"config: [sandbox] timezone {self.timezone!r} is not a known time zone") from None
        for key in LIMIT_KEYS:
            if not 1 <= getattr(self, key) <= ceilings[key]:
                raise ValueError(f"config: [sandbox] {key} must be between 1 and its ceiling ({ceilings[key]})")
        for key in ("evict_min_age", "create_per_ip", "create_window", "invite_slots", "create_global", "create_global_window"):
            if getattr(self, key) < 1:
                raise ValueError(f"config: [sandbox] {key} must be at least 1")
        if not 32 <= self.create_ipv6_prefix <= 64:
            raise ValueError("config: [sandbox] create_ipv6_prefix must be between 32 and 64")


@dataclass
class Config:
    public_base: str = "https://wiai.uni-bamberg.de/datastore"
    client_dir: str | None = None
    docs_dir: str | None = None
    disk_path: str | None = None
    read_only_threshold: float = 0.85
    sweep_interval: int = 3600
    privacy_url: str | None = None
    # login.psi and the dashboard (PLAN 6, 10)
    loginpsi_key_file: str | None = None
    loginpsi_app: str = "wiai-datastore"
    loginpsi_url: str = "https://login.psi.uni-bamberg.de"
    operators: list[str] = field(default_factory=list)  # login.psi user IDs or e-mail addresses, lower case
    dev_login: bool = False  # tests and local development only
    session_idle: int = 7200
    session_absolute: int = 43200
    # privacy page (PLAN 13); the two backup sentences are one operator decision
    privacy_updated: str | None = None  # language-neutral, or "German text / English text" (split by page language)
    privacy_updated_de: str | None = None
    privacy_updated_en: str | None = None
    backup_retention_de: str = BACKUP_RETENTION_DE
    backup_retention_en: str = BACKUP_RETENTION_EN
    library_latest: str | None = None
    library_deprecated: list[str] = field(default_factory=list)
    limit_defaults: dict = field(default_factory=lambda: dict(DEFAULT_LIMITS))
    limit_ceilings: dict = field(default_factory=lambda: dict(CEILING_LIMITS))
    rate_ip_failures: int = 60
    rate_ip_window: int = 60
    rate_id_failures: int = 10
    rate_id_window: int = 60
    rate_create: int = 30
    rate_create_window: int = 3600
    escrow: list[EscrowSet] = field(default_factory=list)
    operator_token_hashes: list[bytes] = field(default_factory=list)
    sandbox: SandboxConfig | None = None

    def validate(self) -> None:
        if len(self.escrow) != 2 or [e.status for e in self.escrow] != ["current", "spare"]:
            raise ValueError("config: exactly one current and one spare escrow key set are required")
        for e in self.escrow:
            b64u_decode(e.e_pub, 65)
            b64u_decode(e.s_pub, 65)
        for key in LIMIT_KEYS:
            if not 1 <= self.limit_defaults[key] <= self.limit_ceilings[key]:
                raise ValueError(f"config: default for {key} must be between 1 and its ceiling")
        if not 0 < self.read_only_threshold <= 1:
            raise ValueError("config: read_only_threshold must be in (0, 1]")
        if not 60 <= self.session_idle <= self.session_absolute:
            raise ValueError("config: session_idle must be at least 60 and not above session_absolute")
        if self.sandbox is not None:
            self.sandbox.validate(self.limit_ceilings)

    @property
    def privacy_link(self) -> str:
        return self.privacy_url or self.public_base.rstrip("/") + "/privacy"


def parse_token_hash(text: str) -> bytes:
    """Operator token hash: SHA-256 of the full `wdsop.…` string, as 64 hex digits or 43 base64url characters."""
    text = text.strip()
    if len(text) == 64:
        return bytes.fromhex(text)
    return b64u_decode(text, 32)


def _load_sandbox(parser) -> SandboxConfig | None:
    """[sandbox]: the section's presence enables the sandbox. A trailing " ; comment" on a value is ignored here."""
    if not parser.has_section("sandbox"):
        return None

    def raw(key):
        value = parser.get("sandbox", key, fallback=None)
        return None if value is None else value.split(" ;")[0].split("\t;")[0].strip()

    def boolean(key, default):
        value = raw(key)
        if value is None or value == "":
            return default
        if value.lower() not in ("1", "true", "yes", "on", "0", "false", "no", "off"):
            raise ValueError(f"config: [sandbox] {key} must be true or false")
        return value.lower() in ("1", "true", "yes", "on")

    def integer(key, default):
        value = raw(key)
        if value is None or value == "":
            return default
        try:
            return int(value)
        except ValueError:
            raise ValueError(f"config: [sandbox] {key} must be a whole number") from None

    scope_id = raw("scope_id")
    if not scope_id:
        raise ValueError("config: [sandbox] needs scope_id")
    d = SandboxConfig(scope_id=scope_id)
    return SandboxConfig(
        scope_id=scope_id, enabled=boolean("enabled", d.enabled), name=raw("name") or d.name,
        wipe_time=raw("wipe_time") or d.wipe_time, timezone=raw("timezone") or d.timezone, hibp=boolean("hibp", d.hibp),
        max_value_bytes=integer("max_value_bytes", d.max_value_bytes), vault_bytes=integer("vault_bytes", d.vault_bytes),
        scope_bytes=integer("scope_bytes", d.scope_bytes), max_vaults=integer("max_vaults", d.max_vaults),
        history_versions=integer("history_versions", d.history_versions),
        evict_min_age=integer("evict_min_age", d.evict_min_age), create_per_ip=integer("create_per_ip", d.create_per_ip),
        create_window=integer("create_window", d.create_window), invite_slots=integer("invite_slots", d.invite_slots),
        create_ipv6_prefix=integer("create_ipv6_prefix", d.create_ipv6_prefix), create_global=integer("create_global", d.create_global),
        create_global_window=integer("create_global_window", d.create_global_window))


def load_config(path: str | Path | None) -> Config:
    cfg = Config()
    if path is None:
        return cfg
    parser = configparser.ConfigParser(interpolation=None)
    with open(path, encoding="utf-8") as fh:
        parser.read_file(fh)

    def get(section, key, default=None):
        return parser.get(section, key, fallback=default) if parser.has_section(section) else default

    s = "server"
    cfg.public_base = get(s, "public_base", cfg.public_base)
    cfg.client_dir = get(s, "client_dir", cfg.client_dir)
    cfg.docs_dir = get(s, "docs_dir", cfg.docs_dir)
    cfg.disk_path = get(s, "disk_path", cfg.disk_path)
    cfg.read_only_threshold = float(get(s, "read_only_threshold", cfg.read_only_threshold))
    cfg.sweep_interval = int(get(s, "sweep_interval", cfg.sweep_interval))
    cfg.privacy_url = get(s, "privacy_url", cfg.privacy_url)
    cfg.library_latest = get(s, "library_latest", cfg.library_latest)
    deprecated = get(s, "library_deprecated", "")
    cfg.library_deprecated = [v for v in deprecated.replace(",", " ").split() if v]

    cfg.loginpsi_key_file = (get("loginpsi", "key_file", "") or "").strip() or None
    cfg.loginpsi_app = (get("loginpsi", "app", cfg.loginpsi_app) or cfg.loginpsi_app).strip()
    cfg.loginpsi_url = (get("loginpsi", "url", cfg.loginpsi_url) or cfg.loginpsi_url).strip().rstrip("/")
    cfg.operators = [o.lower() for o in (get("dashboard", "operators", "") or "").split() if o]
    cfg.dev_login = (get("dashboard", "dev_login", "false") or "false").strip().lower() in ("1", "true", "yes", "on")
    cfg.session_idle = int(get("dashboard", "session_idle", cfg.session_idle))
    cfg.session_absolute = int(get("dashboard", "session_absolute", cfg.session_absolute))
    cfg.privacy_updated = (get("privacy", "updated", "") or "").strip() or None
    cfg.privacy_updated_de = (get("privacy", "updated_de", "") or "").strip() or None
    cfg.privacy_updated_en = (get("privacy", "updated_en", "") or "").strip() or None
    cfg.backup_retention_de = (get("privacy", "backup_retention_de", "") or "").strip() or cfg.backup_retention_de
    cfg.backup_retention_en = (get("privacy", "backup_retention_en", "") or "").strip() or cfg.backup_retention_en

    for section, target in (("limits.defaults", cfg.limit_defaults), ("limits.ceilings", cfg.limit_ceilings)):
        if parser.has_section(section):
            for key in LIMIT_KEYS:
                if parser.has_option(section, key):
                    target[key] = parser.getint(section, key)

    r = "ratelimit"
    for attr in ("rate_ip_failures", "rate_ip_window", "rate_id_failures", "rate_id_window", "rate_create",
                 "rate_create_window"):
        value = get(r, attr[len("rate_"):], None)
        if value is not None:
            setattr(cfg, attr, int(value))

    if parser.has_section("escrow"):
        cfg.escrow = [
            EscrowSet(parser.get("escrow", "current_e_pub").strip(), parser.get("escrow", "current_s_pub").strip(), "current"),
            EscrowSet(parser.get("escrow", "spare_e_pub").strip(), parser.get("escrow", "spare_s_pub").strip(), "spare"),
        ]
    cfg.sandbox = _load_sandbox(parser)
    hashes = get("operator", "token_hashes", "") or ""
    cfg.operator_token_hashes = [parse_token_hash(h) for h in hashes.replace(",", " ").split() if h]
    return cfg
