"""The public sandbox: configuration, scope row, open enrollment, limits, eviction, no recovery, invites, nightly wipe, CLI."""

import contextlib
import datetime
import io
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from zoneinfo import ZoneInfo

from wds_server import cli, sandbox
from wds_server.config import SANDBOX_CREATOR, SandboxConfig, load_config
from wds_server.db import SCHEMA_VERSION
from wds_server.maintenance import run_maintenance
from wds_server.util import b32c_encode, b64u_encode, sha256

from .helpers import API, START_TIME, Member, ServerTestCase, Vault

SID = "sandbox-000000"


def sb(**kw) -> SandboxConfig:
    return SandboxConfig(scope_id=SID, **kw)


class SandboxCase(ServerTestCase):
    sandbox_kw: dict = {}

    def setUp(self):
        self.env_kwargs = {"config_overrides": {"sandbox": sb(**self.sandbox_kw)}}
        super().setUp()
        self.sb = self.env.config.sandbox

    def vault(self, **kw) -> Vault:
        v = Vault(self.env, SID)
        r = v.create(**kw)
        self.assertEqual(r.status, 201, r)
        return v

    def vault_ids(self):
        return {r[0] for r in self.env.sql("SELECT vault_id FROM vaults WHERE scope_id=?", (SID,))}

    def audit(self, action):
        return [tuple(r) for r in self.env.sql("SELECT vault_id, detail FROM audit WHERE action=? ORDER BY id", (action,))]


# -- configuration ---------------------------------------------------------------------------------------------------------


class Configuration(unittest.TestCase):
    def load(self, text: str):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "wds.ini")
            Path(path).write_text(text)
            return load_config(path)

    def test_no_section_means_no_sandbox(self):
        self.assertIsNone(self.load("[server]\nsweep_interval = 5\n").sandbox)

    def test_defaults(self):
        c = self.load(f"[sandbox]\nscope_id = {SID}\n").sandbox
        self.assertEqual((c.scope_id, c.enabled, c.wipe_time, c.timezone), (SID, True, "03:30", "Europe/Berlin"))
        self.assertEqual((c.max_value_bytes, c.vault_bytes, c.scope_bytes, c.max_vaults, c.history_versions),
                         (524288, 2097152, 1073741824, 500, 2))
        self.assertEqual((c.evict_min_age, c.create_per_ip, c.create_window, c.invite_slots), (1800, 20, 3600, 3))
        self.assertEqual(c.name, "WIAI Datastore sandbox")

    def test_values_and_inline_comments(self):
        c = self.load(f"[sandbox]\nscope_id = {SID}          ; required to enable\nenabled = false ; switch\nwipe_time = 04:15\n"
                      "timezone = UTC\nmax_vaults = 7\nname = Test sandbox\n").sandbox
        self.assertEqual((c.enabled, c.wipe_time, c.timezone, c.max_vaults, c.name), (False, "04:15", "UTC", 7, "Test sandbox"))
        self.assertEqual(c.scope_id, SID)

    def test_validation(self):
        ceilings = load_config(None).limit_ceilings
        for bad in ({"scope_id": "Not A Scope"}, {"wipe_time": "3:30"}, {"wipe_time": "24:00"}, {"timezone": "Nowhere/Land"},
                    {"max_vaults": 501}, {"max_value_bytes": 0}, {"evict_min_age": 0}, {"invite_slots": 0}):
            with self.assertRaises(ValueError, msg=bad):
                SandboxConfig(**{"scope_id": SID, **bad}).validate(ceilings)
        SandboxConfig(scope_id=SID).validate(ceilings)

    def test_the_example_file_documents_the_defaults(self):
        import re
        example = (Path(__file__).resolve().parents[1] / "config.example.ini").read_text()
        start = example.index("# [sandbox]")
        block = example[start:example.index("\n[escrow]", start)]
        # remove the comment marker of every setting line: all of them must parse and equal the built-in defaults
        text = re.sub(r"(?m)^# (?=\[sandbox\]|[a-z_]+ = )", "", block)
        c = self.load(text).sandbox
        self.assertEqual(c, SandboxConfig(scope_id=SID))
        self.assertIsNone(self.load(block).sandbox)  # as shipped, the section is off

    def test_section_without_scope_id_or_with_bad_values_is_refused(self):
        for text in ("[sandbox]\nenabled = true\n", f"[sandbox]\nscope_id = {SID}\nmax_vaults = many\n",
                     f"[sandbox]\nscope_id = {SID}\nenabled = maybe\n"):
            with self.assertRaises(ValueError, msg=text):
                self.load(text)


