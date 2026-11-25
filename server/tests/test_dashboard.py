"""login.psi login, sessions, authorisation rules, dev login."""

import json
import os
import re
import urllib.parse

from nacl.secret import SecretBox

from wds_server import access
from wds_server.dashboard import safe_next

from .dash_helpers import D, DashCase, Env


class LoginPsi(DashCase):
    def test_start_redirects_to_login_psi(self):
        b = self.browser()
        r, sent = self.start_login(b, "/datastore/scopes/x")
        loc = urllib.parse.urlsplit(r.headers["location"])
        self.assertEqual(loc.scheme + "://" + loc.netloc + loc.path, "https://login.psi.uni-bamberg.de/loginapi/request")
        q = urllib.parse.parse_qs(loc.query)
        self.assertEqual(q["app"], ["wiai-datastore"])
        self.assertEqual(sent["next"], "/datastore/scopes/x")
        nonce_cookie = [c for c in b.raw_cookies if c.startswith("__Host-wds_login=")][0]
        self.assertEqual(sent["session_key"], nonce_cookie.split("=", 1)[1].split(";")[0])
        for part in ("Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=600"):
            self.assertIn(part, nonce_cookie)

    def test_app_and_url_come_from_config(self):
        self.env.close()
        self.config = {"loginpsi_app": "other-app", "loginpsi_url": "https://login.example.org"}
        self.setUp()
        r, _ = self.start_login(self.browser())
        self.assertTrue(r.headers["location"].startswith("https://login.example.org/loginapi/request?app=other-app&token="))

    def test_callback_creates_session_with_strict_cookie(self):
        b = self.browser()
        r = self.login(b)
        self.assertEqual(r.status, 200, r)
        self.assertIn('http-equiv="refresh"', r.text)  # same-site hop so the Strict cookie is sent (see dashboard.py)
        session = [c for c in b.login_cookies if c.startswith("__Host-wds_session=")]
        self.assertEqual(len(session), 1)
        self.assertEqual(set(p.strip() for p in session[0].split(";")[1:]), {"Path=/", "Secure", "HttpOnly", "SameSite=Strict"})
        self.assertNotIn("Domain", session[0])
        self.assertNotIn("__Host-wds_login", b.cookies)  # nonce cleared
        home = b.get("/")
        self.assertEqual(home.status, 200)
        self.assertIn("Alice Example", home.text)
        # only the hash of the cookie is stored
        token = b.cookies["__Host-wds_session"]
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM sessions WHERE token_hash=?", (token.encode(),))[0][0], 0)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM sessions")[0][0], 1)

    def test_matriculation_number_is_not_stored(self):
        b = self.browser()
        self.login(b, "student", "s@stud.uni-bamberg.de", matriculation="1234567")
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM sessions")[0][0], 0)
        dump = json.dumps([list(map(str, r)) for r in self.env.sql("SELECT * FROM sessions")])
        self.assertNotIn("1234567", dump)

    def test_nonce_is_single_use(self):
        b = self.browser()
        r, sent = self.start_login(b)
        token = urllib.parse.quote(self.login_token(sent["session_key"]))
        nonce = b.cookies["__Host-wds_login"]
        self.assertEqual(b.get("/_lpmiddleware/login?token=" + token).status, 200)
        b2 = self.browser()
        b2.cookies["__Host-wds_login"] = nonce  # a copy of the cookie, as a replaying attacker would have
        r = b2.get("/_lpmiddleware/login?token=" + token)
        self.assertEqual(r.status, 403)
        self.assertNotIn("__Host-wds_session", b2.cookies)

    def test_response_for_another_browser_is_refused(self):
        victim = self.browser()
        _, sent_v = self.start_login(victim)
        attacker = self.browser()
        _, sent_a = self.start_login(attacker)
        token = urllib.parse.quote(self.login_token(sent_a["session_key"]))
        r = victim.get("/_lpmiddleware/login?token=" + token)  # attacker's login result sent to the victim
        self.assertEqual(r.status, 403)
        self.assertNotIn("__Host-wds_session", victim.cookies)
        nocookie = self.browser()
        self.assertEqual(nocookie.get("/_lpmiddleware/login?token=" + token).status, 403)

    def test_nonce_expires_after_ten_minutes(self):
        b = self.browser()
        _, sent = self.start_login(b)
        self.env.clock.advance(601)
        r = b.get("/_lpmiddleware/login?token=" + urllib.parse.quote(self.login_token(sent["session_key"])))
        self.assertEqual(r.status, 403)
        b = self.browser()
        _, sent = self.start_login(b)
        self.env.clock.advance(599)
        r = b.get("/_lpmiddleware/login?token=" + urllib.parse.quote(self.login_token(sent["session_key"])))
        self.assertEqual(r.status, 200)

    def test_garbage_and_foreign_tokens_are_refused(self):
        b = self.browser()
        _, sent = self.start_login(b)
        foreign = self.login_token(sent["session_key"], box=SecretBox(os.urandom(32)))
        for token in ("", "%%%", "AAAA", urllib.parse.quote(foreign)):
            self.assertEqual(b.get("/_lpmiddleware/login?token=" + token).status, 403, token)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM sessions")[0][0], 0)

    def test_next_is_validated(self):
        for nxt, expected in (("/datastore/scopes/abc", "/datastore/scopes/abc"), ("https://evil.example/", "/datastore/"),
                              ("//evil.example/datastore/", "/datastore/"), ("/other/", "/datastore/"),
                              ("/datastore/../etc", "/datastore/"), ("/datastore/%2e%2e/x", "/datastore/"),
                              ("/datastore//evil", "/datastore/"), ("/datastore\\evil", "/datastore/"),
                              ("/datastore/_lpmiddleware/login", "/datastore/"), ("/datastore/api/v1/x", "/datastore/"),
                              ("javascript:alert(1)", "/datastore/"), ("/datastore", "/datastore/"), ("", "/datastore/"),
                              (None, "/datastore/"), ("/datastore/x\n", "/datastore/"), ("/datastoreX/", "/datastore/")):
            self.assertEqual(safe_next(nxt), expected, nxt)
        b = self.browser()
        _, sent = self.start_login(b, "https://evil.example/")
        self.assertEqual(sent["next"], "/datastore/")
        r = self.browser()
        token = urllib.parse.quote(self.login_token(self.start_login(r)[1]["session_key"], next_path="https://evil.example/x"))
        resp = r.get("/_lpmiddleware/login?token=" + token)
        self.assertIn('url=/datastore/"', resp.text)
        self.assertNotIn("evil", resp.text)

    def test_unreadable_key_file_means_no_login(self):
        self.env.close()
        with open(os.path.join(self.keydir, "key"), "w") as fh:
            fh.write("not base64!")
        keyfile = os.path.join(self.keydir, "key")
        self.env = Env({"operators": ["boss"], "loginpsi_key_file": keyfile})
        self.c = self.env.client
        b = self.browser()
        self.assertEqual(b.get("/login").status, 503)


