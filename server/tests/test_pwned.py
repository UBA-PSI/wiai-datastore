"""The breach check through this server: GET /datastore/api/v1/pwned/<5 uppercase hex characters> (pwned.py).

The service itself is never contacted: the unit tests replace the fetch, the HTTP test runs a small server of its own."""

import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from wds_server import pwned

from .helpers import API, ServerTestCase

SUFFIX = "0018A45C4D1DEF81644B54AB7F969B88D65"      # 35 hex characters
PAD = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
ANSWER = (SUFFIX + ":10\r\n" + PAD + ":0\r\n" + "00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2\r\n").encode()


class Case(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.calls = []
        self.answer = ANSWER

        def fetch(prefix):
            self.calls.append(prefix)
            if isinstance(self.answer, Exception):
                raise self.answer
            return self.answer
        self.env.svc.pwned.fetch = fetch

    def ask(self, prefix="21BD1", ip=None):
        return self.c.get(f"{API}/pwned/{prefix}", ip=ip) if ip else self.c.get(f"{API}/pwned/{prefix}")


class Contract(Case):
    def test_the_answer_is_the_range_list_as_plain_text(self):
        r = self.ask()
        self.assertEqual(r.status, 200, r)
        self.assertEqual(r.headers["content-type"], "text/plain; charset=utf-8")
        self.assertEqual(r.headers["cache-control"], "no-store")
        self.assertEqual(r.headers["access-control-allow-origin"], "*")          # apps on other origins call it, too
        lines = r.text.split("\r\n")
        self.assertEqual(lines[:3], [SUFFIX + ":10", PAD + ":0", "00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2"])   # padding stays: the client ignores count 0
        self.assertEqual(self.calls, ["21BD1"])

    def test_only_five_uppercase_hex_characters(self):
        for bad in ("21bd1", "21BD", "21BD12", "21BDG", "2 BD1", "21BD%2F", "%00%00%00%00%00"):
            r = self.ask(bad)
            self.assertIn(r.status, (400, 404), bad)
            self.assertEqual(r.json()["error"] in ("bad_request", "not_found"), True)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.ask("00000").status, 200)
        self.assertEqual(self.ask("FFFFF").status, 200)

    def test_get_only(self):
        for method in ("POST", "PUT", "DELETE"):
            self.assertEqual(self.c.request(method, f"{API}/pwned/21BD1", {}, b"").status, 405, method)

    def test_no_token_and_no_scope_are_needed(self):
        self.assertEqual(self.ask().status, 200)
        self.assertEqual(self.c.get(f"{API}/pwned/21BD1", {"Authorization": "Bearer garbage"}).status, 200)


class Cache(Case):
    def test_answers_are_cached_for_24_hours(self):
        self.assertEqual(self.ask().status, 200)
        self.env.clock.advance(24 * 3600 - 1)
        self.assertEqual(self.ask().status, 200)
        self.assertEqual(self.calls, ["21BD1"])
        self.env.clock.advance(2)
        self.assertEqual(self.ask().status, 200)
        self.assertEqual(self.calls, ["21BD1", "21BD1"])

    def test_the_cache_is_bounded(self):
        self.env.config.rate_pwned = 10**6
        for i in range(pwned.CACHE_ENTRIES + 5):
            self.assertEqual(self.ask("%05X" % i).status, 200)
        self.assertLessEqual(len(self.env.svc.pwned._cache), pwned.CACHE_ENTRIES)
        self.calls.clear()
        self.ask("%05X" % (pwned.CACHE_ENTRIES + 4))     # the newest is still there
        self.assertEqual(self.calls, [])
        self.ask("00000")                                # the oldest is gone
        self.assertEqual(self.calls, ["00000"])

    def test_a_failure_is_not_cached(self):
        self.answer = b"<html>Service Unavailable</html>"
        self.assertEqual(self.ask().status, 503)
        self.assertEqual(self.env.svc.pwned._cache, {})


class Unreachable(Case):
    def test_503_when_the_service_cannot_be_reached_and_no_new_attempt_for_a_minute(self):
        self.answer = OSError("Network is unreachable")
        r = self.ask()
        self.assertError(r, 503, "pwned_unavailable")
        self.assertEqual(r.headers["retry-after"], "60")
        self.assertEqual(r.headers["access-control-allow-origin"], "*")
        self.assertEqual(self.ask("AAAAA").status, 503)
        self.assertEqual(self.calls, ["21BD1"])           # the second request did not wait for another timeout
        self.env.clock.advance(59)
        self.assertEqual(self.ask("BBBBB").status, 503)
        self.assertEqual(self.calls, ["21BD1"])
        self.env.clock.advance(2)
        self.answer = ANSWER                              # the service is back
        self.assertEqual(self.ask("BBBBB").status, 200)
        self.assertEqual(self.calls, ["21BD1", "BBBBB"])

    def test_cached_answers_survive_an_outage(self):
        self.assertEqual(self.ask().status, 200)
        self.answer = TimeoutError()
        self.assertEqual(self.ask("AAAAA").status, 503)
        self.assertEqual(self.ask().status, 200)

    def test_an_answer_that_is_not_the_service_is_a_503(self):
        for junk in (b"", b"hello", b"<html>blocked by firewall</html>", b"ABC:1", (SUFFIX + ":x").encode(), b"\xff\xfe", b"0" * 3_000_000):
            self.env.svc.pwned._down_until = 0
            self.answer = junk
            self.assertEqual(self.ask().status, 503, junk[:20])

    def test_switched_off_by_an_empty_url(self):
        self.env.svc.pwned.url = ""
        self.assertError(self.ask(), 503, "pwned_unavailable")
        self.assertEqual(self.calls, [])

    def test_everything_else_works_while_it_is_down(self):
        self.answer = OSError("blocked")
        self.assertEqual(self.ask().status, 503)
        v = self.env.new_vault()
        self.assertEqual(self.c.get(f"{API}/slots/{v.access_id}", v.auth).status, 200)
        self.assertEqual(self.c.get("/datastore/healthz").status, 200)

    def test_too_many_parallel_requests_do_not_pile_up(self):
        for _ in range(pwned.MAX_PARALLEL):
            self.env.svc.pwned._slots.acquire()
        self.assertEqual(self.ask().status, 503)
        self.assertEqual(self.calls, [])


