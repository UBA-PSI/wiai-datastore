"""Dashboard: the prompt with the scope's settings, the CLAUDE.md section, and the sandbox scope (read-only, operators only);
the docs placeholders."""

import html
import re

from wds_server import docs
from wds_server.config import SandboxConfig

from .dash_helpers import DashCase
from .helpers import API

SID = "sandbox-000000"


def pre(page: str, ident: str) -> str:
    return html.unescape(re.search(rf'<pre id="{ident}">(.*?)</pre>', page, re.S).group(1))


class PromptWithoutSandbox(DashCase):
    """The dashboard's "Text für Claude" is one English text (prompt.py) that is also the CLAUDE.md / AGENTS.md section."""

    def page(self, b, scope):
        return b.get(f"/scopes/{scope}").text

    def test_the_text_for_claude(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a, name="Demo")
        text = pre(self.page(a, scope), "prompt")
        self.assertTrue(text.startswith("## Data storage: WIAI Datastore\n"))
        self.assertIn(f"app ID (scope) {scope}.", text)
        self.assertIn("- Before building or changing storage, the data model, the library script tag or the Content-Security-Policy, read "
                      "https://wiai.uni-bamberg.de/datastore/llms.txt and follow its rules.", text)
        self.assertIn('  en: "Data is end-to-end encrypted; the faculty holds a recovery key for emergencies."', text)
        self.assertIn('  de: "Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel."', text)
        self.assertIn("- Test with wds-verify (https://github.com/UBA-PSI/wiai-datastore); it runs against the sandbox.", text)
        self.assertIn("update its report in README.md.", text)
        self.assertIn("(create the files if missing; keep their other content)", text)

    def test_the_text_is_the_same_in_both_dashboard_languages_and_has_a_copy_button(self):
        texts = []
        for lang in ("en", "de"):
            a = self.staff(lang_header=lang)
            scope = self.make_scope(a, name="Demo")
            page = self.page(a, scope)
            self.assertIn('data-copy="prompt"', page)
            texts.append(pre(page, "prompt").replace(scope, "ID"))
        self.assertEqual(texts[0], texts[1])

    def test_the_join_code_itself_is_never_in_the_prompt(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a)
        code = self.row(scope)["join_code"]
        text = pre(self.page(a, scope), "prompt")
        self.assertNotIn(code, text)
        self.assertIn("The join code of this app is a secret of the staff. Never write it into the app, the README, tests, scripts, CLAUDE.md or AGENTS.md, ", text)
        self.assertIn("and never ask for it in the chat.", text)

    def test_prompt_has_no_real_scope_test_path(self):
        a = self.staff(lang_header="en")
        text = pre(self.page(a, self.make_scope(a, name="Demo")), "prompt")
        for word in ("~/.wds", "deleteVault", "drive-library", "test vault", "WDS_JOIN_CODE"):
            self.assertNotIn(word, text)

    def test_nothing_that_can_change_is_in_the_text(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a)
        before = pre(self.page(a, scope), "prompt")
        with self.env.svc.db.connection() as conn:   # what the operator does with the command line
            conn.execute("UPDATE scopes SET limits='{\"max_vaults\": 7, \"history_versions\": 3}', join_code='ZZZZ9999' WHERE scope_id=?", (scope,))
        self.assertEqual(pre(self.page(a, scope), "prompt"), before)
        for gone in ("Limits", "vaults", "Enrollment", "Breach", "as of"):
            self.assertNotIn(gone, before, gone)

    def test_the_dashboard_explains_the_purpose_in_german_and_english(self):
        de = html.unescape(self.staff(lang_header="de").get(f"/scopes/{self.make_scope(self.staff(lang_header='de'), name='Demo')}").text)
        self.assertIn("Kopieren Sie diesen Text in Ihr Gespräch mit Claude", de)
        self.assertIn("legt den Text zugleich in der App als CLAUDE.md und AGENTS.md ab", de)
        self.assertIn("Er ist englisch, weil er in der App neben dem Programmcode steht.", de)
        a = self.staff(lang_header="en")
        en = html.unescape(a.get(f"/scopes/{self.make_scope(a, name='Demo')}").text)
        self.assertIn("Paste this text into your conversation with Claude", en)
        self.assertIn("also keeps the text in the app as CLAUDE.md and AGENTS.md", en)
        for text in (de, en):
            self.assertNotIn('id="claude-md"', text)                    # one block, not two
            self.assertNotIn("CLAUDE.md / AGENTS.md für das App-Repository", text)

    def test_no_dashboard_address_as_the_source_of_settings(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a)
        text = pre(self.page(a, scope), "prompt")
        self.assertNotIn("/scopes/", text)
        self.assertNotIn("/datastore/login", text)
        self.assertNotIn("dashboard", text.lower())

    def test_sandbox_lines_are_absent_without_a_sandbox(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a)
        self.assertIn("it runs against the sandbox", pre(self.page(a, scope), "prompt"))   # the tool, not the ID
        self.assertNotIn("sandbox-", pre(self.page(a, scope), "prompt"))
        self.assertNotIn("Never write the sandbox scope ID", pre(self.page(a, scope), "prompt"))


