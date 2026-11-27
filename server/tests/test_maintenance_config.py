import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from wds_server.config import load_config
from wds_server.db import SCHEMA_VERSION, Database
from wds_server.maintenance import run_maintenance
from wds_server.util import b64u_encode, sha256

from .helpers import API, ESCROW_KEYS, ServerTestCase, Vault, b64

SERVER_DIR = Path(__file__).resolve().parents[1]


class Maintenance(ServerTestCase):
    def maint(self):
        return run_maintenance(self.env.svc)

    def test_empty_vaults_purged_after_seven_days(self):
        scope = self.env.create_scope()
        empty = self.env.new_vault(scope)
        used = self.env.new_vault(scope)
        used.put_ok("a")
        deleted_record = self.env.new_vault(scope)
        deleted_record.put_ok("a")
        deleted_record.delete("a", 1)  # a tombstone still means the vault has had records
        self.env.clock.advance(7 * 86400 - 1)
        self.assertEqual(self.maint()["empty_vaults"], 0)
        self.env.clock.advance(1)
        self.assertEqual(self.maint()["empty_vaults"], 1)
        self.assertError(self.c.get(f"{API}/slots/{empty.access_id}", empty.auth), 401, "unauthorized")
        self.assertEqual(self.c.get(f"{API}/slots/{used.access_id}", used.auth).status, 200)
        self.assertEqual(self.c.get(f"{API}/slots/{deleted_record.access_id}", deleted_record.auth).status, 200)
        for table in ("rosters", "slots", "keyring", "slot_ids"):
            self.assertEqual(self.env.sql(f"SELECT COUNT(*) FROM {table} WHERE vault_id=?", (empty.vault,))[0][0], 0, table)
        audit = self.env.sql("SELECT action, detail FROM audit WHERE vault_id=? ORDER BY id DESC LIMIT 1", (empty.vault,))
        self.assertEqual(tuple(audit[0]), ("vault_purged", "empty"))

    def test_soft_deleted_vaults_purged_after_thirty_days(self):
        v = self.env.new_vault()
        v.put_ok("a", size=500)
        scope_before = self.env.sql("SELECT COUNT(*) FROM record_versions")[0][0]
        self.assertEqual(scope_before, 1)
        self.c.delete(v.path, v.auth)
        self.env.clock.advance(30 * 86400 - 1)
        self.assertEqual(self.maint()["deleted_vaults"], 0)
        self.assertEqual(self.c.get(v.path + "/usage", v.auth).status, 410)
        self.env.clock.advance(1)
        self.assertEqual(self.maint()["deleted_vaults"], 1)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM record_versions")[0][0], 0)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM vaults")[0][0], 0)
        # the vault ID can be created again (it is self-certifying and was purged)
        self.assertEqual(self.c.get(f"{API}/admin/vaults/{v.vault}", self.env.op).status, 404)

    def test_deleted_vault_counts_against_scope_quota_until_purged(self):
        [a] = self.env.quota_scope(scope_bytes=1000, vault_bytes=1000)
        scope = {"scope": a.scope}
        a.put_ok("x", size=900)
        self.c.delete(a.path, a.auth)
        b = self.env.new_vault(scope)
        self.assertEqual(b.put("x", size=500, if_none_match=True).status, 507)
        self.env.clock.advance(30 * 86400)
        self.maint()  # purges the deleted vault (and the empty vault b)
        c = self.env.new_vault(scope)
        self.assertEqual(c.put("x", size=500, if_none_match=True).status, 201)

    def test_deleted_vault_does_not_count_for_vault_limit(self):
        scope = self.env.create_scope(limits={"max_vaults": 1})
        a = self.env.new_vault(scope)
        self.assertError(Vault(self.env, scope["scope"]).create(), 403, "vault_limit_reached")
        self.c.delete(a.path, a.auth)
        self.assertEqual(Vault(self.env, scope["scope"]).create().status, 201)

    def test_sweep_prunes_histories_after_limit_change(self):
        scope = self.env.create_scope(limits={"history_versions": 10})
        v = self.env.new_vault(scope)
        for _ in range(6):
            v.put_ok("a", size=100)
        self.env.clock.advance(1000)
        self.c.patch_json(f"{API}/admin/scopes/{scope['scope']}", {"limits": {"history_versions": 2}}, self.env.op)
        stats = self.maint()
        self.assertEqual((stats["pruned_versions"], stats["freed_bytes"]), (1, 400))
        h = self.c.get(f"{v.path}/records/{Vault.rid('a')}/versions", v.auth).json()
        self.assertEqual([x["version"] for x in h["versions"]], [6, 5])
        self.assertEqual(self.c.get(v.path + "/usage", v.auth).json()["bytes"], 200)

    def test_sweep_respects_ten_minute_floor(self):
        scope = self.env.create_scope(limits={"history_versions": 10})
        v = self.env.new_vault(scope)
        for _ in range(4):
            v.put_ok("a")
        self.c.patch_json(f"{API}/admin/scopes/{scope['scope']}", {"limits": {"history_versions": 1}}, self.env.op)
        self.assertEqual(self.maint()["freed_bytes"], 0)
        self.env.clock.advance(600)
        self.assertEqual(self.maint()["freed_bytes"], 300)


