"""Dashboard for people who are not developers: the default create form, the default view of a scope with the expert area folded
away, the remembered expert choice, the plain-language texts, sizes in MB, and the help contact."""

import html as htmllib
import os
import re
import tempfile
import urllib.parse

from wds_server import prompt as prompt_mod
from wds_server.config import SandboxConfig, load_config
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
        self.assertEqual(values["contact_email"], "alice@uni-bamberg.de")   # prefilled with the person's own address
        self.assertEqual((values["enrollment"], values["hibp"], values["slug"]), ("join_code", "1", ""))
        values["name"] = "Notenrechner"
        r = a.post("/scopes", values)
        self.assertEqual(r.status, 303)
        scope = r.headers["location"].split("?")[0].rsplit("/", 1)[1]
        row = self.row(scope)
        self.assertEqual((row["enrollment"], row["hibp"], row["contact_email"], row["limits"]), ("join_code", 1, "alice@uni-bamberg.de", "{}"))
        self.assertRegex(row["join_code"], r"^[0-9A-Z]{8}$")
        self.assertTrue(scope.startswith("notenrechner-"))
        limits = self.env.svc.scope_limits(row)
        self.assertEqual(limits["max_vaults"], self.env.config.limit_defaults["max_vaults"])   # the server defaults, nothing stored

    def test_slug_enrollment_and_breach_check_are_inside_the_collapsed_part(self):
        a = self.staff()
        home = a.get("/").text
        outside, rest = home.split('<details class="expert" id="create-more">', 1)
        inside = rest.split("</details>", 1)[0]
        for field in ('id="c_slug"', 'id="c_enroll"', 'id="c_hibp"'):
            self.assertNotIn(field, outside)
            self.assertIn(field, inside)
        for field in ('id="c_name"', 'id="c_mail"', 'id="c_desc"'):
            self.assertIn(field, outside)
        self.assertNotIn("<details class=\"expert\" id=\"create-more\" open", home)
        self.assertIn("Weitere Einstellungen (für Fachleute)", home)

    def test_defaults_sentence_names_the_values_and_the_us_service(self):
        a = self.staff()
        text = htmllib.unescape(re.sub(r"<[^>]+>", "", a.get("/").text))
        self.assertIn("Standard für neue Apps: Tresore nur mit Beitrittscode (ein Code, den Sie an Ihre Nutzenden weitergeben;", text)   # the terms are explained where they first appear
        self.assertIn("Pwned Passwords in den USA", text)           # the transfer is named in the visible sentence
        self.assertIn("Jede Person bekommt einen Tresor mit 200 MB Speicher. Einzelne Dateien dürfen bis 10 MB groß sein, von jedem Eintrag bleiben 10 frühere Versionen erhalten. Höchstens 50 Tresore, also 50 Personen.", text)
        en = htmllib.unescape(re.sub(r"<[^>]+>", "", a.get("/?lang=en").text))
        self.assertIn("Default for new apps: vaults only with a join code (a code that you give to your users;", en)
        self.assertIn("a vault with 200 MB of storage. Single files may be up to 10 MB; 10 earlier versions of every entry are kept.", en)

    def test_the_expert_fields_still_work(self):
        a = self.staff()
        values = form_defaults(a.get("/").text, "/scopes")
        values.update({"name": "Offene App", "slug": "offen", "enrollment": "open"})
        del values["hibp"]                                             # the box unticked
        scope = a.post("/scopes", values).headers["location"].split("?")[0].rsplit("/", 1)[1]
        row = self.row(scope)
        self.assertTrue(scope.startswith("offen-"))
        self.assertEqual((row["enrollment"], row["hibp"], row["join_code"]), ("open", 0, None))

    def test_an_error_in_an_expert_field_opens_the_collapsed_part(self):
        a = self.staff()
        r = a.post("/scopes", {"name": "App", "slug": "Bad Slug!", "contact_email": "a@uni-bamberg.de", "enrollment": "join_code", "hibp": "1"})
        self.assertEqual(r.status, 400)
        self.assertIn('<details class="expert" id="create-more" open>', r.text)
        self.assertIn("Bad Slug!", r.text)
        r = a.post("/scopes", {"name": "App", "contact_email": "not-an-address", "enrollment": "join_code", "hibp": "1"})   # an error elsewhere keeps it closed
        self.assertEqual(r.status, 400)
        self.assertNotIn('id="create-more" open', r.text)
        self.assertIn('value="not-an-address"', r.text)                  # what was typed stays; no prefill over it

    def test_expert_cookie_opens_the_collapsed_part(self):
        a = self.staff()
        a.post("/prefs/expert", {"on": "1", "next": "/datastore/"})
        self.assertIn('<details class="expert" id="create-more" open>', a.get("/").text)