class Migration(SandboxCase):
    def test_meta_table_exists(self):
        self.assertEqual(SCHEMA_VERSION, 5)
        self.assertEqual(self.env.sql("PRAGMA user_version")[0][0], SCHEMA_VERSION)
        with self.env.svc.db.connection() as conn:
            self.assertIsNone(sandbox.meta_get(conn, "nope"))
            sandbox.meta_set(conn, "k", "1")
            sandbox.meta_set(conn, "k", "2")
            self.assertEqual(sandbox.meta_get(conn, "k"), "2")


# -- the scope row ---------------------------------------------------------------------------------------------------------


class ScopeRow(SandboxCase):
    def row(self):
        return dict(self.env.sql("SELECT * FROM scopes WHERE scope_id=?", (SID,))[0])

    def test_inserted_at_start(self):
        r = self.row()
        self.assertEqual((r["name"], r["status"], r["join_code"], r["creator"], r["deleted"]),
                         ("WIAI Datastore sandbox", "active", None, SANDBOX_CREATOR, None))
        self.assertEqual(r["description"], "Public sandbox (server config)")
        self.assertEqual(json.loads(r["limits"]), self.sb.limits())
        self.assertEqual(self.sb.limits()["history_versions"], 2)

    def test_updated_from_the_configuration(self):
        self.sb.name, self.sb.max_vaults = "Renamed", 9
        sandbox.ensure_sandbox(self.env.svc)
        r = self.row()
        self.assertEqual((r["name"], json.loads(r["limits"])["max_vaults"]), ("Renamed", 9))
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM scopes WHERE scope_id=?", (SID,))[0][0], 1)

    def test_changes_made_elsewhere_are_reset(self):
        # direct edits are what an operator could do with sqlite3
        with self.env.svc.db.connection() as conn:
            conn.execute("UPDATE scopes SET status='suspended', join_code='ABC12345' WHERE scope_id=?", (SID,))
        sandbox.ensure_sandbox(self.env.svc)
        r = self.row()
        self.assertEqual((r["status"], r["join_code"]), ("active", None))

    def test_foreign_scope_with_that_id_stops_the_start(self):
        self.sb.scope_id = "sandbox-000001"
        with self.env.svc.db.connection() as conn:
            conn.execute("INSERT INTO scopes (scope_id, name, status, limits, created, creator)"
                         " VALUES ('sandbox-000001', 'Mine', 'active', '{}', 1, 'alice')")
        with self.assertRaises(ValueError):
            sandbox.ensure_sandbox(self.env.svc)

    def test_start_is_refused_on_a_foreign_scope(self):
        from wds_server.app import create_app
        with self.env.svc.db.connection() as conn:
            conn.execute("UPDATE scopes SET creator='alice' WHERE scope_id=?", (SID,))
        with self.assertRaises(ValueError):
            create_app(self.env.config, self.env.svc.db_path)

    def test_removing_the_section_deletes_the_scope(self):
        v = self.vault()
        self.env.config.sandbox = None
        sandbox.ensure_sandbox(self.env.svc)
        self.assertIsNotNone(self.row()["deleted"])
        self.assertIsNotNone(self.env.sql("SELECT deleted FROM vaults WHERE vault_id=?", (v.vault,))[0][0])
        self.assertEqual(self.c.get(f"{API}/scopes/{SID}").status, 404)
        # putting the section back revives the row
        self.env.config.sandbox = self.sb
        sandbox.ensure_sandbox(self.env.svc)
        self.assertIsNone(self.row()["deleted"])

    def test_other_scopes_are_never_touched(self):
        scope = self.env.create_scope(slug="other")
        self.env.config.sandbox = None
        sandbox.ensure_sandbox(self.env.svc)
        self.assertEqual(self.c.get(f"{API}/scopes/{scope['scope']}").status, 200)

    def test_operator_api_cannot_change_it(self):
        r = self.c.patch_json(f"{API}/admin/scopes/{SID}", {"status": "suspended"}, self.env.op)
        self.assertError(r, 403, "sandbox_config")


