import copy
import os

from wds_server.util import b64u_encode, sha256

from .helpers import API, ESCROW_KEYS, Env, ServerTestCase, Vault, b64, envelope, kdf_doc


class CreateVault(ServerTestCase):
    def test_success_and_state(self):
        scope = self.env.create_scope()
        v = Vault(self.env, scope["scope"])
        r = v.create()
        self.assertEqual(r.status, 201, r)
        d = r.json()
        self.assertEqual(d["vault"], v.vault)
        self.assertEqual((d["epoch"], d["roster_version"]), (1, 1))
        self.assertEqual(d["head"], Vault.hash_of(v._pending_body))
        # the founder can unlock
        r = self.c.get(f"{API}/slots/{v.access_id}", v.auth)
        self.assertEqual(r.status, 200)
        s = r.json()
        self.assertEqual((s["role"], s["kind"], s["sv"], s["epoch"]), ("owner", "passphrase", 1, 1))
        self.assertEqual(s["roster"], {"version": 1, "head": d["head"]})
        self.assertEqual(s["keyring"]["rv"], 1)
        self.assertIsNone(s["recovery"])
        self.assertFalse(s["renewal_pending"])
        r = self.c.get(v.path + "/roster", v.auth)
        self.assertEqual(r.json()["head"], 1)
        self.assertEqual(len(r.json()["versions"]), 1)
        self.assertEqual(list(r.json()["slots"]), [v.slot])

    def test_duplicates(self):
        scope = self.env.create_scope()
        a = Vault(self.env, scope["scope"])
        self.assertEqual(a.create().status, 201)
        r = self.c.post_json(f"{API}/scopes/{scope['scope']}/vaults", a.last_body)
        self.assertError(r, 409, "vault_exists")
        b = Vault(self.env, scope["scope"])
        b.access_id = a.access_id
        self.assertError(b.create(), 409, "access_id_taken")

    def test_unknown_scope_and_suspended(self):
        v = Vault(self.env, "nope-abcdef")
        self.assertError(v.create(), 404, "not_found")
        scope = self.env.create_scope()
        r = self.c.patch_json(f"{API}/admin/scopes/{scope['scope']}", {"status": "suspended"}, self.env.op)
        self.assertEqual(r.json()["status"], "suspended")
        self.assertError(Vault(self.env, scope["scope"]).create(), 403, "scope_suspended")

    def test_the_join_code_is_the_only_way_in(self):
        coded = self.env.create_scope(slug="coded")
        code = coded["join_code"]
        self.assertEqual(len(code), 8)
        self.assertEqual(coded["enrollment"], "join_code")
        self.assertError(Vault(self.env, coded["scope"]).create(join_code="WRONGWRONG"), 403, "join_code_invalid")
        self.assertError(Vault(self.env, coded["scope"]).create(mutate=lambda b: b.pop("join_code")), 403, "join_code_invalid")
        self.assertError(Vault(self.env, coded["scope"]).create(mutate=lambda b: b.update(join_code=None)), 403, "join_code_invalid")
        # no scope is open, not even one whose code is missing from the database; no "open" or "closed" enrollment exists
        self.env.sql("SELECT 1")
        with self.env.svc.db.connection() as conn:
            conn.execute("UPDATE scopes SET join_code=NULL WHERE scope_id=?", (coded["scope"],))
        self.assertError(Vault(self.env, coded["scope"]).create(mutate=lambda b: b.pop("join_code")), 403, "join_code_invalid")
        with self.env.svc.db.connection() as conn:
            conn.execute("UPDATE scopes SET join_code=? WHERE scope_id=?", (code, coded["scope"]))
        display = code[:4].lower() + " - " + code[4:]
        self.assertEqual(Vault(self.env, coded["scope"]).create(join_code=display).status, 201)
        self.assertEqual(Vault(self.env, coded["scope"]).create(join_code="  " + code + " ").status, 201)

    def test_wrong_join_code_counts_as_auth_failure(self):
        self.env.config.rate_create = 1000
        coded = self.env.create_scope(slug="coded")
        statuses = [Vault(self.env, coded["scope"]).create(join_code="NOPENOPE").status for _ in range(62)]
        self.assertEqual(statuses[:60], [403] * 60)
        self.assertEqual(statuses[60], 429)
        # a correct code from the same IP is still throttled? no: only failures are throttled, but the code check is
        # skipped while over budget, so a correct code from a blocked IP is refused until the window passes
        self.assertEqual(Vault(self.env, coded["scope"]).create(join_code=coded["join_code"]).status, 429)
        self.env.clock.advance(61)
        self.assertEqual(Vault(self.env, coded["scope"]).create(join_code=coded["join_code"]).status, 201)

    def test_vault_limit(self):
        scope = self.env.create_scope(limits={"max_vaults": 2})
        self.assertEqual(Vault(self.env, scope["scope"]).create().status, 201)
        self.assertEqual(Vault(self.env, scope["scope"]).create().status, 201)
        self.assertError(Vault(self.env, scope["scope"]).create(), 403, "vault_limit_reached")

    def test_creation_rate_limit_per_ip(self):
        scope = self.env.create_scope(limits={"max_vaults": 500})
        for i in range(30):
            self.assertEqual(Vault(self.env, scope["scope"]).create(ip="9.9.9.9").status, 201, i)
        r = Vault(self.env, scope["scope"]).create(ip="9.9.9.9")
        self.assertError(r, 429, "rate_limited")
        self.assertGreater(int(r.headers["retry-after"]), 0)
        self.assertEqual(Vault(self.env, scope["scope"]).create(ip="9.9.9.8").status, 201)
        self.env.clock.advance(3601)
        self.assertEqual(Vault(self.env, scope["scope"]).create(ip="9.9.9.9").status, 201)

    def test_unparseable_json_does_not_count_for_creation_limit(self):
        scope = self.env.create_scope()
        for _ in range(40):
            r = self.c.request("POST", f"{API}/scopes/{scope['scope']}/vaults", {"Content-Type": "application/json"}, b"{nope")
            self.assertError(r, 400, "bad_request")
        self.assertEqual(Vault(self.env, scope["scope"]).create().status, 201)

    def test_read_only_refuses_creation(self):
        scope = self.env.create_scope()
        self.env.disk[0] = 0.85
        r = Vault(self.env, scope["scope"]).create()
        self.assertError(r, 503, "read_only")
        self.assertEqual(r.headers["retry-after"], "3600")

    def test_there_is_no_recovery_contact(self):
        """The optional contact e-mail is gone: the key is unknown, whatever its value."""
        scope = self.env.create_scope()
        for value in (None, "me@uni-bamberg.de"):
            r = Vault(self.env, scope["scope"]).create(mutate=lambda b, value=value: b.update(recovery_contact=value))
            self.assertError(r, 400, "bad_request")


