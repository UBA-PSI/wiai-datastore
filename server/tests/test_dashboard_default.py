"""Dashboard for people who are not developers: the default create form, the default view of a scope with the expert area folded
away, the remembered expert choice, the plain-language texts, sizes in MB, and the help contact."""

import html as htmllib
import os
import re
import tempfile
import urllib.parse

from wds_server import prompt as prompt_mod
from wds_server.config import SandboxConfig, load_config
from wds_server.docs import REPO_URL
from wds_server.texts import TEXTS
from wds_server.ui import fmt_bytes

from .dash_helpers import DashCase

EXPERT_OPEN = re.compile(r'<details class="expert" id="expert"( open)?>')


def form_defaults(page: str, action: str) -> dict:
    """What a browser would submit for the form with this action when nobody changes anything."""
    form = re.search(rf'<form method="post" action="[^"]*{action}"[^>]*>(.*?)</form>', page, re.S).group(1)
    out = {}
    for tag in re.findall(r"<select.*?</select>|<textarea.*?</textarea>|<input[^>]*>", form, re.S):
        name = re.search(r'name="([^"]+)"', tag)
        if not name or "type=\"submit\"" in tag:
            continue
        kind = re.search(r'type="([^"]+)"', tag)
        if tag.startswith("<select"):
            sel = re.search(r'<option value="([^"]+)" selected', tag)
            out[name.group(1)] = sel.group(1) if sel else re.search(r'<option value="([^"]+)"', tag).group(1)
        elif tag.startswith("<textarea"):
            out[name.group(1)] = htmllib.unescape(re.search(r">(.*?)</textarea>", tag, re.S).group(1))
        elif kind and kind.group(1) == "checkbox":
            if " checked" in tag:
                out[name.group(1)] = re.search(r'value="([^"]*)"', tag).group(1)
        else:
            value = re.search(r'value="([^"]*)"', tag)
            out[name.group(1)] = htmllib.unescape(value.group(1)) if value else ""
    return out


def split_default_and_expert(page: str):
    m = EXPERT_OPEN.search(page)
    return page[:m.start()], page[m.start():]