# -- scope document and schedule -------------------------------------------------------------------------------------------


class Schedule(SandboxCase):
    def test_scope_document(self):
        d = self.c.get(f"{API}/scopes/{SID}").json()
        self.assertEqual(d["enrollment"], "open")  # only the sandbox is open
        self.assertNotIn("hibp", d)
        self.assertEqual(d["limits"]["max_value_bytes"], 524288)
        s = d["sandbox"]
        self.assertEqual(set(s), {"enabled", "wipe_at", "timezone", "next_wipe", "last_wipe"})
        self.assertEqual((s["enabled"], s["wipe_at"], s["timezone"], s["last_wipe"]), (True, "03:30", "Europe/Berlin", None))
        # START_TIME is 09:00 in Berlin: the next 03:30 is 18.5 hours away
        self.assertEqual(s["next_wipe"], START_TIME + int(18.5 * 3600))
        other = self.env.create_scope(slug="other")
        self.assertIsNone(self.c.get(f"{API}/scopes/{other['scope']}").json()["sandbox"])

    def test_last_wipe_after_a_wipe(self):
        run_maintenance(self.env.svc)
        d = self.c.get(f"{API}/scopes/{SID}").json()["sandbox"]
        self.assertEqual(d["last_wipe"], START_TIME - int(5.5 * 3600))

    def test_next_wipe_follows_daylight_saving_time(self):
        cfg = sb()
        berlin = ZoneInfo("Europe/Berlin")

        def at(y, m, d, h, mi):
            return int(datetime.datetime(y, m, d, h, mi, tzinfo=berlin).timestamp())

        # 2027-03-28: clocks go 02:00 -> 03:00; the day between the two wipes has 23 hours
        a = sandbox.wipe_instants(cfg, at(2027, 3, 27, 12, 0))
        self.assertEqual(a, (at(2027, 3, 27, 3, 30), at(2027, 3, 28, 3, 30)))
        self.assertEqual(a[1] - a[0], 23 * 3600)
        # 2027-10-31: clocks go 03:00 -> 02:00; 25 hours
        b = sandbox.wipe_instants(cfg, at(2027, 10, 30, 12, 0))
        self.assertEqual(b[1] - b[0], 25 * 3600)
        self.assertEqual(b[1], at(2027, 10, 31, 3, 30))
        # exactly at the instant, that instant is the latest one
        self.assertEqual(sandbox.wipe_instants(cfg, a[1])[0], a[1])
        self.assertEqual(sandbox.wipe_instants(cfg, a[1] - 1)[1], a[1])

    def test_other_timezone_and_time(self):
        cfg = sb(wipe_time="23:15", timezone="UTC")
        t = int(datetime.datetime(2027, 1, 15, 8, 0, tzinfo=datetime.timezone.utc).timestamp())
        self.assertEqual(sandbox.wipe_instants(cfg, t), (t - 8 * 3600 - 45 * 60, t + 15 * 3600 + 15 * 60))


# -- open enrollment and creation limits -----------------------------------------------------------------------------------


