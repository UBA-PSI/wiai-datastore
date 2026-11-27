"""Privacy page (Art. 13 GDPR), language switch, configuration of the dashboard."""

import html
import os
import re
import tempfile
import unittest

from wds_server.config import BACKUP_RETENTION_DE, BACKUP_RETENTION_EN, SandboxConfig, load_config

from .dash_helpers import DashCase
from .helpers import API, Env

DE_FACTS = [
    "Otto-Friedrich-Universität Bamberg, vertreten durch ihren Präsidenten", "Kapuzinerstraße 16, 96047 Bamberg",
    "praesident@uni-bamberg.de", "+49 951 863-1001",
    "Lehrstuhl für Privatsphäre und Sicherheit in Informationssystemen", "An der Weberei 5, 96047 Bamberg", "dh.psi@uni-bamberg.de",
    "Kapuzinerstraße 25, 96047 Bamberg", "datenschutzbeauftragter@uni-bamberg.de", "+49 951 863-1030",
    "Der Bayerische Landesbeauftragte für den Datenschutz", "Postfach 22 12 19, 80502 München", "Wagmüllerstraße 18, 80538 München",
    "poststelle@datenschutz-bayern.de", "+49 89 212672-0", "www.datenschutz-bayern.de",
    "Art. 6 Abs. 1 Buchst. e und Abs. 3 DSGVO", "Art. 4 Abs. 1 BayDSG",
    "api.pwnedpasswords.com", "Troy Hunt", "Cloudflare", "SHA-1", "USA", "Art. 11 DSGVO", "Art. 15 DSGVO", "(Art. 16)", "(Art. 17)",
    "(Art. 18)", "(Art. 21)", "Zugangskennung", "72 Stunden", "30 Tage", "7 Tage nach dem Anlegen", "2 nächtliche Kopien",
    "Treuhandschlüssel", "Die Fakultät kann den Inhalt jedes Tresors entschlüsseln", "eigene Datenschutzerklärung", "höchstens eine Stunde",
    "kein Protokoll", "1 Jahr", "keine Pflicht",
    "Passwortprüfung: Schutz Ihrer Daten", "Cloudflare, Inc. (USA)", "EU-US Data Privacy Framework", "Art. 45 DSGVO", "Datenübertragbarkeit (Art. 20",
    "Eine automatisierte Entscheidungsfindung einschließlich Profiling findet nicht statt", "__Host-wds_login", "Mit-Administrator eingetragen hat",
    "Innerhalb der Universität", "Der Betrieb sieht alle Apps", "abgewiesene Anmeldungsversuche",
]
EN_FACTS = [
    "Otto-Friedrich-Universität Bamberg, represented by its President", "Kapuzinerstraße 16, 96047 Bamberg", "+49 951 863-1001",
    "An der Weberei 5, 96047 Bamberg", "dh.psi@uni-bamberg.de", "datenschutzbeauftragter@uni-bamberg.de", "+49 951 863-1030",
    "BayLfD", "poststelle@datenschutz-bayern.de", "+49 89 212672-0", "Art. 6(1)(e) and (3) GDPR", "Art. 4(1) BayDSG",
    "api.pwnedpasswords.com", "Troy Hunt", "Cloudflare", "SHA-1", "USA", "Art. 11 GDPR", "Art. 15 GDPR", "72 hours", "30 days",
    "2 nightly copies", "escrow key", "The faculty can decrypt the content of every vault", "their own privacy notice", "at most one hour",
    "no log", "1 year", "under no obligation",
    "Password check: protecting your data", "Cloudflare, Inc. (USA)", "EU-US Data Privacy Framework", "Art. 45 GDPR", "data portability (Art. 20",
    "No automated decision-making, including profiling, takes place", "__Host-wds_login", "listed as co-admin", "Inside the university",
    "The operator sees all apps", "refused login attempts",
]