class ExpertPreference(DashCase):
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

    def test_remember_sets_a_cookie_and_opens_the_area_afterwards(self):
        r = self.a.post("/prefs/expert", {"on": "1", "next": f"/datastore/scopes/{self.scope}"})
        self.assertEqual(r.status, 303)
        self.assertEqual(r.headers["location"], f"/datastore/scopes/{self.scope}#expert")
        raw = next(c for c in self.a.raw_cookies if c.startswith("wds_expert="))
        for part in ("wds_expert=1", "Path=/", "SameSite=Strict", "HttpOnly", "Secure", "Max-Age=31536000"):
            self.assertIn(part, raw)
        self.assertTrue(self.state(self.a))
        r = self.a.post("/prefs/expert", {"on": "0", "next": f"/datastore/scopes/{self.scope}"})   # forget
        self.assertEqual(r.status, 303)
        self.assertNotIn("wds_expert", self.a.cookies)
        self.assertFalse(self.state(self.a))

    def test_the_button_offers_the_other_direction(self):
        page = self.a.get(f"/scopes/{self.scope}").text
        self.assertIn("Experteneinstellungen immer aufgeklappt zeigen", page)
        self.assertIn('name="on" value="1"', page)
        self.a.post("/prefs/expert", {"on": "1", "next": "/datastore/"})
        page = self.a.get(f"/scopes/{self.scope}").text
        self.assertIn("Experteneinstellungen wieder zuklappen", page)
        self.assertIn('name="on" value="0"', page)

    def test_csrf_and_login_are_required(self):
        r = self.a.post("/prefs/expert", {"on": "1", "next": "/datastore/", "csrf": "wrong"}, csrf=False)
        self.assertEqual(r.status, 403)
        self.assertNotIn("wds_expert", self.a.cookies)
        r = self.a.post("/prefs/expert", {"on": "1", "next": "/datastore/"}, csrf=False)
        self.assertEqual(r.status, 403)
        self.assertEqual(self.browser().post("/prefs/expert", {"on": "1"}).status, 401)
        self.assertEqual(self.a.post("/prefs/expert", {"on": "1"}, headers={"Origin": "https://evil.example"}).status, 403)

    def test_next_is_a_local_path_below_the_dashboard(self):
        for bad in ("https://evil.example/", "//evil.example/", "/elsewhere", "/datastore/../x", "javascript:alert(1)", "/datastore//evil.example"):
            r = self.a.post("/prefs/expert", {"on": "1", "next": bad})
            self.assertEqual(r.status, 303, bad)
            self.assertEqual(r.headers["location"], "/datastore/#expert", bad)

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
        r = self.a.post(f"/scopes/{self.scope}/limits", {"max_vaults": "20"})
        page = self.a.get(r.headers["location"]).text
        self.assertRegex(page, r'<details class="expert" id="expert" open>')
        self.assertIn("Grenzen gespeichert", page)
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
        for needle in ("/settings", "/limits", "/admins", "/enrollment", "/delete", "/suspend", 'id="tag"', 'id="claude-md"', "integrity=\"sha384"):
            self.assertNotIn(needle, d.replace("&lt;script", ""), needle)
        self.assertNotIn("<table", d)
        for needle in ("/settings", "/limits", "/admins", "/enrollment", "/suspend", "/delete", 'id="tag"', 'id="claude-md"', "Wiederherstellungsschlüssel"):
            self.assertIn(needle, self.expert, needle)
        # the rotate button stays in the default view: a leaked code has to be replaced without opening anything
        self.assertIn(f"/scopes/{self.scope}/join-code", d)
        self.assertNotIn(f"/scopes/{self.scope}/join-code", self.expert)

    def test_expert_area_labels_and_headings(self):
        e = self.expert
        self.assertIn("<summary>Experteneinstellungen</summary>", e)
        self.assertIn("Für Fachleute: Einstellungen, die die meisten Apps nicht brauchen.", e)
        for heading in ("Angaben zur App", "Anlegen von Tresoren", "Speicherplatz und Grenzen", "Administratoren", "Tresore", "Änderungsprotokoll", "App pausieren", "App löschen"):
            self.assertIn(f">{heading}</h3>", e.replace(' id="admins"', "").replace(' id="vaults"', "").replace(' id="enrollment"', "").replace(' id="limits"', ""), heading)
        self.assertNotRegex(e, r"<h2")                                  # the area has h3 and h4 only: heading order stays
        self.assertIn("Höchstzahl der Tresore", e)
        self.assertIn("Personen mit Zugang", e)
        self.assertIn("Neu verschlüsseln läuft noch", e)
        self.assertIn("Größen in MB (1 MB = 1.048.576 Bytes)", e)
        for label in ("s_name", "s_desc", "s_mail", "s_hibp", "e_mode", "l_max_vaults", "a_new", "d_conf"):
            self.assertIn(f'for="{label}"', e)
        visible = re.sub(r"<pre.*?</pre>|<style.*?</style>|<script.*?</script>|<[^>]+>", "", self.page, flags=re.S)   # the prompt for Claude may say "Scope"
        self.assertNotIn("Scope", visible)
        self.assertNotIn("MiB", self.page)

    def test_open_and_closed_enrollment_have_a_sentence_instead_of_a_code(self):
        self.a.post(f"/scopes/{self.scope}/enrollment", {"enrollment": "open"})
        d, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}").text)
        self.assertIn("Jede Person, die die App hat, kann einen Tresor anlegen (höchstens 50).", d)
        self.assertNotIn('id="jc"', d)
        self.a.post(f"/scopes/{self.scope}/enrollment", {"enrollment": "closed"})
        d, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}").text)
        self.assertIn("Zurzeit können keine neuen Tresore angelegt werden.", d)

    def test_usage_counts_active_vaults_and_warns_near_the_limit(self):
        self.a.post(f"/scopes/{self.scope}/enrollment", {"enrollment": "open"})
        self.a.post(f"/scopes/{self.scope}/limits", {"max_vaults": "5"})
        vaults = [self.env.new_vault({"scope": self.scope, "join_code": None}) for _ in range(4)]
        vaults[0].put_ok("rec", size=2000)
        d, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}").text)
        self.assertRegex(d, r"4 von 5 Tresoren angelegt, zusammen [\d,]+ KB von 2,0 GB Speicher belegt")
        self.assertIn("Die App ist bald voll", d)
        self.a.post(f"/scopes/{self.scope}/vaults/{vaults[1].vault}/delete", {})
        d, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}").text)
        self.assertIn("3 von 5 Tresoren", d)                           # a deleted vault does not count
        self.assertNotIn("Die App ist bald voll", d)

    def test_paused_app_shows_the_badge_and_the_way_back_in_the_default_view(self):
        self.a.post(f"/scopes/{self.scope}/suspend", {})
        page = self.a.get(f"/scopes/{self.scope}").text
        d, e = split_default_and_expert(page)
        self.assertIn("pausiert (durch Sie oder Mit-Administratoren)", d)
        self.assertIn(f"/scopes/{self.scope}/resume", d)
        self.assertIn("Pause beenden", d)
        self.assertNotIn(f"/scopes/{self.scope}/suspend", d + e)
        en = self.a.get(f"/scopes/{self.scope}?lang=en").text
        self.assertIn("paused (by you or a co-admin)", en)
        self.assertIn("End pause", en)

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
    def prompt(self, lang, **over):
        a = self.staff(lang_header=lang)
        scope = self.make_scope(a, name="Demo", **over)
        return html_pre(a.get(f"/scopes/{scope}").text, "prompt"), html_pre(a.get(f"/scopes/{scope}").text, "claude-md")

    def test_breach_check_sentence_is_in_the_prompt_iff_the_check_is_on(self):
        for lang in ("en", "de"):
            on, snippet = self.prompt(lang)
            self.assertIn(prompt_mod.HIBP_EN, on)
            self.assertIn(prompt_mod.HIBP_DE, on)
            self.assertIn(prompt_mod.PRIVACY_EN, on)                          # the official sentence stays word for word
            self.assertIn(prompt_mod.PRIVACY_DE, on)
            self.assertLess(on.index(prompt_mod.PRIVACY_DE), on.index(prompt_mod.HIBP_DE))    # right after it
            self.assertIn("https://api.pwnedpasswords.com", on)               # the CSP line stays
            off, _ = self.prompt(lang, hibp="")
            self.assertNotIn(prompt_mod.HIBP_EN, off)
            self.assertNotIn(prompt_mod.HIBP_DE, off)
            self.assertNotIn("Pwned Passwords", off)
            self.assertNotIn("Pwned", snippet)                                # the snippet carries no setting

    def test_the_two_languages_of_the_sentence_say_the_same_things(self):
        for text in (prompt_mod.HIBP_EN, prompt_mod.HIBP_DE):
            self.assertIn("Pwned Passwords", text)
            self.assertIn("USA", text)
        self.assertIn("five characters of a checksum", prompt_mod.HIBP_EN)
        self.assertIn("fünf Zeichen einer Prüfsumme", prompt_mod.HIBP_DE)

    def test_porting_and_the_join_code_file(self):
        for lang in ("en", "de"):
            text, snippet = self.prompt(lang)
            self.assertIn("/docs/porting.md", text)
            self.assertIn("store.migrateLocal", text)
            self.assertIn("~/.wds/join-code", text)
            self.assertNotIn("WDS_JOIN_CODE", text + snippet)
            self.assertNotIn("MiB", text)
            self.assertIn("/docs/porting.md", snippet)
            self.assertIn("store.migrateLocal", snippet)
        text, _ = self.prompt("en", enrollment="open")
        self.assertNotIn("join-code", text)                                   # no code, no file

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
    NEW_KEYS = ("create_defaults", "create_more", "f_description_hint", "sid_hint", "vault_explain", "who_reads", "expert_title", "expert_hint",
                "expert_remember", "expert_forget", "expert_remember_hint", "next_steps", "step_prompt", "step_code", "step_code_open",
                "step_code_closed", "step_users", "step_users_hint", "users_doc", "usage_title", "usage_text", "usage_near", "test_vault_hint",
                "help_title", "help_text", "help_contact", "join_code_test_hint")

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
        sandbox_or_operator = {"sandbox_readonly", "err_sandbox_config", "sandbox_admins", "global_hint", "dev_hint", "act_scope_locked"}
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
        self.assertIn("nie die Passphrase", de["f_hibp_hint"])                                              # Datenlecks-Prüfung
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

    def test_privacy_page_names_the_display_cookie(self):
        for lang, word in (("de", "wds_expert"), ("en", "wds_expert")):
            self.assertIn(word, self.browser().get("/privacy?lang=" + lang).text)


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
        self.assertIn("Claude bittet Sie vielleicht um Hilfe bei einem freiwilligen Test und erklärt Ihnen jeden Schritt.", d)
        self.assertIn("Sie müssen den Text nicht verstehen; Claude liest ihn.", d)
        en, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}?lang=en").text)
        self.assertIn("Claude may ask you for help with an optional test and explains every step.", en)
        self.assertNotIn("against this app", en)                            # "your app" and "this app" were both called app

    def test_the_recovery_code_is_explained_next_to_the_users_guide(self):
        d, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}").text)
        self.assertIn("den Wiederherstellungscode (ein Code auf dem Zugangsblatt, mit dem die Fakultät im Notfall den Zugang wiederherstellen kann", d)

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
        self.assertIn('<a href="#vaults">Experteneinstellungen › Tresore</a>', d)
        self.assertIn("Kennung = erste Spalte der Tabelle", d)
        self.assertIn("Claude löscht ihn selbst und nennt Ihnen dessen Kennung.", d)
        self.assertNotIn("die Uhrzeit des Tests", d)                         # never pick a vault by time among the users' vaults
        for anchor in ("vaults", "limits", "enrollment", "admins"):
            self.assertIn(f'id="{anchor}"', e)
        self.a.post(f"/scopes/{self.scope}/enrollment", {"enrollment": "closed"})
        d2, _ = split_default_and_expert(self.a.get(f"/scopes/{self.scope}").text)
        self.assertIn('<a href="#enrollment">Experteneinstellungen › Anlegen von Tresoren</a>', d2)

    def test_the_page_script_opens_the_folded_area_for_a_link_into_it(self):
        page = self.a.get(f"/scopes/{self.scope}").text
        self.assertIn("function wdsOpen()", page)
        self.assertIn("window.addEventListener('hashchange',wdsOpen)", page)
        self.assertIn("closest('details')", page)