class Creation(SandboxCase):
    sandbox_kw = {"create_per_ip": 3}

    def test_open_without_join_code(self):
        r = Vault(self.env, SID).create()
        self.assertEqual(r.status, 201, r)

    def test_a_recovery_contact_is_refused_here_too(self):
        r = Vault(self.env, SID).create(mutate=lambda b: b.update(recovery_contact="me@uni-bamberg.de"))
        self.assertEqual(r.status, 400, r)

    def test_per_ip_limit(self):
        for _ in range(3):
            self.assertEqual(Vault(self.env, SID).create(ip="203.0.113.5").status, 201)
        r = Vault(self.env, SID).create(ip="203.0.113.5")
        self.assertError(r, 429, "rate_limited")
        self.assertGreater(int(r.headers["retry-after"]), 0)
        self.assertEqual(Vault(self.env, SID).create(ip="203.0.113.6").status, 201)
        self.env.clock.advance(3600)
        self.assertEqual(Vault(self.env, SID).create(ip="203.0.113.5").status, 201)

    def test_ipv6_clients_share_a_prefix(self):
        for host in ("1", "2", "3"):
            self.assertEqual(Vault(self.env, SID).create(ip="2001:db8:1:2::" + host).status, 201)
        self.assertError(Vault(self.env, SID).create(ip="2001:db8:1:2::ffff"), 429, "rate_limited")

    def test_other_scopes_are_not_limited_by_it(self):
        scope = self.env.create_scope(slug="other")
        for _ in range(5):
            self.assertEqual(Vault(self.env, scope["scope"]).create(ip="203.0.113.5").status, 201)


class CreationBudget(SandboxCase):
    sandbox_kw = {"create_per_ip": 3, "create_global": 5, "create_global_window": 600}

    def test_ipv6_clients_of_one_56_share_a_bucket(self):
        for sub in ("a", "b", "c"):  # three different /64 prefixes inside one /56
            self.assertEqual(Vault(self.env, SID).create(ip=f"2001:db8:1:{sub}0::1").status, 201)
        self.assertError(Vault(self.env, SID).create(ip="2001:db8:1:d0::1"), 429, "rate_limited")
        self.assertEqual(Vault(self.env, SID).create(ip="2001:db8:1:100::1").status, 201)  # another /56

    def test_global_budget_answers_503_with_retry_after_instead_of_evicting(self):
        for n in range(5):
            self.assertEqual(Vault(self.env, SID).create(ip=f"203.0.113.{n + 1}").status, 201)
        before = self.vault_ids()
        r = Vault(self.env, SID).create(ip="203.0.113.99")
        self.assertError(r, 503, "sandbox_busy")
        self.assertGreater(int(r.headers["retry-after"]), 0)
        self.assertLessEqual(int(r.headers["retry-after"]), 600)
        self.assertEqual(self.vault_ids(), before)
        self.env.clock.advance(601)
        self.assertEqual(Vault(self.env, SID).create(ip="203.0.113.99").status, 201)

    def test_a_vault_its_owner_deletes_gives_the_creation_back(self):
        vaults = [Vault(self.env, SID) for _ in range(3)]
        for v in vaults:
            self.assertEqual(v.create(ip="203.0.113.5").status, 201)
        self.assertError(Vault(self.env, SID).create(ip="203.0.113.5"), 429, "rate_limited")
        self.assertEqual(self.c.delete(vaults[0].path, vaults[0].auth, ip="203.0.113.5").status, 200)
        self.assertEqual(Vault(self.env, SID).create(ip="203.0.113.5").status, 201)

    def test_config_keys(self):
        c = sb()
        self.assertEqual((c.create_ipv6_prefix, c.create_global, c.create_global_window), (56, 60, 600))
        for bad in ({"create_ipv6_prefix": 16}, {"create_ipv6_prefix": 65}, {"create_global": 0}, {"create_global_window": 0}):
            with self.assertRaises(ValueError):
                sb(**bad).validate(self.env.config.limit_ceilings)