class PromptWithSandbox(DashCase):
    config = {"sandbox": SandboxConfig(scope_id=SID)}

    def test_the_sandbox_id_is_named_so_that_it_is_never_written_into_the_app(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a)
        text = pre(a.get(f"/scopes/{scope}").text, "prompt")
        self.assertIn(f"Never write the sandbox scope ID {SID} into this app.", text)
        de = self.browser(lang_header="de")
        self.login(de, "alice", "alice@uni-bamberg.de")
        self.assertEqual(pre(de.get(f"/scopes/{scope}").text, "prompt"), text)


class SandboxScopeInTheDashboard(DashCase):
    config = {"sandbox": SandboxConfig(scope_id=SID)}

    def test_not_listed_and_not_reachable_for_staff(self):
        a = self.staff()
        self.make_scope(a, name="Mine")
        home = a.get("/").text
        self.assertNotIn(SID, home)
        self.assertEqual(a.get(f"/scopes/{SID}").status, 404)
        self.assertEqual(a.post(f"/scopes/{SID}/settings", {"name": "x", "contact_email": "a@uni-bamberg.de"}).status, 404)

    def test_operator_sees_it_read_only(self):
        op = self.operator()
        listing = op.get("/operator").text
        self.assertIn(SID, listing)
        self.assertIn("Testumgebung", listing)  # the badge
        r = op.get(f"/scopes/{SID}")
        self.assertEqual(r.status, 200)
        text = html.unescape(r.text)
        self.assertIn("[sandbox]", text)
        self.assertIn("03:30 (Europe/Berlin)", text)
        self.assertNotIn('id="prompt"', text)  # no integration block: apps must not use this scope
        for form in ("/settings", "/limits", "/join-code", "/admins", "/suspend", "/resume", "/delete"):
            self.assertNotIn(f"/scopes/{SID}{form}", text, form)
        self.assertNotIn("config:sandbox", text)  # no admin list: the configuration file owns the scope
        self.assertIn("Die Testumgebung wird im Abschnitt [sandbox] der Serverkonfiguration verwaltet", text)
        en = html.unescape(op.get(f"/scopes/{SID}?lang=en").text)
        self.assertIn("configured in the [sandbox] section of the server configuration; changes here are refused", en)
        self.assertIn("The sandbox is managed in the [sandbox] section of the server configuration; it has no admins in the dashboard.", en)
        self.assertNotIn("always stays listed", en)

    def test_every_post_is_refused(self):
        op = self.operator()
        op.get(f"/scopes/{SID}")
        for path, form in (("/settings", {"name": "x", "contact_email": "a@uni-bamberg.de"}),
                           ("/join-code", {}), ("/admins", {"admin": "bob"}),
                           ("/admins/remove", {"admin": "bob"}), ("/suspend", {}), ("/resume", {}),
                           ("/delete", {"confirm": SID}), ("/vaults/ABCDEFGHJKMNPQRSTVWXYZ0123/delete", {})):
            r = op.post(f"/scopes/{SID}{path}?lang=en", form)
            self.assertEqual(r.status, 403, path)
            self.assertIn("changes here are refused", html.unescape(r.text), path)
        row = self.env.sql("SELECT status, join_code, deleted FROM scopes WHERE scope_id=?", (SID,))[0]
        self.assertEqual(tuple(row), ("active", None, None))

    def test_the_disk_budget_counts_the_sandbox(self):
        self.env.svc.disk_total_override = 4 * 2**30  # 70 % = 2.8 GiB: one default scope (2 GiB) fits alone, not next to the sandbox (1 GiB)
        a = self.staff()
        r = a.post("/scopes", {"name": "Big", "contact_email": "a@uni-bamberg.de"})
        self.assertEqual(r.status, 409)
        self.env.config.sandbox = None
        from wds_server.sandbox import ensure_sandbox
        ensure_sandbox(self.env.svc)
        r = a.post("/scopes", {"name": "Big", "contact_email": "a@uni-bamberg.de"})
        self.assertEqual(r.status, 303)

    def test_audit_texts_for_the_sandbox_entries(self):
        with self.env.svc.db.connection() as conn:
            self.env.svc.audit(conn, "system", "sandbox_wiped", SID, None, "4")
            self.env.svc.audit(conn, "system", "sandbox_evicted", SID, "V" * 26, "capacity")
        op = self.operator()
        text = html.unescape(op.get("/operator/audit?lang=en").text)
        self.assertIn("Sandbox: nightly wipe", text)
        self.assertIn("4 vaults deleted", text)
        self.assertIn("Sandbox: vault removed early", text)
        self.assertIn("sandbox full", text)
        de = html.unescape(op.get("/operator/audit?lang=de").text)
        self.assertIn("Testumgebung: nächtliche Löschung", de)


