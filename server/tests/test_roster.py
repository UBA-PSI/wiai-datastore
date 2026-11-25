import os

from .helpers import API, ESCROW_KEYS, ServerTestCase, Vault, b64, envelope, fake_pub


class RosterBase(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.v = self.env.new_vault()

    def commit(self, epochs):
        return {"epochs": [{"c": self.v.commits.get(e) or b64(os.urandom(32)), "e": e} for e in epochs], "nk": self.v.nk_commit}


class RosterChain(RosterBase):
    def test_invite_adds_version_and_slot(self):
        m = self.v.invite(role="write")
        self.assertEqual(self.v.version, 2)
        d = self.c.get(self.v.path + "/roster", self.v.auth).json()
        self.assertEqual((d["head"], d["epoch"], len(d["versions"])), (2, 1, 2))
        self.assertEqual(d["head_hash"], self.v.head)
        self.assertEqual(d["versions"][1]["body"]["prev"], d["versions"][0]["body"] and Vault.hash_of(d["versions"][0]["body"]))
        self.assertEqual(set(d["slots"]), {self.v.slot, m.slot})
        self.assertFalse(d["slots"][m.slot]["used"])
        # the keyring was replaced with entries for all three slots
        keyring = self.env.sql("SELECT slot_id, roster_version FROM keyring WHERE vault_id=?", (self.v.vault,))
        self.assertEqual({(r[0], r[1]) for r in keyring}, {(s, 2) for s in self.v.slots})

    def test_since_parameter(self):
        self.v.invite()
        self.v.invite()
        d = self.c.get(self.v.path + "/roster?since=2", self.v.auth).json()
        self.assertEqual([x["body"]["version"] for x in d["versions"]], [3])
        d = self.c.get(self.v.path + "/roster?since=0", self.v.auth).json()
        self.assertEqual(len(d["versions"]), 3)
        self.assertError(self.c.get(self.v.path + "/roster?since=-1", self.v.auth), 400, "bad_request")
        self.assertError(self.c.get(self.v.path + "/roster?since=x", self.v.auth), 400, "bad_request")

    def test_only_owners_post_rosters(self):
        m = self.v.invite()
        m.redeem()
        body = self.v.roster_body()
        r = self.c.post_json(self.v.path + "/roster", {"roster": self.v.sign(body), "keyring": self.v.keyring_for(self.v.slots)},
                             m.auth)
        self.assertError(r, 403, "forbidden")

    def test_compare_and_swap_conflict(self):
        stale = self.v.roster_body()
        self.v.invite()
        r = self.v.post_roster(stale, new_slots=[])
        self.assertError(r, 409, "roster_conflict")
        self.assertEqual(r.json()["head"], 2)
        self.assertEqual(r.json()["head_hash"], self.v.head)
        wrong_prev = self.v.roster_body(prev=b64(os.urandom(32)))
        self.assertError(self.v.post_roster(wrong_prev), 409, "roster_conflict")
        skip = self.v.roster_body(version=9)
        self.assertError(self.v.post_roster(skip), 409, "roster_conflict")

    def test_unknown_request_keys(self):
        body = self.v.roster_body()
        r = self.c.post_json(self.v.path + "/roster", {"roster": self.v.sign(body), "keyring": self.v.keyring_for(self.v.slots),
                                                       "extra": 1}, self.v.auth)
        self.assertError(r, 400, "bad_request")

    def test_invalid_structure_keeps_state(self):
        r = self.v.post_roster(self.v.roster_body(epoch=3))
        self.assertError(r, 400, "invalid_roster")
        r = self.v.post_roster(self.v.roster_body(scope="x-abcdef"))
        self.assertError(r, 400, "invalid_roster")
        r = self.v.post_roster(self.v.roster_body(signer=b64(os.urandom(12))))
        self.assertError(r, 400, "invalid_roster")
        self.assertEqual(self.c.get(self.v.path + "/roster", self.v.auth).json()["head"], 1)

    def test_signer_must_be_owner_and_not_escrow(self):
        m = self.v.invite()
        self.assertError(self.v.post_roster(self.v.roster_body(signer=m.slot)), 400, "invalid_roster")
        self.assertError(self.v.post_roster(self.v.roster_body(signer=self.v.escrow_slot)), 400, "invalid_roster")

    def test_keyring_must_match_slots(self):
        body = self.v.roster_body()
        ids = list(self.v.slots)
        self.assertError(self.v.post_roster(body, keyring=self.v.keyring_for(ids[:1])), 400, "invalid_keyring")
        self.assertError(self.v.post_roster(body, keyring=self.v.keyring_for(ids + ["AAAAAAAAAAAAAAAA"])), 400, "invalid_keyring")
        bad = self.v.keyring_for(ids)
        bad[ids[0]] = b64(envelope(3, 0, 50))
        self.assertError(self.v.post_roster(body, keyring=bad), 400, "malformed_envelope")
        body = self.v.bump_body()
        self.assertEqual(self.v.post_roster(body, keyring=self.v.keyring_for(ids)).status, 200)

    def test_escrow_switch_to_spare(self):
        slots = {k: dict(s) for k, s in self.v.slots.items()}
        slots[self.v.escrow_slot].update(e_pub=b64(ESCROW_KEYS["spare"][0]), s_pub=b64(ESCROW_KEYS["spare"][1]))
        r = self.v.post_roster(self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"])))
        self.assertEqual(r.status, 200, r)

    def test_escrow_cannot_be_removed_or_replaced_by_other_id(self):
        slots = [s for s in self.v.slots.values() if s["id"] != self.v.escrow_slot]
        self.assertError(self.v.post_roster(self.v.roster_body(slots=slots)), 400, "invalid_roster")
        new_id = b64(os.urandom(12))
        slots = [dict(s, id=new_id) if s["id"] == self.v.escrow_slot else s for s in self.v.slots.values()]
        slots.sort(key=lambda s: s["id"])
        self.assertError(self.v.post_roster(self.v.roster_body(slots=slots)), 400, "invalid_roster")

    def test_owner_can_change_own_keys(self):
        slots = {k: dict(s) for k, s in self.v.slots.items()}
        slots[self.v.slot].update(e_pub=b64(fake_pub("new e")), s_pub=b64(fake_pub("new s")))
        r = self.v.post_roster(self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"])))
        self.assertEqual(r.status, 200, r)

    def test_commitments_rules(self):
        body = self.v.roster_body()
        body["commit"]["nk"] = b64(os.urandom(32))
        self.assertError(self.v.post_roster(body), 400, "invalid_roster")
        body = self.v.roster_body()
        body["commit"]["epochs"][0]["c"] = b64(os.urandom(32))
        self.assertError(self.v.post_roster(body), 400, "invalid_roster")


class Invites(RosterBase):
    def test_new_slots_must_match_added_slots(self):
        from .helpers import Member
        member = Member(self.v, "write")
        entry = self.v.entry(member.slot, "invite", "write", member.e_pub, member.s_pub, self.env.clock.t + 3600)
        slots = sorted([*self.v.slots.values(), entry], key=lambda s: s["id"])
        body = self.v.roster_body(slots=slots)
        self.assertError(self.v.post_roster(body), 400, "invalid_roster")  # no new_slots
        self.assertError(self.v.post_roster(body, new_slots=[]), 400, "invalid_roster")
        other = Member(self.v, "write")
        self.assertError(self.v.post_roster(body, new_slots=[other.new_slot_material()]), 400, "invalid_roster")
        self.assertError(self.v.post_roster(body, new_slots=[member.new_slot_material(), other.new_slot_material()]),
                         400, "invalid_roster")
        self.assertEqual(self.v.post_roster(body, new_slots=[member.new_slot_material()]).status, 200)

    def test_new_slot_material_validation(self):
        from .helpers import Member
        for name, change in {
            "kdf": {"kdf": {"alg": "argon2id"}}, "access id": {"access_id": "000G40R40M30E209185Y"},
            "token hash": {"token_hash": "x"}, "wrapped": {"wrapped": b64(envelope(3, 0, 200))}, "extra": {"extra": 1},
        }.items():
            with self.subTest(name):
                member = Member(self.v, "write")
                entry = self.v.entry(member.slot, "invite", "write", member.e_pub, member.s_pub, self.env.clock.t + 3600)
                body = self.v.roster_body(slots=sorted([*self.v.slots.values(), entry], key=lambda s: s["id"]))
                material = {**member.new_slot_material(), **change}
                r = self.v.post_roster(body, new_slots=[material])
                self.assertEqual(r.status, 400, r)

    def test_invite_expiry_window(self):
        from .helpers import Member
        for ttl, ok in ((0, False), (-5, False), (1, True), (15 * 86400, True), (15 * 86400 + 1, False)):
            with self.subTest(ttl):
                member = Member(self.v, "write")
                entry = self.v.entry(member.slot, "invite", "write", member.e_pub, member.s_pub, self.env.clock.t + ttl)
                body = self.v.roster_body(slots=sorted([*self.v.slots.values(), entry], key=lambda s: s["id"]))
                r = self.v.post_roster(body, new_slots=[member.new_slot_material()])
                self.assertEqual(r.status, 200 if ok else 400, r)

    def test_invite_slot_rules(self):
        from .helpers import Member
        member = Member(self.v, "write")
        good = self.v.entry(member.slot, "invite", "write", member.e_pub, member.s_pub, self.env.clock.t + 60)

        def attempt(entry, **kw):
            body = self.v.roster_body(slots=sorted([*self.v.slots.values(), entry], key=lambda s: s["id"]))
            return self.v.post_roster(body, new_slots=[member.new_slot_material()], apply=False, **kw)

        self.assertError(attempt({**good, "role": "owner"}), 400, "invalid_roster")      # owner invite by non-escrow
        self.assertError(attempt({**good, "expires": None}), 400, "invalid_roster")
        self.assertError(attempt({**good, "kind": "passphrase", "expires": None}), 400, "invalid_roster")  # must be invite
        self.assertEqual(attempt(good).status, 200)

    def test_slot_and_access_ids_never_reused(self):
        from .helpers import Member
        m = self.v.invite()
        # reuse the access id of an existing slot
        member = Member(self.v, "write")
        member.access_id = m.access_id
        entry = self.v.entry(member.slot, "invite", "write", member.e_pub, member.s_pub, self.env.clock.t + 60)
        body = self.v.roster_body(slots=sorted([*self.v.slots.values(), entry], key=lambda s: s["id"]))
        self.assertError(self.v.post_roster(body, new_slots=[member.new_slot_material()]), 409, "access_id_taken")
        # remove the invite, then try to add the same slot id again
        r = self.v.post_roster(self.v.roster_body(slots=[s for s in self.v.slots.values() if s["id"] != m.slot]))
        self.assertEqual(r.status, 200, r)
        again = Member(self.v, "write")
        again.slot = m.slot
        entry = self.v.entry(again.slot, "invite", "write", again.e_pub, again.s_pub, self.env.clock.t + 60)
        body = self.v.roster_body(slots=sorted([*self.v.slots.values(), entry], key=lambda s: s["id"]))
        self.assertError(self.v.post_roster(body, new_slots=[again.new_slot_material()]), 409, "slot_id_taken")
        # a removed slot's access id stays taken
        again2 = Member(self.v, "write")
        again2.access_id = m.access_id
        entry = self.v.entry(again2.slot, "invite", "write", again2.e_pub, again2.s_pub, self.env.clock.t + 60)
        body = self.v.roster_body(slots=sorted([*self.v.slots.values(), entry], key=lambda s: s["id"]))
        self.assertError(self.v.post_roster(body, new_slots=[again2.new_slot_material()]), 409, "access_id_taken")

    def test_unused_invite_removal_needs_no_new_epoch(self):
        m = self.v.invite()
        r = self.v.post_roster(self.v.roster_body(slots=[s for s in self.v.slots.values() if s["id"] != m.slot]))
        self.assertEqual(r.status, 200, r)
        self.assertEqual(self.v.epoch, 1)
        self.assertError(self.c.get(f"{API}/slots/{m.access_id}", m.auth), 401, "revoked")

    def test_used_invite_removal_requires_revocation(self):
        m = self.v.invite()
        self.assertEqual(self.c.get(f"{API}/slots/{m.access_id}", m.auth).status, 200)  # authenticates: used
        r = self.v.post_roster(self.v.roster_body(slots=[s for s in self.v.slots.values() if s["id"] != m.slot]))
        self.assertError(r, 409, "revocation_required")

    def test_redeemed_member_removal_requires_revocation_and_works_with_epoch(self):
        m = self.v.invite()
        m.redeem()
        r = self.v.post_roster(self.v.roster_body(slots=[s for s in self.v.slots.values() if s["id"] != m.slot]))
        self.assertError(r, 409, "revocation_required")
        r = self.v.revoke(m.slot)
        self.assertEqual(r.status, 200, r)
        self.assertEqual(r.json()["epoch"], 2)
        self.assertEqual(self.c.get(self.v.path + "/usage", self.v.auth).status, 200)
        # the new epoch is visible
        self.assertEqual(self.c.get(f"{API}/slots/{self.v.access_id}", self.v.auth).json()["epoch"], 2)

    def test_kind_change_needs_redemption_and_renewal_adoption(self):
        m = self.v.invite()
        slots = {k: dict(s) for k, s in self.v.slots.items()}
        slots[m.slot].update(kind="passphrase", expires=None)
        body = self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"]))
        self.assertError(self.v.post_roster(body), 400, "invalid_roster")  # not redeemed
        m.redeem()
        # new keys that are not the pending renewal
        wrong = {k: dict(s) for k, s in slots.items()}
        wrong[m.slot].update(e_pub=b64(fake_pub("other")), s_pub=b64(fake_pub("other2")))
        self.assertError(self.v.post_roster(self.v.roster_body(slots=sorted(wrong.values(), key=lambda s: s["id"]))), 409,
                         "renewal_mismatch")
        # old keys with the kind change: allowed (owner acknowledges but keeps the invite keys)
        # adopt the renewal
        slots[m.slot].update(e_pub=b64(m.new_e_pub), s_pub=b64(m.new_s_pub))
        body = self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"]))
        r = self.v.post_roster(body)
        self.assertEqual(r.status, 200, r)
        d = self.c.get(f"{API}/slots/{m.access_id}", m.auth).json()
        self.assertFalse(d["renewal_pending"])
        self.assertEqual(d["kind"], "passphrase")
        self.assertIsNone(self.c.get(self.v.path + "/roster", self.v.auth).json()["slots"][m.slot]["renewal"])

    def test_key_change_without_renewal_is_a_mismatch(self):
        m = self.v.invite()
        m.redeem()
        self.v.post_roster(self.v.roster_body(slots=sorted(
            [dict(s, kind="passphrase", expires=None) if s["id"] == m.slot else s for s in self.v.slots.values()],
            key=lambda s: s["id"])))
        slots = {k: dict(s) for k, s in self.v.slots.items()}
        slots[m.slot].update(e_pub=b64(fake_pub("x")), s_pub=b64(fake_pub("y")))
        self.assertError(self.v.post_roster(self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"]))), 409,
                         "renewal_mismatch")

    def test_role_changes(self):
        m = self.v.invite(role="read")
        slots = {k: dict(s) for k, s in self.v.slots.items()}
        slots[m.slot]["role"] = "write"
        r = self.v.post_roster(self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"])))
        self.assertEqual(r.status, 200, r)
        self.assertEqual(self.c.get(f"{API}/slots/{m.access_id}", m.auth).json()["role"], "write")
        slots[m.slot]["role"] = "owner"
        self.assertError(self.v.post_roster(self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"]))), 400,
                         "invalid_roster")
        slots[m.slot]["role"] = "read"
        slots[self.v.slot]["role"] = "write"
        self.assertError(self.v.post_roster(self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"]))), 400,
                         "invalid_roster")

    def test_expiry_cannot_change_while_invite(self):
        m = self.v.invite()
        slots = {k: dict(s) for k, s in self.v.slots.items()}
        slots[m.slot]["expires"] += 100
        self.assertError(self.v.post_roster(self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"]))), 400,
                         "invalid_roster")


class Epochs(RosterBase):
    def test_epoch_bump_without_removal(self):
        epochs = {1: self.v.commits[1], 2: b64(os.urandom(32))}
        body = self.v.roster_body(epoch=2, commit={"epochs": [{"c": c, "e": e} for e, c in epochs.items()], "nk": self.v.nk_commit})
        r = self.v.post_roster(body)
        self.assertEqual(r.status, 200, r)
        self.assertEqual(self.v.epoch, 2)

    def test_epoch_must_be_in_commitments_and_grow_by_one(self):
        epochs = {1: self.v.commits[1], 3: b64(os.urandom(32))}
        body = self.v.roster_body(epoch=3, commit={"epochs": [{"c": c, "e": e} for e, c in epochs.items()], "nk": self.v.nk_commit})
        self.assertError(self.v.post_roster(body), 400, "invalid_roster")
        body = self.v.roster_body(epoch=2)
        self.assertError(self.v.post_roster(body), 400, "invalid_roster")  # commit.epochs does not contain 2

    def test_epoch_in_use_blocks_dropping(self):
        self.v.put_ok("a")
        epochs = {1: self.v.commits[1], 2: b64(os.urandom(32))}
        r = self.v.post_roster(self.v.roster_body(epoch=2, commit={"epochs": [{"c": c, "e": e} for e, c in epochs.items()],
                                                                    "nk": self.v.nk_commit}))
        self.assertEqual(r.status, 200)
        drop = {2: epochs[2]}
        body = self.v.roster_body(epoch=2, commit={"epochs": [{"c": c, "e": e} for e, c in drop.items()], "nk": self.v.nk_commit})
        r = self.v.post_roster(body)
        self.assertError(r, 409, "epoch_in_use")
        self.assertEqual(r.json()["epochs"], [1])

    def test_drop_after_rekey(self):
        self.v.put_ok("a")
        epochs = {1: self.v.commits[1], 2: b64(os.urandom(32))}
        self.v.post_roster(self.v.roster_body(epoch=2, commit={"epochs": [{"c": c, "e": e} for e, c in epochs.items()],
                                                                "nk": self.v.nk_commit}))
        items = self.c.get(self.v.path + "/rekey", self.v.auth).json()["items"]
        self.assertEqual(len(items), 1)
        r = self.c.put_bytes(f"{self.v.path}/records/{items[0]['id']}/versions/1/rekey", envelope(1, 2, items[0]["size"]),
                             {**self.v.auth, "If-Match": '"e1"'})
        self.assertEqual(r.status, 200, r)
        drop = {2: epochs[2]}
        r = self.v.post_roster(self.v.roster_body(epoch=2, commit={"epochs": [{"c": c, "e": e} for e, c in drop.items()],
                                                                    "nk": self.v.nk_commit}))
        self.assertEqual(r.status, 200, r)

    def test_roster_limits(self):
        # 64 slots are the maximum
        from .helpers import Member
        slots = dict(self.v.slots)
        members = []
        while len(slots) < 65:
            m = Member(self.v, "read")
            members.append(m)
            slots[m.slot] = self.v.entry(m.slot, "invite", "read", m.e_pub, m.s_pub, self.env.clock.t + 3600)
        body = self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"]))
        r = self.v.post_roster(body, new_slots=[m.new_slot_material() for m in members])
        self.assertError(r, 400, "invalid_roster")
        del slots[members[-1].slot]
        members.pop()
        body = self.v.roster_body(slots=sorted(slots.values(), key=lambda s: s["id"]))
        r = self.v.post_roster(body, new_slots=[m.new_slot_material() for m in members])
        self.assertEqual(r.status, 200, r)