class Eviction(SandboxCase):
    sandbox_kw = {"max_vaults": 3, "create_per_ip": 100}

    def three(self):
        out = []
        for _ in range(3):
            out.append(self.vault())
            self.env.clock.advance(10)
        return out

    def test_young_vaults_are_never_evicted(self):
        self.three()
        self.env.clock.advance(100)
        r = Vault(self.env, SID).create()
        self.assertError(r, 403, "vault_limit_reached")
        self.assertEqual(len(self.vault_ids()), 3)

    def test_oldest_vault_older_than_the_minimum_age_makes_room(self):
        a, b, c = self.three()
        a.put_ok("x", size=300)
        self.env.clock.advance(1800)
        d = Vault(self.env, SID)
        self.assertEqual(d.create().status, 201)
        self.assertEqual(self.vault_ids(), {b.vault, c.vault, d.vault})
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM record_versions WHERE vault_id=?", (a.vault,))[0][0], 0)
        self.assertEqual(self.audit("sandbox_evicted"), [(a.vault, "capacity")])
        self.assertEqual(self.c.get(a.path + "/usage", a.auth).status, 401)

    def test_a_write_over_the_scope_quota_evicts_the_oldest_vault(self):
        a, b, c = self.three()
        self.env.clock.advance(2000)
        roster = self.env.sql("SELECT roster_bytes FROM vaults WHERE vault_id=?", (c.vault,))[0][0]
        self.sb.scope_bytes = 3 * roster + 1000
        sandbox.ensure_sandbox(self.env.svc)
        r = c.put("x", size=1500, if_none_match=True)
        self.assertEqual(r.status, 201, r)
        self.assertEqual(self.vault_ids(), {b.vault, c.vault})
        self.assertEqual(self.audit("sandbox_evicted"), [(a.vault, "capacity")])

    def test_a_write_that_cannot_fit_even_after_evicting_fails_and_keeps_everything(self):
        a, b, c = self.three()
        self.env.clock.advance(2000)
        roster = self.env.sql("SELECT roster_bytes FROM vaults WHERE vault_id=?", (c.vault,))[0][0]
        self.sb.scope_bytes = 3 * roster + 1000
        sandbox.ensure_sandbox(self.env.svc)
        r = c.put("x", size=3 * roster + 5000, if_none_match=True)
        self.assertError(r, 507, "quota_exceeded")
        self.assertEqual(self.vault_ids(), {a.vault, b.vault, c.vault})  # the eviction rolled back with the write

    def test_the_writer_is_never_its_own_victim(self):
        a, b, c = self.three()
        self.env.clock.advance(2000)
        self.sb.scope_bytes = 1
        sandbox.ensure_sandbox(self.env.svc)
        self.assertError(a.put("x", size=100, if_none_match=True), 507, "quota_exceeded")
        self.assertIn(a.vault, self.vault_ids())

    def test_a_vault_that_was_written_recently_is_not_evicted(self):
        a, b, c = self.three()
        self.env.clock.advance(1800)
        a.put_ok("x", size=300)   # a is the oldest vault, but somebody is working in it right now
        d = Vault(self.env, SID)
        self.assertEqual(d.create().status, 201)
        self.assertEqual(self.vault_ids(), {a.vault, c.vault, d.vault})   # b was the oldest vault nobody touched

    def test_owner_delete_purges_at_once(self):
        a, b, c = self.three()
        a.put_ok("x", size=300)
        r = self.c.delete(a.path, a.auth)
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json()["purge_after"], r.json()["deleted"])
        self.assertNotIn(a.vault, self.vault_ids())
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM record_versions WHERE vault_id=?", (a.vault,))[0][0], 0)
        self.assertEqual(self.audit("vault_deleted"), [(a.vault, "owner")])
        # the access ID is still never reused
        again = Vault(self.env, SID)
        again.access_id = a.access_id
        self.assertError(again.create(), 409, "access_id_taken")
        self.assertEqual(Vault(self.env, SID).create().status, 201)  # the count is free again, nothing needed evicting

    def test_a_normal_scope_still_refuses_instead_of_evicting(self):
        scope = self.env.create_scope(slug="small", limits={"max_vaults": 1})
        self.env.new_vault(scope)
        self.env.clock.advance(100000)
        self.assertError(Vault(self.env, scope["scope"]).create(), 403, "vault_limit_reached")