class DefaultCreateForm(DashCase):
    def test_standard_variant_needs_name_and_contact_only(self):
        a = self.staff(lang_header="en")
        home = a.get("/").text
        values = form_defaults(home, "/scopes")
        self.assertEqual(set(values) - {"csrf"}, {"name", "contact_email", "description"})
        self.assertEqual(values["contact_email"], "alice@uni-bamberg.de")   # prefilled with the person's own address
        values["name"] = "Notenrechner"
        r = a.post("/scopes", values)
        self.assertEqual(r.status, 303)
        scope = r.headers["location"].split("?")[0].rsplit("/", 1)[1]
        row = self.row(scope)
        self.assertEqual((row["contact_email"], row["limits"]), ("alice@uni-bamberg.de", "{}"))
        self.assertRegex(row["join_code"], r"^[0-9A-Z]{8}$")
        self.assertTrue(scope.startswith("notenrechner-"))
        limits = self.env.svc.scope_limits(row)
        self.assertEqual(limits["max_vaults"], self.env.config.limit_defaults["max_vaults"])   # the server defaults, nothing stored

    def test_there_is_nothing_to_choose_but_the_three_answers(self):
        home = self.staff().get("/").text
        for gone in ('id="c_slug"', 'id="c_enroll"', 'id="c_hibp"', 'id="create-more"', 'name="slug"', 'name="enrollment"', 'name="hibp"'):
            self.assertNotIn(gone, home, gone)
        for field in ('id="c_name"', 'id="c_mail"', 'id="c_desc"'):
            self.assertIn(field, home)

    def test_defaults_sentence_names_the_values(self):
        a = self.staff()
        text = htmllib.unescape(re.sub(r"<[^>]+>", "", a.get("/").text))
        self.assertIn("Neue Apps: Tresore werden mit dem Beitrittscode angelegt (ein Code, den Sie an Ihre Nutzenden weitergeben;", text)   # the terms are explained where they first appear
        self.assertIn("Kennwörter (Passphrasen), die aus bekannten Datenlecks stammen, werden abgelehnt.", text)
        self.assertNotIn("Pwned", text)                                    # one rule for every app: nothing to switch, nothing to explain here
        self.assertIn("Jede Person bekommt einen Tresor mit 200 MB Speicher. Einzelne Dateien dürfen bis 10 MB groß sein, von jedem Eintrag bleiben 10 frühere Versionen erhalten. Höchstens 50 Tresore (eingeladene Personen brauchen keinen eigenen).", text)
        self.assertIn("Brauchen Sie mehr, wenden Sie sich später an den Betrieb.", text)
        en = htmllib.unescape(re.sub(r"<[^>]+>", "", a.get("/?lang=en").text))
        self.assertIn("New apps: vaults are created with the join code (a code that you give to your users;", en)
        self.assertIn("a vault with 200 MB of storage. Single files may be up to 10 MB; 10 earlier versions of every entry are kept.", en)

    def test_the_short_name_of_the_app_id_always_comes_from_the_name(self):
        a = self.staff()
        for name, prefix in (("Noten Rechner", "noten-rechner-"), ("Größe & Co.", "groe-co-"), ("2024 Plan", "plan-"), ("!!!", "app-")):
            scope = self.make_scope(a, name=name)
            self.assertTrue(scope.startswith(prefix), (name, scope))
        # fields of the removed form are ignored, not obeyed
        r = a.post("/scopes", {"name": "Offene App", "contact_email": "a@uni-bamberg.de", "slug": "evil", "enrollment": "open", "hibp": ""})
        self.assertEqual(r.status, 303)
        scope = r.headers["location"].split("?")[0].rsplit("/", 1)[1]
        self.assertTrue(scope.startswith("offene-app-"))
        self.assertRegex(self.row(scope)["join_code"], r"^[0-9A-Z]{8}$")

    def test_an_error_keeps_what_was_typed(self):
        a = self.staff()
        r = a.post("/scopes", {"name": "App", "contact_email": "not-an-address"})
        self.assertEqual(r.status, 400)
        self.assertIn('value="not-an-address"', r.text)                  # what was typed stays; no prefill over it


class ExpertArea(DashCase):
    """The expert area is folded for staff, open for the operator, and opened by an error or by the result of a form inside it.
    There is no remembered choice any more: no cookie, no preference route."""

    def setUp(self):
        super().setUp()
        self.a = self.staff()
        self.scope = self.make_scope(self.a)

    def state(self, b, path=None):
        m = EXPERT_OPEN.search(b.get(path or f"/scopes/{self.scope}").text)
        self.assertIsNotNone(m)
        return bool(m.group(1))

    def test_closed_by_default_for_staff(self):
        self.assertFalse(self.state(self.a))

    def test_there_is_no_remembered_choice(self):
        r = self.a.post("/prefs/expert", {"on": "1", "next": "/datastore/"})
        self.assertEqual(r.status, 404)
        self.assertFalse([c for c in self.a.raw_cookies if c.startswith("wds_expert")])
        page = self.a.get(f"/scopes/{self.scope}").text
        for gone in ("/prefs/expert", "wds_expert", 'name="on"'):
            self.assertNotIn(gone, page)
        self.assertFalse(self.state(self.a))
        self.a.cookies["wds_expert"] = "1"                               # an old cookie does nothing
        self.assertFalse(self.state(self.a))

    def test_the_operator_always_sees_it_opened(self):
        op = self.operator()
        self.assertTrue(self.state(op))
        own = self.make_scope(op, name="Op App")                       # the operator's own app, too
        self.assertTrue(self.state(op, f"/scopes/{own}"))

    def test_an_error_inside_the_area_opens_it(self):
        r = self.a.post(f"/scopes/{self.scope}/admins", {"admin": "not valid!"})
        self.assertEqual(r.status, 400)
        self.assertRegex(r.text, r'<details class="expert" id="expert" open>')
        self.assertIn('id="admin-err"', r.text)

    def test_the_result_of_a_form_in_the_area_shows_it_opened(self):
        r = self.a.post(f"/scopes/{self.scope}/settings", {"name": "Renamed", "contact_email": "x@uni-bamberg.de"})
        page = self.a.get(r.headers["location"]).text
        self.assertRegex(page, r'<details class="expert" id="expert" open>')
        self.assertIn("Gespeichert", page)
        # the rotated code is shown in the default view, so that notice does not open the area
        r = self.a.post(f"/scopes/{self.scope}/join-code", {})
        self.assertFalse(bool(EXPERT_OPEN.search(self.a.get(r.headers["location"]).text).group(1)))


