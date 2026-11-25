from .helpers import API, ServerTestCase

EXPOSE = "ETag, Retry-After, WDS-Commit"


class Cors(ServerTestCase):
    def test_preflight_any_api_path(self):
        for path in (f"{API}/scopes/x", f"{API}/vaults/abc/records/def", f"{API}/does/not/exist", f"{API}/admin/scopes"):
            r = self.c.request("OPTIONS", path, {"Origin": "null", "Access-Control-Request-Method": "PUT"})
            self.assertEqual(r.status, 204, path)
            self.assertEqual(r.body, b"")
            h = r.headers
            self.assertEqual(h["access-control-allow-origin"], "*")
            self.assertEqual(h["access-control-expose-headers"], EXPOSE)
            self.assertEqual(h["access-control-allow-methods"], "GET, PUT, POST, DELETE")
            self.assertEqual(h["access-control-allow-headers"],
                             "Authorization, Content-Type, If-Match, If-None-Match, WDS-Commit")
            self.assertEqual(h["access-control-max-age"], "600")
            self.assertNotIn("access-control-allow-credentials", h)

    def test_preflight_not_rate_limited_or_authenticated(self):
        for _ in range(200):
            self.assertEqual(self.c.request("OPTIONS", f"{API}/vaults/x/roster").status, 204)

    def test_origin_never_echoed(self):
        for origin in ("null", "https://evil.example", "file://"):
            r = self.c.get(f"{API}/scopes/nope-abcdef", {"Origin": origin})
            self.assertEqual(r.headers["access-control-allow-origin"], "*")
            self.assertNotIn("access-control-allow-credentials", r.headers)

    def test_headers_on_success_error_and_429(self):
        scope = self.env.create_scope()
        responses = [self.c.get(f"{API}/scopes/{scope['scope']}"), self.c.get(f"{API}/scopes/nope-abcdef"),
                     self.c.get(f"{API}/slots/000G40R40M30E209185Z", {"Authorization": "Bearer nonsense"})]
        for _ in range(70):
            responses.append(self.c.get(f"{API}/slots/000G40R40M30E209185Z", {"Authorization": "Bearer wds1.bad.bad"}))
        self.assertEqual(responses[-1].status, 429)
        for r in responses:
            self.assertEqual(r.headers["access-control-allow-origin"], "*", r)
            self.assertEqual(r.headers["access-control-expose-headers"], EXPOSE)
            self.assertEqual(r.headers["cache-control"], "no-store")
            self.assertEqual(r.headers["x-content-type-options"], "nosniff")
            self.assertEqual(r.headers["referrer-policy"], "no-referrer")
            self.assertEqual(r.headers["strict-transport-security"], "max-age=31536000")

    def test_unhandled_error_still_has_cors(self):
        import unittest.mock as m
        with m.patch("wds_server.api_public._get_scope", side_effect=RuntimeError("boom")), \
                self.assertLogs("wds_server", "ERROR"):
            r = self.c.get(f"{API}/scopes/x-abcdef")
        self.assertError(r, 500, "internal")
        self.assertEqual(r.headers["access-control-allow-origin"], "*")