class PrivacySandboxSection(DashCase):
    config = {"sandbox": SandboxConfig(scope_id="sandbox-000000", wipe_time="04:10", timezone="UTC", create_window=7200)}

    def text(self, lang):
        return html.unescape(re.sub(r"<[^>]+>", "", self.browser().get("/privacy?lang=" + lang).text))

    def test_german(self):
        t = self.text("de")
        for needle in ("10. Testumgebung (Sandbox)", "ohne Beitrittscode einen Tresor anlegen", "Speichern Sie dort keine echten Daten",
                       "jede Nacht gelöscht, gegen 04:10 Uhr (UTC)", "kein Wiederherstellungsverfahren",
                       "Wiederherstellungsschlüssel der Fakultät (Abschnitt 4) auch Tresore der Testumgebung",
                       "keinen eigenen Schlüsselsatz", "IPv6-/56-Präfix", "höchstens 2 Stunden, nicht gespeichert",
                       "ohne IP-Adressen protokolliert"):
            self.assertIn(needle, t, needle)
        self.assertIn('href="#sandbox"', self.browser().get("/privacy?lang=de").text)

    def test_english(self):
        t = self.text("en")
        for needle in ("10. The sandbox", "without a join code", "Do not store real data there", "around 04:10 (UTC)",
                       "no recovery procedure in the sandbox", "also opens sandbox vaults",
                       "no separate key set", "IPv6 /56 prefix", "for at most 2 hours, not stored",
                       "logged without IP addresses"):
            self.assertIn(needle, t, needle)

    def test_section_is_absent_without_a_sandbox(self):
        self.env.config.sandbox = None
        for lang in ("de", "en"):
            self.assertNotIn("sandbox", self.browser().get("/privacy?lang=" + lang).text.lower())