class CreateValidation(ServerTestCase):
    """Every structural rule of 6.1, 6.2 and 8.3 yields a 400."""

    def setUp(self):
        super().setUp()
        self.scope = self.env.create_scope()["scope"]

    def attempt(self, mutate, status=400, code=None):
        v = Vault(self.env, self.scope)
        r = v.create(mutate=mutate)
        self.assertEqual(r.status, status, r)
        if code:
            self.assertEqual(r.json()["error"], code, r)
        return r

    def roster(self, body, fn):
        fn(body["roster"]["body"])

    def test_unknown_and_missing_keys(self):
        self.attempt(lambda b: b.update(extra=1), code="bad_request")
        self.attempt(lambda b: b.pop("recovery_hash"), code="bad_request")
        self.attempt(lambda b: b["slots"][0].update(extra=1), code="bad_request")

    def test_vault_id(self):
        self.attempt(lambda b: b.update(vault="9FYJS2VF3VP7MAQYPJ5S6KQ4P9"), code="invalid_roster")
        self.attempt(lambda b: b.update(vault="short"), code="bad_request")

    def test_roster_structure(self):
        cases = {
            "type": lambda r: r.update(type="other"),
            "version": lambda r: r.update(version=2),
            "prev": lambda r: r.update(prev="x"),
            "epoch": lambda r: r.update(epoch=2),
            "scope": lambda r: r.update(scope="other-abcdef"),
            "extra key": lambda r: r.update(extra=1),
            "float": lambda r: r.update(time=1.5),
            "commit epochs": lambda r: r["commit"].update(epochs=[]),
            "commit nk": lambda r: r["commit"].update(nk="short"),
            "one slot": lambda r: r.update(slots=r["slots"][:1]),
            "three slots": lambda r: r["slots"].append(dict(r["slots"][0], id="AAAAAAAAAAAAAAAA")),
            "signer unknown": lambda r: r.update(signer="AAAAAAAAAAAAAAAA"),
            "bad pub": lambda r: r["slots"][0].update(e_pub=b64(b"\x05" + bytes(64))),
            "short pub": lambda r: r["slots"][0].update(s_pub=b64(b"\x04" + bytes(10))),
            "bad role": lambda r: r["slots"][0].update(role="admin"),
            "expires on passphrase": lambda r: r["slots"][0].update(expires=5),
        }
        for name, fn in cases.items():
            with self.subTest(name):
                def mutate(b, fn=fn):
                    fn(b["roster"]["body"])
                r = self.attempt(mutate)
                if name == "float":
                    self.assertEqual(r.json()["error"], "bad_request")  # floats are rejected while parsing
                else:
                    self.assertEqual(r.json()["error"], "invalid_roster", name)
                    self.assertIn("detail", r.json())

    def test_escrow_rules(self):
        def swap_keys(b):
            for s in b["roster"]["body"]["slots"]:
                if s["kind"] == "escrow":
                    s["e_pub"] = b64(b"\x04" + os.urandom(64))
        self.attempt(swap_keys, code="invalid_roster")

        def both_passphrase(b):
            for s in b["roster"]["body"]["slots"]:
                s["kind"] = "passphrase"
        self.attempt(both_passphrase, code="invalid_roster")

        def spare_ok(b):
            for s in b["roster"]["body"]["slots"]:
                if s["kind"] == "escrow":
                    s["e_pub"], s["s_pub"] = (b64(k) for k in ESCROW_KEYS["spare"])
        self.attempt(spare_ok, status=201)

        def escrow_signs(b):
            r = b["roster"]["body"]
            r["signer"] = next(s["id"] for s in r["slots"] if s["kind"] == "escrow")
        self.attempt(escrow_signs, code="invalid_roster")

    def test_slots_unsorted_or_duplicate(self):
        def reverse(b):
            r = b["roster"]["body"]
            r["slots"] = list(reversed(r["slots"]))
        self.attempt(reverse, code="invalid_roster")

    def test_founder_slot_entry(self):
        self.attempt(lambda b: b["slots"].append(dict(b["slots"][0])), code="bad_request")
        self.attempt(lambda b: b["slots"][0].update(slot="AAAAAAAAAAAAAAAA"), code="bad_request")
        self.attempt(lambda b: b["slots"][0].update(access_id="000G40R40M30E209185Y"), code="bad_request")
        self.attempt(lambda b: b["slots"][0].update(token_hash="short"), code="bad_request")
        self.attempt(lambda b: b["slots"][0].update(kdf={"alg": "invite"}), code="bad_request")

    def test_kdf_window(self):
        for change in ({"m": 1024}, {"m": 262145}, {"t": 2}, {"t": 11}, {"p": 2}, {"v": 16}, {"salt": b64(os.urandom(8))},
                       {"alg": "argon2d"}):
            with self.subTest(change):
                self.attempt(lambda b, c=change: b["slots"][0].update(kdf={**kdf_doc(), **c}), code="bad_request")
        self.attempt(lambda b: b["slots"][0].update(kdf={**kdf_doc(), "m": 262144, "t": 10}), status=201)
        self.attempt(lambda b: b["slots"][0]["kdf"].update(extra=1), code="bad_request")

    def test_wrapped_envelope(self):
        bad = {
            "short": envelope(2, 0, 20),
            "magic": envelope(2, 0, 100, magic=b"XXXX"),
            "type": envelope(1, 0, 100),
            "flags": envelope(2, 0, 100, flags=1),
            "epoch": envelope(2, 5, 100),
            "long": envelope(2, 0, 4097),
        }
        for name, data in bad.items():
            with self.subTest(name):
                self.attempt(lambda b, d=data: b["slots"][0].update(wrapped=b64(d)), code="malformed_envelope")
        self.attempt(lambda b: b["slots"][0].update(wrapped=b64(envelope(2, 0, 4096))), status=201)
        self.attempt(lambda b: b["slots"][0].update(wrapped=b64(envelope(2, 0, 100)) + "="), code="malformed_envelope")

    def test_keyring(self):
        self.attempt(lambda b: b["keyring"].pop(next(iter(b["keyring"]))), code="invalid_keyring")
        self.attempt(lambda b: b["keyring"].update({"AAAAAAAAAAAAAAAA": b64(envelope(3, 0, 140))}), code="invalid_keyring")
        self.attempt(lambda b: b.update(keyring=[]), code="invalid_keyring")
        first = lambda b: next(iter(b["keyring"]))  # noqa: E731
        self.attempt(lambda b: b["keyring"].update({first(b): b64(envelope(3, 0, 102))}), code="malformed_envelope")
        self.attempt(lambda b: b["keyring"].update({first(b): b64(envelope(2, 0, 140))}), code="malformed_envelope")
        self.attempt(lambda b: b["keyring"].update({first(b): b64(envelope(3, 1, 140))}), code="malformed_envelope")
        self.attempt(lambda b: b["keyring"].update({first(b): b64(envelope(3, 0, 16385))}), code="malformed_envelope")
        raw = bytearray(envelope(3, 0, 140))
        raw[10] = 0x02
        self.attempt(lambda b: b["keyring"].update({first(b): b64(bytes(raw))}), code="malformed_envelope")

    def test_recovery_hash(self):
        self.attempt(lambda b: b.update(recovery_hash="short"), code="bad_request")
        self.attempt(lambda b: b.update(recovery_hash=None), code="bad_request")

    def test_content_type_and_length_rules(self):
        url = f"{API}/scopes/{self.scope}/vaults"
        r = self.c.request("POST", url, {"Content-Type": "text/plain"}, b"{}")
        self.assertError(r, 415, "unsupported_media_type")
        r = self.c.request("POST", url, {"Content-Type": "application/json; charset=latin-1"}, b"{}")
        self.assertError(r, 415, "unsupported_media_type")
        r = self.c.request("POST", url, {"Content-Type": "application/json; charset=UTF-8"}, b"[]")
        self.assertError(r, 400, "bad_request")
        r = self.c.request("POST", url, {"Content-Type": "application/json"}, b"{}", add_length=False)
        self.assertError(r, 411, "length_required")
        r = self.c.request("POST", url, {"Content-Type": "application/json", "Content-Length": "1048577"}, b"{}",
                           add_length=False)
        self.assertError(r, 413, "value_too_large")
        r = self.c.request("POST", url, {"Content-Type": "application/json"}, b'{"a":1,"a":2}')
        self.assertError(r, 400, "bad_request")
        r = self.c.request("POST", url, {"Content-Type": "application/json"}, b'\xef\xbb\xbf{}')
        self.assertError(r, 400, "bad_request")
        r = self.c.request("POST", url, {"Content-Type": "application/json"}, b'{"a":\xff}')
        self.assertError(r, 400, "bad_request")
        r = self.c.request("POST", url, {"Content-Type": "application/json"}, b'{"a":1e3}')
        self.assertError(r, 400, "bad_request")