# -- no recovery -----------------------------------------------------------------------------------------------------------


class NoRecovery(SandboxCase):
    def test_every_operator_recovery_endpoint_refuses(self):
        v = self.vault()
        base = f"{API}/admin/vaults/{v.vault}"
        for r in (self.c.post_json(base + "/recovery", {"recovery_code": "0" * 28}, self.env.op),
                  self.c.delete(base + "/recovery", self.env.op),
                  self.c.get(base + "/escrow", self.env.op),
                  self.c.post_json(base + "/recovery/complete", {"roster": {}, "keyring": {}}, self.env.op)):
            self.assertError(r, 409, "sandbox_no_recovery")
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM recoveries")[0][0], 0)
        self.assertEqual(self.c.get(base, self.env.op).status, 200)  # the status call stays

    def test_normal_vaults_are_not_affected(self):
        v = self.env.new_vault()
        r = self.c.post_json(f"{API}/admin/vaults/{v.vault}/recovery", {"recovery_code": b32c_encode(v.recovery_code)}, self.env.op)
        self.assertEqual(r.status, 201, r)


# -- invites ---------------------------------------------------------------------------------------------------------------


class Invites(SandboxCase):
    def try_invite(self, v: Vault, ttl=3600, role="write"):
        m = Member(v, role)
        entry = v.entry(m.slot, "invite", role, m.e_pub, m.s_pub, self.env.clock.t + ttl)
        slots = {**v.slots, m.slot: entry}
        body = v.roster_body(slots=sorted(slots.values(), key=lambda e: e["id"]))
        return v.post_roster(body, new_slots=[m.new_slot_material()]), m

    def test_three_invites_then_the_limit(self):
        v = self.vault()
        for _ in range(3):
            r, _ = self.try_invite(v)
            self.assertEqual(r.status, 200, r)
        r, _ = self.try_invite(v)
        self.assertError(r, 409, "invite_limit")
        self.assertEqual(r.json()["limit"], 3)

    def test_redeemed_invites_count_too_and_revoked_ones_do_not(self):
        v = self.vault()
        members = []
        for _ in range(3):
            r, m = self.try_invite(v)
            self.assertEqual(r.status, 200, r)
            members.append(m)
        self.assertEqual(members[0].redeem().status, 200)
        self.assertError(self.try_invite(v)[0], 409, "invite_limit")
        self.assertEqual(v.revoke(members[1].slot).status, 200)  # new epoch; the revoked invite no longer counts
        self.assertEqual(self.try_invite(v)[0].status, 200)

    def test_expiry_is_capped_at_the_next_wipe(self):
        v = self.vault()
        r, _ = self.try_invite(v, ttl=2 * 86400)
        self.assertError(r, 400, "invalid_roster")
        self.assertIn("wipe", r.json()["detail"])
        r, _ = self.try_invite(v, ttl=int(18.5 * 3600))  # exactly the next wipe
        self.assertEqual(r.status, 200, r)

    def test_normal_scopes_keep_their_rules(self):
        v = self.env.new_vault()
        for _ in range(4):
            r, _ = self.try_invite(v, ttl=2 * 86400)
            self.assertEqual(r.status, 200, r)


class Disabled(SandboxCase):
    sandbox_kw = {"enabled": False}

    def test_creates_are_refused(self):
        r = Vault(self.env, SID).create()
        self.assertError(r, 503, "sandbox_disabled")
        self.assertNotIn("retry-after", r.headers)
        d = self.c.get(f"{API}/scopes/{SID}").json()
        self.assertFalse(d["sandbox"]["enabled"])

    def test_redeems_are_refused(self):
        self.sb.enabled = True
        v = self.vault()
        m = v.invite()
        self.sb.enabled = False
        self.assertError(m.redeem(), 503, "sandbox_disabled")
        self.assertEqual(self.c.get(v.path + "/usage", v.auth).status, 200)  # existing vaults keep working

    def test_other_scopes_work(self):
        self.assertEqual(self.env.new_vault().vault is not None, True)