class Privacy(DashCase):
    def test_german_is_the_default(self):
        r = self.browser().get("/privacy")
        self.assertEqual(r.status, 200)
        self.assertIn('<html lang="de">', r.text)
        self.assertEqual(r.headers["content-language"], "de")
        self.assertIn("Datenschutzhinweise (Art. 13 DSGVO)", r.text)
        text = re.sub(r"<[^>]+>", "", r.text)
        for fact in DE_FACTS:
            self.assertIn(fact, text, fact)

    def test_english_with_lang_parameter(self):
        r = self.browser().get("/privacy?lang=en")
        self.assertEqual(r.status, 200)
        self.assertIn('<html lang="en">', r.text)
        self.assertIn("Privacy notice (Art. 13 GDPR)", r.text)
        text = re.sub(r"<[^>]+>", "", r.text)
        for fact in EN_FACTS:
            self.assertIn(fact, text, fact)
        self.assertNotIn("Datenschutzhinweise", r.text)
        # the switch keeps the page and flips the language
        self.assertIn('href="/datastore/privacy?lang=de"', r.text)

    def test_breach_check_through_the_faculty_server_and_nothing_conditional(self):
        de = html.unescape(re.sub(r"<[^>]+>", "", self.browser().get("/privacy?lang=de").text))
        en = html.unescape(re.sub(r"<[^>]+>", "", self.browser().get("/privacy?lang=en").text))
        for needle in ("ersten 5 Zeichen einer Prüfsumme", "an den Server der Fakultät", "weder Ihre Passphrase noch Ihre IP-Adresse", "bis zu 24 Stunden"):
            self.assertIn(needle, de, needle)
        for needle in ("first 5 characters of a checksum", "to the faculty's server", "neither your passphrase nor your IP address", "up to 24 hours"):
            self.assertIn(needle, en, needle)
        for text in (de, en):
            for gone in ("Have I Been Pwned", "pro App abgeschaltet", "switched off per app", "Kontakt-E-Mail (optional)", "Contact e-mail (optional)",
                         "wds_expert", "über die Kontakt-E-Mail", "via the contact", "Wiederherstellungscode", "recovery code"):
                self.assertNotIn(gone, text, gone)
        self.assertIn("Notfallcode", de)
        self.assertIn("emergency code", en)

    def test_page_covers_both_groups_and_the_developer_section(self):
        text = re.sub(r"<[^>]+>", "", self.browser().get("/privacy").text)
        for needle in ("(a)", "(b)", "Gruppe a", "Gruppe b", "Hinweise für Entwicklerinnen und Entwickler"):
            self.assertIn(needle, text)

    def test_unknown_language_falls_back_to_german(self):
        self.assertIn('<html lang="de">', self.browser().get("/privacy?lang=fr").text)

    def test_no_login_needed_and_no_session_data_shown(self):
        r = self.browser().get("/privacy")
        self.assertNotIn("csrf", r.text)

    def test_backup_sentence_comes_from_one_config_value(self):
        de = self.browser().get("/privacy").text
        en = self.browser().get("/privacy?lang=en").text
        self.assertIn(BACKUP_RETENTION_DE, de)
        self.assertIn(BACKUP_RETENTION_EN, en)
        self.assertIn("Aufbewahrungsfrist wird festgelegt.", de)
        self.env.config.backup_retention_de = "VM-Sicherungen: 14 Tage <b>x</b>."
        self.env.config.backup_retention_en = "VM backups: 14 days."
        self.env.config.privacy_updated = "Stand-Testwert"
        de = self.browser().get("/privacy").text
        en = self.browser().get("/privacy?lang=en").text
        self.assertIn("VM-Sicherungen: 14 Tage &lt;b&gt;x&lt;/b&gt;.", de)
        self.assertNotIn(BACKUP_RETENTION_DE, de)
        self.assertIn("VM backups: 14 days.", en)
        self.assertIn("Stand: Stand-Testwert", de)
        self.assertIn("Last updated: Stand-Testwert", en)

    def test_no_hard_coded_date(self):
        text = re.sub(r"<[^>]+>", "", self.browser().get("/privacy").text)
        self.assertNotRegex(text, r"\b(19|20)\d\d\b")
        self.assertIn("Stand: wird festgelegt", text)

    def test_retention_figures_follow_the_server(self):
        self.env.config.session_idle = 3600
        self.env.config.session_absolute = 36000
        text = re.sub(r"<[^>]+>", "", self.browser().get("/privacy").text)
        self.assertIn("nach 1 Stunden ohne Aktivität oder spätestens nach 10 Stunden", text)

    def test_privacy_url_config_is_unchanged(self):
        scope = self.env.create_scope()
        self.assertEqual(self.c.get(f"{API}/scopes/{scope['scope']}").json()["privacy_url"], "https://wiai.uni-bamberg.de/datastore/privacy")
        self.env.config.privacy_url = "https://example.org/own-privacy"
        self.assertEqual(self.c.get(f"{API}/scopes/{scope['scope']}").json()["privacy_url"], "https://example.org/own-privacy")

    def test_footer_links_the_privacy_page_on_every_page(self):
        a = self.staff()
        scope = self.make_scope(a)
        for page in ("/", f"/scopes/{scope}", f"/scopes/{scope}/audit"):
            self.assertIn('<footer><a href="/datastore/privacy">', a.get(page).text, page)
        self.assertIn('<footer><a href="/datastore/privacy">', self.browser().get("/").text)
        self.assertIn('<footer><a href="/datastore/privacy?lang=en">', self.browser().get("/?lang=en").text)

    def test_privacy_is_not_cacheable_forever(self):
        self.assertEqual(self.browser().get("/privacy").headers["cache-control"], "no-cache")


