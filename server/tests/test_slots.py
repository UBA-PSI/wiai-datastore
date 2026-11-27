import os

from wds_server.util import b64u_encode, sha256

from .helpers import API, INVITE_KDF, ServerTestCase, Vault, b64, envelope, kdf_doc


class SlotEndpoints(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.v = self.env.new_vault()

    def put_slot(self, v=None, sv=1, **over):
        v = v or self.v
        body = {"kdf": kdf_doc(), "token_hash": b64(sha256(b"n" * 32)), "wrapped": b64(envelope(2, 0, 180))}
        body.update(over)
        h = {**v.auth}
        if sv is not None:
            h["If-Match"] = f'"{sv}"'
        return self.c.put_json(f"{API}/slots/{v.access_id}", body, h)

    def test_get_slot_requires_matching_token(self):
        other = self.env.new_vault()
        r = self.c.get(f"{API}/slots/{self.v.access_id}", other.auth)
        self.assertError(r, 403, "forbidden")
        r = self.c.get(f"{API}/slots/{self.v.access_id}")
        self.assertError(r, 401, "unauthorized")
        self.assertEqual(r.headers["www-authenticate"], 'Bearer realm="wds"')

    def test_put_slot_changes_token(self):
        r = self.put_slot()
        self.assertEqual(r.status, 200, r)
        self.assertEqual(r.json(), {"sv": 2})
        self.assertError(self.c.get(f"{API}/slots/{self.v.access_id}", self.v.auth), 401, "unauthorized")
        new = Vault.bearer(self.v.access_id, b"n" * 32)
        r = self.c.get(f"{API}/slots/{self.v.access_id}", new)
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json()["sv"], 2)

    def test_put_slot_preconditions(self):
        self.assertError(self.put_slot(sv=None), 428, "precondition_required")
        r = self.put_slot(sv=7)
        self.assertEqual(r.status, 412)
        self.assertEqual(r.json()["current"], 1)
        r = self.c.put_json(f"{API}/slots/{self.v.access_id}", {}, {**self.v.auth, "If-Match": "W/\"1\""})
        self.assertError(r, 400, "bad_request")
        r = self.c.put_json(f"{API}/slots/{self.v.access_id}", {}, {**self.v.auth, "If-Match": "*"})
        self.assertError(r, 400, "bad_request")

    def test_put_slot_validation(self):
        self.assertError(self.put_slot(kdf={"alg": "invite"}), 400, "bad_request")
        self.assertError(self.put_slot(token_hash="x"), 400, "bad_request")
        self.assertError(self.put_slot(wrapped=b64(envelope(1, 1, 100))), 400, "malformed_envelope")
        self.assertError(self.put_slot(extra=1), 400, "bad_request")

    def test_put_slot_for_invite_is_not_redeemed(self):
        m = self.v.invite()
        r = self.c.put_json(f"{API}/slots/{m.access_id}",
                            {"kdf": kdf_doc(), "token_hash": b64(sha256(b"x")), "wrapped": b64(envelope(2, 0, 180))},
                            {**m.auth, "If-Match": '"1"'})
        self.assertError(r, 409, "not_redeemed")

    def test_redeem_flow(self):
        m = self.v.invite(role="read")
        r = self.c.get(f"{API}/slots/{m.access_id}", m.auth)
        d = r.json()
        self.assertEqual((d["kind"], d["role"], d["kdf"]), ("invite", "read", INVITE_KDF))
        self.assertIsNotNone(d["expires"])
        r = m.redeem()
        self.assertEqual(r.status, 200, r)
        self.assertEqual(r.json(), {"sv": 2})
        # the invite token is gone, the new one works
        self.assertError(self.c.get(f"{API}/slots/{m.access_id}", Vault.bearer(m.access_id, b"\x00" * 32)), 401, "unauthorized")
        d = self.c.get(f"{API}/slots/{m.access_id}", m.auth).json()
        self.assertEqual((d["kind"], d["role"], d["renewal_pending"], d["expires"]), ("passphrase", "read", True, None))
        self.assertEqual(d["kdf"]["alg"], "argon2id")
        # the owner sees the redemption
        s = self.c.get(self.v.path + "/roster", self.v.auth).json()["slots"][m.slot]
        self.assertTrue(s["used"])
        self.assertIsNotNone(s["redeemed"])
        self.assertEqual(s["renewal"]["body"]["slot"], m.slot)
        self.assertFalse(s["expired"])
        # a second redemption fails
        again = self.c.post_json(f"{API}/slots/{m.access_id}/redeem", {"kdf": kdf_doc(), "token_hash": b64(sha256(b"z")),
                                 "wrapped": b64(envelope(2, 0, 200)), "renewal": m.renewal()}, m.auth)
        self.assertError(again, 409, "already_redeemed")

    def test_redeem_renewal_checks(self):
        for name, over in {
            "other slot": {"slot": b64(os.urandom(12))}, "other vault": {"vault": "9FYJS2VF3VP7MAQYPJ5S6KQ4P9"},
            "other scope": {"scope": "x-abcdef"}, "rv too high": {"rv": 99}, "rv zero": {"rv": 0},
            "type": {"type": "other"}, "version": {"v": 2}, "pub": {"e_pub": "AAAA"},
        }.items():
            with self.subTest(name):
                m = self.v.invite()
                r = m.redeem(renewal=m.renewal(**over))
                self.assertError(r, 400, "bad_request")
        m = self.v.invite()
        bad = m.renewal()
        bad["sig"] = "short"
        self.assertError(m.redeem(renewal=bad), 400, "bad_request")
        bad = m.renewal()
        bad["body"]["extra"] = 1
        self.assertError(m.redeem(renewal=bad), 400, "bad_request")

    def test_invite_expiry(self):
        m = self.v.invite(ttl=100)
        self.env.clock.advance(99)
        self.assertEqual(self.c.get(f"{API}/slots/{m.access_id}", m.auth).status, 200)
        self.env.clock.advance(1)
        self.assertError(self.c.get(f"{API}/slots/{m.access_id}", m.auth), 410, "invite_expired")
        self.assertError(m.redeem(), 410, "invite_expired")
        s = self.c.get(self.v.path + "/roster", self.v.auth).json()["slots"][m.slot]
        self.assertTrue(s["expired"])
        # a wrong token on an expired invite is just unauthorized
        self.assertError(self.c.get(f"{API}/slots/{m.access_id}", Vault.bearer(m.access_id, os.urandom(32))), 401, "unauthorized")

    def test_the_manual_renewal_endpoint_is_gone(self):
        m = self.v.invite()
        m.redeem()
        body = {"renewal": m.renewal(), "wrapped": b64(envelope(2, 0, 300))}
        self.assertIn(self.c.post_json(f"{API}/slots/{m.access_id}/renewal", body, {**m.auth, "If-Match": '"2"'}).status, (404, 405))

    def test_revoked_access_answers_401_revoked(self):
        m = self.v.invite()
        m.redeem()
        r = self.v.revoke(m.slot)
        self.assertEqual(r.status, 200, r)
        self.assertError(self.c.get(f"{API}/slots/{m.access_id}", m.auth), 401, "revoked")
        self.assertError(self.c.get(f"{API}/vaults/{self.v.vault}/usage", m.auth), 401, "revoked")
        self.assertError(self.c.get(f"{API}/slots/{m.access_id}/kdf"), 404, "not_found")

    def test_vault_deleted_gives_410_everywhere(self):
        r = self.c.delete(self.v.path, self.v.auth)
        self.assertEqual(r.status, 200)
        d = r.json()
        self.assertEqual(d["purge_after"], d["deleted"] + 2592000)
        for path in (f"{API}/slots/{self.v.access_id}", self.v.path + "/roster", self.v.path + "/usage",
                     self.v.path + "/records"):
            self.assertError(self.c.get(path, self.v.auth), 410, "vault_deleted")
        self.assertError(self.v.put("x", if_none_match=True), 410, "vault_deleted")
        self.assertError(self.c.delete(self.v.path, self.v.auth), 410, "vault_deleted")