# -- nightly wipe ----------------------------------------------------------------------------------------------------------


class Wipe(SandboxCase):
    def maint(self):
        return run_maintenance(self.env.svc)

    def last(self):
        with self.env.svc.db.connection() as conn:
            return sandbox.last_wipe(conn)

    def test_not_due_spares_vaults_created_after_the_scheduled_instant(self):
        v = self.vault()  # 09:00 local, after the 03:30 of the same day
        stats = self.maint()
        self.assertEqual(stats["sandbox_vaults"], 0)
        self.assertIn(v.vault, self.vault_ids())
        self.assertEqual(self.last(), START_TIME - int(5.5 * 3600))
        self.env.clock.advance(3600)
        self.assertEqual(self.maint()["sandbox_vaults"], 0)

    def test_due_purges_older_vaults_once_per_night(self):
        old = self.vault()
        old.put_ok("x", size=400)
        soft = self.vault()
        # a soft-deleted sandbox vault (dashboard delete) is wiped, too
        with self.env.svc.db.connection() as conn:
            conn.execute("UPDATE vaults SET deleted=? WHERE vault_id=?", (START_TIME, soft.vault))
        other = self.env.new_vault()
        other.put_ok("x", size=400)
        self.maint()
        self.env.clock.advance(int(18.5 * 3600) + 300)  # 03:35 the next night
        fresh = self.vault()  # created after the instant: survives this night
        self.env.clock.advance(60)
        stats = self.maint()
        self.assertEqual(stats["sandbox_vaults"], 2)
        self.assertEqual(self.vault_ids(), {fresh.vault})
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM record_versions WHERE vault_id=?", (old.vault,))[0][0], 0)
        self.assertEqual(self.c.get(other.path + "/usage", other.auth).status, 200)  # other scopes untouched
        self.assertEqual(self.last(), START_TIME + int(18.5 * 3600))
        self.assertEqual(self.c.get(f"{API}/scopes/{SID}").json()["sandbox"]["last_wipe"], START_TIME + int(18.5 * 3600))
        self.assertEqual([d for _, d in self.audit("sandbox_wiped")][-1], "2")
        # a second sweep the same night does nothing, even with new vaults
        self.assertEqual(self.maint()["sandbox_vaults"], 0)
        self.assertEqual(self.vault_ids(), {fresh.vault})
        # the next night takes the survivor
        self.env.clock.advance(86400)
        self.assertEqual(self.maint()["sandbox_vaults"], 1)
        self.assertEqual(self.vault_ids(), set())

    def test_access_ids_are_never_reused_after_a_wipe(self):
        v = self.vault()
        self.maint()
        self.env.clock.advance(86400)
        self.maint()
        self.assertEqual(self.vault_ids(), set())
        again = Vault(self.env, SID)
        again.access_id = v.access_id
        self.assertError(again.create(), 409, "access_id_taken")

    def test_wipe_without_a_sandbox_does_nothing(self):
        self.env.config.sandbox = None
        self.assertEqual(self.maint()["sandbox_vaults"], 0)

    def test_marker_survives_a_failed_wipe(self):
        a, b = self.vault(), self.vault()
        self.env.clock.advance(86400)
        real = sandbox.purge_vault
        calls = []

        def flaky(*args, **kw):
            calls.append(args[2])
            if len(calls) == 2:
                raise RuntimeError("disk full")
            return real(*args, **kw)

        sandbox.purge_vault = flaky
        try:
            with self.assertRaises(RuntimeError):
                self.maint()
        finally:
            sandbox.purge_vault = real
        self.assertEqual(len(self.vault_ids()), 1)  # one vault was purged in its own transaction
        self.assertNotEqual(self.last(), START_TIME + 86400)
        self.assertEqual(self.maint()["sandbox_vaults"], 1)  # the next sweep finishes the job
        self.assertEqual(self.vault_ids(), set())