class Language(DashCase):
    def test_default_is_german(self):
        r = self.browser().get("/")
        self.assertIn('<html lang="de">', r.text)
        self.assertIn("Anmeldung", r.text)

    def test_accept_language(self):
        for header, expected in (("en", "en"), ("en-US,en;q=0.9,de;q=0.8", "en"), ("de-DE,de;q=0.9,en;q=0.8", "de"),
                                 ("fr,en;q=0.5", "en"), ("fr", "de"), ("en;q=0.2,de;q=0.9", "de"), ("*", "de"), ("garbage;;q=x", "de"),
                                 ("en;q=0, de", "de")):
            r = self.browser().get("/", headers={"Accept-Language": header})
            self.assertIn(f'<html lang="{expected}">', r.text, header)

    def test_query_parameter_wins_over_header(self):
        r = self.browser().get("/?lang=de", headers={"Accept-Language": "en"})
        self.assertIn('<html lang="de">', r.text)
        r = self.browser().get("/?lang=en", headers={"Accept-Language": "de"})
        self.assertIn('<html lang="en">', r.text)
        self.assertIn("Sign in with your university ID", r.text)

    def test_language_is_kept_in_links_and_forms_once_chosen(self):
        a = self.staff()
        scope = self.make_scope(a)
        html = a.get(f"/scopes/{scope}?lang=en").text
        self.assertIn(f'action="/datastore/scopes/{scope}/settings?lang=en"', html)
        self.assertIn('href="/datastore/?lang=en"', html)
        r = a.post(f"/scopes/{scope}/settings?lang=en", {"name": "X", "contact_email": "x@uni-bamberg.de"})
        self.assertEqual(r.status, 303)
        self.assertIn("lang=en", r.headers["location"])
        self.assertIn("Saved.", a.get(r.headers["location"]).text)
        self.assertIn("Gespeichert.", a.get(r.headers["location"].replace("lang=en", "lang=de")).text)
        # without an explicit choice the links stay clean
        plain = a.get(f"/scopes/{scope}").text
        self.assertIn(f'action="/datastore/scopes/{scope}/settings"', plain)
        self.assertIn('<a class="brand" href="/datastore/">', plain)

    def test_language_switch_links(self):
        html = self.browser().get("/?lang=en").text
        self.assertIn('hreflang="de" href="/datastore/?lang=de"', html)
        self.assertIn("<strong>English</strong>", html)
        html = self.browser().get("/").text
        self.assertIn('hreflang="en" href="/datastore/?lang=en"', html)

    def test_dashboard_pages_exist_in_both_languages(self):
        a = self.staff()
        scope = self.make_scope(a)
        op = self.operator()
        pages = [(a, "/"), (a, f"/scopes/{scope}"), (a, f"/scopes/{scope}/audit"), (op, "/operator"), (op, "/operator/audit")]
        for who, page in pages:
            de = who.get(page + "?lang=de").text
            en = who.get(page + "?lang=en").text
            self.assertNotEqual(re.sub(r"<[^>]+>", "", de), re.sub(r"<[^>]+>", "", en), page)
            self.assertIn('lang="de"', de)
            self.assertIn('lang="en"', en)

    def test_every_text_has_both_languages(self):
        from wds_server.texts import TEXTS
        for key, (de, en) in TEXTS.items():
            self.assertTrue(de.strip() and en.strip(), key)
            self.assertNotEqual(de, en, key) if len(de) > 12 else None
            self.assertEqual(sorted(re.findall(r"\{(\w+)\}", de)), sorted(re.findall(r"\{(\w+)\}", en)), key)

    def test_every_key_used_in_the_code_exists(self):
        from wds_server.texts import TEXTS
        here = os.path.dirname(os.path.dirname(__file__))
        source = ""
        for f in ("dashboard.py", "ui.py"):
            with open(os.path.join(here, "wds_server", f), encoding="utf-8") as fh:
                source += fh.read()
        used = set(re.findall(r"\bt\(\"([a-z_0-9]+)\"", source)) | set(re.findall(r"DashError\(\d+, \"([a-z_]+)\"", source))
        for key in used:
            if not key.endswith("_"):  # "enroll_" + name and similar families are checked below
                self.assertIn(key, TEXTS, key)
        families = {"escrow_": ["current", "spare", "other"],
                    "lim_": ["max_value_bytes", "vault_bytes", "scope_bytes", "max_vaults", "history_versions"],
                    "notice_": ["created", "saved", "code_rotated", "admin_added", "admin_removed", "vault_deleted",
                                "suspended", "resumed", "blocked", "unblocked"],
                    "role_": ["creator", "admin"],
                    "login_failed_": ["unreadable", "wrong_browser", "expired", "replayed", "no_username"],
                    "login_denied_": ["blocked", "not_allowed"]}
        for prefix, names in families.items():
            for n in names:
                self.assertIn(prefix + n, TEXTS, prefix + n)

    def test_german_uses_sie(self):
        from wds_server.texts import TEXTS
        for key, (de, _) in TEXTS.items():
            self.assertNotRegex(de, r"\b(Du|Dein\w*|Dich|Dir|du|dein\w*|dich|dir)\b", key)


