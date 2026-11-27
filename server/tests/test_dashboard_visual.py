"""Dashboard readability: local time and number formats, plain-language audit entries, cards on narrow screens, errors next to
the field they belong to; and the privacy page's "Stand" line in the page language only."""

import re

from wds_server.ui import fmt_bytes, fmt_number, fmt_time

from .dash_helpers import DashCase


class Formats(DashCase):
    def test_times_are_local_and_in_the_language_of_the_page(self):
        # 2026-11-24 22:42:00 UTC is 23:42 in Berlin (CET)
        ts = 1795560120
        self.assertEqual(fmt_time(ts, "de"), "24.11.2026, 23:42")
        self.assertEqual(fmt_time(ts, "en"), "24 Nov 2026, 23:42")
        # summer time
        self.assertEqual(fmt_time(1782900000, "de"), "01.07.2026, 12:00")
        self.assertEqual(fmt_time(None, "de"), "–")
        self.assertNotIn("UTC", fmt_time(ts, "de"))

    def test_numbers_follow_the_language(self):
        self.assertEqual(fmt_number(10.0, "de"), "10,0")
        self.assertEqual(fmt_number(10.0, "en"), "10.0")
        self.assertEqual(fmt_bytes(10 * 1048576, "de"), "10,0 MB")
        self.assertEqual(fmt_bytes(10 * 1048576, "en"), "10.0 MB")
        self.assertEqual(fmt_bytes(512, "de"), "512 B")


class Tables(DashCase):
    def test_every_cell_has_its_column_title_for_the_card_layout(self):
        a = self.staff()
        scope = self.make_scope(a)
        html = a.get(f"/scopes/{scope}").text
        self.assertIn('<td data-label="Kennung / E-Mail">', html)
        self.assertRegex(html, r'<td data-label="Höchstwert" class="num">')
        self.assertIn(".scroll td::before{content:attr(data-label)", html)          # the narrow-screen rule is in the page
        self.assertNotRegex(html, r"<td(?![^>]*data-label)")                        # no cell without a title

    def test_audit_in_words_with_a_wrapping_details_column(self):
        a = self.staff()
        scope = self.make_scope(a)
        with self.env.svc.db.connection() as conn:   # written by the operator's command line (wds_server.cli limits)
            self.env.svc.audit(conn, "cli", "limits_updated", scope, None, "max_value_bytes=5242880,vault_bytes=default")
        html = a.get(f"/scopes/{scope}/audit").text
        self.assertIn("Grenzen geändert", html)
        self.assertIn("Größte Datei bzw. größter Eintrag: 5,0 MB", html)
        self.assertIn("Standard", html)
        self.assertNotIn("max_value_bytes=", html)
        self.assertIn('class="wrap"', html)
        en = a.get(f"/scopes/{scope}/audit?lang=en").text
        self.assertIn("Limits changed", en)
        self.assertIn("Largest file or entry: 5.0 MB", en)
        self.assertIn("default", en)
        self.assertIn("Zeiten in Ortszeit", html)


class FieldErrors(DashCase):
    def test_invalid_admin_is_reported_next_to_the_field(self):
        a = self.staff()
        scope = self.make_scope(a)
        r = a.post(f"/scopes/{scope}/admins", {"admin": "not valid!"})
        self.assertEqual(r.status, 400)
        html = r.text
        self.assertIn("Das ist keine gültige Uni-Kennung oder E-Mail-Adresse.", html)
        # inside the admins form, after the input, which keeps what was typed and is marked invalid
        form = re.search(r'<form method="post" action="[^"]*/admins">.*?</form>', html, re.S).group(0)
        self.assertIn('id="admin-err"', form)
        self.assertIn("Das ist keine gültige", form)
        self.assertIn('value="not valid!"', form)
        self.assertIn('aria-invalid="true"', form)
        self.assertEqual(html.count("Das ist keine gültige"), 1)                      # and not at the top of the page, too
        en = a.post(f"/scopes/{scope}/admins?lang=en", {"admin": "not valid!"}).text
        self.assertIn("This is not a valid university ID or e-mail address.", en)

    def test_create_error_is_inside_the_create_form(self):
        a = self.staff()
        r = a.post("/scopes", {"name": "App", "contact_email": "not-an-address"})
        self.assertEqual(r.status, 400)
        form = re.search(r'<form method="post" action="[^"]*/scopes">.*?</form>', r.text, re.S).group(0)
        self.assertIn('id="create-err"', form)

    def test_operator_block_error_is_next_to_the_field(self):
        op = self.operator()
        r = op.post("/operator/block", {"username": "no good!"})
        self.assertEqual(r.status, 400)
        form = re.search(r'<form method="post" action="[^"]*/operator/block">.*?</form>', r.text, re.S).group(0)
        self.assertIn('id="block-err"', form)


class Privacy(DashCase):
    def line(self, lang):
        text = re.sub(r"<[^>]+>", "", self.browser().get("/privacy?lang=" + lang).text)
        return re.search(r"(Stand|Last updated): ([^\n]*)", text).group(2).strip()

    def test_stand_line_is_in_the_page_language_only(self):
        cfg = self.env.config
        cfg.privacy_updated = "Entwurf, Prüfung steht aus / Draft, review pending"
        self.assertEqual(self.line("de"), "Entwurf, Prüfung steht aus")
        self.assertEqual(self.line("en"), "Draft, review pending")
        cfg.privacy_updated = "Version 3"                                              # one value: both languages
        self.assertEqual(self.line("de"), "Version 3")
        self.assertEqual(self.line("en"), "Version 3")
        cfg.privacy_updated_de, cfg.privacy_updated_en = "Geprüft von Frau X", "Reviewed by Ms X"   # explicit values win
        self.assertEqual(self.line("de"), "Geprüft von Frau X")
        self.assertEqual(self.line("en"), "Reviewed by Ms X")
