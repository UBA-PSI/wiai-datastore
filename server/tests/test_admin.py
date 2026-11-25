import json
import os

from wds_server.util import b32c_decode, b32c_encode, b64u_encode, sha256

from .helpers import API, ESCROW_KEYS, ServerTestCase, Vault, b64, envelope, fake_pub


class OperatorAuth(ServerTestCase):
    def test_requires_operator_token(self):
        body = {"slug": "x", "name": "X"}
        self.assertError(self.c.post_json(f"{API}/admin/scopes", body), 401, "unauthorized")
        self.assertError(self.c.post_json(f"{API}/admin/scopes", body, {"Authorization": "Bearer wdsop.AAAA"}), 401, "unauthorized")
        v = self.env.new_vault()
        # a slot token is not an operator token
        self.assertError(self.c.post_json(f"{API}/admin/scopes", body, v.auth), 401, "unauthorized")
        # an operator token is not a slot token
        self.assertError(self.c.get(f"{API}/slots/{v.access_id}", self.env.op), 401, "unauthorized")
        self.assertEqual(self.c.post_json(f"{API}/admin/scopes", body, self.env.op).status, 201)

    def test_multiple_operator_hashes(self):
        second = "wdsop." + b64(os.urandom(32))
        self.env.config.operator_token_hashes.append(sha256(second.encode()))
        self.assertEqual(self.c.post_json(f"{API}/admin/scopes", {"slug": "x", "name": "X"}, {"Authorization": "Bearer " + second}).status, 201)


class ScopeAdmin(ServerTestCase):
    def test_create_defaults(self):
        r = self.c.post_json(f"{API}/admin/scopes", {"slug": "my-app", "name": "My App", "enrollment": "join_code",
                                                    "join_code": None, "hibp": True, "limits": None}, self.env.op)
        self.assertEqual(r.status, 201, r)
        d = r.json()
        self.assertRegex(d["scope"], r"^my-app-[0-9a-hjkmnp-tv-z]{6}$")
        self.assertEqual(len(d["join_code"]), 8)
        self.assertEqual(d["limits"]["max_value_bytes"], 10485760)
        self.assertEqual(d["limits"]["scope_bytes"], 2147483648)
        self.assertEqual(d["limits"]["max_vaults"], 50)
        self.assertEqual(d["enrollment"], "join_code")

    def test_create_with_explicit_code_and_limits(self):
        r = self.c.post_json(f"{API}/admin/scopes", {"slug": "a", "name": "A", "join_code": "abcd-efgh 12", "limits": {"max_vaults": 3}},
                             self.env.op)
        d = r.json()
        self.assertEqual((d["join_code"], d["limits"]["max_vaults"]), ("ABCDEFGH12", 3))

    def test_create_validation(self):
        bad = [{"slug": "Bad", "name": "x"}, {"slug": "a" * 42, "name": "x"}, {"slug": "1a", "name": "x"},
               {"slug": "a--b", "name": "x"}, {"slug": "a", "name": ""}, {"slug": "a", "name": "x\ny"},
               {"slug": "a", "name": "x", "enrollment": "weird"}, {"slug": "a", "name": "x", "hibp": "yes"},
               {"slug": "a", "name": "x", "join_code": "ab"}, {"name": "x"}, {"slug": "a", "name": "x", "extra": 1}]
        for body in bad:
            self.assertError(self.c.post_json(f"{API}/admin/scopes", body, self.env.op), 400, "bad_request")
        self.assertEqual(self.c.post_json(f"{API}/admin/scopes", {"slug": "a" * 41, "name": "x"}, self.env.op).status, 201)

    def test_scope_id_pattern_matches_vault_creation_routing(self):
        d = self.env.create_scope(slug="notenrechner")
        self.assertLessEqual(len(d["scope"]), 48)

    def test_patch(self):
        d = self.env.create_scope(enrollment="join_code")
        url = f"{API}/admin/scopes/{d['scope']}"
        r = self.c.patch_json(url, {"name": "Neu", "hibp": False, "enrollment": "open", "limits": {"max_vaults": 7, "history_versions": 4}},
                              self.env.op)
        self.assertEqual(r.status, 200, r)
        j = r.json()
        self.assertEqual((j["name"], j["hibp"], j["enrollment"], j["limits"]["max_vaults"], j["limits"]["history_versions"]),
                         ("Neu", False, "open", 7, 4))
        public = self.c.get(f"{API}/scopes/{d['scope']}").json()
        self.assertEqual((public["name"], public["hibp"], public["limits"]["history_versions"]), ("Neu", False, 4))
        r = self.c.patch_json(url, {"limits": {"max_vaults": None}}, self.env.op)
        self.assertEqual(r.json()["limits"]["max_vaults"], 50)
        r = self.c.patch_json(url, {"join_code": "NEWCODE99", "enrollment": "join_code"}, self.env.op)
        self.assertEqual(r.json()["join_code"], "NEWCODE99")
        r = self.c.patch_json(url, {"join_code": None}, self.env.op)
        self.assertEqual(len(r.json()["join_code"]), 8)
        for bad in ({"status": "gone"}, {"enrollment": "x"}, {"limits": {"max_vaults": 9999}}, {"name": ""}, {"hibp": 1}, {"bogus": 1}):
            self.assertError(self.c.patch_json(url, bad, self.env.op), 400, "bad_request")
        self.assertError(self.c.patch_json(f"{API}/admin/scopes/nope-abcdef", {"name": "x"}, self.env.op), 404, "not_found")

    def test_changed_join_code_applies_immediately(self):
        d = self.env.create_scope(enrollment="join_code")
        old = d["join_code"]
        self.c.patch_json(f"{API}/admin/scopes/{d['scope']}", {"join_code": "FRESHCODE"}, self.env.op)
        self.assertError(Vault(self.env, d["scope"]).create(join_code=old), 403, "join_code_invalid")
        self.assertEqual(Vault(self.env, d["scope"]).create(join_code="FRESHCODE").status, 201)

    def test_audit_entries(self):
        d = self.env.create_scope()
        self.c.patch_json(f"{API}/admin/scopes/{d['scope']}", {"status": "suspended"}, self.env.op)
        rows = self.env.sql("SELECT actor, action FROM audit ORDER BY id")
        self.assertEqual([(r[0], r[1]) for r in rows], [("operator", "scope_created"), ("operator", "scope_updated")])