class ConfigFile(unittest.TestCase):
    def load(self, text):
        with tempfile.NamedTemporaryFile("w", suffix=".ini", delete=False) as fh:
            fh.write(text)
        try:
            return load_config(fh.name)
        finally:
            os.unlink(fh.name)

    def test_defaults(self):
        cfg = load_config(None)
        self.assertEqual((cfg.loginpsi_key_file, cfg.loginpsi_app, cfg.loginpsi_url), (None, "wiai-datastore", "https://login.psi.uni-bamberg.de"))
        self.assertEqual((cfg.operators, cfg.dev_login, cfg.privacy_updated), ([], False, None))
        self.assertEqual((cfg.backup_retention_de, cfg.backup_retention_en), (BACKUP_RETENTION_DE, BACKUP_RETENTION_EN))
        self.assertEqual(BACKUP_RETENTION_DE, "Sicherungen der virtuellen Maschine: Aufbewahrungsfrist wird festgelegt.")

    def test_sections(self):
        cfg = self.load("""
[loginpsi]
key_file = /etc/wiai-datastore/loginpsi.key
app = other
url = https://login.example.org/

[dashboard]
operators = Boss  ops@Uni-Bamberg.de
dev_login = true
session_idle = 600
session_absolute = 7200

[privacy]
updated = Stand X
backup_retention_de = Aufbewahrung 14 Tage.
backup_retention_en = Retention 14 days.
""")
        self.assertEqual((cfg.loginpsi_key_file, cfg.loginpsi_app, cfg.loginpsi_url),
                         ("/etc/wiai-datastore/loginpsi.key", "other", "https://login.example.org"))
        self.assertEqual(cfg.operators, ["boss", "ops@uni-bamberg.de"])
        self.assertTrue(cfg.dev_login)
        self.assertEqual((cfg.session_idle, cfg.session_absolute), (600, 7200))
        self.assertEqual((cfg.privacy_updated, cfg.backup_retention_de, cfg.backup_retention_en),
                         ("Stand X", "Aufbewahrung 14 Tage.", "Retention 14 days."))

    def test_breach_check_settings(self):
        d = load_config(None)
        self.assertEqual((d.pwned_url, d.rate_pwned, d.rate_pwned_window), ("https://api.pwnedpasswords.com/range/", 120, 60))
        c = self.load("[server]\npwned_url = http://127.0.0.1:9/range\n[ratelimit]\npwned = 5\npwned_window = 10\n")
        self.assertEqual((c.pwned_url, c.rate_pwned, c.rate_pwned_window), ("http://127.0.0.1:9/range/", 5, 10))
        self.assertEqual(self.load("[server]\npwned_url =\n").pwned_url, "")          # switched off
        from .helpers import escrow_sets
        bad = self.load("[server]\npwned_url = ftp://x/\n")
        bad.escrow = escrow_sets()
        with self.assertRaises(ValueError):
            bad.validate()

    def test_dev_login_needs_an_explicit_true(self):
        for value, expected in (("false", False), ("", False), ("no", False), ("yes", True), ("1", True), ("TRUE", True)):
            self.assertEqual(self.load(f"[dashboard]\ndev_login = {value}\n").dev_login, expected, value)

    def test_session_timeouts_are_validated(self):
        from .helpers import escrow_sets
        cfg = self.load("[dashboard]\nsession_idle = 30\n")
        cfg.escrow = escrow_sets()
        with self.assertRaises(ValueError):
            cfg.validate()