class NotConfigured(DashCase):
    with_login = False

    def test_dashboard_says_login_not_configured(self):
        b = self.browser(lang_header="en")
        r = b.get("/")
        self.assertEqual(r.status, 200)
        self.assertIn("Login is not configured", r.text)
        self.assertEqual(b.get("/login").status, 503)
        self.assertEqual(b.get("/_lpmiddleware/login?token=x").status, 503)
        self.assertEqual(self.browser().get("/", headers={"Accept-Language": "de"}).text.count("Login nicht konfiguriert"), 1)

    def test_dev_login_is_off_by_default(self):
        b = self.browser()
        self.assertNotIn("_dev_login", b.get("/").text)
        r = b.post("/_dev_login", {"username": "alice", "email": "alice@uni-bamberg.de"})
        self.assertEqual(r.status, 404)


class DevLogin(DashCase):
    with_login = False
    config = {"dev_login": True}

    def dev(self, b, **fields):
        page = b.get("/")
        self.assertIn("/datastore/_dev_login", page.text)
        pre = re.search(r'name="pre" value="([^"]+)"', page.text).group(1)
        form = {"pre": pre, "username": "alice", "email": "alice@uni-bamberg.de", "name": "Dev Alice"}
        form.update(fields)
        return b.post("/_dev_login", form, csrf=False)

    def test_dev_login_works_when_enabled_and_applies_staff_rule(self):
        b = self.browser()
        r = self.dev(b)
        self.assertEqual(r.status, 303, r)
        self.assertEqual(b.get("/").status, 200)
        self.assertIn("Dev Alice", b.get("/").text)
        s = self.browser()
        self.assertEqual(self.dev(s, username="stu", email="x@stud.uni-bamberg.de", matriculation_number="12").status, 403)

    def test_dev_login_needs_the_form_token(self):
        b = self.browser()
        b.get("/")
        r = b.post("/_dev_login", {"pre": "wrong", "username": "alice", "email": "alice@uni-bamberg.de"}, csrf=False)
        self.assertEqual(r.status, 403)
        r = self.browser().post("/_dev_login", {"username": "alice", "email": "alice@uni-bamberg.de"}, csrf=False)
        self.assertEqual(r.status, 403)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM sessions")[0][0], 0)


