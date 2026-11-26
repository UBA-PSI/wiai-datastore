"""Dashboard features: sessions and CSRF, scopes, limits, admins, vaults, operator console, audit, maintenance."""

import json
import re

from wds_server.maintenance import run_maintenance
from wds_server.service import AUDIT_RETENTION, DELETED_VAULT_TTL

from .dash_helpers import D, DashCase
from .helpers import API, b64


class Sessions(DashCase):
    def test_idle_timeout(self):
        b = self.staff()
        self.env.clock.advance(self.env.config.session_idle - 1)
        self.assertEqual(b.get("/").status, 200)  # activity renews the idle timer
        self.env.clock.advance(self.env.config.session_idle - 1)
        self.assertIn("Alice", b.get("/").text)
        self.env.clock.advance(self.env.config.session_idle + 1)
        r = b.get("/", headers={"Accept-Language": "en"})
        self.assertNotIn("Alice", r.text)
        self.assertIn("Sign in", r.text)

    def test_absolute_timeout(self):
        b = self.staff()
        step = self.env.config.session_idle - 10
        for _ in range(self.env.config.session_absolute // step):
            self.env.clock.advance(step)
            b.get("/")
        self.env.clock.advance(step)
        self.assertNotIn("Alice", b.get("/").text)

    def test_logout_ends_session(self):
        b = self.staff()
        token = b.cookies["__Host-wds_session"]
        r = b.post("/logout", {})
        self.assertEqual(r.status, 303)
        self.assertNotIn("__Host-wds_session", b.cookies)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM sessions")[0][0], 0)
        replay = self.browser()
        replay.cookies["__Host-wds_session"] = token
        self.assertNotIn("Alice", replay.get("/").text)

    def test_new_login_replaces_old_session_cookie(self):
        first = self.staff()
        old = first.cookies["__Host-wds_session"]
        b = self.browser()
        _, sent = self.start_login(b)
        b.cookies["__Host-wds_session"] = old  # the browser still holds the old session while it signs in again
        b.get("/_lpmiddleware/login?token=" + __import__("urllib.parse", fromlist=["x"]).quote(self.login_token(sent["session_key"])))
        self.assertNotEqual(b.cookies["__Host-wds_session"], old)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM sessions")[0][0], 1)

    def test_unknown_session_cookie_is_anonymous(self):
        b = self.browser()
        b.cookies["__Host-wds_session"] = "x" * 43
        self.assertEqual(b.get("/").status, 200)
        self.assertEqual(b.get("/scopes/whatever-abcdef", ).status, 303)  # to the login

    def test_deep_link_goes_through_login_and_back(self):
        a = self.staff()
        scope = self.make_scope(a)
        b = self.browser()
        r = b.get(f"/scopes/{scope}")
        self.assertEqual(r.status, 303)
        self.assertTrue(r.headers["location"].startswith("/datastore/login?next="))
        r = b.get(r.headers["location"])
        self.assertEqual(r.status, 303)
        sent = json.loads(self.box.decrypt(__import__("base64").b64decode(__import__("urllib.parse", fromlist=["x"]).parse_qs(
            __import__("urllib.parse", fromlist=["x"]).urlsplit(r.headers["location"]).query)["token"][0])))
        self.assertEqual(sent["next"], f"/datastore/scopes/{scope}")

    def test_session_cookie_is_not_read_by_the_api(self):
        b = self.staff()
        r = self.c.get(f"{API}/admin/vaults/ABC", {"Cookie": f"__Host-wds_session={b.cookies['__Host-wds_session']}"})
        self.assertEqual(r.status, 401)


class Csrf(DashCase):
    def test_every_form_has_a_token_and_post_checks_it(self):
        a = self.staff()
        scope = self.make_scope(a)
        for page in ("/", f"/scopes/{scope}", "/operator"):
            viewer = self.operator() if page == "/operator" else a
            html = viewer.get(page).text
            self.assertEqual(len(re.findall(r'<form method="post"', html)), len(re.findall(r'name="csrf"', html)), page)
            self.assertIn('name="csrf"', html)
        self.assertGreater(len(re.findall(r'<form method="post"', a.get(f"/scopes/{scope}").text)), 5)

    def test_missing_wrong_or_foreign_token_is_rejected(self):
        a = self.staff()
        scope = self.make_scope(a)
        before = self.row(scope)["name"]
        form = {"name": "Changed", "contact_email": "x@uni-bamberg.de"}
        for csrf in ("", "wrong", "x" * 32):
            r = a.post(f"/scopes/{scope}/settings", {**form, "csrf": csrf}, csrf=False)
            self.assertEqual(r.status, 403, csrf)
        r = a.post(f"/scopes/{scope}/settings", form, csrf=False)  # no field at all
        self.assertEqual(r.status, 403)
        other = self.staff("bob")  # token of another session
        r = a.post(f"/scopes/{scope}/settings", {**form, "csrf": other.csrf}, csrf=False)
        self.assertEqual(r.status, 403)
        self.assertEqual(self.row(scope)["name"], before)
        r = a.post(f"/scopes/{scope}/settings", form)
        self.assertEqual(r.status, 303)
        self.assertEqual(self.row(scope)["name"], "Changed")

    def test_logout_needs_token(self):
        a = self.staff()
        self.assertEqual(a.post("/logout", {"csrf": "bad"}, csrf=False).status, 403)
        self.assertIn("__Host-wds_session", a.cookies)

    def test_foreign_origin_and_wrong_content_type_are_rejected(self):
        a = self.staff()
        scope = self.make_scope(a)
        form = {"name": "Changed", "contact_email": "x@uni-bamberg.de"}
        self.assertEqual(a.post(f"/scopes/{scope}/settings", form, headers={"Origin": "https://evil.example"}).status, 403)
        self.assertEqual(a.post(f"/scopes/{scope}/settings", form, headers={"Origin": "null"}).status, 403)
        self.assertEqual(a.post(f"/scopes/{scope}/settings", form, headers={"Origin": "https://wiai.uni-bamberg.de"}).status, 303)
        for site in ("cross-site", "same-site"):
            self.assertEqual(a.post(f"/scopes/{scope}/settings", form, headers={"Sec-Fetch-Site": site}).status, 403, site)
        self.assertEqual(a.post(f"/scopes/{scope}/settings", form, headers={"Sec-Fetch-Site": "same-origin"}).status, 303)
        r = a.request("POST", f"/scopes/{scope}/settings", None, headers={"Content-Type": "application/json"})
        self.assertEqual(r.status, 415)
        r = a.request("POST", f"/scopes/{scope}/settings", None, headers={"Content-Type": "multipart/form-data; boundary=x"})
        self.assertEqual(r.status, 415)

    def test_oversized_form_is_refused(self):
        a = self.staff()
        scope = self.make_scope(a)
        r = a.post(f"/scopes/{scope}/settings", {"name": "x", "description": "y" * 70000})
        self.assertEqual(r.status, 413)

    def test_post_without_session(self):
        r = self.browser().post("/scopes", {"name": "x", "contact_email": "x@uni-bamberg.de"})
        self.assertEqual(r.status, 401)


class Headers(DashCase):
    def test_security_headers_and_strict_csp(self):
        a = self.staff()
        for page in ("/", "/privacy"):
            r = a.get(page)
            csp = r.headers["content-security-policy"]
            nonce = re.search(r"'nonce-([^']+)'", csp).group(1)
            self.assertIn(f'<style nonce="{nonce}">', r.text)
            self.assertIn(f'<script nonce="{nonce}">', r.text)
            for needle in ("default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"):
                self.assertIn(needle, csp)
            self.assertNotIn("unsafe-inline", csp)
            self.assertNotIn("unsafe-eval", csp)
            self.assertEqual(r.headers["x-content-type-options"], "nosniff")
            self.assertEqual(r.headers["referrer-policy"], "same-origin")  # "no-referrer" would turn Origin into "null" on our own forms
            self.assertIn("max-age", r.headers["strict-transport-security"])
            self.assertEqual(r.headers["x-frame-options"], "DENY")
            self.assertTrue(r.headers["content-type"].startswith("text/html"))
            self.assertEqual(len(re.findall(r"<script nonce=", r.text)), 1)
            self.assertNotRegex(r.text, r"<script[^>]*\bsrc=|<link[^>]*rel=.stylesheet|@import|\son[a-z]+=")
        self.assertEqual(a.get("/").headers["cache-control"], "no-store")

    def test_no_external_assets_on_any_page(self):
        a = self.staff()
        scope = self.make_scope(a)
        op = self.operator()
        pages = [a.get("/").text, a.get(f"/scopes/{scope}").text, a.get(f"/scopes/{scope}/audit").text, op.get("/operator").text,
                 self.browser().get("/privacy").text]
        for html in pages:
            for url in re.findall(r'(?:src|href|action)="(https?://[^"]+)"', html):
                self.assertIn(url, ("https://www.datenschutz-bayern.de",), url)  # a link, never an asset

    def test_not_found_and_method_checks(self):
        a = self.staff()
        self.assertEqual(a.get("/scopes/not-a-scope").status, 404)
        self.assertEqual(a.get("/scopes/nope-abcdef/audit").status, 404)
        self.assertEqual(a.request("GET", "/logout").status, 405)
        self.assertEqual(a.request("DELETE", "/").status, 405)


class Scopes(DashCase):
    def test_create_scope(self):
        a = self.staff("alice")
        r = a.post("/scopes", {"name": "Notenrechner 2", "slug": "", "description": "Computes", "contact_email": "dev@uni-bamberg.de",
                               "enrollment": "join_code", "hibp": "1"})
        self.assertEqual(r.status, 303)
        scope = r.headers["location"].split("?")[0].rsplit("/", 1)[1]
        self.assertRegex(scope, r"^notenrechner-2-[0-9a-z]{6}$")
        row = self.row(scope)
        self.assertEqual((row["name"], row["description"], row["contact_email"], row["creator"], row["enrollment"], row["hibp"]),
                         ("Notenrechner 2", "Computes", "dev@uni-bamberg.de", "alice", "join_code", 1))
        self.assertRegex(row["join_code"], r"^[0-9A-Z]{8}$")
        self.assertEqual([tuple(x) for x in self.env.sql("SELECT admin, role FROM scope_admins WHERE scope_id=?", (scope,))],
                         [("alice", "creator")])
        audit = self.env.sql("SELECT actor, action FROM audit WHERE scope_id=?", (scope,))
        self.assertEqual([tuple(x) for x in audit], [("user:alice", "scope_created")])
        # visible to the app API as well
        self.assertEqual(self.c.get(f"{API}/scopes/{scope}").json()["name"], "Notenrechner 2")
        self.assertIn(scope, a.get("/").text)

    def test_create_options(self):
        a = self.staff()
        scope = self.make_scope(a, slug="my-slug", enrollment="open", hibp="")
        self.assertTrue(scope.startswith("my-slug-"))
        row = self.row(scope)
        self.assertEqual((row["enrollment"], row["hibp"], row["join_code"]), ("open", 0, None))
        self.assertEqual(self.c.get(f"{API}/scopes/{scope}").json()["hibp"], False)

    def test_create_validation_keeps_the_form_values(self):
        a = self.staff()
        r = a.post("/scopes", {"name": "Keep me", "contact_email": "not-an-address", "enrollment": "join_code"})
        self.assertEqual(r.status, 400)
        self.assertIn("Keep me", r.text)
        self.assertIn("e-mail address", r.text)
        r = a.post("/scopes", {"name": "", "contact_email": "a@b.de"})
        self.assertEqual(r.status, 400)
        r = a.post("/scopes", {"name": "X", "contact_email": "a@b.de", "slug": "Bad Slug!"})
        self.assertEqual(r.status, 400)
        r = a.post("/scopes", {"name": "X", "contact_email": "a@b.de", "enrollment": "everyone"})
        self.assertEqual(r.status, 400)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM scopes")[0][0], 0)

    def test_create_is_refused_in_read_only_mode_and_for_non_staff(self):
        a = self.staff()
        self.env.disk[0] = 0.9
        r = a.post("/scopes", {"name": "X", "contact_email": "a@b.de"})
        self.assertEqual(r.status, 503)
        self.env.disk[0] = 0.1
        stu = self.browser()
        self.assertEqual(self.login(stu, "stu", "s@stud.uni-bamberg.de", matriculation="1").status, 403)

    def test_operator_may_create_scopes(self):
        op = self.operator()
        scope = self.make_scope(op)
        self.assertEqual(self.row(scope)["creator"], "boss")

    def test_scope_page_shows_script_tag_and_prompt(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a, name="Demo")
        html = a.get(f"/scopes/{scope}").text
        self.assertIn(scope, html)
        self.assertIn('&lt;script src=&quot;https://wiai.uni-bamberg.de/datastore/client/wds-1.0.0.js&quot; integrity=&quot;sha384-TESTHASH+/=&quot; '
                      'crossorigin=&quot;anonymous&quot;&gt;&lt;/script&gt;', html)
        self.assertIn("https://wiai.uni-bamberg.de/datastore/llms.txt", html)
        prompt = re.search(r'<pre id="prompt">(.*?)</pre>', html, re.S).group(1)
        self.assertIn(f"- App ID (scope): {scope}", prompt)
        self.assertIn("wds-verify", prompt)
        de = self.browser(lang_header="de")
        self.login(de, "alice", "alice@uni-bamberg.de")
        self.assertIn(f"- App-ID (Scope): {scope}", de.get(f"/scopes/{scope}").text)

    def test_missing_hashes_file(self):
        import os
        os.remove(os.path.join(self.env.config.client_dir, "hashes.json"))
        a = self.staff(lang_header="en")
        scope = self.make_scope(a)
        r = a.get(f"/scopes/{scope}")
        self.assertEqual(r.status, 200)
        self.assertIn("checksums are not available", r.text)

    def test_names_are_escaped(self):
        a = self.staff()
        scope = self.make_scope(a, name="<script>alert(1)</script>", description='"><img src=x onerror=alert(1)>')
        for html in (a.get("/").text, a.get(f"/scopes/{scope}").text):
            self.assertNotIn("<script>alert(1)", html)
            self.assertNotIn("<img src=x", html)
        self.assertIn("&lt;script&gt;alert(1)", a.get("/").text)

    def test_settings_enrollment_and_join_code(self):
        a = self.staff()
        scope = self.make_scope(a)
        old = self.row(scope)["join_code"]
        r = a.post(f"/scopes/{scope}/settings", {"name": "New Name", "description": "D2", "contact_email": "n@uni-bamberg.de"})
        self.assertEqual(r.status, 303)
        row = self.row(scope)
        self.assertEqual((row["name"], row["description"], row["contact_email"], row["hibp"]), ("New Name", "D2", "n@uni-bamberg.de", 0))
        self.assertEqual(a.post(f"/scopes/{scope}/settings", {"name": "N", "contact_email": ""}).status, 400)
        r = a.post(f"/scopes/{scope}/join-code", {})
        self.assertEqual(r.status, 303)
        new = self.row(scope)["join_code"]
        self.assertNotEqual(new, old)
        self.assertIn(new, a.get(f"/scopes/{scope}").text)
        self.assertEqual(a.post(f"/scopes/{scope}/enrollment", {"enrollment": "closed"}).status, 303)
        self.assertEqual(self.c.get(f"{API}/scopes/{scope}").json()["enrollment"], "closed")
        self.assertNotIn(new, a.get(f"/scopes/{scope}").text)  # code is only shown in join-code mode
        self.assertEqual(a.post(f"/scopes/{scope}/enrollment", {"enrollment": "bogus"}).status, 400)
        self.assertEqual(a.post(f"/scopes/{scope}/enrollment", {"enrollment": "join_code"}).status, 303)
        self.assertEqual(self.row(scope)["join_code"], new)
        actions = [x[0] for x in self.env.sql("SELECT action FROM audit WHERE scope_id=? ORDER BY id", (scope,))]
        self.assertEqual(actions, ["scope_created", "scope_updated", "join_code_rotated", "enrollment_changed", "enrollment_changed"])

    def test_new_join_code_works_for_vault_creation(self):
        a = self.staff()
        scope = self.make_scope(a)
        a.post(f"/scopes/{scope}/join-code", {})
        from .helpers import Vault
        v = Vault(self.env, scope)
        self.assertEqual(v.create(join_code="WRONG123").status, 403)
        self.assertEqual(v.create(join_code=self.row(scope)["join_code"]).status, 201)

    def test_limits_within_ceilings(self):
        a = self.staff()
        scope = self.make_scope(a)
        html = a.get(f"/scopes/{scope}").text
        for needle in ("10,0 MB", "25,0 MB", "200,0 MB", "1,0 GB", "2,0 GB", "10,0 GB", "50", "500"):  # defaults and ceilings are shown
            self.assertIn(needle, html)                      # numbers as a German reader writes them
        en = a.get(f"/scopes/{scope}?lang=en").text
        for needle in ("10.0 MB", "25.0 MB", "1.0 GB"):
            self.assertIn(needle, en)
        r = a.post(f"/scopes/{scope}/limits", {"max_value_bytes": "5", "vault_bytes": "100", "scope_bytes": "1000", "max_vaults": "20",
                                               "history_versions": "7"})
        self.assertEqual(r.status, 303, r.text[:300])
        doc = self.c.get(f"{API}/scopes/{scope}").json()["limits"]
        self.assertEqual((doc["max_value_bytes"], doc["vault_bytes"], doc["history_versions"]), (5 * 1048576, 100 * 1048576, 7))
        self.assertEqual(json.loads(self.row(scope)["limits"])["scope_bytes"], 1000 * 1048576)
        self.assertEqual(json.loads(self.row(scope)["limits"])["max_vaults"], 20)
        # blank fields go back to the defaults
        a.post(f"/scopes/{scope}/limits", {"max_value_bytes": "", "vault_bytes": "", "scope_bytes": "", "max_vaults": "", "history_versions": ""})
        self.assertEqual(json.loads(self.row(scope)["limits"]), {})

    def test_limits_above_ceiling_or_invalid_are_refused(self):
        a = self.staff()
        scope = self.make_scope(a)
        for field, value in (("max_vaults", "501"), ("history_versions", "51"), ("max_value_bytes", "26"), ("vault_bytes", "1025"),
                             ("scope_bytes", "10241"), ("max_vaults", "0"), ("max_vaults", "-1"), ("max_vaults", "abc"),
                             ("max_vaults", "1.5"), ("max_vaults", "99999999999999999")):
            r = a.post(f"/scopes/{scope}/limits", {field: value})
            self.assertIn(r.status, (400,), (field, value, r.status))
            self.assertEqual(json.loads(self.row(scope)["limits"]), {}, (field, value))
        self.assertEqual(a.post(f"/scopes/{scope}/limits", {"max_vaults": "500", "history_versions": "50", "max_value_bytes": "25"}).status, 303)

    def test_limits_total_stays_below_seventy_percent_of_the_disk(self):
        a = self.staff()
        self.env.svc.disk_total_override = 10 * 1024**3  # budget 7 GiB; every scope starts with 2 GiB
        s1, s2, s3 = (self.make_scope(a, name=f"S{i}") for i in range(3))
        r = a.post("/scopes", {"name": "S4", "contact_email": "a@b.de"})
        self.assertEqual(r.status, 409, r.text[:200])  # 4 x 2 GiB > 7 GiB
        self.assertIn("70 %", r.text)
        r = a.post(f"/scopes/{s1}/limits", {"scope_bytes": "5000"})  # 5 + 2 + 2 > 7
        self.assertEqual(r.status, 409)
        self.assertEqual(json.loads(self.row(s1)["limits"]), {})
        self.assertEqual(a.post(f"/scopes/{s1}/limits", {"scope_bytes": "3000"}).status, 303)  # 3 + 2 + 2 = 7 GiB (approx.)
        self.assertEqual(a.post(f"/scopes/{s1}/limits", {"scope_bytes": "500"}).status, 303)  # lowering always works
        self.env.svc.disk_total_override = 1024**3  # budget now smaller than what is committed: lowering still works
        self.assertEqual(a.post(f"/scopes/{s2}/limits", {"scope_bytes": "100"}).status, 303)
        self.assertEqual(a.post(f"/scopes/{s2}/limits", {"scope_bytes": "200"}).status, 409)

    def test_lowering_value_limit_below_stored_value_is_refused(self):
        a = self.staff()
        scope = self.make_scope(a, enrollment="open")
        v = self.env.new_vault({"scope": scope, "join_code": None})
        v.put_ok("big", size=2 * 1048576)
        r = a.post(f"/scopes/{scope}/limits", {"max_value_bytes": "1"})
        self.assertEqual(r.status, 409)
        self.assertIn("largest value", r.text)
        self.assertEqual(a.post(f"/scopes/{scope}/limits", {"max_value_bytes": "3"}).status, 303)

    def test_coadmins(self):
        a = self.staff("alice")
        scope = self.make_scope(a)
        bob = self.staff("bob")
        self.assertEqual(bob.get(f"/scopes/{scope}").status, 404)
        for bad in ("", "a b", "x@", "@y.de", "-bad", "a" * 300):
            self.assertEqual(a.post(f"/scopes/{scope}/admins", {"admin": bad}).status, 400, bad)
        self.assertEqual(a.post(f"/scopes/{scope}/admins", {"admin": " Bob "}).status, 303)
        self.assertEqual(a.post(f"/scopes/{scope}/admins", {"admin": "bob"}).status, 409)
        self.assertEqual(bob.get(f"/scopes/{scope}").status, 200)
        self.assertIn(scope, bob.get("/").text)
        # by e-mail
        carol = self.staff("carol")
        a.post(f"/scopes/{scope}/admins", {"admin": "Carol@Uni-Bamberg.de"})
        self.assertEqual(carol.get(f"/scopes/{scope}").status, 200)
        # a co-admin may manage, but nobody can remove the creator
        self.assertEqual(bob.post(f"/scopes/{scope}/settings", {"name": "By Bob", "contact_email": "b@uni-bamberg.de"}).status, 303)
        self.assertEqual(bob.post(f"/scopes/{scope}/admins/remove", {"admin": "alice"}).status, 404)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM scope_admins WHERE admin='alice'")[0][0], 1)
        self.assertEqual(a.post(f"/scopes/{scope}/admins/remove", {"admin": "bob"}).status, 303)
        self.assertEqual(bob.get(f"/scopes/{scope}").status, 404)
        self.assertEqual(bob.post(f"/scopes/{scope}/settings", {"name": "again", "contact_email": "b@uni-bamberg.de"}).status, 404)
        actions = [x[0] for x in self.env.sql("SELECT action FROM audit WHERE scope_id=? ORDER BY id", (scope,))]
        self.assertEqual(actions.count("admin_added"), 2)
        self.assertEqual(actions.count("admin_removed"), 1)

    def test_other_staff_cannot_post_to_foreign_scope(self):
        a = self.staff("alice")
        scope = self.make_scope(a)
        mallory = self.staff("mallory")
        for path, form in ((f"/scopes/{scope}/settings", {"name": "Pwn", "contact_email": "m@uni-bamberg.de"}),
                           (f"/scopes/{scope}/limits", {"max_vaults": "5"}), (f"/scopes/{scope}/join-code", {}),
                           (f"/scopes/{scope}/enrollment", {"enrollment": "open"}), (f"/scopes/{scope}/admins", {"admin": "mallory"}),
                           (f"/scopes/{scope}/suspend", {}), (f"/scopes/{scope}/delete", {"confirm": scope})):
            self.assertEqual(mallory.post(path, form).status, 404, path)
        row = self.row(scope)
        self.assertEqual((row["name"], row["status"], row["deleted"]), ("My App", "active", None))
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM scope_admins WHERE scope_id=?", (scope,))[0][0], 1)

    def test_vault_list_and_delete(self):
        a = self.staff()
        scope = self.make_scope(a, enrollment="open")
        v = self.env.new_vault({"scope": scope, "join_code": None})
        v.put_ok("rec", size=1000)
        w = self.env.new_vault({"scope": scope, "join_code": None})
        other = self.env.new_vault()  # a vault of a scope that is not Alice's
        html = a.get(f"/scopes/{scope}").text
        self.assertIn(v.vault, html)
        self.assertIn(w.vault, html)
        self.assertNotIn(other.vault, html)
        row = re.search(rf"<code>{v.vault}</code>(.*?)</tr>", html, re.S).group(1)
        self.assertIn("KB", row)  # bytes (record plus roster)
        self.assertRegex(re.sub(r"<[^>]+>", " ", row), r"\b1\b")  # one member (the founder)
        # re-encryption pending: record blobs of an older epoch
        self.env.sql("SELECT 1")
        with self.env.svc.db.connection() as conn:
            conn.execute("UPDATE vaults SET epoch=2 WHERE vault_id=?", (v.vault,))
        row = re.search(rf"<code>{v.vault}</code>(.*?)</tr>", a.get(f"/scopes/{scope}").text, re.S).group(1)
        self.assertIn("badge warn", row)
        # delete (soft)
        r = a.post(f"/scopes/{scope}/vaults/{v.vault}/delete", {})
        self.assertEqual(r.status, 303)
        self.assertIsNotNone(self.env.sql("SELECT deleted FROM vaults WHERE vault_id=?", (v.vault,))[0][0])
        self.assertEqual(self.c.get(v.path + "/usage", v.auth).status, 410)
        self.assertIn("vault_deleted", [x[0] for x in self.env.sql("SELECT action FROM audit WHERE vault_id=?", (v.vault,))])
        actor = self.env.sql("SELECT actor FROM audit WHERE vault_id=? AND action='vault_deleted'", (v.vault,))[0][0]
        self.assertEqual(actor, "user:alice")
        self.assertEqual(a.post(f"/scopes/{scope}/vaults/{v.vault}/delete", {}).status, 404)  # already deleted
        self.assertEqual(a.post(f"/scopes/{scope}/vaults/{other.vault}/delete", {}).status, 404)  # not in this scope
        self.assertEqual(self.c.get(other.path + "/usage", other.auth).status, 200)
        self.assertEqual(a.post(f"/scopes/{scope}/vaults/NOTAVAULT/delete", {}).status, 404)
        self.assertIn("gelöscht", a.get(f"/scopes/{scope}").text)
        run_maintenance(self.env.svc)
        self.env.clock.advance(DELETED_VAULT_TTL)
        self.assertEqual(run_maintenance(self.env.svc)["deleted_vaults"], 1)

    def test_suspend_and_resume(self):
        a = self.staff()
        scope = self.make_scope(a, enrollment="open")
        self.assertEqual(a.post(f"/scopes/{scope}/suspend", {}).status, 303)
        self.assertEqual(self.row(scope)["status"], "suspended")
        from .helpers import Vault
        self.assertEqual(Vault(self.env, scope).create().status, 403)
        self.assertEqual(a.post(f"/scopes/{scope}/resume", {}).status, 303)
        self.assertEqual(Vault(self.env, scope).create().status, 201)
        # the operator's suspension is not the admin's to lift
        op = self.operator()
        self.assertEqual(op.post(f"/scopes/{scope}/suspend", {}).status, 303)
        self.assertEqual(self.row(scope)["suspended_by"], "operator")
        r = a.post(f"/scopes/{scope}/resume", {})
        self.assertEqual(r.status, 403)
        self.assertEqual(self.row(scope)["status"], "suspended")
        self.assertIn("Betrieb", a.get(f"/scopes/{scope}").text)
        self.assertEqual(op.post(f"/scopes/{scope}/resume", {}).status, 303)
        self.assertEqual(self.row(scope)["status"], "active")
        actors = [tuple(x) for x in self.env.sql("SELECT actor, action FROM audit WHERE action IN ('scope_suspended', 'scope_resumed') ORDER BY id")]
        self.assertEqual(actors, [("user:alice", "scope_suspended"), ("user:alice", "scope_resumed"), ("operator:boss", "scope_suspended"),
                                  ("operator:boss", "scope_resumed")])

    def test_api_suspension_counts_as_operator(self):
        a = self.staff()
        scope = self.make_scope(a)
        r = self.c.patch_json(f"{API}/admin/scopes/{scope}", {"status": "suspended"}, self.env.op)
        self.assertEqual(r.status, 200)
        self.assertEqual(a.post(f"/scopes/{scope}/resume", {}).status, 403)

    def test_operator_cannot_edit_other_peoples_scope(self):
        a = self.staff()
        scope = self.make_scope(a)
        op = self.operator()
        page = op.get(f"/scopes/{scope}")
        self.assertEqual(page.status, 200)
        self.assertNotIn(f"/scopes/{scope}/settings", page.text)
        for path, form in ((f"/scopes/{scope}/settings", {"name": "Op", "contact_email": "o@uni-bamberg.de"}),
                           (f"/scopes/{scope}/join-code", {}), (f"/scopes/{scope}/limits", {"max_vaults": "5"})):  # only suspend, resume, delete
            self.assertEqual(op.post(path, form).status, 403, path)

    def test_delete_scope(self):
        a = self.staff()
        scope = self.make_scope(a, enrollment="open")
        v = self.env.new_vault({"scope": scope, "join_code": None})
        v.put_ok("rec")
        self.assertEqual(a.post(f"/scopes/{scope}/delete", {"confirm": "wrong"}).status, 400)
        self.assertIsNone(self.row(scope)["deleted"])
        r = a.post(f"/scopes/{scope}/delete", {"confirm": scope})
        self.assertEqual(r.status, 303)
        row = self.row(scope)
        self.assertIsNotNone(row["deleted"])
        self.assertEqual((row["description"], row["contact_email"], row["join_code"]), ("", "", None))
        self.assertEqual(self.c.get(f"{API}/scopes/{scope}").status, 404)
        self.assertEqual(self.c.get(v.path + "/usage", v.auth).status, 410)  # vault soft-deleted with the scope
        self.assertEqual(a.get(f"/scopes/{scope}").status, 404)
        self.assertNotIn(scope, a.get("/").text)
        self.env.clock.advance(DELETED_VAULT_TTL)
        stats = run_maintenance(self.env.svc)
        self.assertEqual(stats["deleted_vaults"], 1)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM scopes WHERE scope_id=?", (scope,))[0][0], 0)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM scope_admins WHERE scope_id=?", (scope,))[0][0], 0)
        # a scope without vaults goes at the next sweep
        a = self.staff("alice")  # the old session expired with the 30 days
        s2 = self.make_scope(a)
        a.post(f"/scopes/{s2}/delete", {"confirm": s2})
        self.assertEqual(run_maintenance(self.env.svc)["scopes"], 1)

    def test_audit_page(self):
        a = self.staff()
        scope = self.make_scope(a)
        a.post(f"/scopes/{scope}/join-code", {})
        html = a.get(f"/scopes/{scope}/audit").text
        # the log is written in words, not in the internal codes
        self.assertIn("App angelegt", html)
        self.assertIn("Beitrittscode erneuert", html)
        self.assertIn("Nutzer:in alice", html)
        for code in ("scope_created", "join_code_rotated", "user:alice"):
            self.assertNotIn(code, html)
        en = a.get(f"/scopes/{scope}/audit?lang=en").text
        self.assertIn("App created", en)
        self.assertIn("User alice", en)
        self.assertNotRegex(html, r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")  # no IP addresses
        # entries written by the vault API show up too (revocations, recoveries, deletions)
        v = self.env.new_vault({"scope": scope, "join_code": self.row(scope)["join_code"]})
        self.c.delete(v.path, v.auth)
        self.assertIn("Tresor gelöscht", a.get(f"/scopes/{scope}/audit").text)
        # not the audit of another scope
        s2 = self.make_scope(a, name="Second")
        self.assertNotIn("join_code_rotated", a.get(f"/scopes/{s2}/audit").text)


class Operator(DashCase):
    def test_overview(self):
        a = self.staff("alice")
        scope = self.make_scope(a, name="Alice App", enrollment="open")
        v = self.env.new_vault({"scope": scope, "join_code": None})
        v.put_ok("r", size=500)
        self.env.new_vault({"scope": scope, "join_code": None})
        op = self.operator()
        html = op.get("/operator").text
        self.assertIn("Alice App", html)
        self.assertIn(scope, html)
        self.assertIn("alice", html)
        # global limits from the configuration, read-only (no form for them)
        self.assertIn("10,0 MB", html)
        self.assertNotIn('name="max_vaults"', html)
        # disk and read-only state
        self.assertIn("10,0 %", html)
        self.env.disk[0] = 0.9
        self.assertRegex(op.get("/operator").text, r'badge bad">ja')
        # the scope list links to the scope page
        self.assertEqual(op.get(f"/scopes/{scope}").status, 200)

    def test_escrow_status_counts_vaults_per_key_set(self):
        from wds_server.config import EscrowSet
        a = self.staff()
        scope = self.make_scope(a, enrollment="open")
        for _ in range(3):
            self.env.new_vault({"scope": scope, "join_code": None})
        op = self.operator()
        html = op.get("/operator").text
        status = self.env.svc.config.escrow
        counts = re.findall(r'<td data-label="[^"]*"><code class="small">([^<]+)</code></td><td data-label="[^"]*" class="num">(\d+)</td>', html)
        by_id = {k: int(v) for k, v in counts}
        self.assertEqual(by_id[status[0].key_id], 3)
        self.assertEqual(by_id[status[1].key_id], 0)
        # a vault whose roster names another key set counts as "other"
        with self.env.svc.db.connection() as conn:
            vid = conn.execute("SELECT vault_id, roster_version FROM vaults LIMIT 1").fetchone()
            body = json.loads(conn.execute("SELECT body FROM rosters WHERE vault_id=? AND version=?", (vid[0], vid[1])).fetchone()[0])
            for s in body["slots"]:
                s["e_pub"] = b64(b"\x04" + b"z" * 64)
            conn.execute("UPDATE rosters SET body=? WHERE vault_id=? AND version=?", (json.dumps(body), vid[0], vid[1]))
        html = op.get("/operator").text
        self.assertIn('<td data-label="Schlüssel-ID">–</td><td data-label="Tresore" class="num">1</td>', html)

    def test_recoveries_are_listed(self):
        a = self.staff()
        scope = self.make_scope(a, enrollment="open")
        v = self.env.new_vault({"scope": scope, "join_code": None})
        from wds_server.util import b32c_encode
        r = self.c.post_json(f"{API}/admin/vaults/{v.vault}/recovery", {"recovery_code": b32c_encode(v.recovery_code)}, self.env.op)
        self.assertEqual(r.status, 201)
        op = self.operator()
        html = op.get("/operator").text
        self.assertIn(v.vault, html)
        self.assertIn("Wiederherstellung beantragt", html)
        self.assertIn("pending", html)
        self.assertIn("Wiederherstellung beantragt", op.get("/operator/audit").text)
        # scope admins see the recovery in the audit of their scope, too
        self.assertIn("Wiederherstellung beantragt", a.get(f"/scopes/{scope}/audit").text)

    def test_global_audit_page(self):
        a = self.staff()
        self.make_scope(a)
        op = self.operator()
        html = op.get("/operator/audit").text
        self.assertIn("App angelegt", html)


class Maintenance(DashCase):
    def test_audit_entries_are_swept_after_one_year(self):
        a = self.staff()
        scope = self.make_scope(a)
        self.assertEqual(AUDIT_RETENTION, 365 * 86400)
        self.env.clock.advance(AUDIT_RETENTION - 1)
        self.assertEqual(run_maintenance(self.env.svc)["audit_rows"], 0)
        self.env.clock.advance(1)
        self.assertEqual(run_maintenance(self.env.svc)["audit_rows"], 0)  # the entry is exactly one year old: kept
        self.env.clock.advance(1)
        self.assertEqual(run_maintenance(self.env.svc)["audit_rows"], 2)  # the login and the scope creation
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM audit WHERE scope_id=?", (scope,))[0][0], 0)

    def test_expired_sessions_are_swept(self):
        self.staff("alice")
        self.env.clock.advance(self.env.config.session_idle + 1)
        b = self.staff("bob")
        self.assertEqual(run_maintenance(self.env.svc)["sessions"], 1)
        self.assertEqual(self.env.sql("SELECT username FROM sessions")[0][0], "bob")
        self.assertIn("Bob", b.get("/").text)
