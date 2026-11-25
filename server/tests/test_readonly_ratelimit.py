import os

from wds_server.util import b32c_encode

from .helpers import API, ServerTestCase, Vault, b64, envelope, kdf_doc
from wds_server.util import sha256


class ReadOnlyMode(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.v = self.env.new_vault()
        self.v.put_ok("a")
        self.v.put_ok("a")
        self.m = self.v.invite(role="write")
        self.m.redeem()
        self.fresh = self.v.invite(role="read")  # an unredeemed invite, created before read-only

    def ro(self, on=True):
        self.env.disk[0] = 0.85 if on else 0.1

    def test_threshold_is_inclusive_and_probe_is_injectable(self):
        self.env.disk[0] = 0.8499
        self.assertFalse(self.c.get("/datastore/healthz").json()["read_only"])
        self.env.disk[0] = 0.85
        self.assertTrue(self.c.get("/datastore/healthz").json()["read_only"])

    def test_refused_operations(self):
        self.ro()
        r = self.v.put("a", if_match=2)
        self.assertError(r, 503, "read_only")
        self.assertEqual(r.headers["retry-after"], "3600")
        self.assertError(self.v.put("new", if_none_match=True), 503, "read_only")
        # roster with new_slots
        from .helpers import Member
        member = Member(self.v, "read")
        entry = self.v.entry(member.slot, "invite", "read", member.e_pub, member.s_pub, self.env.clock.t + 60)
        body = self.v.roster_body(slots=sorted([*self.v.slots.values(), entry], key=lambda s: s["id"]))
        self.assertError(self.v.post_roster(body, new_slots=[member.new_slot_material()]), 503, "read_only")
        self.assertError(self.c.post_json(f"{API}/admin/scopes", {"slug": "x", "name": "X"}, self.env.op), 503, "read_only")

    def test_allowed_operations(self):
        self.ro()
        # reads
        for path in (f"/slots/{self.v.access_id}", f"/vaults/{self.v.vault}/roster", f"/vaults/{self.v.vault}/records",
                     f"/vaults/{self.v.vault}/usage", f"/vaults/{self.v.vault}/records/{Vault.rid('a')}",
                     f"/vaults/{self.v.vault}/records/{Vault.rid('a')}/versions", f"/vaults/{self.v.vault}/rekey"):
            self.assertEqual(self.c.get(API + path, self.v.auth).status, 200, path)
        self.assertTrue(self.c.get(f"{API}/vaults/{self.v.vault}/usage", self.v.auth).json()["read_only"])
        # delete record, purge history
        self.assertEqual(self.v.delete("a", 2).status, 200)
        self.assertEqual(self.c.delete(f"{self.v.path}/records/{Vault.rid('a')}/versions", self.v.auth).status, 200)
        # PUT /slots, renewal
        r = self.c.put_json(f"{API}/slots/{self.m.access_id}", {"kdf": kdf_doc(), "token_hash": b64(sha256(b"n" * 32)),
                            "wrapped": b64(envelope(2, 0, 200))}, {**self.m.auth, "If-Match": '"2"'})
        self.assertEqual(r.status, 200, r)
        self.m.token = b"n" * 32
        r = self.c.post_json(f"{API}/slots/{self.m.access_id}/renewal", {"renewal": self.m.renewal(), "wrapped": b64(envelope(2, 0, 200))},
                             {**self.m.auth, "If-Match": '"3"'})
        self.assertEqual(r.status, 200, r)
        # redeem
        self.assertEqual(self.fresh.redeem().status, 200)
        # roster without new_slots: only versions that protect (revocation here); role changes and bare epoch bumps wait
        slots = {k: dict(s) for k, s in self.v.slots.items()}
        slots[self.m.slot]["role"] = "read"
        r = self.v.post_roster(self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"])))
        self.assertError(r, 503, "read_only")
        self.assertError(self.v.post_roster(self.v.bump_body()), 503, "read_only")
        self.assertEqual(self.v.revoke(self.m.slot).status, 200)
        # recovery cancel is allowed (404 only because none is pending)
        self.assertError(self.c.delete(f"{self.v.path}/recovery", self.v.auth), 404, "not_found")
        # vault deletion
        self.assertEqual(self.c.delete(self.v.path, self.v.auth).status, 200)

    def test_back_to_normal(self):
        self.ro()
        self.assertEqual(self.v.put("a", if_match=2).status, 503)
        self.ro(False)
        self.assertEqual(self.v.put("a", if_match=2).status, 200)


class RateLimits(ServerTestCase):
    def bad_token(self, access_id=None, ip=None):
        aid = access_id or b32c_encode(os.urandom(12))
        return self.c.get(f"{API}/slots/{aid}", Vault.bearer(aid, os.urandom(32)), ip=ip)

    def test_correct_tokens_are_never_throttled(self):
        v = self.env.new_vault()
        for _ in range(70):
            self.assertEqual(self.bad_token(ip="5.5.5.5").status in (401, 429), True)
        self.assertEqual(self.bad_token(ip="5.5.5.5").status, 429)
        for _ in range(100):
            r = self.c.get(f"{API}/slots/{v.access_id}", v.auth, ip="5.5.5.5")
            self.assertEqual(r.status, 200)
        # the right token for an endpoint of another vault is a 403, not a 429
        other = self.env.new_vault()
        self.assertError(self.c.get(f"{other.path}/usage", v.auth, ip="5.5.5.5"), 403, "forbidden")

    def test_ip_limit_60_per_minute(self):
        results = [self.bad_token(ip="6.6.6.6").status for _ in range(61)]
        self.assertEqual(results[:60], [401] * 60)
        self.assertEqual(results[60], 429)
        r = self.bad_token(ip="6.6.6.6")
        self.assertEqual(r.json()["error"], "rate_limited")
        self.assertGreaterEqual(int(r.headers["retry-after"]), 1)
        self.assertLessEqual(int(r.headers["retry-after"]), 60)
        # other IPs are unaffected
        self.assertEqual(self.bad_token(ip="6.6.6.7").status, 401)
        # unauthenticated requests without a token from the blocked IP are throttled too
        self.assertEqual(self.c.get(f"{API}/slots/{b32c_encode(bytes(12))}", ip="6.6.6.6").status, 429)
        # window slides
        self.env.clock.advance(61)
        self.assertEqual(self.bad_token(ip="6.6.6.6").status, 401)

    def test_per_access_id_limit_10_per_minute_per_ip(self):
        aid = b32c_encode(os.urandom(12))
        results = [self.bad_token(aid, ip="7.7.7.7").status for _ in range(11)]
        self.assertEqual(results, [401] * 10 + [429])
        # same IP, other access ID: fine
        self.assertEqual(self.bad_token(ip="7.7.7.7").status, 401)
        # another IP, same access ID: fine (a stranger cannot exhaust a victim's budget from elsewhere)
        self.assertEqual(self.bad_token(aid, ip="7.7.7.8").status, 401)

    def test_victim_can_still_log_in_with_correct_token_during_attack(self):
        v = self.env.new_vault()
        for _ in range(15):
            self.bad_token(v.access_id, ip="8.8.8.8")
        self.assertEqual(self.bad_token(v.access_id, ip="8.8.8.8").status, 429)
        self.assertEqual(self.c.get(f"{API}/slots/{v.access_id}", v.auth, ip="8.8.8.8").status, 200)
        self.assertEqual(self.c.get(f"{API}/slots/{v.access_id}", v.auth, ip="8.8.4.4").status, 200)

    def test_unknown_access_id_on_kdf_counts(self):
        statuses = [self.c.get(f"{API}/slots/{b32c_encode(os.urandom(12))}/kdf", ip="9.1.1.1").status for _ in range(61)]
        self.assertEqual(statuses[:60], [404] * 60)
        self.assertEqual(statuses[60], 429)
        v = self.env.new_vault()
        # lookups of existing access IDs ignore the IP-wide budget: one noisy client behind a NAT must not lock out the others
        self.assertEqual(self.c.get(f"{API}/slots/{v.access_id}/kdf", ip="9.1.1.1").status, 200)
        self.assertEqual(self.c.get(f"{API}/slots/{v.access_id}/kdf", ip="9.1.1.2").status, 200)
        # but unknown IDs from the blocked IP still get 429
        self.assertEqual(self.c.get(f"{API}/slots/{b32c_encode(os.urandom(12))}/kdf", ip="9.1.1.1").status, 429)

    def test_known_access_id_on_kdf_does_not_count(self):
        v = self.env.new_vault()
        for _ in range(100):
            self.assertEqual(self.c.get(f"{API}/slots/{v.access_id}/kdf", ip="9.2.2.2").status, 200)

    def test_non_auth_errors_never_count(self):
        v = self.env.new_vault()
        v.put_ok("a")
        for _ in range(80):
            self.assertEqual(v.put("a", if_match=9).status, 412)  # 412 and
            self.assertEqual(v.put("zz", epoch=7, if_none_match=True).status, 409)  # 409 never count
            self.assertEqual(self.c.get(f"{API}/scopes/nope-abcdef").status, 404)
        self.assertEqual(self.bad_token().status, 401)

    def test_wrong_operator_token_counts(self):
        statuses = [self.c.post_json(f"{API}/admin/scopes", {"slug": "x", "name": "X"},
                                     {"Authorization": "Bearer wdsop." + b64(os.urandom(32))}, ip="4.4.4.4").status
                    for _ in range(61)]
        self.assertEqual(statuses[:60], [401] * 60)
        self.assertEqual(statuses[60], 429)
        # the right operator token still works
        self.assertEqual(self.c.post_json(f"{API}/admin/scopes", {"slug": "x", "name": "X"}, self.env.op, ip="4.4.4.4").status, 201)

    def test_malformed_bearer_counts_missing_does_not(self):
        for _ in range(100):
            self.assertEqual(self.c.get(f"{API}/slots/{b32c_encode(bytes(12))}", ip="3.3.3.3").status, 401)
        statuses = [self.c.get(f"{API}/slots/{b32c_encode(bytes(12))}", {"Authorization": "Bearer junk"}, ip="3.3.3.4").status
                    for _ in range(61)]
        self.assertEqual(statuses[-1], 429)

    def test_revoked_requests_count_as_failures(self):
        v = self.env.new_vault()
        m = v.invite()
        m.redeem()
        v.revoke(m.slot)
        statuses = [self.c.get(f"{API}/slots/{m.access_id}", m.auth, ip="2.2.2.2").status for _ in range(11)]
        self.assertEqual(statuses, [401] * 10 + [429])