class DefaultView(DashCase):
    def setUp(self):
        super().setUp()
        self.a = self.staff()
        self.scope = self.make_scope(self.a, name="Demo")
        self.page = self.a.get(f"/scopes/{self.scope}").text
        self.default, self.expert = split_default_and_expert(self.page)

    def test_default_view_has_the_steps_usage_help_and_app_id(self):
        d = self.default
        order = [d.index(x) for x in ('<h1>', 'id="next-steps"', 'id="prompt"', 'id="jc"', "/docs/users.de", 'id="usage"', 'id="help"', 'id="sid"')]
        self.assertEqual(order, sorted(order))
        self.assertIn("<ol class=\"steps\">", d)
        self.assertEqual(d.count("<li>"), 3)
        self.assertIn(self.row(self.scope)["join_code"], d)
        self.assertIn("0 von 50 Tresoren angelegt, zusammen 0 B von 2,0 GB Speicher belegt.", d)
        self.assertIn("Ein Tresor ist der verschlüsselte Speicherplatz einer Person in Ihrer App.", d)
        self.assertIn("Die Kennung Ihrer App beim Datastore.", d)
        self.assertIn("Nur wer diesen Code kennt", d)
        self.assertIn("verhindert nur, dass Fremde Speicherplatz belegen", d)

    def test_who_can_read_uses_the_official_sentence(self):
        for lang, sentence in (("de", prompt_mod.PRIVACY_DE), ("en", prompt_mod.PRIVACY_EN)):
            page = htmllib.unescape(self.a.get(f"/scopes/{self.scope}?lang={lang}").text)
            self.assertIn(sentence, page)
        self.assertIn("nie deren Inhalte", self.default)

    def test_no_developer_or_admin_forms_in_the_default_view(self):
        d = self.default
        for needle in ("/settings", "/limits", "/admins", "/enrollment", "/delete", "/suspend", 'id="tag"', "integrity=\"sha384"):
            self.assertNotIn(needle, d.replace("&lt;script", ""), needle)
        self.assertNotIn("<table", d)
        for needle in ("/settings", "/admins", "/delete", 'id="tag"'):
            self.assertIn(needle, self.expert, needle)
        for gone in ("/limits", "/enrollment", "/suspend", 'id="claude-md"', 'name="hibp"', 'name="slug"', "prefs/expert"):   # nothing to edit or choose any more
            self.assertNotIn(gone, d + self.expert, gone)
        # the rotate button stays in the default view: a leaked code has to be replaced without opening anything
        self.assertIn(f"/scopes/{self.scope}/join-code", d)
        self.assertNotIn(f"/scopes/{self.scope}/join-code", self.expert)

    def test_expert_area_labels_and_headings(self):
        e = self.expert
        self.assertIn("<summary>Experteneinstellungen</summary>", e)
        self.assertIn("Für Fachleute: Einstellungen, die die meisten Apps nicht brauchen.", e)
        for heading in ("Angaben zur App", "Speicherplatz und Grenzen", "Administratoren", "Tresore", "Änderungsprotokoll", "App löschen"):
            self.assertIn(f">{heading}</h3>", e.replace(' id="admins"', "").replace(' id="vaults"', "").replace(' id="limits"', ""), heading)
        for gone in ("Anlegen von Tresoren", "App pausieren", "Personen mit Zugang", "Neu verschlüsseln läuft noch"):
            self.assertNotIn(gone, e, gone)
        self.assertNotRegex(e, r"<h2")                                  # the area has h3 and h4 only: heading order stays
        self.assertIn("Höchstzahl der Tresore", e)
        self.assertIn("Größen in MB (1 MB = 1.048.576 Bytes)", e)
        for label in ("s_name", "s_desc", "s_mail", "a_new", "d_conf"):
            self.assertIn(f'for="{label}"', e)
        for label in ("s_hibp", "e_mode", "l_max_vaults"):
            self.assertNotIn(f'for="{label}"', e)
        self.assertNotIn("<input type=\"number\"", e)                   # the limits table shows values only
        visible = re.sub(r"<pre.*?</pre>|<style.*?</style>|<script.*?</script>|<[^>]+>", "", self.page, flags=re.S)   # the prompt for Claude may say "Scope"
        self.assertNotIn("Scope", visible)
        self.assertNotIn("MiB", self.page)

    def test_the_join_code_is_the_only_way_and_rotating_it_stops_the_old_one(self):
        code = self.row(self.scope)["join_code"]
        self.assertIn(f'<code id="jc" class="big">{code}</code>', self.default)
        for gone in ("Jede Person, die die App hat", "Zurzeit können keine neuen Tresore", "enrollment"):
            self.assertNotIn(gone, self.page, gone)
        self.assertEqual(self.a.post(f"/scopes/{self.scope}/enrollment", {"enrollment": "open"}).status, 404)
        self.a.post(f"/scopes/{self.scope}/join-code", {})
        self.assertNotEqual(self.row(self.scope)["join_code"], code)

    def test_usage_counts_active_vaults_and_warns_near_the_limit(self):
        with self.env.svc.db.connection() as conn:   # the operator's CLI does this (wds_server.cli limits); the dashboard only shows the limits
            conn.execute("UPDATE scopes SET limits='{\"max_vaults\": 5}' WHERE scope_id=?", (self.scope,))
        vaults = [self.env.new_vault({"scope": self.scope, "join_code": None}) for _ in range(4)]
        vaults[0].put_ok("rec", size=2000)
        d, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}").text)
        self.assertRegex(d, r"4 von 5 Tresoren angelegt, zusammen [\d,]+ KB von 2,0 GB Speicher belegt")
        self.assertIn("Die App ist bald voll", d)
        self.a.post(f"/scopes/{self.scope}/vaults/{vaults[1].vault}/delete", {})
        d, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}").text)
        self.assertIn("3 von 5 Tresoren", d)                           # a deleted vault does not count
        self.assertNotIn("Die App ist bald voll", d)

    def test_only_the_operator_pauses_and_an_admin_is_told_so(self):
        self.assertEqual(self.a.post(f"/scopes/{self.scope}/suspend", {}).status, 403)
        self.assertEqual(self.row(self.scope)["status"], "active")
        self.assertNotIn(f"/scopes/{self.scope}/suspend", self.page)
        self.operator().post(f"/scopes/{self.scope}/suspend", {})
        page = self.a.get(f"/scopes/{self.scope}").text
        d, e = split_default_and_expert(page)
        self.assertIn("pausiert", d)
        self.assertIn("Nur der Betrieb kann die Pause beenden.", d)
        self.assertNotIn("durch Sie", page)
        self.assertNotIn(f"/scopes/{self.scope}/resume", page)
        self.assertEqual(self.a.post(f"/scopes/{self.scope}/resume", {}).status, 403)
        en = self.a.get(f"/scopes/{self.scope}?lang=en").text
        self.assertIn("The operator has paused this app. Only the operator can end the pause.", en)

    def test_help_box_links_and_optional_contact(self):
        d = self.default
        self.assertIn('href="/datastore/docs/"', d)
        self.assertIn('href="/datastore/docs/porting"', d)
        self.assertIn('href="#admins"', d)
        self.assertNotIn("Fragen?", d)
        self.env.config.help_contact = "dev@uni-bamberg.de"
        d, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}").text)
        self.assertIn('Fragen? <a href="mailto:dev@uni-bamberg.de">dev@uni-bamberg.de</a>', d)
        self.env.config.help_contact = "Sprechstunde Raum 12"
        d, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}?lang=en").text)
        self.assertIn("Questions? Sprechstunde Raum 12", d)
        self.assertNotIn("mailto:", d)
        self.env.config.help_contact = '<b>"x"</b>'
        d, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}").text)
        self.assertNotIn("<b>", d)

    def test_help_contact_is_read_from_the_configuration_file(self):
        with tempfile.NamedTemporaryFile("w", suffix=".ini", delete=False) as fh:
            fh.write("[server]\nhelp_contact = dev@uni-bamberg.de\n")
        try:
            self.assertEqual(load_config(fh.name).help_contact, "dev@uni-bamberg.de")
        finally:
            os.unlink(fh.name)
        self.assertEqual(load_config(None).help_contact, "")

    def test_operator_view_has_the_area_opened_and_the_known_actions(self):
        op = self.operator()
        d, e = split_default_and_expert(op.get(f"/scopes/{self.scope}").text)
        self.assertIn("Sie sehen diese App als Betrieb.", d)
        self.assertNotIn('id="jc"', d)                                  # the code is for the app's admins
        self.assertIn(f"/scopes/{self.scope}/suspend", e)
        self.assertIn(f"/scopes/{self.scope}/delete", e)
        self.assertNotIn(f"/scopes/{self.scope}/settings", e)


