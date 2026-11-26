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
    def page(self, b, scope):
        return b.get(f"/scopes/{scope}").text

    def test_english_prompt_carries_the_settings(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a, name="Demo")  # join code, breach check on
        text = pre(self.page(a, scope), "prompt")
        self.assertIn("I am building or porting a single-file web app that stores its data in the WIAI Datastore of the University of Bamberg.", text)
        self.assertIn("Wherever the app describes its privacy, say exactly this sentence, in the language of the text (a longer text may follow it):", text)
        self.assertIn("- English: Data is end-to-end encrypted; the faculty holds a recovery key for emergencies.", text)
        self.assertIn("- German: Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel.", text)
        self.assertRegex(text, r"Scope settings \(as of \d+ \w+ \d{4}; wds-verify prints the current ones\):")
        self.assertIn(f"- App ID (scope): {scope}", text)
        self.assertIn("- Enrollment: join code: users type a join code when they create their vault; never put it into the app", text)
        self.assertIn("- Breach check: on (keep https://api.pwnedpasswords.com in connect-src)", text)
        self.assertIn("- Limits: 10 MB per record, 200 MB per vault including history, 10 versions per record, 50 vaults", text)
        self.assertIn("https://wiai.uni-bamberg.de/datastore/llms.txt", text)
        self.assertIn('wds-verify (https://github.com/UBA-PSI/wiai-datastore, integration.md section "wds-verify")', text)
        self.assertIn("If the app already exists, read https://wiai.uni-bamberg.de/datastore/docs/porting.md first; data the old version left in the browser is taken over with store.migrateLocal.", text)
        self.assertIn("(create them if missing; keep existing content)", text)
        self.assertIn(f'WDS.connect({{ scope: "{scope}" }})', text)
        self.assertIn("integrity=", text)  # the tag with its hash
        self.assertIn("TESTHASH", text)

    def test_the_join_code_itself_is_never_in_the_prompt(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a)
        code = self.row(scope)["join_code"]
        page = self.page(a, scope)
        self.assertNotIn(code, pre(page, "prompt"))
        self.assertNotIn(code, pre(page, "claude-md"))

    def test_open_and_closed_enrollment_and_breach_check_off(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a, enrollment="open", hibp="")
        text = pre(self.page(a, scope), "prompt")
        self.assertIn("- Enrollment: open: anybody with the app can create a vault (limit 50)", text)
        self.assertIn("- Breach check: off (remove https://api.pwnedpasswords.com from connect-src)", text)
        a.post(f"/scopes/{scope}/enrollment", {"enrollment": "closed"})
        self.assertIn("- Enrollment: closed: no new vaults", pre(self.page(a, scope), "prompt"))

    def test_prompt_says_how_to_get_the_join_code_for_a_test_vault(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a, name="Demo")  # join code
        text = pre(self.page(a, scope), "prompt")
        self.assertIn("I put the join code into the file ~/.wds/join-code myself.", text)
        self.assertIn('When you need it, give me the commands from porting.md ("The join code for tests") and wait until I say it is there.', text)
        self.assertIn("Never read, print or copy that file and never ask me for the code in the chat.", text)
        self.assertIn("Never write the code into the app, the README, a test script, a command line, CLAUDE.md or AGENTS.md.", text)
        self.assertIn("End the test by deleting the test vault yourself (deleteVault of tools/lib/drive-library.mjs", text)
        self.assertIn("tell me its ID and the time, so that I can check that it is gone.", text)
        self.assertNotIn("delete exactly that vault afterwards", text)
        self.assertIn("(the deletion path of a migration)", text)  # no sandbox here: the sandbox is not mentioned
        self.assertNotIn("WDS_JOIN_CODE", text)
        self.assertNotIn("This test is optional", text)  # the optional-test sentence points to the sandbox, which this server does not have
        de = self.staff(lang_header="de")
        dscope = self.make_scope(de, name="Demo")
        dtext = pre(self.page(de, dscope), "prompt")
        self.assertIn("lege ich den Beitrittscode selbst in die Datei ~/.wds/join-code.", dtext)
        self.assertIn("gib mir die Befehle aus porting.md", dtext)
        self.assertIn("Lies, zeige oder kopiere diese Datei nie und frag mich nie im Chat nach dem Code.", dtext)
        self.assertIn("Beende den Test, indem du den Test-Tresor selbst löschst", dtext)
        self.assertNotIn("dann lösche ich genau diesen Tresor danach", dtext)
        self.assertNotIn("WDS_JOIN_CODE", dtext)

    def test_prompt_for_open_enrollment_needs_no_join_code(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a, name="Demo", enrollment="open")
        text = pre(self.page(a, scope), "prompt")
        self.assertIn("create one yourself: this scope needs no join code.", text)
        self.assertNotIn("ask me for the join code", text)
        snippet = pre(self.page(a, scope), "claude-md")
        self.assertNotIn("join code", snippet)  # an open scope has no code to protect: the snippet does not talk about one
        a.post(f"/scopes/{scope}/enrollment", {"enrollment": "closed"})
        self.assertNotIn("join code", pre(self.page(a, scope), "claude-md"))

    def test_limits_follow_the_scope(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a)
        a.post(f"/scopes/{scope}/limits", {"max_value_bytes": "2", "vault_bytes": "20", "scope_bytes": "", "max_vaults": "7",
                                          "history_versions": "3"})
        text = pre(self.page(a, scope), "prompt")
        self.assertIn("- Limits: 2 MB per record, 20 MB per vault including history, 3 versions per record, 7 vaults", text)

    def test_german_prompt(self):
        a = self.staff(lang_header="de")
        scope = self.make_scope(a, name="Demo", enrollment="open", hibp="")
        text = pre(self.page(a, scope), "prompt")
        self.assertIn("Ich baue oder portiere eine Web-App", text)
        self.assertIn("- Deutsch: Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel.", text)
        self.assertIn("- Englisch: Data is end-to-end encrypted; the faculty holds a recovery key for emergencies.", text)
        self.assertIn(f"- App-ID (Scope): {scope}", text)
        self.assertIn("- Anlegen von Tresoren: offen: jede Person mit der App kann einen Tresor anlegen (Höchstzahl 50)", text)
        self.assertIn("- Prüfung auf Datenlecks: aus (https://api.pwnedpasswords.com aus connect-src entfernen)", text)
        self.assertIn("- Grenzen: 10 MB je Datensatz, 200 MB je Tresor einschließlich Verlauf, 10 Versionen je Datensatz, 50 Tresore", text)
        self.assertIn("lies zuerst https://wiai.uni-bamberg.de/datastore/docs/porting.md; Daten, die die alte Version im Browser hinterlassen hat, übernimmst du mit store.migrateLocal", text)
        self.assertIn("behalte den bisherigen Inhalt", text)
        self.assertRegex(text, r"Stand \d{2}\.\d{2}\.\d{4}; wds-verify")

    def test_snippet_is_english_in_both_languages_with_a_copy_button(self):
        for lang in ("en", "de"):
            a = self.staff(lang_header=lang)
            scope = self.make_scope(a)
            page = self.page(a, scope)
            snippet = pre(page, "claude-md")
            self.assertTrue(snippet.startswith("## Data storage: WIAI Datastore\n"))
            self.assertIn(f"app ID (scope) {scope}.", snippet)
            self.assertIn('  en: "Data is end-to-end encrypted; the faculty holds a recovery key for emergencies."', snippet)
            self.assertIn('  de: "Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel."', snippet)
            self.assertIn("- The join code of this scope is a secret of the staff. Never write it into the app, the README, tests, scripts, CLAUDE.md or AGENTS.md.", snippet)
            self.assertIn("the person puts the code into the file ~/.wds/join-code themselves", snippet)
            self.assertIn("Never read, print or copy that file and never ask for the code in the chat.", snippet)
            self.assertNotIn("WDS_JOIN_CODE", snippet)
            self.assertIn("read https://wiai.uni-bamberg.de/datastore/llms.txt and follow it.", snippet)
            self.assertIn("run wds-verify, it prints them.", snippet)
            self.assertIn("(https://github.com/UBA-PSI/wiai-datastore)", snippet)
            self.assertIn('data-copy="claude-md"', page)
            self.assertIn(snippet, pre(page, "prompt"))  # the prompt ends with the same section
            self.assertNotIn("sandbox", snippet.lower())

    def test_headings_and_hint_in_both_languages(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a)
        en = a.get(f"/scopes/{scope}").text
        self.assertIn("CLAUDE.md / AGENTS.md for the app repository", en)
        self.assertIn("For apps that already exist: add this section to CLAUDE.md and AGENTS.md in the app's folder.", html.unescape(en))
        de = self.browser(lang_header="de")
        self.login(de, "alice", "alice@uni-bamberg.de")
        text = html.unescape(de.get(f"/scopes/{scope}").text)
        self.assertIn("CLAUDE.md / AGENTS.md für das App-Repository", text)
        self.assertIn("Für Apps, die schon existieren", text)

    def test_no_dashboard_address_as_the_source_of_settings(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a)
        page = self.page(a, scope)
        for ident in ("prompt", "claude-md"):
            text = pre(page, ident)
            self.assertNotIn("/scopes/", text)
            self.assertNotIn("/datastore/login", text)
            self.assertNotIn("dashboard", text.lower())

    def test_sandbox_lines_are_absent_without_a_sandbox(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a)
        page = self.page(a, scope)
        for ident in ("prompt", "claude-md"):
            self.assertNotIn("sandbox", pre(page, ident).lower())