class Database_(unittest.TestCase):
    def test_migration_sets_version_and_pragmas(self):
        with tempfile.TemporaryDirectory() as d:
            db = Database(os.path.join(d, "x.db"))
            with db.connection() as conn:
                self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
                self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0], "wal")
                self.assertEqual(conn.execute("PRAGMA secure_delete").fetchone()[0], 1)
                self.assertEqual(conn.execute("PRAGMA auto_vacuum").fetchone()[0], 2)  # incremental
                self.assertEqual(conn.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            db.close()
            db = Database(os.path.join(d, "x.db"))  # reopening is a no-op
            db.close()

    def test_newer_schema_is_refused(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "x.db")
            conn = sqlite3.connect(path)
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
            conn.close()
            with self.assertRaises(RuntimeError):
                Database(path)


class ConfigLoading(unittest.TestCase):
    def test_ini(self):
        e, s = b64u_encode(b"\x04" + bytes(64)), b64u_encode(b"\x04" + bytes([1]) * 64)
        token_hash = b64u_encode(sha256(b"wdsop.x"))
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "wds.ini")
            Path(path).write_text(f"""
[server]
read_only_threshold = 0.9
client_dir = /srv/client
library_latest = 2.0.0
library_deprecated = 1.0.0, 1.1.0
privacy_url = https://example.org/p
sweep_interval = 60
[limits.defaults]
max_vaults = 20
[limits.ceilings]
max_vaults = 100
[ratelimit]
ip_failures = 5
create = 7
[escrow]
current_e_pub = {e}
current_s_pub = {s}
spare_e_pub = {s}
spare_s_pub = {e}
[operator]
token_hashes = {token_hash} {sha256(b"y").hex()}
""")
            cfg = load_config(path)
        cfg.validate()
        self.assertEqual(cfg.read_only_threshold, 0.9)
        self.assertEqual(cfg.library_deprecated, ["1.0.0", "1.1.0"])
        self.assertEqual((cfg.limit_defaults["max_vaults"], cfg.limit_ceilings["max_vaults"]), (20, 100))
        self.assertEqual(cfg.limit_defaults["vault_bytes"], 209715200)
        self.assertEqual((cfg.rate_ip_failures, cfg.rate_create, cfg.rate_id_failures), (5, 7, 10))
        self.assertEqual([x.status for x in cfg.escrow], ["current", "spare"])
        self.assertEqual(len(cfg.operator_token_hashes), 2)
        self.assertEqual(cfg.operator_token_hashes[0], sha256(b"wdsop.x"))
        self.assertEqual(cfg.privacy_link, "https://example.org/p")

    def test_validation(self):
        from wds_server.config import Config
        with self.assertRaises(ValueError):
            Config().validate()  # no escrow keys