class PromptSentences(DashCase):
    """"Text für Claude": one English text for both uses, the conversation and CLAUDE.md / AGENTS.md (prompt.py)."""

    def prompt(self, lang="de", name="Demo"):
        a = self.staff(lang_header=lang)
        scope = self.make_scope(a, name=name)
        return scope, html_pre(a.get(f"/scopes/{scope}").text, "prompt")

    def test_one_english_text_whatever_the_dashboard_language(self):
        scope_de, de = self.prompt("de")
        scope_en, en = self.prompt("en")
        self.assertEqual(de.replace(scope_de, "ID"), en.replace(scope_en, "ID"))
        for needle in (f"app ID (scope) {scope_de}", "/llms.txt and follow its rules", prompt_mod.PRIVACY_EN, prompt_mod.PRIVACY_DE, "wds-verify",
                       "Keep this section in CLAUDE.md and AGENTS.md"):
            self.assertIn(needle, de, needle)
        self.assertNotIn("Ich baue", de)

    def test_nothing_that_changes_is_copied_into_it(self):
        _, text = self.prompt()
        for gone in ("Enrollment", "Breach", "Pwned", "per vault", "WDS.connect", "<script", "integrity", "MiB", "~/.wds", "deleteVault", "WDS_JOIN_CODE",
                     "as of"):
            self.assertNotIn(gone, text, gone)
        self.assertIn("The join code of this app is a secret of the staff", text)

    def test_the_text_is_exactly_what_prompt_py_makes(self):
        scope, text = self.prompt()
        self.assertEqual(text, prompt_mod.claude_text(sid=scope, base="https://wiai.uni-bamberg.de/datastore", repo_url=REPO_URL, sandbox_id=None))

    def test_there_is_no_second_block_for_claude_md(self):
        a = self.staff()
        page = a.get(f"/scopes/{self.make_scope(a)}").text
        self.assertEqual(page.count('id="prompt"'), 1)
        self.assertNotIn('id="claude-md"', page)

    def test_the_breach_check_wording_is_one_sentence_per_language(self):
        for text in (prompt_mod.BREACH_EN, prompt_mod.BREACH_DE):
            self.assertIn("Pwned Passwords", text)
            self.assertIn("USA", text)
        self.assertIn("first five characters of a checksum", prompt_mod.BREACH_EN)
        self.assertIn("ersten fünf Zeichen einer Prüfsumme", prompt_mod.BREACH_DE)
        self.assertIn("neither the passphrase nor your IP address", prompt_mod.BREACH_EN)
        self.assertIn("weder die Passphrase noch Ihre IP-Adresse", prompt_mod.BREACH_DE)

    def test_dashboard_never_puts_the_code_into_the_prompt(self):
        a = self.staff()
        scope = self.make_scope(a)
        code = self.row(scope)["join_code"]
        default, expert = split_default_and_expert(a.get(f"/scopes/{scope}").text)
        self.assertNotIn(code, html_pre(default, "prompt"))
        self.assertIn(f'<code id="jc" class="big">{code}</code>', default)    # it is shown once, as the step for the person


