"""Regression tests for the review findings: unredeemed invites, roster growth, owner invites after recovery,
kdf lookups under the rate limiter, retired access IDs, kdf of deleted vaults, audit of failed operator calls."""

import os
import sqlite3
import tempfile
import unittest
from unittest import mock

from wds_server import ratelimit
from wds_server.auth import authenticate_slot, reverify
from wds_server.db import MIGRATIONS, Database
from wds_server.errors import ApiError
from wds_server.maintenance import run_maintenance
from wds_server.util import b32c_encode

from .helpers import API, Member, ServerTestCase, Vault, b64, envelope


class UnredeemedInvites(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.v = self.env.new_vault()
        self.v.put_ok("a")

    def _recovery_owner_invite(self):
        url = f"{API}/admin/vaults/{self.v.vault}"
        r = self.c.post_json(url + "/recovery", {"recovery_code": b32c_encode(self.v.recovery_code)}, self.env.op)
        self.assertEqual(r.status, 201, r)
        self.env.clock.advance(259200)
        m = Member(self.v, "owner")
        entry = self.v.entry(m.slot, "invite", "owner", m.e_pub, m.s_pub, self.env.clock.t + 3600)
        slots = sorted([*self.v.slots.values(), entry], key=lambda s: s["id"])
        body = self.v.roster_body(slots=slots, signer=self.v.escrow_slot)
        payload = {"roster": self.v.sign(body), "keyring": self.v.keyring_for([s["id"] for s in slots]),
                   "new_slots": [m.new_slot_material()]}
        r = self.c.post_json(url + "/recovery/complete", payload, self.env.op)
        self.assertEqual(r.status, 200, r)
        self.v.version, self.v.head = body["version"], self.v.hash_of(body)
        self.v.slots = {s["id"]: s for s in slots}
        return m

    def assertAllRefused(self, m):
        h, p = m.auth, self.v.path
        rid = Vault.rid("a")
        calls = [
            self.c.get(p + "/records", h), self.c.get(f"{p}/records/{rid}", h), self.c.get(f"{p}/records/{rid}/versions", h),
            self.c.get(p + "/usage", h), self.c.get(p + "/rekey", h),
            self.v.put("a", if_match=1, auth=h), self.v.put("new", if_none_match=True, auth=h),
            self.v.delete("a", 1, auth=h),
            self.c.delete(f"{p}/records/{rid}/versions", h),
            self.c.post_json(p + "/roster", {}, h), self.c.delete(p + "/recovery", h), self.c.delete(p, h),
        ]
        for r in calls:
            self.assertError(r, 403, "forbidden")
        # nothing happened
        self.assertEqual(self.v.put_ok("a", size=100).status, 200)
        self.assertIsNone(self.env.sql("SELECT deleted FROM vaults WHERE vault_id=?", (self.v.vault,))[0][0])

    def test_write_invite_cannot_use_vault_endpoints_until_redeemed(self):
        m = self.v.invite(role="write")
        self.assertAllRefused(m)
        # what the redeem flow needs still works
        self.assertEqual(self.c.get(f"{API}/slots/{m.access_id}", m.auth).status, 200)
        self.assertEqual(self.c.get(self.v.path + "/roster", m.auth).status, 200)
        self.assertEqual(m.redeem().status, 200)
        self.assertEqual(self.c.get(self.v.path + "/records", m.auth).status, 200)
        self.assertEqual(self.v.put("b", if_none_match=True, auth=m.auth).status, 201)

    def test_unredeemed_recovery_owner_invite_cannot_delete_or_cancel(self):
        m = self._recovery_owner_invite()
        self.assertAllRefused(m)
        self.assertEqual(self.c.get(f"{API}/slots/{m.access_id}", m.auth).status, 200)
        self.assertEqual(m.redeem().status, 200)
        self.assertEqual(self.c.get(self.v.path + "/usage", m.auth).status, 200)

    def test_slot_endpoints_keep_their_own_answers_for_unredeemed_invites(self):
        m = self.v.invite(role="read")
        r = self.c.put_json(f"{API}/slots/{m.access_id}", {"kdf": {}, "token_hash": b64(os.urandom(32)), "wrapped": b64(envelope(2, 0, 200))},
                            {**m.auth, "If-Match": '"1"'})
        self.assertEqual(r.status, 400)  # body validation first, as before; never 403
        from .helpers import kdf_doc
        r = self.c.put_json(f"{API}/slots/{m.access_id}", {"kdf": kdf_doc(), "token_hash": b64(os.urandom(32)),
                            "wrapped": b64(envelope(2, 0, 200))}, {**m.auth, "If-Match": '"1"'})
        self.assertError(r, 409, "not_redeemed")

    def test_reverify_rejects_unredeemed_unless_opted_in(self):
        m = self.v.invite(role="write")
        svc = self.env.svc
        with svc.db.connection() as conn:
            auth = authenticate_slot(svc, conn, "1.1.1.1", f"Bearer wds1.{m.access_id}.{b64(m.token)}", allow_unredeemed=True)
            with self.assertRaises(ApiError) as ctx:
                reverify(conn, auth)
            self.assertEqual((ctx.exception.status, ctx.exception.code), (403, "forbidden"))
            reverify(conn, auth, allow_unredeemed=True)
            with self.assertRaises(ApiError):
                authenticate_slot(svc, conn, "1.1.1.1", f"Bearer wds1.{m.access_id}.{b64(m.token)}")


class RosterGrowth(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.v = self.env.new_vault()

    def test_noop_versions_are_rejected(self):
        self.assertError(self.v.post_roster(), 400, "invalid_roster")
        self.env.clock.advance(60)
        self.assertError(self.v.post_roster(), 400, "invalid_roster")  # only the time differs
        self.assertEqual(self.env.sql("SELECT roster_version FROM vaults WHERE vault_id=?", (self.v.vault,))[0][0], 1)
        self.assertEqual(self.v.post_roster(self.v.bump_body()).status, 200)

    def test_noop_with_other_signer_is_rejected(self):
        m = self.v.invite(role="write")
        m.redeem()
        # a role toggle is a change, repeating the head is not
        slots = {k: dict(s) for k, s in self.v.slots.items()}
        self.assertError(self.v.post_roster(self.v.roster_body(signer=self.v.slot)), 400, "invalid_roster")
        slots[m.slot]["role"] = "read"
        self.assertEqual(self.v.post_roster(self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"]))).status, 200)

    def test_version_cap(self):
        with mock.patch("wds_server.roster.ROSTER_SOFT_CAP", 3), mock.patch("wds_server.roster.ROSTER_HARD_CAP", 4):
            m = self.v.invite(role="write")                                     # version 2
            self.assertEqual(self.v.post_roster(self.v.bump_body()).status, 200)  # version 3
            r = self.v.post_roster(self.v.bump_body())                         # version 4: over the soft cap
            self.assertEqual((r.status, r.json()["error"], r.json()["limit"]), (507, "quota_exceeded", "roster_versions"))
            self.assertEqual(self.v.revoke(m.slot).status, 200)                # version 4: a removal still goes through
            self.assertError(self.v.post_roster(self.v.bump_body()), 507, "quota_exceeded")  # version 5: over the hard cap
            self.assertEqual(self.env.sql("SELECT roster_version FROM vaults WHERE vault_id=?", (self.v.vault,))[0][0], 4)

    def test_roster_bytes_are_tracked_and_capped(self):
        def used():
            return self.env.sql("SELECT roster_bytes FROM vaults WHERE vault_id=?", (self.v.vault,))[0][0]
        first = used()
        self.assertGreater(first, 500)
        m = self.v.invite(role="write")
        second = used()
        self.assertGreater(second, first)
        with mock.patch("wds_server.roster.ROSTER_BYTES_CAP", second + 10):
            r = self.v.post_roster(self.v.bump_body())
            self.assertEqual((r.status, r.json()["limit"]), (507, "roster_bytes"))
            self.assertEqual(used(), second)
            self.assertEqual(self.v.revoke(m.slot).status, 200)  # a revocation is never blocked by the quota
        self.assertGreater(used(), second)

    def test_roster_bytes_count_against_the_vault_quota(self):
        scope = self.env.create_scope(slug="small", limits={"vault_bytes": 1500})
        v = self.env.new_vault(scope)
        r = v.post_roster(v.bump_body())
        self.assertEqual((r.status, r.json()["limit"]), (507, "vault_bytes"))

    def test_roster_bytes_count_against_the_scope_quota(self):
        scope = self.env.create_scope(slug="tiny", limits={"scope_bytes": 1500, "vault_bytes": 1000000})
        v = self.env.new_vault(scope)
        r = v.post_roster(v.bump_body())
        self.assertEqual((r.status, r.json()["limit"]), (507, "scope_bytes"))

    def test_read_only_accepts_only_protective_versions(self):
        m = self.v.invite(role="write")
        m.redeem()
        self.env.disk[0] = 0.9
        self.assertError(self.v.post_roster(self.v.bump_body()), 503, "read_only")
        slots = {k: dict(s) for k, s in self.v.slots.items()}
        slots[m.slot]["role"] = "read"
        self.assertError(self.v.post_roster(self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"]))), 503, "read_only")
        self.assertEqual(self.v.revoke(m.slot).status, 200)
        # an escrow switch is protective too
        slots = {k: dict(s) for k, s in self.v.slots.items()}
        from .helpers import ESCROW_KEYS
        e = slots[self.v.escrow_slot]
        e["e_pub"], e["s_pub"] = b64(ESCROW_KEYS["spare"][0]), b64(ESCROW_KEYS["spare"][1])
        self.assertEqual(self.v.post_roster(self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"]))).status, 200)


class OwnerInviteAfterRecovery(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.v = self.env.new_vault()
        url = f"{API}/admin/vaults/{self.v.vault}"
        self.assertEqual(self.c.post_json(url + "/recovery", {"recovery_code": b32c_encode(self.v.recovery_code)}, self.env.op).status, 201)
        self.env.clock.advance(259200)
        self.owner = Member(self.v, "owner")
        entry = self.v.entry(self.owner.slot, "invite", "owner", self.owner.e_pub, self.owner.s_pub, self.env.clock.t + 86400)
        slots = sorted([*self.v.slots.values(), entry], key=lambda s: s["id"])
        body = self.v.roster_body(slots=slots, signer=self.v.escrow_slot)
        payload = {"roster": self.v.sign(body), "keyring": self.v.keyring_for([s["id"] for s in slots]),
                   "new_slots": [self.owner.new_slot_material()]}
        self.assertEqual(self.c.post_json(url + "/recovery/complete", payload, self.env.op).status, 200)
        self.v.version, self.v.head = body["version"], self.v.hash_of(body)
        self.v.slots = {s["id"]: s for s in slots}

    def test_founder_can_keep_posting_while_the_recovered_owner_invite_is_pending(self):
        m = self.v.invite(role="read")  # adds a read invite; the owner invite stays in the roster
        self.assertEqual(self.v.version, 3)
        self.assertEqual(self.v.post_roster(self.v.bump_body()).status, 200)
        self.assertEqual(self.v.revoke(m.slot).status, 200)
        self.assertIn(self.owner.slot, self.v.slots)

    def test_only_the_owner_itself_adopts_its_key_renewal(self):
        # the recovered owner redeems (announcing new keys); the founder must not sign them in, the owner itself may
        self.assertEqual(self.owner.redeem().status, 200)
        slots = {k: dict(s) for k, s in self.v.slots.items()}
        slots[self.owner.slot].update(kind="passphrase", expires=None, e_pub=b64(self.owner.new_e_pub), s_pub=b64(self.owner.new_s_pub))
        adopted = sorted(slots.values(), key=lambda s: s["id"])
        r = self.v.post_roster(self.v.roster_body(slots=adopted))
        self.assertError(r, 400, "invalid_roster")
        self.assertIn("own keys", r.json()["detail"])
        r = self.v.post_roster(self.v.roster_body(slots=adopted, signer=self.owner.slot), headers=self.owner.auth)
        self.assertEqual(r.status, 200, r)
        # the adopted renewal is cleared, like for any other slot (found by the integration tests)
        self.assertIsNone(self.c.get(self.v.path + "/roster", self.owner.auth).json()["slots"][self.owner.slot]["renewal"])
        self.assertFalse(self.c.get(f"{API}/slots/{self.owner.access_id}", self.owner.auth).json()["renewal_pending"])

    def test_owners_can_revoke_each_other_with_an_epoch_bump(self):
        # PLAN 5.7: the founder removes the recovered owner; once that owner has been used, a removal needs a new epoch
        self.assertEqual(self.owner.redeem().status, 200)
        slots = [s for s in self.v.slots.values() if s["id"] != self.owner.slot]
        self.assertError(self.v.post_roster(self.v.roster_body(slots=sorted(slots, key=lambda s: s["id"]))), 409, "revocation_required")
        self.assertEqual(self.v.revoke(self.owner.slot).status, 200)
        self.assertNotIn(self.owner.slot, self.v.slots)

    def test_recovered_owner_can_revoke_the_founder(self):
        self.assertEqual(self.owner.redeem().status, 200)
        slots = [s for s in self.v.slots.values() if s["id"] != self.v.slot]
        epoch = self.v.epoch + 1
        commits = {**self.v.commits, epoch: b64(os.urandom(32))}
        body = self.v.roster_body(slots=sorted(slots, key=lambda s: s["id"]), epoch=epoch, signer=self.owner.slot,
                                  commit={"epochs": [{"c": c, "e": e} for e, c in sorted(commits.items())], "nk": self.v.nk_commit})
        self.assertEqual(self.v.post_roster(body, headers=self.owner.auth).status, 200)
        self.assertEqual(self.c.get(f"{API}/slots/{self.v.access_id}", self.v.auth).status, 401)

    def test_founder_still_cannot_add_or_alter_owner_invites(self):
        # a second owner invite added by the founder
        extra = Member(self.v, "owner")
        entry = self.v.entry(extra.slot, "invite", "owner", extra.e_pub, extra.s_pub, self.env.clock.t + 60)
        slots = sorted([*self.v.slots.values(), entry], key=lambda s: s["id"])
        self.assertError(self.v.post_roster(self.v.roster_body(slots=slots), new_slots=[extra.new_slot_material()]), 400, "invalid_roster")
        # changing the pending owner invite: expiry, role
        changed = {k: dict(s) for k, s in self.v.slots.items()}
        changed[self.owner.slot]["expires"] += 1
        self.assertError(self.v.post_roster(self.v.roster_body(slots=sorted(changed.values(), key=lambda s: s["id"]))), 400, "invalid_roster")
        changed = {k: dict(s) for k, s in self.v.slots.items()}
        changed[self.owner.slot]["role"] = "read"
        self.assertError(self.v.post_roster(self.v.roster_body(slots=sorted(changed.values(), key=lambda s: s["id"]))), 400, "invalid_roster")


class KdfLookups(ServerTestCase):
    def kdf(self, aid, ip):
        return self.c.get(f"{API}/slots/{aid}/kdf", ip=ip)

    def test_existing_ids_are_never_throttled_by_the_ip_budget(self):
        v = self.env.new_vault()
        for _ in range(60):
            self.assertEqual(self.kdf(b32c_encode(os.urandom(12)), "9.9.9.9").status, 404)
        self.assertError(self.kdf(b32c_encode(os.urandom(12)), "9.9.9.9"), 429, "rate_limited")
        self.assertEqual(self.kdf(v.access_id, "9.9.9.9").status, 200)
        # also not after wrong tokens for exactly that ID from the same IP
        for _ in range(15):
            self.c.get(f"{API}/slots/{v.access_id}", Vault.bearer(v.access_id, os.urandom(32)), ip="9.9.9.8")
        self.assertEqual(self.kdf(v.access_id, "9.9.9.8").status, 200)

    def test_ipv6_clients_share_their_64_bit_prefix(self):
        self.assertEqual(ratelimit.bucket("2001:db8:1:2::1"), ratelimit.bucket("2001:db8:1:2:ffff::9"))
        self.assertNotEqual(ratelimit.bucket("2001:db8:1:2::1"), ratelimit.bucket("2001:db8:1:3::1"))
        self.assertEqual(ratelimit.bucket("1.2.3.4"), "1.2.3.4")
        self.assertEqual(ratelimit.bucket("::ffff:1.2.3.4"), "1.2.3.4")
        self.assertEqual(ratelimit.bucket("unknown"), "unknown")
        for i in range(60):
            self.kdf(b32c_encode(os.urandom(12)), f"2001:db8:5:5::{i + 1:x}")
        self.assertError(self.kdf(b32c_encode(os.urandom(12)), "2001:db8:5:5:aaaa::1"), 429, "rate_limited")
        self.assertEqual(self.kdf(b32c_encode(os.urandom(12)), "2001:db8:5:6::1").status, 404)

    def test_deleted_vault_answers_410_without_counting(self):
        v = self.env.new_vault()
        self.assertEqual(self.c.delete(v.path, v.auth).status, 200)
        for _ in range(70):
            self.assertError(self.kdf(v.access_id, "9.8.7.6"), 410, "vault_deleted")
        self.assertEqual(self.kdf(b32c_encode(os.urandom(12)), "9.8.7.6").status, 404)  # budget untouched


class RetiredAccessIds(ServerTestCase):
    def test_purged_vault_keeps_its_access_ids_retired(self):
        scope = self.env.create_scope()
        v = self.env.new_vault(scope)
        m = v.invite(role="read")
        self.env.clock.advance(8 * 86400)
        self.assertEqual(run_maintenance(self.env.svc)["empty_vaults"], 1)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM slots WHERE access_id=?", (v.access_id,))[0][0], 0)
        # creation with the founder's old access ID
        again = Vault(self.env, scope["scope"])
        again.access_id = v.access_id
        self.assertError(again.create(), 409, "access_id_taken")
        # an invite with the old invite access ID
        w = self.env.new_vault(scope)
        m2 = Member(w, "read")
        m2.access_id = m.access_id
        entry = w.entry(m2.slot, "invite", "read", m2.e_pub, m2.s_pub, self.env.clock.t + 3600)
        slots = sorted([*w.slots.values(), entry], key=lambda s: s["id"])
        self.assertError(w.post_roster(w.roster_body(slots=slots), new_slots=[m2.new_slot_material()]), 409, "access_id_taken")

    def test_migration_backfills_retired_ids_and_roster_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "old.db")
            conn = sqlite3.connect(path, isolation_level=None)
            for statement in MIGRATIONS[1]:
                conn.execute(statement)
            conn.execute("PRAGMA user_version = 1")
            conn.execute("INSERT INTO scopes (scope_id, name, enrollment, created) VALUES ('s-aaaaaa','S','open',1)")
            conn.execute("INSERT INTO vaults (vault_id, scope_id, created, epoch, roster_version, head_hash, escrow_slot, recovery_hash)"
                         " VALUES ('v1','s-aaaaaa',1,1,1,'h','e','r')")
            conn.execute("INSERT INTO rosters (vault_id, version, body, sig, hash, created) VALUES ('v1',1,'{\"a\":1}','sig','h',1)")
            conn.execute("INSERT INTO slots (access_id, vault_id, slot_id, kind, role, kdf, token_hash, wrapped, created)"
                         " VALUES ('AID1','v1','sl','passphrase','owner','{}',x'00','w',1)")
            conn.close()
            db = Database(path)
            with db.connection() as c:
                self.assertEqual([r[0] for r in c.execute("SELECT access_id FROM access_ids")], ["AID1"])
                self.assertEqual(c.execute("SELECT roster_bytes FROM vaults").fetchone()[0], len('{"a":1}') + len("sig"))
            db.close()


class OperatorAudit(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.v = self.env.new_vault()
        self.url = f"{API}/admin/vaults/{self.v.vault}"

    def last(self):
        return tuple(self.env.sql("SELECT actor, action, scope_id, vault_id, detail FROM audit ORDER BY id DESC LIMIT 1")[0])

    def test_failed_recovery_calls_are_audited(self):
        wrong = b32c_encode(os.urandom(17))
        self.assertError(self.c.post_json(self.url + "/recovery", {"recovery_code": wrong}, self.env.op), 403, "recovery_code_invalid")
        self.assertEqual(self.last(), ("operator", "recovery_start_failed", self.v.scope, self.v.vault, "recovery_code_invalid"))
        self.assertEqual(self.c.post_json(self.url + "/recovery", {"recovery_code": b32c_encode(self.v.recovery_code)}, self.env.op).status, 201)
        self.assertError(self.c.post_json(self.url + "/recovery", {"recovery_code": b32c_encode(self.v.recovery_code)}, self.env.op), 409, "recovery_pending")
        self.assertEqual(self.last()[1:], ("recovery_start_failed", self.v.scope, self.v.vault, "recovery_pending"))
        self.assertError(self.c.get(self.url + "/escrow", self.env.op), 409, "recovery_not_ready")
        self.assertEqual(self.last()[1:], ("escrow_fetch_failed", self.v.scope, self.v.vault, "recovery_not_ready"))
        self.env.clock.advance(259200)
        bad = {"roster": self.v.sign(self.v.roster_body(signer=self.v.escrow_slot)), "keyring": self.v.keyring_for(self.v.slots)}
        self.assertError(self.c.post_json(self.url + "/recovery/complete", bad, self.env.op), 400, "invalid_roster")
        self.assertEqual(self.last()[1:], ("recovery_complete_failed", self.v.scope, self.v.vault, "invalid_roster"))
        # the recovery is still pending: a failed completion changed nothing but the audit
        self.assertEqual(self.c.get(self.url, self.env.op).json()["recovery"]["method"], "code")

    def test_unknown_and_malformed_vaults_are_audited_without_scope(self):
        other = f"{API}/admin/vaults/{'A' * 26}"
        self.assertError(self.c.get(other, self.env.op), 404, "not_found")
        self.assertEqual(self.last(), ("operator", "vault_status_failed", None, "A" * 26, "not_found"))
        self.assertError(self.c.get(f"{API}/admin/vaults/nope", self.env.op), 400, "bad_request")
        self.assertEqual(self.last(), ("operator", "vault_status_failed", None, None, "bad_request"))

    def test_wrong_operator_token_is_not_audited(self):
        before = self.env.sql("SELECT COUNT(*) FROM audit")[0][0]
        self.c.get(self.url, {"Authorization": "Bearer wdsop." + b64(os.urandom(32))})
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM audit")[0][0], before)


if __name__ == "__main__":
    unittest.main()
