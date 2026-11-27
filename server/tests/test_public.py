from wds_server.util import max_envelope_bytes

from .helpers import API, ServerTestCase


class PublicEndpoints(ServerTestCase):
    def test_scope_document(self):
        scope = self.env.create_scope(slug="notenrechner", name="Notenrechner")
        self.assertRegex(scope["scope"], r"^notenrechner-[0-9a-hjkmnp-tv-z]{6}$")
        r = self.c.get(f"{API}/scopes/{scope['scope']}")
        self.assertEqual(r.status, 200)
        d = r.json()
        self.assertEqual(set(d), {"scope", "name", "status", "enrollment", "read_only", "limits", "kdf", "escrow",
                                  "library", "privacy_url", "sandbox"})
        self.assertIsNone(d["sandbox"])  # only the configured sandbox scope carries a sandbox block
        self.assertEqual(d["name"], "Notenrechner")
        self.assertEqual(d["status"], "active")
        self.assertEqual(d["kdf"], {"alg": "argon2id", "m": 65536, "p": 1, "t": 3, "v": 19})
        self.assertEqual(set(d["limits"]), {"history_versions", "max_envelope_bytes", "max_value_bytes", "vault_bytes"})
        self.assertEqual(d["limits"]["max_value_bytes"], 10485760)
        self.assertEqual(d["limits"]["max_envelope_bytes"], max_envelope_bytes(10485760))
        self.assertEqual([e["status"] for e in d["escrow"]], ["current", "spare"])
        self.assertEqual(len(d["escrow"][0]["id"]), 43)
        self.assertIn("latest", d["library"])
        self.assertTrue(d["privacy_url"].startswith("https://wiai.uni-bamberg.de/datastore/"))
        self.assertNotIn("join_code", d)

    def test_unknown_scope(self):
        self.assertError(self.c.get(f"{API}/scopes/nope-abcdef"), 404, "not_found")
        self.assertError(self.c.get(f"{API}/scopes/NOPE"), 404, "not_found")

    def test_kdf_lookup(self):
        v = self.env.new_vault()
        r = self.c.get(f"{API}/slots/{v.access_id}/kdf")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json()["kind"], "passphrase")
        self.assertEqual(r.json()["kdf"]["alg"], "argon2id")
        m = v.invite()
        r = self.c.get(f"{API}/slots/{m.access_id}/kdf")
        self.assertEqual(r.json(), {"kind": "invite", "kdf": {"alg": "invite"}})

    def test_kdf_malformed_and_unknown(self):
        self.assertError(self.c.get(f"{API}/slots/000G40R40M30E209185Y/kdf"), 400, "bad_request")
        self.assertError(self.c.get(f"{API}/slots/short/kdf"), 400, "bad_request")
        self.assertError(self.c.get(f"{API}/slots/000G40R40M30E209185Z/kdf"), 404, "not_found")

    def test_healthz(self):
        r = self.c.get("/datastore/healthz")
        self.assertEqual(r.json(), {"status": "ok", "read_only": False})
        self.env.disk[0] = 0.9
        self.assertEqual(self.c.get("/datastore/healthz").json(), {"status": "ok", "read_only": True})

    def test_json_404_and_405(self):
        r = self.c.get(f"{API}/nothing")
        self.assertError(r, 404, "not_found")
        self.assertEqual(r.headers["access-control-allow-origin"], "*")
        r = self.c.request("PATCH", f"{API}/scopes/x-abcdef")
        self.assertError(r, 405, "method_not_allowed")
        self.assertIn("allow", r.headers)
        self.assertEqual(r.headers["access-control-allow-origin"], "*")

    def test_head_is_served_like_get(self):
        scope = self.env.create_scope()
        r = self.c.request("HEAD", f"{API}/scopes/{scope['scope']}")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.headers["access-control-allow-origin"], "*")

    def test_no_slash_redirects_under_api(self):
        r = self.c.get(f"{API}/scopes/nope-abcdef/")
        self.assertError(r, 404, "not_found")

    def test_root_redirect_and_placeholder(self):
        r = self.c.get("/datastore")
        self.assertEqual(r.status, 308)
        self.assertEqual(r.headers["location"], "/datastore/")
        r = self.c.get("/datastore/")
        self.assertEqual(r.status, 200)
        self.assertIn("text/html", r.headers["content-type"])
        self.assertEqual(r.headers["x-content-type-options"], "nosniff")


class StaticClient(ServerTestCase):
    def test_serves_library_with_immutable_cors_headers(self):
        import os
        d = self.env.config.client_dir
        with open(os.path.join(d, "wds-1.2.3.js"), "wb") as fh:
            fh.write(b"console.log(1)")
        with open(os.path.join(d, "wds-1.2.3.js.sri"), "wb") as fh:
            fh.write(b"sha384-abc=")
        r = self.c.get("/datastore/client/wds-1.2.3.js")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.body, b"console.log(1)")
        self.assertEqual(r.headers["content-type"], "text/javascript; charset=utf-8")
        self.assertEqual(r.headers["access-control-allow-origin"], "*")
        self.assertEqual(r.headers["cross-origin-resource-policy"], "cross-origin")
        self.assertEqual(r.headers["cache-control"], "public, max-age=31536000, immutable")
        self.assertEqual(r.headers["x-content-type-options"], "nosniff")
        r = self.c.get("/datastore/client/wds-1.2.3.js.sri")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.body, b"sha384-abc=")
        self.assertEqual(r.headers["access-control-allow-origin"], "*")
        self.assertEqual(r.headers["cache-control"], "public, max-age=31536000, immutable")
        self.assertEqual(self.env.client.get("/datastore/client/wds-9.js").status, 404)

    def test_latest_library_version_from_dist(self):
        import os
        d = self.env.config.client_dir
        for n in ("wds-1.0.0.js", "wds-1.10.0.js", "wds-1.9.0.js"):
            open(os.path.join(d, n), "wb").close()
        scope = self.env.create_scope()
        self.assertEqual(self.c.get(f"{API}/scopes/{scope['scope']}").json()["library"]["latest"], "1.10.0")

    def test_no_path_traversal(self):
        for name in ("..%2Fetc%2Fpasswd", "wds-..%2F..%2Fx.js", "other.js", "wds-1.0.0.txt"):
            self.assertEqual(self.c.get("/datastore/client/" + name).status, 404, name)