def html_pre(page: str, ident: str) -> str:
    return htmllib.unescape(re.search(rf'<pre id="{ident}">(.*?)</pre>', page, re.S).group(1))


class SandboxScope(DashCase):
    config = {"sandbox": SandboxConfig(scope_id="sandbox-000000")}

    def test_the_sandbox_page_is_the_expert_area_for_the_operator(self):
        op = self.operator()
        page = op.get("/scopes/sandbox-000000").text
        self.assertRegex(page, r'<details class="expert" id="expert" open>')
        self.assertIn('id="sid"', page)
        self.assertNotIn('id="next-steps"', page)
        self.assertNotIn('id="prompt"', page)


class PlainLanguage(DashCase):
    NEW_KEYS = ("create_defaults", "f_description_hint", "sid_hint", "vault_explain", "who_reads", "expert_title", "expert_hint",
                "next_steps", "step_prompt", "step_code", "step_users", "step_users_hint", "users_doc", "usage_title", "usage_text", "usage_near",
                "help_title", "help_text", "help_contact", "join_code_claude_hint")

    def test_new_texts_exist_in_both_languages_and_differ(self):
        for key in self.NEW_KEYS:
            de, en = TEXTS[key]
            self.assertTrue(de.strip() and en.strip(), key)
            self.assertNotEqual(de, en, key)
            self.assertEqual(sorted(re.findall(r"\{(\w+)\}", de)), sorted(re.findall(r"\{(\w+)\}", en)), key)

    def test_the_jargon_is_gone(self):
        banned = (r"Scope", r"MiB", r"KiB", r"GiB", r"\bSRI\b", r"Hashwert", r"\bHash\b", r"Have I Been Pwned", r"App (ge)?sperr", r"\bSperre\b",
                  r"gesperrt \(durch", r"Treuhand")
        banned_en = (r"[Ss]cope ID", r"MiB", r"KiB", r"GiB", r"\bSRI\b", r"\bhash\b", r"Have I Been Pwned", r"\b[Ss]uspend", r"escrow")
        sandbox_or_operator = {"sandbox_readonly", "err_sandbox_config", "sandbox_admins", "global_hint", "dev_hint"}
        for key, (de, en) in TEXTS.items():
            if key in sandbox_or_operator:
                continue
            for pattern in banned:
                self.assertNotRegex(de, pattern, key)
            for pattern in banned_en:
                self.assertNotRegex(en, pattern, key)

    def test_the_words_the_maintainer_asked_to_explain_are_explained(self):
        de = {k: v[0] for k, v in TEXTS.items()}
        self.assertIn("verschlüsselte Speicherplatz einer Person", de["vault_explain"])                    # Tresor
        self.assertIn("Nur wer diesen Code kennt", de["join_code_hint"])                                    # Beitrittscode
        self.assertIn("nicht geheim", de["sid_hint"])                                                       # App-ID
        self.assertIn("(das Team, das den Datastore für die Fakultät betreibt)", de["who_reads"])           # Betrieb
        self.assertIn("1 MB = 1.048.576 Bytes", de["limits_hint"])                                          # MB
        self.assertIn("lesen und exportieren", de["suspend_hint"])                                          # Pause

    def test_sizes_are_written_in_mb(self):
        self.assertEqual(fmt_bytes(512, "en"), "512 B")
        self.assertEqual(fmt_bytes(2048, "en"), "2.0 KB")
        self.assertEqual(fmt_bytes(10 * 1048576, "de"), "10,0 MB")
        self.assertEqual(fmt_bytes(1073741824, "en"), "1.0 GB")
        self.assertEqual(fmt_bytes(3 * 1024**4, "en"), "3.0 TB")
        self.assertEqual(fmt_bytes(2000 * 1024**4, "en"), "2000.0 TB")

    def test_the_privacy_page_names_no_display_cookie_any_more(self):
        for lang in ("de", "en"):
            self.assertNotIn("wds_expert", self.browser().get("/privacy?lang=" + lang).text)

    def test_the_words_for_the_users_code_and_the_faculty_key_are_kept_apart(self):
        """D8: the user's code is the "Notfallcode"; "Wiederherstellungsschlüssel" is the faculty's key, in the official sentence."""
        for key, (de, en) in TEXTS.items():
            self.assertNotIn("Wiederherstellungscode", de, key)
            self.assertNotRegex(en, r"[Rr]ecovery code", key)