class DocPlaceholders(DashCase):
    """The docs placeholders for the repository and the sandbox (docs.py)."""
    config = {"sandbox": SandboxConfig(scope_id=SID, max_value_bytes=524288, vault_bytes=2097152, history_versions=2)}

    def values(self):
        return docs.placeholders(self.env.svc)

    def test_with_a_sandbox(self):
        v = self.values()
        self.assertEqual(v["repo_url"], "https://github.com/UBA-PSI/wiai-datastore")
        self.assertEqual(v["sandbox_scope"], SID)
        self.assertEqual(v["sandbox_wipe"], "03:30 Europe/Berlin")
        self.assertEqual(v["sandbox_limits"], "512 KB per record, 2 MB per vault, 2 versions")
        self.assertEqual(v["sandbox_creation"], "20 per network per hour, 60 for the whole sandbox per 10 minutes")   # create_per_ip / create_window, create_global / create_global_window

    def test_without_a_sandbox(self):
        self.env.config.sandbox = None
        v = self.values()
        self.assertEqual((v["sandbox_scope"], v["sandbox_wipe"], v["sandbox_limits"], v["sandbox_creation"]), ("(no sandbox on this server)", "-", "-", "-"))
        self.assertEqual(v["repo_url"], docs.REPO_URL)

    def test_fill_leaves_nothing_behind(self):
        text = "{{repo_url}} {{sandbox_scope}} {{sandbox_wipe}} {{sandbox_limits}} {{sandbox_creation}}"
        self.assertNotIn("{{", docs.fill(text, self.values()))
        self.env.config.sandbox = None
        self.assertNotIn("{{", docs.fill(text, self.values()))

    def test_window_words(self):
        self.assertEqual([docs._window(n) for n in (3600, 7200, 600, 60, 90)], ["hour", "2 hours", "10 minutes", "minute", "90 seconds"])

    def test_size_words(self):
        self.assertEqual([docs._size(n) for n in (100, 1024, 1536, 524288, 2097152, 1073741824)],
                         ["100 B", "1 KB", "1.5 KB", "512 KB", "2 MB", "1 GB"])