class PromptWithSandbox(DashCase):
    config = {"sandbox": SandboxConfig(scope_id=SID)}

    def test_sandbox_lines_in_prompt_and_snippet(self):
        a = self.staff(lang_header="en")
        scope = self.make_scope(a)
        page = a.get(f"/scopes/{scope}").text
        text = pre(page, "prompt")
        self.assertIn("For end-to-end test runs use wds-verify --target sandbox (or --sandbox-copy). Never write the sandbox scope ID", text)
        self.assertIn(f"{SID} into the app file: data there is deleted every night.", text)
        self.assertIn("(the deletion path of a migration: the sandbox never deletes old data)", text)
        self.assertIn("This test is optional: wds-verify --target sandbox with --migration-delete covers the deletion path.", text)
        snippet = pre(page, "claude-md")
        self.assertIn(f"- Never write the sandbox scope ID {SID} into this app; test with wds-verify --target sandbox.", snippet)
        de = self.browser(lang_header="de")
        self.login(de, "alice", "alice@uni-bamberg.de")
        dtext = pre(de.get(f"/scopes/{scope}").text, "prompt")
        self.assertIn("--target sandbox", dtext)
        self.assertIn(SID, dtext)
        self.assertIn("jede Nacht gelöscht", dtext)


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
        for form in ("/settings", "/enrollment", "/limits", "/join-code", "/admins", "/suspend", "/resume", "/delete"):
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
        for path, form in (("/settings", {"name": "x", "contact_email": "a@uni-bamberg.de"}), ("/enrollment", {"enrollment": "closed"}),
                           ("/join-code", {}), ("/limits", {"max_vaults": "1"}), ("/admins", {"admin": "bob"}),
                           ("/admins/remove", {"admin": "bob"}), ("/suspend", {}), ("/resume", {}),
                           ("/delete", {"confirm": SID}), ("/vaults/ABCDEFGHJKMNPQRSTVWXYZ0123/delete", {})):
            r = op.post(f"/scopes/{SID}{path}?lang=en", form)
            self.assertEqual(r.status, 403, path)
            self.assertIn("changes here are refused", html.unescape(r.text), path)
        row = self.env.sql("SELECT status, enrollment, deleted FROM scopes WHERE scope_id=?", (SID,))[0]
        self.assertEqual(tuple(row), ("active", "open", None))

    def test_the_disk_budget_counts_the_sandbox(self):
        self.env.svc.disk_total_override = 4 * 2**30  # 70 % = 2.8 GiB: one default scope (2 GiB) fits alone, not next to the sandbox (1 GiB)
        a = self.staff()
        r = a.post("/scopes", {"name": "Big", "contact_email": "a@uni-bamberg.de", "enrollment": "open", "hibp": "1"})
        self.assertEqual(r.status, 409)
        self.env.config.sandbox = None
        from wds_server.sandbox import ensure_sandbox
        ensure_sandbox(self.env.svc)
        r = a.post("/scopes", {"name": "Big", "contact_email": "a@uni-bamberg.de", "enrollment": "open", "hibp": "1"})
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

    def test_without_a_sandbox(self):
        self.env.config.sandbox = None
        v = self.values()
        self.assertEqual((v["sandbox_scope"], v["sandbox_wipe"], v["sandbox_limits"]), ("(no sandbox on this server)", "-", "-"))
        self.assertEqual(v["repo_url"], docs.REPO_URL)

    def test_fill_leaves_nothing_behind(self):
        text = "{{repo_url}} {{sandbox_scope}} {{sandbox_wipe}} {{sandbox_limits}}"
        self.assertNotIn("{{", docs.fill(text, self.values()))
        self.env.config.sandbox = None
        self.assertNotIn("{{", docs.fill(text, self.values()))

    def test_size_words(self):
        self.assertEqual([docs._size(n) for n in (100, 1024, 1536, 524288, 2097152, 1073741824)],
                         ["100 B", "1 KB", "1.5 KB", "512 KB", "2 MB", "1 GB"])
