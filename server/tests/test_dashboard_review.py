"""Regression tests for the dashboard security review: per-creator scope cap, operator lock and delete, audit detail."""

import re

from .dash_helpers import DashCase

CAP = 5


class ScopeCap(DashCase):
    def test_one_person_cannot_create_more_than_the_cap(self):
        a = self.staff("alice")
        for i in range(CAP):
            self.make_scope(a, name=f"App {i}")
        r = a.post("/scopes", {"name": "One too many", "contact_email": "a@uni-bamberg.de", "enrollment": "closed"})
        self.assertEqual(r.status, 409)
        self.assertIn("schon 5 aktive Apps", r.text)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM scopes WHERE creator='alice'")[0][0], CAP)
        # another staff member is not affected
        b = self.staff("bob")
        self.make_scope(b, name="Bob's app")

    def test_deleting_a_scope_frees_a_place(self):
        a = self.staff("alice")
        ids = [self.make_scope(a, name=f"App {i}") for i in range(CAP)]
        self.assertEqual(a.post("/scopes", {"name": "X", "contact_email": "a@uni-bamberg.de"}).status, 409)
        self.assertEqual(a.post(f"/scopes/{ids[0]}/delete", {"confirm": ids[0]}).status, 303)
        self.make_scope(a, name="Replacement")

    def test_operator_is_exempt(self):
        op = self.operator()
        for i in range(CAP + 2):
            self.make_scope(op, name=f"Op {i}")

    def test_suspended_scopes_count(self):
        a = self.staff("alice")
        ids = [self.make_scope(a, name=f"App {i}") for i in range(CAP)]
        a.post(f"/scopes/{ids[0]}/suspend", {})
        self.assertEqual(a.post("/scopes", {"name": "X", "contact_email": "a@uni-bamberg.de"}).status, 409)

    def test_cap_stops_a_budget_hog_and_the_operator_can_free_the_budget(self):
        self.env.svc.disk_total_override = 10 * 1024**3  # budget 7 GiB; every scope starts with 2 GiB: three scopes fit
        a, b = self.staff("alice"), self.staff("bob")
        ids = [self.make_scope(a, name=f"App {i}") for i in range(3)]
        r = b.post("/scopes", {"name": "Bob", "contact_email": "b@uni-bamberg.de"})
        self.assertEqual(r.status, 409)  # alice used up the budget
        op = self.operator()
        self.assertEqual(op.post(f"/scopes/{ids[0]}/delete", {"confirm": ids[0]}).status, 303)
        self.make_scope(b, name="Bob")