class Rules(DashCase):
    def test_staff_rule(self):
        for email, matric, expected in (
                ("a@uni-bamberg.de", None, True), ("A@Uni-Bamberg.DE", "", True), ("a@uni-bamberg.de", "123", False),
                ("a@stud.uni-bamberg.de", None, False), ("a@sub.uni-bamberg.de", None, False), ("a@uni-bamberg.de.evil.org", None, False),
                ("a@notuni-bamberg.de", None, False), ("x@evil.org@uni-bamberg.de", None, False), ("@uni-bamberg.de", None, False),
                ("uni-bamberg.de", None, False), ("", None, False), (" a@uni-bamberg.de ", None, True), ("a b@uni-bamberg.de", None, False)):
            self.assertEqual(access.staff_rule(email, matric), expected, (email, matric))

    def test_student_cannot_enter(self):
        b = self.browser()
        r = self.login(b, "stu", "stu@stud.uni-bamberg.de", matriculation="1234567")
        self.assertEqual(r.status, 403)
        self.assertNotIn("__Host-wds_session", b.cookies)
        r = self.login(self.browser(), "stu2", "stu2@uni-bamberg.de", matriculation="1")  # has a number: not staff
        self.assertEqual(r.status, 403)

    def test_staff_cannot_open_operator_pages_or_other_scopes(self):
        a = self.staff("alice")
        scope = self.make_scope(a)
        other = self.staff("bob")
        self.assertEqual(other.get("/operator").status, 403)
        self.assertEqual(other.get("/operator/audit").status, 403)
        self.assertEqual(other.get(f"/scopes/{scope}").status, 404)
        self.assertEqual(other.get(f"/scopes/{scope}/audit").status, 404)
        self.assertNotIn(scope, other.get("/").text)

    def test_operator_by_username_or_email(self):
        self.env.close()
        self.operators = ["opsuser", "Ops.Mail@uni-bamberg.de"]
        self.setUp()
        b = self.browser()
        self.login(b, "opsuser", "whoever@uni-bamberg.de")
        self.assertEqual(b.get("/operator").status, 200)
        b = self.browser()
        self.login(b, "other", "ops.mail@uni-bamberg.de")
        self.assertEqual(b.get("/operator").status, 200)
        b = self.browser()
        self.login(b, "nobody", "nobody@uni-bamberg.de")
        self.assertEqual(b.get("/operator").status, 403)
        self.assertNotIn("/datastore/operator", b.get("/").text.replace("/datastore/operator/", ""))

    def test_operator_may_use_dashboard_without_staff_mail(self):
        b = self.browser()
        r = self.login(b, "boss", "boss@example.org")
        self.assertEqual(r.status, 200)

    def test_listed_coadmin_without_staff_rule_can_log_in(self):
        a = self.staff("alice")
        scope = self.make_scope(a)
        r = a.post(f"/scopes/{scope}/admins", {"admin": "ext@example.org"})
        self.assertEqual(r.status, 303)
        b = self.browser()
        self.assertEqual(self.login(b, "ext", "ext@example.org").status, 200)
        self.assertIn(scope, b.get("/").text)
        self.assertIn("Neue Apps können nur Beschäftigte", b.get("/").text)  # not staff: no create form
        self.assertEqual(b.post("/scopes", {"name": "X", "contact_email": "x@y.de"}).status, 403)

    def test_blocked_user_cannot_log_in_and_loses_session(self):
        a = self.staff("alice")
        op = self.operator()
        self.assertEqual(a.get("/").status, 200)
        r = op.post("/operator/block", {"username": "Alice", "reason": "test"})
        self.assertEqual(r.status, 303)
        r = a.get("/", headers={"Accept-Language": "en"})
        self.assertIn("Sign in", r.text)  # session is gone
        b = self.browser()
        self.assertEqual(self.login(b, "alice", "alice@uni-bamberg.de").status, 403)
        self.assertIn("alice", op.get("/operator").text)
        op.post("/operator/unblock", {"username": "alice"})
        self.assertEqual(self.login(self.browser(), "alice", "alice@uni-bamberg.de").status, 200)
        actions = [r[0] for r in self.env.sql("SELECT action FROM audit ORDER BY id")]
        self.assertIn("user_blocked", actions)
        self.assertIn("user_unblocked", actions)

    def test_operator_cannot_be_blocked(self):
        op = self.operator()
        r = op.post("/operator/block", {"username": "boss"})
        self.assertEqual(r.status, 409)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM blocked_users")[0][0], 0)
        self.assertEqual(op.post("/operator/block", {"username": "a b"}).status, 400)