class ValueLimit(ServerTestCase):
    """PLAN 8.3: lowering max_value_bytes must never make stored values unreadable or impossible to re-encrypt."""

    def setUp(self):
        super().setUp()
        self.scope = self.env.create_scope(limits={"max_value_bytes": 100000})
        self.url = f"{API}/admin/scopes/{self.scope['scope']}"
        self.v = self.env.new_vault(self.scope)
        self.v.put_ok("big", size=60000)
        self.v.put_ok("small", size=200)

    def patch(self, limits):
        return self.c.patch_json(self.url, {"limits": limits}, self.env.op)

    def test_refused_below_the_largest_stored_envelope(self):
        from wds_server.util import max_envelope_bytes
        r = self.patch({"max_value_bytes": 1000})
        self.assertError(r, 409, "limit_below_stored_value")
        d = r.json()
        self.assertEqual((d["limit"], d["largest_envelope_bytes"]), ("max_value_bytes", 60000))
        low = d["minimum_max_value_bytes"]
        self.assertGreaterEqual(max_envelope_bytes(low), 60000)
        self.assertLess(max_envelope_bytes(low - 1), 60000)
        self.assertEqual(self.c.get(f"{API}/scopes/{self.scope['scope']}").json()["limits"]["max_value_bytes"], 100000)
        # exactly the reported minimum is accepted, and the record stays within the new limit
        r = self.patch({"max_value_bytes": low})
        self.assertEqual(r.status, 200, r)
        self.assertEqual(r.json()["limits"]["max_value_bytes"], low)
        self.assertEqual(self.v.get("big").status, 200)

    def test_history_versions_and_deleted_vaults_count(self):
        # the big blob is no longer the latest version, but it is still stored
        self.v.put_ok("big", size=300)
        self.assertError(self.patch({"max_value_bytes": 1000}), 409, "limit_below_stored_value")
        self.c.delete(self.v.path, self.v.auth)  # deleted vaults hold their data until purged
        self.assertError(self.patch({"max_value_bytes": 1000}), 409, "limit_below_stored_value")
        self.env.clock.advance(31 * 86400)
        from wds_server.maintenance import run_maintenance
        run_maintenance(self.env.svc)
        self.assertEqual(self.patch({"max_value_bytes": 1000}).status, 200)

    def test_reset_to_a_lower_default_is_checked_too(self):
        self.env.config.limit_defaults["max_value_bytes"] = 1000
        self.assertError(self.patch({"max_value_bytes": None}), 409, "limit_below_stored_value")

    def test_other_changes_and_other_scopes_are_not_affected(self):
        self.assertEqual(self.c.patch_json(self.url, {"name": "Renamed", "limits": {"max_vaults": 3}}, self.env.op).status, 200)
        other = self.env.create_scope(slug="other", limits={"max_value_bytes": 100000})
        self.assertEqual(self.c.patch_json(f"{API}/admin/scopes/{other['scope']}",
                                           {"limits": {"max_value_bytes": 1000}}, self.env.op).status, 200)
        # raising is always fine
        self.assertEqual(self.patch({"max_value_bytes": 200000}).status, 200)