class OperatorLock(DashCase):
    def setUp(self):
        super().setUp()
        self.a = self.staff("alice")
        self.scope = self.make_scope(self.a)
        self.a.post(f"/scopes/{self.scope}/admins", {"admin": "carol"})  # a co-admin who is not staff
        self.carol = self.browser()
        self.assertEqual(self.login(self.carol, "carol", "carol@stud.uni-bamberg.de", matriculation="1234567").status, 200)
        self.op = self.operator()

    def test_admins_cannot_change_a_scope_the_operator_suspended(self):
        self.assertEqual(self.op.post(f"/scopes/{self.scope}/suspend", {}).status, 303)
        s = self.scope
        attempts = [(f"/scopes/{s}/limits", {"max_vaults": "500"}), (f"/scopes/{s}/admins", {"admin": "mallory"}),
                    (f"/scopes/{s}/settings", {"name": "Mine", "contact_email": "me@example.org"}),
                    (f"/scopes/{s}/enrollment", {"enrollment": "open"}), (f"/scopes/{s}/join-code", {}),
                    (f"/scopes/{s}/delete", {"confirm": s})]
        for who in (self.a, self.carol):
            for path, form in attempts:
                self.assertEqual(who.post(path, form).status, 403, path)
        row = self.row(s)
        self.assertIsNone(row["deleted"])
        self.assertEqual(row["name"], "My App")
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM scope_admins WHERE admin='mallory'")[0][0], 0)
        # the edit forms are not offered while the scope is locked
        html = self.a.get(f"/scopes/{s}").text
        self.assertNotIn(f'action="/datastore/scopes/{s}/settings"', html)
        self.assertNotIn(f'action="/datastore/scopes/{s}/delete"', html)

    def test_after_the_operator_resumes_admins_can_edit_again(self):
        self.op.post(f"/scopes/{self.scope}/suspend", {})
        self.op.post(f"/scopes/{self.scope}/resume", {})
        self.assertEqual(self.a.post(f"/scopes/{self.scope}/settings", {"name": "Renamed", "contact_email": "me@uni-bamberg.de"}).status, 303)
        self.assertEqual(self.row(self.scope)["name"], "Renamed")

    def test_admin_suspension_leaves_admins_in_charge(self):
        self.a.post(f"/scopes/{self.scope}/suspend", {})
        self.assertEqual(self.a.post(f"/scopes/{self.scope}/settings", {"name": "Renamed", "contact_email": "me@uni-bamberg.de"}).status, 303)

    def test_operator_can_take_over_an_admin_suspension(self):
        self.a.post(f"/scopes/{self.scope}/suspend", {})
        self.assertEqual(self.row(self.scope)["suspended_by"], "admin")
        html = self.op.get(f"/scopes/{self.scope}").text
        self.assertIn(f'action="/datastore/scopes/{self.scope}/suspend"', html)  # the lock control
        r = self.op.post(f"/scopes/{self.scope}/suspend", {})
        self.assertEqual(r.status, 303)
        self.assertIn("notice=locked", r.headers["location"])
        self.assertEqual(self.row(self.scope)["suspended_by"], "operator")
        self.assertEqual(self.a.post(f"/scopes/{self.scope}/resume", {}).status, 403)
        self.assertEqual(self.a.post(f"/scopes/{self.scope}/limits", {"max_vaults": "5"}).status, 403)
        self.assertIn("scope_locked", [x[0] for x in self.env.sql("SELECT action FROM audit WHERE scope_id=?", (self.scope,))])
        # an admin cannot take over anything; the lock control is not shown for an active or operator-suspended scope
        self.assertNotIn(f'action="/datastore/scopes/{self.scope}/suspend"', self.op.get(f"/scopes/{self.scope}").text)
        self.assertEqual(self.op.post(f"/scopes/{self.scope}/resume", {}).status, 303)
        self.assertEqual(self.row(self.scope)["status"], "active")

    def test_admins_do_not_see_a_lock_control(self):
        self.a.post(f"/scopes/{self.scope}/suspend", {})
        self.assertNotIn("Take over", self.a.get(f"/scopes/{self.scope}?lang=en").text)

    def test_operator_can_delete_a_scope(self):
        s = self.scope
        self.assertIn(f'action="/datastore/scopes/{s}/delete"', self.op.get(f"/scopes/{s}").text)
        self.assertEqual(self.op.post(f"/scopes/{s}/delete", {"confirm": "wrong"}).status, 400)
        self.assertEqual(self.op.post(f"/scopes/{s}/delete", {"confirm": s}).status, 303)
        self.assertIsNotNone(self.row(s)["deleted"])
        self.assertEqual(self.env.sql("SELECT actor FROM audit WHERE action='scope_deleted'")[0][0], "operator:boss")
        # an operator is still not a general editor
        s2 = self.make_scope(self.a, name="Second")
        self.assertEqual(self.op.post(f"/scopes/{s2}/limits", {"max_vaults": "5"}).status, 403)


class AuditDetail(DashCase):
    def audit(self, scope, action):
        return [x[0] for x in self.env.sql("SELECT detail FROM audit WHERE scope_id=? AND action=? ORDER BY id", (scope, action))]

    def test_scope_updated_names_only_what_changed(self):
        a = self.staff()
        s = self.make_scope(a)
        a.post(f"/scopes/{s}/settings", {"name": "My App", "description": "A test app", "contact_email": "dev@uni-bamberg.de", "hibp": "1"})
        self.assertEqual(self.audit(s, "scope_updated"), [])  # nothing changed, nothing logged
        a.post(f"/scopes/{s}/settings", {"name": "Renamed", "description": "A test app", "contact_email": "new@uni-bamberg.de", "hibp": "1"})
        self.assertEqual(self.audit(s, "scope_updated"), ["name, contact_email dev@uni-bamberg.de -> new@uni-bamberg.de"])
        a.post(f"/scopes/{s}/settings", {"name": "Renamed", "description": "Other", "contact_email": "new@uni-bamberg.de"})
        self.assertEqual(self.audit(s, "scope_updated")[1], "description, hibp")

    def test_logins_and_refused_logins_are_logged_without_ip(self):
        a = self.staff("alice")
        self.assertEqual(self.login(self.browser(), "carol", "carol@stud.uni-bamberg.de", matriculation="1234567").status, 403)
        rows = [tuple(x) for x in self.env.sql("SELECT actor, action, detail, scope_id FROM audit WHERE action LIKE 'login%' ORDER BY id")]
        self.assertEqual(rows, [("user:alice", "login", None, None), ("user:carol", "login_denied", "not_allowed", None)])
        op = self.operator()
        html = op.get("/operator/audit").text
        self.assertIn("Anmeldung abgelehnt", html)
        self.assertIn("Konto nicht berechtigt", html)
        self.assertNotRegex(html, r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")