class LayLanguage(DashCase):
    """Round F, review: the terms of the dashboard are explained where a person meets them first, and the default view needs no terminal and no expert area."""

    def setUp(self):
        super().setUp()
        self.a = self.staff()
        self.scope = self.make_scope(self.a, name="Demo")

    def test_home_says_what_an_app_and_a_vault_are_before_the_form(self):
        home = htmllib.unescape(self.a.get("/").text)
        text = re.sub(r"<[^>]+>", "", home)
        self.assertLess(home.index('id="home-intro"'), home.index("Neue App anlegen"))
        self.assertIn("Eine App ist ein kleines Programm im Browser", text)
        self.assertIn("einen eigenen Tresor: einen verschlüsselten Speicherplatz", text)
        self.assertIn("App-ID: die Kennung der App beim Datastore", text)    # the column the list shows
        self.assertNotIn("Fassungen", text)
        en = re.sub(r"<[^>]+>", "", htmllib.unescape(self.a.get("/?lang=en").text))
        self.assertIn("An app is a small program in the browser", en)
        self.assertIn("a vault of their own for this: an encrypted storage space", en)

    def test_the_step_texts_do_not_send_a_layperson_to_a_terminal(self):
        d, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}").text)
        d = re.sub(r"<pre.*?</pre>", "", d, flags=re.S)                      # the text for Claude names the file; the person's own texts do not
        self.assertNotIn("~/.wds", d)
        self.assertNotIn("Textdatei", d)
        self.assertIn("Claude braucht den Code nicht: Claude testet in der Testumgebung.", d)
        self.assertIn("Sie müssen den Text nicht verstehen; Claude liest ihn.", d)
        en, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}?lang=en").text)
        self.assertIn("Claude does not need the code: Claude tests in the sandbox.", en)
        self.assertNotIn("against this app", en)                            # "your app" and "this app" were both called app

    def test_the_emergency_code_is_explained_next_to_the_users_guide(self):
        d, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}").text)
        self.assertIn("den Notfallcode (ein Code auf dem Zugangsblatt, mit dem die Fakultät im Notfall den Zugang wiederherstellen kann", d)
        en, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}?lang=en").text)
        self.assertIn("the emergency code (a code on the access sheet", en)

    def test_help_links_say_who_they_are_for_and_the_lay_help_is_the_users_guide(self):
        d, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}").text)
        self.assertIn('href="/datastore/docs/users.de"', d)
        self.assertIn("(beide sind für Claude geschrieben, auf Englisch)", d)
        en, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}?lang=en").text)
        self.assertIn('href="/datastore/docs/users.en"', en)
        self.assertIn("(both are written for Claude, in English)", en)

    def test_mentions_of_the_expert_area_are_links_to_anchors_inside_it(self):
        page = self.a.get(f"/scopes/{self.scope}").text
        d, e = split_default_and_expert(page)
        self.assertNotIn("die Uhrzeit des Tests", d)                         # never pick a vault by time among the users' vaults
        for anchor in ("vaults", "limits", "admins"):
            self.assertIn(f'id="{anchor}"', e)
        self.assertNotIn('id="enrollment"', e)
        self.assertIn('<a href="#admins">Experteneinstellungen › Administratoren</a>', d)

    def test_the_page_script_opens_the_folded_area_for_a_link_into_it(self):
        page = self.a.get(f"/scopes/{self.scope}").text
        self.assertIn("function wdsOpen()", page)
        self.assertIn("window.addEventListener('hashchange',wdsOpen)", page)
        self.assertIn("closest('details')", page)