class Recovery(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.scope = self.env.create_scope()
        self.v = Vault(self.env, self.scope["scope"])
        self.v.create(mutate=lambda b: b.update(recovery_contact="me@uni-bamberg.de"))
        self.code = b32c_encode(self.v.recovery_code)
        self.url = f"{API}/admin/vaults/{self.v.vault}"

    def start(self, **body):
        return self.c.post_json(self.url + "/recovery", body or {"recovery_code": self.code}, self.env.op)

    def test_vault_status(self):
        self.v.put_ok("a", size=300)
        r = self.c.get(self.url, self.env.op)
        d = r.json()
        self.assertEqual((d["vault"], d["scope"], d["epoch"], d["roster_version"], d["bytes"], d["deleted"], d["recovery"],
                          d["has_recovery_contact"]), (self.v.vault, self.scope["scope"], 1, 1, 300, None, None, True))
        self.assertError(self.c.get(f"{API}/admin/vaults/9FYJS2VF3VP7MAQYPJ5S6KQ4P9", self.env.op), 404, "not_found")
        self.assertError(self.c.get(f"{API}/admin/vaults/bad", self.env.op), 400, "bad_request")

    def test_start_with_code_waits_72_hours(self):
        r = self.start()
        self.assertEqual(r.status, 201, r)
        d = r.json()
        self.assertEqual((d["method"], d["ready_at"] - d["requested"]), ("code", 259200))
        self.assertEqual(self.start().json()["error"], "recovery_pending")
        # visible to the owner
        s = self.c.get(f"{API}/slots/{self.v.access_id}", self.v.auth).json()
        self.assertEqual(s["recovery"], {"method": "code", "requested": d["requested"], "ready_at": d["ready_at"]})
        self.assertEqual(self.c.get(self.url, self.env.op).json()["recovery"]["method"], "code")

    def test_start_with_contact_waits_7_days(self):
        r = self.start(contact=True)
        self.assertEqual(r.status, 201, r)
        self.assertEqual((r.json()["method"], r.json()["ready_at"] - r.json()["requested"]), ("contact", 604800))

    def test_contact_requires_recovery_contact(self):
        v = self.env.new_vault(self.scope)
        r = self.c.post_json(f"{API}/admin/vaults/{v.vault}/recovery", {"contact": True}, self.env.op)
        self.assertError(r, 409, "no_recovery_contact")

    @staticmethod
    def _decodes(code):
        try:
            b32c_decode(code, 17)
            return True
        except ValueError:
            return False

    def test_wrong_code_and_validation(self):
        wrong = b32c_encode(os.urandom(17))
        self.assertError(self.start(recovery_code=wrong), 403, "recovery_code_invalid")
        self.assertError(self.start(recovery_code="short"), 400, "bad_request")
        bad = next(c for c in (self.code[:-1] + ch for ch in "0123456789ABCDEFGHJKMNPQRSTVWXYZ")
                   if c != self.code and not self._decodes(c))  # a typo that the check bits catch (one in sixteen would pass)
        self.assertError(self.start(recovery_code=bad), 400, "bad_request")
        self.assertError(self.start(contact=False), 400, "bad_request")
        self.assertError(self.c.post_json(self.url + "/recovery", {}, self.env.op), 400, "bad_request")
        self.assertError(self.c.post_json(self.url + "/recovery", {"contact": True, "recovery_code": self.code}, self.env.op), 400,
                         "bad_request")

    def test_wrong_codes_are_rate_limited(self):
        statuses = [self.start(recovery_code=b32c_encode(os.urandom(17))).status for _ in range(61)]
        self.assertEqual(statuses[:60], [403] * 60)
        self.assertEqual(statuses[60], 429)

    def test_cancel_by_operator_and_by_owner(self):
        self.assertError(self.c.delete(self.url + "/recovery", self.env.op), 404, "not_found")
        self.assertError(self.c.delete(self.v.path + "/recovery", self.v.auth), 404, "not_found")
        self.start()
        r = self.c.delete(self.v.path + "/recovery", self.v.auth)
        self.assertEqual((r.status, r.json()), (200, {"cancelled": True}))
        self.assertIsNone(self.c.get(f"{API}/slots/{self.v.access_id}", self.v.auth).json()["recovery"])
        self.start()
        self.assertEqual(self.c.delete(self.url + "/recovery", self.env.op).json(), {"cancelled": True})
        self.assertEqual(self.start().status, 201)

    def test_escrow_fetch_only_after_waiting_period(self):
        self.assertError(self.c.get(self.url + "/escrow", self.env.op), 409, "recovery_not_ready")
        self.start()
        self.assertError(self.c.get(self.url + "/escrow", self.env.op), 409, "recovery_not_ready")
        self.env.clock.advance(259199)
        self.assertError(self.c.get(self.url + "/escrow", self.env.op), 409, "recovery_not_ready")
        self.env.clock.advance(1)
        r = self.c.get(self.url + "/escrow", self.env.op)
        self.assertEqual(r.status, 200, r)
        d = r.json()
        self.assertEqual((d["vault"], d["scope"], d["epoch"], d["escrow_slot"]), (self.v.vault, self.scope["scope"], 1, self.v.escrow_slot))
        self.assertEqual(d["roster"]["head"], 1)
        self.assertEqual(d["roster"]["head_hash"], self.v.head)
        self.assertEqual(len(d["roster"]["versions"]), 1)
        entry = self.env.sql("SELECT entry FROM keyring WHERE vault_id=? AND slot_id=?", (self.v.vault, self.v.escrow_slot))[0][0]
        self.assertEqual(d["keyring_entry"], entry)

    def recovery_roster(self, ttl=3600, **over):
        """Roster version signed by the escrow slot adding one owner invite."""
        from .helpers import Member
        m = Member(self.v, "owner")
        entry = self.v.entry(m.slot, "invite", "owner", m.e_pub, m.s_pub, self.env.clock.t + ttl)
        slots = sorted([*self.v.slots.values(), entry], key=lambda s: s["id"])
        body = self.v.roster_body(slots=slots, signer=self.v.escrow_slot, **over)
        return m, body, {"roster": self.v.sign(body), "keyring": self.v.keyring_for([s["id"] for s in slots]),
                         "new_slots": [m.new_slot_material()]}

    def test_complete_recovery(self):
        self.start()
        m, body, payload = self.recovery_roster()
        complete = self.url + "/recovery/complete"
        self.assertError(self.c.post_json(complete, payload, self.env.op), 409, "recovery_not_ready")
        self.env.clock.advance(259200)
        m, body, payload = self.recovery_roster()
        r = self.c.post_json(complete, payload, self.env.op)
        self.assertEqual(r.status, 200, r)
        self.assertEqual(r.json(), {"version": 2, "head": Vault.hash_of(body), "epoch": 1})
        # the new owner can use the invite; the old owner still works
        d = self.c.get(f"{API}/slots/{m.access_id}", m.auth).json()
        self.assertEqual((d["role"], d["kind"]), ("owner", "invite"))
        self.assertEqual(self.c.get(f"{API}/slots/{self.v.access_id}", self.v.auth).status, 200)
        self.assertIsNone(self.c.get(f"{API}/slots/{self.v.access_id}", self.v.auth).json()["recovery"])
        # no longer pending
        self.assertError(self.c.get(self.url + "/escrow", self.env.op), 409, "recovery_not_ready")
        rows = self.env.sql("SELECT action FROM audit WHERE vault_id=? ORDER BY id", (self.v.vault,))
        self.assertEqual([r[0] for r in rows], ["vault_created", "recovery_started", "recovery_complete_failed",
                                                 "recovery_completed", "escrow_fetch_failed"])

    def test_complete_rules(self):
        self.start()
        self.env.clock.advance(259200)
        complete = self.url + "/recovery/complete"
        # signed by the founder instead of escrow
        m, body, payload = self.recovery_roster()
        payload["roster"] = self.v.sign({**body, "signer": self.v.slot})
        self.assertError(self.c.post_json(complete, payload, self.env.op), 400, "invalid_roster")
        # adds a write invite instead of an owner
        from .helpers import Member
        member = Member(self.v, "write")
        entry = self.v.entry(member.slot, "invite", "write", member.e_pub, member.s_pub, self.env.clock.t + 60)
        slots = sorted([*self.v.slots.values(), entry], key=lambda s: s["id"])
        payload = {"roster": self.v.sign(self.v.roster_body(slots=slots, signer=self.v.escrow_slot)),
                   "keyring": self.v.keyring_for([s["id"] for s in slots]), "new_slots": [member.new_slot_material()]}
        self.assertError(self.c.post_json(complete, payload, self.env.op), 400, "invalid_roster")
        # adds nothing
        payload = {"roster": self.v.sign(self.v.roster_body(signer=self.v.escrow_slot)),
                   "keyring": self.v.keyring_for(self.v.slots)}
        self.assertError(self.c.post_json(complete, payload, self.env.op), 400, "invalid_roster")
        # expiry window and stale head
        m, body, payload = self.recovery_roster(ttl=16 * 86400)
        self.assertError(self.c.post_json(complete, payload, self.env.op), 400, "invalid_roster")
        m, body, payload = self.recovery_roster(version=5)
        self.assertError(self.c.post_json(complete, payload, self.env.op), 409, "roster_conflict")
        # the real thing still works afterwards
        m, body, payload = self.recovery_roster()
        self.assertEqual(self.c.post_json(complete, payload, self.env.op).status, 200)

    def test_complete_is_limited_to_exactly_one_added_owner_invite(self):
        """The client verifier rejects every other escrow-signed version, so the server must not store one."""
        self.start()
        self.env.clock.advance(259200)
        complete = self.url + "/recovery/complete"

        def detail(payload):
            r = self.c.post_json(complete, payload, self.env.op)
            self.assertError(r, 400, "invalid_roster")
            return r.json()["detail"]

        # epoch bump (with a commitment for it)
        epoch = self.v.epoch + 1
        commit = {"epochs": [{"c": c, "e": e} for e, c in sorted({**self.v.commits, epoch: b64(os.urandom(32))}.items())],
                  "nk": self.v.nk_commit}
        m, body, payload = self.recovery_roster(epoch=epoch, commit=commit)
        self.assertIn("epoch", detail(payload))
        # a different NK commitment
        m, body, payload = self.recovery_roster(commit={"epochs": [{"c": self.v.commits[1], "e": 1}], "nk": b64(os.urandom(32))})
        self.assertIn("commitments", detail(payload))
        # a changed role, changed keys, changed expiry or a removal among the existing slots
        for change in ("role", "keys", "kind", "remove"):
            m, body, payload = self.recovery_roster()
            slots = [dict(s) for s in body["slots"]]
            founder = next(s for s in slots if s["id"] == self.v.slot)
            if change == "role":
                founder["role"] = "write"
            elif change == "keys":
                founder["e_pub"] = b64(fake_pub("other"))
            elif change == "kind":
                founder["kind"] = "invite"
                founder["expires"] = self.env.clock.t + 60
            else:
                slots = [s for s in slots if s["id"] != self.v.slot]
            body = {**body, "slots": slots}
            payload = {**payload, "roster": self.v.sign(body), "keyring": self.v.keyring_for([s["id"] for s in slots])}
            self.assertIn("existing slot", detail(payload), change)
        # the escrow slot is part of "every existing slot": no switch to the spare set during recovery
        m, body, payload = self.recovery_roster()
        slots = [dict(s) for s in body["slots"]]
        escrow = next(s for s in slots if s["id"] == self.v.escrow_slot)
        escrow["e_pub"], escrow["s_pub"] = b64(ESCROW_KEYS["spare"][0]), b64(ESCROW_KEYS["spare"][1])
        body = {**body, "slots": slots}
        payload = {**payload, "roster": self.v.sign(body)}
        self.assertIn("existing slot", detail(payload))
        # nothing was stored, and the plain version still goes through
        self.assertEqual(self.env.sql("SELECT roster_version FROM vaults WHERE vault_id=?", (self.v.vault,))[0][0], 1)
        m, body, payload = self.recovery_roster()
        self.assertEqual(self.c.post_json(complete, payload, self.env.op).status, 200)

    def test_owner_cannot_post_owner_invites_or_escrow_signed_rosters(self):
        from .helpers import Member
        m = Member(self.v, "owner")
        entry = self.v.entry(m.slot, "invite", "owner", m.e_pub, m.s_pub, self.env.clock.t + 60)
        slots = sorted([*self.v.slots.values(), entry], key=lambda s: s["id"])
        body = self.v.roster_body(slots=slots)
        self.assertError(self.v.post_roster(body, new_slots=[m.new_slot_material()]), 400, "invalid_roster")
        body = self.v.roster_body(slots=slots, signer=self.v.escrow_slot)
        self.assertError(self.v.post_roster(body, new_slots=[m.new_slot_material()]), 400, "invalid_roster")

    def test_deleted_vault_recovery(self):
        self.c.delete(self.v.path, self.v.auth)
        self.assertError(self.start(), 410, "vault_deleted")
        self.assertEqual(self.c.get(self.url, self.env.op).json()["deleted"], self.env.clock.t)
