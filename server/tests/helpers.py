"""Test fixtures: environment (app, clock, disk probe, operator token) and a vault builder."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

from wds_server.app import create_app
from wds_server.config import Config, EscrowSet
from wds_server.util import b32c_encode, b64u_encode, cjson, sha256, u32, vault_id_from_pub
from .asgi import Client

API = "/datastore/api/v1"
START_TIME = 1_800_000_000


def fake_pub(seed: str) -> bytes:
    return b"\x04" + sha256(seed.encode() + b"x") + sha256(seed.encode() + b"y")


ESCROW_KEYS = {n: (fake_pub("escrow-" + n + "-e"), fake_pub("escrow-" + n + "-s")) for n in ("current", "spare")}


def escrow_sets():
    return [EscrowSet(b64u_encode(e), b64u_encode(s), name) for name, (e, s) in ESCROW_KEYS.items()]


def envelope(etype: int, epoch: int = 0, length: int = 100, flags: int = 0, magic: bytes = b"WDS1") -> bytes:
    """A structurally valid envelope of total `length` bytes (random ciphertext)."""
    header = magic + bytes([etype, flags]) + u32(epoch)
    body = os.urandom(max(0, length - 10))
    if etype == 3 and len(body) > 0:
        body = b"\x04" + body[1:]
    return header + body


def b64(data: bytes) -> str:
    return b64u_encode(data)


def kdf_doc(salt=None) -> dict:
    return {"alg": "argon2id", "m": 65536, "p": 1, "salt": b64(salt or os.urandom(16)), "t": 3, "v": 19}


INVITE_KDF = {"alg": "invite"}


class Clock:
    def __init__(self, t=START_TIME):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


class Env:
    """Everything a test needs; create with Env() and call close()."""

    def __init__(self, config_overrides=None, disk=0.1):
        self.tmp = tempfile.mkdtemp(prefix="wds-test-")
        self.op_token = "wdsop." + b64(os.urandom(32))
        cfg = Config(escrow=escrow_sets(), operator_token_hashes=[sha256(self.op_token.encode())],
                     client_dir=os.path.join(self.tmp, "dist"), sweep_interval=0)
        for k, v in (config_overrides or {}).items():
            setattr(cfg, k, v)
        os.makedirs(cfg.client_dir)
        self.config = cfg
        self.clock = Clock()
        self.disk = [disk]
        self.join_codes: dict[str, str] = {}
        self.app = create_app(cfg, os.path.join(self.tmp, "test.db"), clock=self.clock, disk_probe=lambda: self.disk[0])
        self.svc = self.app.state.svc
        self.client = Client(self.app)

    def close(self):
        self.client.close()
        self.svc.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    @property
    def op(self):
        return {"Authorization": "Bearer " + self.op_token}

    def create_scope(self, slug="testapp", name="Test App", **kw) -> dict:
        body = {"slug": slug, "name": name, "join_code": None, "limits": None}
        body.update(kw)
        r = self.client.post_json(API + "/admin/scopes", body, self.op)
        assert r.status == 201, r
        doc = r.json()
        self.join_codes[doc["scope"]] = doc["join_code"]  # Vault.create uses it unless a test sends another one
        return doc

    def new_vault(self, scope=None, **kw) -> "Vault":
        scope = scope or self.create_scope()
        v = Vault(self, scope["scope"], **kw)
        r = v.create(join_code=scope.get("join_code") or (self.sql("SELECT join_code FROM scopes WHERE scope_id=?", (scope["scope"],)) or [[None]])[0][0])
        assert r.status == 201, r
        return v

    def quota_scope(self, slug="quota", vaults=1, vault_bytes=None, scope_bytes=None, **limits) -> list:
        """A scope with `vaults` vaults whose byte limits leave exactly the given room for records.

        Roster history counts toward both quotas (PROTOCOL 7.1), so the limits are the wanted room plus the roster bytes
        of the vaults as created."""
        scope = self.create_scope(slug=slug)
        made = [self.new_vault(scope) for _ in range(vaults)]
        roster = sum(self.sql("SELECT roster_bytes FROM vaults WHERE vault_id=?", (v.vault,))[0][0] for v in made)
        per_vault = roster // vaults
        patch = dict(limits)
        if vault_bytes is not None:
            patch["vault_bytes"] = vault_bytes + per_vault
        if scope_bytes is not None:
            patch["scope_bytes"] = scope_bytes + roster
        if patch:
            r = self.client.patch_json(API + "/admin/scopes/" + scope["scope"], {"limits": patch}, self.op)
            assert r.status == 200, r
        return made

    def sql(self, query, args=()):
        with self.svc.db.connection() as conn:
            return conn.execute(query, args).fetchall()


class Vault:
    def __init__(self, env: Env, scope_id: str, name: str = "founder"):
        self.env = env
        self.c = env.client
        self.scope = scope_id
        self.s_pub = fake_pub(os.urandom(8).hex() + "s")
        self.e_pub = fake_pub(os.urandom(8).hex() + "e")
        self.vault = vault_id_from_pub(self.s_pub)
        self.slot = b64(os.urandom(12))
        self.escrow_slot = b64(os.urandom(12))
        self.access_id = b32c_encode(os.urandom(12))
        self.token = os.urandom(32)
        self.recovery_code = os.urandom(17)
        self.nk_commit = b64(os.urandom(32))
        self.commits = {1: b64(os.urandom(32))}
        self.version = 0
        self.head = ""
        self.epoch = 1
        self.slots: dict[str, dict] = {}
        self.invites: dict[str, "Member"] = {}
        self.record_versions: dict[str, int] = {}

    # --- credentials -----------------------------------------------------------------------------------------------

    @staticmethod
    def bearer(access_id: str, token: bytes) -> dict:
        return {"Authorization": f"Bearer wds1.{access_id}.{b64(token)}"}

    @property
    def auth(self) -> dict:
        return self.bearer(self.access_id, self.token)

    @property
    def path(self) -> str:
        return f"{API}/vaults/{self.vault}"

    # --- roster ---------------------------------------------------------------------------------------------------------

    def entry(self, slot_id, kind, role, e_pub, s_pub, expires=None) -> dict:
        return {"e_pub": b64(e_pub), "expires": expires, "id": slot_id, "kind": kind, "role": role, "s_pub": b64(s_pub)}

    def roster_body(self, **over) -> dict:
        slots = sorted(self.slots.values(), key=lambda e: e["id"])
        body = {
            "commit": {"epochs": [{"c": c, "e": e} for e, c in sorted(self.commits.items())], "nk": self.nk_commit},
            "epoch": self.epoch, "prev": self.head, "scope": self.scope, "signer": self.slot, "slots": slots,
            "time": self.env.clock.t, "type": "roster", "v": 1, "vault": self.vault, "version": self.version + 1,
        }
        body.update(over)
        return body

    @staticmethod
    def sign(body: dict) -> dict:
        return {"body": body, "sig": b64(os.urandom(64))}

    @staticmethod
    def hash_of(body: dict) -> str:
        return b64(sha256(cjson(body)))

    def bump_body(self, **over) -> dict:
        """Roster body that raises the epoch by one without removing a slot (a version that is not a no-op)."""
        epoch = self.epoch + 1
        commits = {**self.commits, epoch: b64(os.urandom(32))}
        return self.roster_body(epoch=epoch, commit={"epochs": [{"c": c, "e": e} for e, c in sorted(commits.items())],
                                                     "nk": self.nk_commit}, **over)

    def keyring_for(self, slot_ids) -> dict:
        return {sid: b64(envelope(3, 0, 140)) for sid in slot_ids}

    def create_body(self, join_code=None) -> dict:
        self.slots = {
            self.slot: self.entry(self.slot, "passphrase", "owner", self.e_pub, self.s_pub),
            self.escrow_slot: self.entry(self.escrow_slot, "escrow", "owner", *ESCROW_KEYS["current"]),
        }
        body = self.roster_body()
        self._pending_body = body
        return {
            "vault": self.vault, "roster": self.sign(body),
            "slots": [{"slot": self.slot, "access_id": self.access_id, "kdf": kdf_doc(),
                       "token_hash": b64(sha256(self.token)), "wrapped": b64(envelope(2, 0, 200))}],
            "keyring": self.keyring_for(self.slots),
            "recovery_hash": b64(sha256(self.recovery_code)), "join_code": join_code,
        }

    def create(self, join_code=None, mutate=None, ip=None):
        body = self.create_body(join_code if join_code is not None else self.env.join_codes.get(self.scope))
        if mutate:
            mutate(body)
        self.last_body = body
        r = self.c.post_json(f"{API}/scopes/{self.scope}/vaults", body, ip=ip)
        if r.status == 201:
            self.version, self.head = 1, r.json()["head"]
        return r

    def post_roster(self, body=None, *, keyring=None, new_slots=None, headers=None, raw_doc=None, apply=True, **over):
        """Post a roster version built from current state (override body keys with kwargs)."""
        body = body or self.roster_body(**over)
        doc = raw_doc or self.sign(body)
        payload = {"roster": doc,
                   "keyring": keyring if keyring is not None else self.keyring_for([s["id"] for s in body["slots"]])}
        if new_slots is not None:
            payload["new_slots"] = new_slots
        r = self.c.post_json(self.path + "/roster", payload, headers or self.auth)
        if r.status == 200 and apply:
            self.version, self.head, self.epoch = body["version"], self.hash_of(body), body["epoch"]
            self.slots = {s["id"]: s for s in body["slots"]}
            self.commits = {c["e"]: c["c"] for c in body["commit"]["epochs"]}
        return r

    def invite(self, role="write", ttl=3600, **over) -> "Member":
        m = Member(self, role)
        entry = self.entry(m.slot, "invite", role, m.e_pub, m.s_pub, self.env.clock.t + ttl)
        slots = {**self.slots, m.slot: entry}
        body = self.roster_body(slots=sorted(slots.values(), key=lambda e: e["id"]), **over)
        r = self.post_roster(body, new_slots=[m.new_slot_material()])
        assert r.status == 200, r
        self.invites[m.slot] = m
        return m

    def revoke(self, slot_id: str, new_epoch_commit=None):
        slots = [s for s in self.slots.values() if s["id"] != slot_id]
        epoch = self.epoch + 1
        commits = {**self.commits, epoch: b64(os.urandom(32))}
        body = self.roster_body(slots=sorted(slots, key=lambda e: e["id"]), epoch=epoch,
                                commit={"epochs": [{"c": c, "e": e} for e, c in sorted(commits.items())], "nk": self.nk_commit})
        return self.post_roster(body)

    # --- records ----------------------------------------------------------------------------------------------------------

    @staticmethod
    def rid(name: str) -> str:
        return b64(sha256(name.encode()))

    def put(self, name, *, size=100, epoch=None, if_match=None, if_none_match=False, commit=True, env_bytes=None,
            headers=None, rid=None, auth=None):
        rid = rid or self.rid(name)
        h = dict(auth or self.auth)
        if if_match is not None:
            h["If-Match"] = if_match if isinstance(if_match, str) else f'"{if_match}"'
        if if_none_match:
            h["If-None-Match"] = "*"
        if commit:
            h["WDS-Commit"] = b64(os.urandom(32))
        h.update(headers or {})
        data = env_bytes if env_bytes is not None else envelope(1, self.epoch if epoch is None else epoch, size)
        return self.c.put_bytes(f"{self.path}/records/{rid}", data, h)

    def get(self, name, rid=None, auth=None):
        return self.c.get(f"{self.path}/records/{rid or self.rid(name)}", auth or self.auth)

    def delete(self, name, if_match, auth=None):
        h = dict(auth or self.auth)
        if if_match is not None:
            h["If-Match"] = f'"{if_match}"'
        return self.c.delete(f"{self.path}/records/{self.rid(name)}", h)

    def put_ok(self, name, version=None, **kw):
        """Write the next version of a record; returns the response (asserting success)."""
        latest = self.record_versions.get(name)
        r = self.put(name, if_match=latest, if_none_match=latest is None, **kw)
        assert r.status in (200, 201), r
        self.record_versions[name] = r.json()["version"]
        return r


class Member:
    """An invited slot (fake keys)."""

    def __init__(self, vault: Vault, role: str):
        self.vault = vault
        self.role = role
        self.slot = b64(os.urandom(12))
        self.access_id = b32c_encode(os.urandom(12))
        self.token = os.urandom(32)
        self.e_pub = fake_pub(os.urandom(8).hex() + "e")
        self.s_pub = fake_pub(os.urandom(8).hex() + "s")
        self.new_e_pub = fake_pub(os.urandom(8).hex() + "e2")
        self.new_s_pub = fake_pub(os.urandom(8).hex() + "s2")

    @property
    def auth(self):
        return Vault.bearer(self.access_id, self.token)

    def new_slot_material(self) -> dict:
        return {"slot": self.slot, "access_id": self.access_id, "kdf": INVITE_KDF, "token_hash": b64(sha256(self.token)),
                "wrapped": b64(envelope(2, 0, 150))}

    def renewal(self, rv=None, **over) -> dict:
        body = {"e_pub": b64(self.new_e_pub), "rv": self.vault.version if rv is None else rv, "s_pub": b64(self.new_s_pub),
                "scope": self.vault.scope, "slot": self.slot, "type": "renewal", "v": 1, "vault": self.vault.vault}
        body.update(over)
        return {"body": body, "sig": b64(os.urandom(64))}

    def redeem(self, new_token=None, **over):
        self.new_token = new_token or os.urandom(32)
        body = {"kdf": kdf_doc(), "token_hash": b64(sha256(self.new_token)), "wrapped": b64(envelope(2, 0, 250)),
                "renewal": self.renewal()}
        body.update(over)
        r = self.vault.c.post_json(f"{API}/slots/{self.access_id}/redeem", body, self.auth)
        if r.status == 200:
            self.token = self.new_token
        return r


class ServerTestCase(unittest.TestCase):
    env_kwargs: dict = {}

    def setUp(self):
        self.env = Env(**self.env_kwargs)
        self.c = self.env.client

    def tearDown(self):
        self.env.close()

    def assertError(self, r, status, code):
        self.assertEqual(r.status, status, r)
        self.assertEqual(r.json().get("error"), code, r)