class RateLimit(Case):
    def test_per_client_every_request_counts_cached_ones_too(self):
        statuses = [self.ask(ip="9.9.9.9").status for _ in range(121)]
        self.assertEqual(statuses[:120], [200] * 120)
        self.assertEqual(statuses[120], 429)
        r = self.ask(ip="9.9.9.9")
        self.assertError(r, 429, "rate_limited")
        self.assertGreater(int(r.headers["retry-after"]), 0)
        self.assertEqual(self.ask(ip="9.9.9.8").status, 200)               # another client is not affected
        self.assertEqual(self.calls, ["21BD1"])                           # 121 requests, one visit to the service
        self.env.clock.advance(61)
        self.assertEqual(self.ask(ip="9.9.9.9").status, 200)

    def test_the_limit_is_configurable_and_separate_from_the_authentication_budget(self):
        self.env.config.rate_pwned = 2
        self.assertEqual([self.ask(ip="7.7.7.7").status for _ in range(3)], [200, 200, 429])
        v = self.env.new_vault()
        self.assertEqual(self.c.get(f"{API}/slots/{v.access_id}", v.auth, ip="7.7.7.7").status, 200)


class Privacy(Case):
    def test_the_prefix_is_never_logged_and_never_with_an_address(self):
        records = []

        class Catch(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())
        handler = Catch(level=logging.DEBUG)
        root = logging.getLogger()
        old = root.level
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
        try:
            self.assertEqual(self.ask("ABCDE", ip="203.0.113.77").status, 200)
            self.answer = OSError("down")
            self.assertEqual(self.ask("12345", ip="203.0.113.78").status, 503)
        finally:
            root.removeHandler(handler)
            root.setLevel(old)
        text = "\n".join(records)
        for secret in ("ABCDE", "12345", "203.0.113.77", "203.0.113.78"):
            self.assertNotIn(secret, text)
        self.assertEqual(len(records), 1)                                  # one line about the outage, without a prefix
        self.assertIn("not reachable", text)

    def test_no_audit_row_and_nothing_stored(self):
        before = self.env.sql("SELECT COUNT(*) FROM audit")[0][0]
        self.ask("ABCDE")
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM audit")[0][0], before)
        for table in ("meta", "audit"):
            self.assertNotIn("ABCDE", repr(self.env.sql(f"SELECT * FROM {table}")))


class FakeService(BaseHTTPRequestHandler):
    seen = []
    status = 200

    def do_GET(self):
        FakeService.seen.append((self.path, self.headers.get("Add-Padding"), self.headers.get("User-Agent")))
        body = ANSWER if FakeService.status == 200 else b"nope"
        self.send_response(FakeService.status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class OverHttp(ServerTestCase):
    """The real fetch (urllib) against a local stand-in for api.pwnedpasswords.com."""

    def setUp(self):
        super().setUp()
        FakeService.seen, FakeService.status = [], 200
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeService)
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        self.port = self.upstream.server_address[1]
        self.env.svc.pwned.url = f"http://127.0.0.1:{self.port}/range/"

    def tearDown(self):
        self.upstream.shutdown()
        self.upstream.server_close()
        super().tearDown()

    def test_the_request_to_the_service_carries_the_prefix_and_asks_for_padding_and_nothing_else(self):
        r = self.c.get(f"{API}/pwned/21BD1", {"Authorization": "Bearer secret", "Cookie": "a=b", "Referer": "https://app.example/"})
        self.assertEqual(r.status, 200, r)
        self.assertEqual(r.text.split("\r\n")[0], SUFFIX + ":10")
        self.assertEqual(FakeService.seen, [("/range/21BD1", "true", "wiai-datastore")])

    def test_a_refusing_service_and_a_closed_port_are_503(self):
        FakeService.status = 429
        self.assertEqual(self.c.get(f"{API}/pwned/21BD1").status, 503)
        FakeService.status = 200
        self.env.svc.pwned._down_until = 0
        self.upstream.shutdown()
        self.upstream.server_close()
        self.assertEqual(self.c.get(f"{API}/pwned/AAAAA").status, 503)
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeService)    # tearDown shuts it down
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()

    def test_a_service_that_sends_slowly_is_cut_off_after_the_total_time(self):
        pwned.TOTAL_SECONDS = -1    # the time is already over when the first chunk would be read
        try:
            self.assertEqual(self.c.get(f"{API}/pwned/21BD1").status, 503)
        finally:
            pwned.TOTAL_SECONDS = 8