class Cli(SandboxCase):
    def setUp(self):
        super().setUp()
        e = b64u_encode(b"\x04" + bytes(64))
        s = b64u_encode(b"\x04" + bytes([1]) * 64)
        self.ini = os.path.join(self.env.tmp, "cli.ini")
        Path(self.ini).write_text(f"[escrow]\ncurrent_e_pub={e}\ncurrent_s_pub={s}\nspare_e_pub={s}\nspare_s_pub={e}\n"
                                  f"[operator]\ntoken_hashes={b64u_encode(sha256(b'x'))}\n[sandbox]\nscope_id = {SID}\n")
        self.env.clock.t = int(time.time()) - 600

    def run_cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(list(argv) + ["--db", self.env.svc.db_path, "--config", self.ini])
        return code, out.getvalue()

    def test_status_and_wipe(self):
        a, b = self.vault(), self.vault()
        other = self.env.new_vault()
        code, out = self.run_cli("sandbox", "status")
        d = json.loads(out)
        self.assertEqual((code, d["configured"], d["scope"], d["vaults"], d["enabled"], d["last_wipe"]), (0, True, SID, 2, True, None))
        self.assertGreater(d["bytes"], 0)
        code, out = self.run_cli("sandbox", "wipe")
        self.assertEqual((code, json.loads(out)), (0, {"purged_vaults": 2}))
        self.assertEqual(self.vault_ids(), set())
        self.assertEqual(self.c.get(other.path + "/usage", other.auth).status, 200)
        self.assertGreater(json.loads(self.run_cli("sandbox", "status")[1])["last_wipe"], 0)
        # the sweep that follows does not wipe a second time
        self.vault()
        self.env.clock.advance(60)
        self.assertEqual(run_maintenance(self.env.svc)["sandbox_vaults"], 0)

    def test_maintenance_command_ensures_the_scope(self):
        with self.env.svc.db.connection() as conn:
            conn.execute("DELETE FROM scopes WHERE scope_id=?", (SID,))
        code, out = self.run_cli("maintenance")
        self.assertEqual(code, 0)
        self.assertEqual(self.env.sql("SELECT creator FROM scopes WHERE scope_id=?", (SID,))[0][0], SANDBOX_CREATOR)

    def test_wipe_without_a_section_fails(self):
        Path(self.ini).write_text(Path(self.ini).read_text().split("[sandbox]")[0])
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code, _ = self.run_cli("sandbox", "wipe")
        self.assertEqual(code, 1)
        self.assertIn("sandbox", err.getvalue())


class StaticHashes(ServerTestCase):
    def test_hashes_json_is_public(self):
        dist = self.env.config.client_dir
        body = json.dumps({"1.0.0": {"file": "wds-1.0.0.js", "sri": "sha384-x"}})
        Path(dist, "hashes.json").write_text(body)
        r = self.c.get("/datastore/client/hashes.json")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.headers["content-type"], "application/json")
        self.assertEqual(r.headers["cache-control"], "no-cache")
        self.assertEqual(r.headers["access-control-allow-origin"], "*")
        self.assertEqual(r.headers["cross-origin-resource-policy"], "cross-origin")
        self.assertEqual(r.json()["1.0.0"]["sri"], "sha384-x")
        self.assertEqual(self.c.request("OPTIONS", "/datastore/client/hashes.json").status, 204)

    def test_missing_file_and_other_names(self):
        self.assertEqual(self.c.get("/datastore/client/hashes.json").status, 404)
        Path(self.env.config.client_dir, "other.json").write_text("{}")
        self.assertEqual(self.c.get("/datastore/client/other.json").status, 404)
        Path(self.env.config.client_dir, "wds-1.0.0.js").write_text("x")
        r = self.c.get("/datastore/client/wds-1.0.0.js")
        self.assertEqual(r.headers["cache-control"], "public, max-age=31536000, immutable")


if __name__ == "__main__":
    unittest.main()