class RealServer(unittest.TestCase):
    """Starts the real server with uvicorn and talks to it over HTTP, and exercises the dev CLI."""

    def test_end_to_end_over_http(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d, "wds.ini")
            e, s = (b64u_encode(b"\x04" + bytes([i]) * 64) for i in (1, 2))
            e2, s2 = (b64u_encode(b"\x04" + bytes([i]) * 64) for i in (3, 4))
            cfg.write_text(f"[server]\nread_only_threshold=1.0\npwned_url=http://127.0.0.1:1/range\n[escrow]\ncurrent_e_pub={e}\ncurrent_s_pub={s}\nspare_e_pub={e2}\nspare_s_pub={s2}\n"
                           f"[operator]\ntoken_hashes={b64u_encode(sha256(b'wdsop.unused'))}\n")
            db = os.path.join(d, "t.db")
            env = {**os.environ, "PYTHONPATH": str(SERVER_DIR)}
            out = subprocess.run([sys.executable, "-m", "wds_server.cli", "create-scope", "--db", db, "--config", str(cfg),
                                  "--slug", "cli-app", "--name", "CLI App", "--join-code", "abcd-2345"],
                                 capture_output=True, text=True, env=env, cwd=d, check=True)
            scope = json.loads(out.stdout)
            self.assertRegex(scope["scope"], r"^cli-app-")
            self.assertEqual((scope["join_code"], scope["enrollment"]), ("ABCD2345", "join_code"))
            # the operator changes limits on the command line (the dashboard only shows them)
            out = subprocess.run([sys.executable, "-m", "wds_server.cli", "limits", "--db", db, "--config", str(cfg), "--scope",
                                  scope["scope"], "--limit", "max_vaults=7", "--limit", "history_versions=3"],
                                 capture_output=True, text=True, env=env, cwd=d, check=True)
            self.assertEqual((json.loads(out.stdout)["max_vaults"], json.loads(out.stdout)["history_versions"]), (7, 3))
            out = subprocess.run([sys.executable, "-m", "wds_server.cli", "limits", "--db", db, "--config", str(cfg), "--scope",
                                  scope["scope"], "--limit", "max_vaults=default"], capture_output=True, text=True, env=env, cwd=d, check=True)
            self.assertEqual(json.loads(out.stdout)["max_vaults"], 50)
            out = subprocess.run([sys.executable, "-m", "wds_server.cli", "limits", "--db", db, "--config", str(cfg), "--scope",
                                  scope["scope"], "--limit", "max_vaults=99999"], capture_output=True, text=True, env=env, cwd=d)
            self.assertEqual(out.returncode, 1)
            self.assertIn("bad_request", out.stderr)
            token = subprocess.run([sys.executable, "-m", "wds_server.cli", "operator-token"], capture_output=True, text=True,
                                   env=env, cwd=d, check=True).stdout
            self.assertIn("wdsop.", token)
            out = subprocess.run([sys.executable, "-m", "wds_server.cli", "maintenance", "--db", db, "--config", str(cfg)],
                                 capture_output=True, text=True, env=env, cwd=d, check=True)
            self.assertEqual(json.loads(out.stdout)["empty_vaults"], 0)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            proc = subprocess.Popen([sys.executable, "-m", "wds_server", "--db", db, "--host", "127.0.0.1", "--port", str(port),
                                     "--config", str(cfg)], env=env, cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            try:
                base = f"http://127.0.0.1:{port}/datastore"
                for _ in range(100):
                    try:
                        urllib.request.urlopen(base + "/healthz", timeout=1)
                        break
                    except OSError:
                        time.sleep(0.1)
                with urllib.request.urlopen(base + "/healthz") as r:
                    self.assertEqual(json.loads(r.read()), {"status": "ok", "read_only": False})
                    self.assertNotIn("server", {k.lower() for k in r.headers.keys()})
                with urllib.request.urlopen(f"{base}/api/v1/scopes/{scope['scope']}") as r:
                    self.assertEqual(r.headers["Access-Control-Allow-Origin"], "*")
                    self.assertEqual(json.loads(r.read())["name"], "CLI App")
                # the breach check with the service unreachable (outbound access blocked): a fast 503 for the library's fallback, the rest unharmed
                try:
                    urllib.request.urlopen(f"{base}/api/v1/pwned/21BD1", timeout=10)
                    self.fail("expected a 503")
                except urllib.error.HTTPError as err:
                    self.assertEqual((err.code, json.loads(err.read())["error"], err.headers["Retry-After"]), (503, "pwned_unavailable", "60"))
                    self.assertEqual(err.headers["Access-Control-Allow-Origin"], "*")
                with urllib.request.urlopen(f"{base}/healthz") as r:
                    self.assertEqual(r.status, 200)
                req = urllib.request.Request(f"{base}/api/v1/vaults/x/roster", method="OPTIONS")
                with urllib.request.urlopen(req) as r:
                    self.assertEqual(r.status, 204)
                # an oversized upload with a wrong token is answered before the body is read
                with socket.create_connection(("127.0.0.1", port), timeout=5) as raw:
                    raw.sendall(b"PUT /datastore/api/v1/vaults/AAAAAAAAAAAAAAAAAAAAAAAAAA/records/" + b"A" * 43 +
                                b" HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\n"
                                b"Content-Length: 99999999\r\nAuthorization: Bearer wds1.x.y\r\n\r\n")
                    head = raw.recv(4096)
                self.assertTrue(head.startswith(b"HTTP/1.1 401"), head)
                self.assertIn(b"access-control-allow-origin: *", head.lower())
                try:
                    urllib.request.urlopen(f"{base}/api/v1/slots/000G40R40M30E209185Z")
                except urllib.error.HTTPError as err:
                    self.assertEqual(err.code, 401)
                    self.assertEqual(json.loads(err.read())["error"], "unauthorized")
            finally:
                proc.terminate()
                proc.wait(timeout=10)
                proc.stdout.close()
