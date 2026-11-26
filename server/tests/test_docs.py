"""Documentation routes (docs.py): llms.txt, rendered and raw Markdown, export page, placeholders, renderer."""

import hashlib
import json
import os
import re
import tempfile
import unittest
from base64 import b64encode
from pathlib import Path

from wds_server import docs
from wds_server.config import load_config

from .helpers import API, Env, ServerTestCase

REPO_DOCS = Path(__file__).resolve().parents[2] / "docs" / "site"


def write(path, text):
    Path(path).write_text(text, encoding="utf-8")


class DocsTestCase(ServerTestCase):
    def setUp(self):
        self.docs_dir = tempfile.mkdtemp(prefix="wds-docs-")
        self.env_kwargs = {"config_overrides": {"docs_dir": self.docs_dir, "public_base": "https://example.test/datastore"}}
        super().setUp()
        self.dist = self.env.config.client_dir

    def tearDown(self):
        super().tearDown()
        import shutil
        shutil.rmtree(self.docs_dir, ignore_errors=True)

    def lib(self, version="1.2.3", body=b"console.log(1)", hashes=True, sri_file=False):
        with open(os.path.join(self.dist, f"wds-{version}.js"), "wb") as fh:
            fh.write(body)
        digest = "sha384-" + b64encode(hashlib.sha384(body).digest()).decode()
        if hashes:
            with open(os.path.join(self.dist, "hashes.json"), "w") as fh:
                json.dump({version: {"file": f"wds-{version}.js", "sri": digest, "frozen": False}}, fh)
        if sri_file:
            with open(os.path.join(self.dist, f"wds-{version}.js.sri"), "w") as fh:
                fh.write(digest)
        return digest


class Routes(DocsTestCase):
    def test_llms_txt_is_plain_text_with_placeholders_filled(self):
        digest = self.lib()
        write(os.path.join(self.docs_dir, "llms.txt"), "# T\nbase {{base}} v {{version}} {{unknown}}\n")
        r = self.c.get("/datastore/llms.txt")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.headers["content-type"], "text/plain; charset=utf-8")
        self.assertEqual(r.text, "# T\nbase https://example.test/datastore v 1.2.3 {{unknown}}\n")
        self.assertEqual(r.headers["x-content-type-options"], "nosniff")
        self.assertEqual(r.headers["cache-control"], "no-cache")
        self.assertNotIn(digest, r.text)

    def test_raw_markdown_and_html(self):
        digest = self.lib()
        write(os.path.join(self.docs_dir, "integration.md"),
              "# Guide\n\n" + "{{script_tag}}\n\nUse **this** <b>raw</b> and `code`.\n")
        raw = self.c.get("/datastore/docs/integration.md")
        self.assertEqual(raw.status, 200)
        self.assertEqual(raw.headers["content-type"], "text/markdown; charset=utf-8")
        self.assertIn('<script src="https://example.test/datastore/client/wds-1.2.3.js" integrity="' + digest + '"', raw.text)
        self.assertIn('crossorigin="anonymous"', raw.text)
        page = self.c.get("/datastore/docs/integration")
        self.assertEqual(page.status, 200)
        self.assertIn("text/html", page.headers["content-type"])
        self.assertIn("<title>Guide - WIAI Datastore</title>", page.text)
        self.assertIn('<h1 id="guide">Guide</h1>', page.text)
        self.assertIn("&lt;b&gt;raw&lt;/b&gt;", page.text)  # raw HTML in Markdown is escaped
        self.assertIn("<strong>this</strong>", page.text)
        self.assertIn("<code>code</code>", page.text)
        self.assertIn("&lt;script src=", page.text)  # the tag is shown as text, not executed
        self.assertNotIn("<script", page.text)
        self.assertIn("default-src 'none'", page.headers["content-security-policy"])
        self.assertNotIn("script-src", page.headers["content-security-policy"])

    def test_language_of_german_pages(self):
        self.lib()
        write(os.path.join(self.docs_dir, "users.de.md"), "# Nutzung\n\nText\n")
        self.assertIn('<html lang="de">', self.c.get("/datastore/docs/users.de").text)
        self.assertEqual(self.c.get("/datastore/docs/users.de.md").status, 200)

    def test_navigation_speaks_the_language_of_the_page(self):
        self.lib()
        write(os.path.join(self.docs_dir, "users.de.md"), "# Nutzung\n\nText\n")
        write(os.path.join(self.docs_dir, "users.en.md"), "# Usage\n\nText\n")
        de = self.c.get("/datastore/docs/users.de").text
        self.assertIn(">Dokumentation</a>", de)
        self.assertIn(">Markdown-Quelltext</a>", de)
        self.assertNotIn(">Documentation</a>", de)
        en = self.c.get("/datastore/docs/users.en").text
        self.assertIn(">Documentation</a>", en)
        self.assertIn(">Markdown</a>", en)

    def test_unknown_and_unsafe_names_are_404(self):
        write(os.path.join(self.docs_dir, "secret.txt"), "x")
        write(os.path.join(self.docs_dir, "a.md"), "# A\n")
        for name in ("nope", "nope.md", "..%2Fsecret.txt", "%2e%2e%2fconfig", "a.md.md", "A", "a..b", ".md", "secret.txt", "a%00.md"):
            r = self.c.get("/datastore/docs/" + name)
            self.assertEqual(r.status, 404, name)
        self.assertEqual(self.c.get("/datastore/docs/a").status, 200)
        # a directory with an .md name is not a document
        os.mkdir(os.path.join(self.docs_dir, "dir.md"))
        self.assertEqual(self.c.get("/datastore/docs/dir").status, 404)

    def test_missing_files_are_404(self):
        self.assertEqual(self.c.get("/datastore/llms.txt").status, 404)
        self.assertEqual(self.c.get("/datastore/export/").status, 404)

    def test_index_lists_documents(self):
        write(os.path.join(self.docs_dir, "integration.md"), "# Integration **guide**\n")
        write(os.path.join(self.docs_dir, "operator.md"), "# Operator\n")
        r = self.c.get("/datastore/docs/")
        self.assertEqual(r.status, 200)
        self.assertIn('href="https://example.test/datastore/docs/integration"', r.text)
        self.assertIn("Integration guide", r.text)
        self.assertIn("operator.md", r.text)
        self.assertEqual(self.c.get("/datastore/docs").status, 308)
        self.assertEqual(self.c.get("/datastore/docs").headers["location"], "/datastore/docs/")
        self.assertEqual(self.c.get("/datastore/export").headers["location"], "/datastore/export/")

    def test_head_request(self):
        write(os.path.join(self.docs_dir, "a.md"), "# A\n")
        r = self.c.request("HEAD", "/datastore/docs/a")
        self.assertEqual(r.status, 200)
        self.assertEqual(self.c.request("POST", "/datastore/docs/a").status, 405)

    def test_export_page_filled_and_downloadable(self):
        digest = self.lib()
        write(os.path.join(self.docs_dir, "export.html"),
              '<meta http-equiv="Content-Security-Policy" content="{{csp}}">{{script_tag}}<i>{{sri}} {{library_url}} {{version}}</i>')
        r = self.c.get("/datastore/export/")
        self.assertEqual(r.status, 200)
        self.assertIn("text/html", r.headers["content-type"])
        self.assertIn('integrity="' + digest + '"', r.text)
        self.assertIn("https://example.test/datastore/client/wds-1.2.3.js", r.text)
        self.assertIn("script-src 'unsafe-inline' 'wasm-unsafe-eval' https://example.test/datastore/client/;", r.text)
        d = self.c.get("/datastore/export/wds-export.html")
        self.assertEqual(d.text, r.text)
        self.assertIn("attachment", d.headers["content-disposition"])
        self.assertNotIn("{{", r.text)

    def test_docs_dir_comes_from_the_ini_file(self):
        ini = os.path.join(self.docs_dir, "c.ini")
        write(ini, "[server]\ndocs_dir = /somewhere/docs\n")
        self.assertEqual(load_config(ini).docs_dir, "/somewhere/docs")
        self.assertIsNone(load_config(None).docs_dir)
        # without the setting the app finds docs/site next to the server package
        env = Env()
        try:
            self.assertEqual(env.svc.docs_dir, Path(docs.__file__).resolve().parents[2] / "docs" / "site")
        finally:
            env.close()


class Library(DocsTestCase):
    def test_sri_source_order_hashes_json_then_sri_file_then_computed(self):
        digest = self.lib(hashes=True)
        self.assertEqual(docs.library_info(self.env.svc), {"version": "1.2.3", "file": "wds-1.2.3.js", "sri": digest})
        os.remove(os.path.join(self.dist, "hashes.json"))
        self.assertEqual(docs.library_info(self.env.svc)["sri"], digest)  # computed from the file
        with open(os.path.join(self.dist, "wds-1.2.3.js.sri"), "w") as fh:
            fh.write("sha384-FROMFILE\n")
        self.assertEqual(docs.library_info(self.env.svc)["sri"], "sha384-FROMFILE")
        with open(os.path.join(self.dist, "hashes.json"), "w") as fh:
            json.dump({"1.2.3": {"file": "wds-1.2.3.js", "sri": "sha384-FROMJSON"}}, fh)
        self.assertEqual(docs.library_info(self.env.svc)["sri"], "sha384-FROMJSON")

    def test_broken_hashes_json_falls_back(self):
        digest = self.lib()
        with open(os.path.join(self.dist, "hashes.json"), "w") as fh:
            fh.write("{not json")
        self.assertEqual(docs.library_info(self.env.svc)["sri"], digest)

    def test_newest_version_is_used_and_missing_library_is_visible(self):
        self.lib("1.0.0")
        digest = self.lib("1.10.0", b"newer", hashes=False)
        self.assertEqual(docs.placeholders(self.env.svc)["version"], "1.10.0")
        self.assertEqual(docs.placeholders(self.env.svc)["sri"], digest)
        os.remove(os.path.join(self.dist, "wds-1.10.0.js"))
        os.remove(os.path.join(self.dist, "wds-1.0.0.js"))
        os.remove(os.path.join(self.dist, "hashes.json"))
        self.assertIn("NOT-DEPLOYED", docs.placeholders(self.env.svc)["sri"])

    def test_configured_latest_version_wins(self):
        self.env.config.library_latest = "1.0.0"
        self.lib("1.0.0")
        self.lib("2.0.0", b"x", hashes=False)
        self.assertEqual(docs.placeholders(self.env.svc)["version"], "1.0.0")

    def test_escrow_ids_are_the_configured_pins(self):
        ids = docs.placeholders(self.env.svc)["escrow_ids"].split(", ")
        self.assertEqual(ids, [e.key_id for e in self.env.config.escrow])

    def test_csp_policy(self):
        csp = docs.csp_policy("https://wiai.uni-bamberg.de/datastore/")
        self.assertIn("default-src 'none'", csp)
        self.assertIn("script-src 'unsafe-inline' 'wasm-unsafe-eval' https://wiai.uni-bamberg.de/datastore/client/;", csp)
        self.assertIn("connect-src https://wiai.uni-bamberg.de/datastore/api/ https://api.pwnedpasswords.com;", csp)
        self.assertNotIn("'unsafe-eval'", csp.replace("'wasm-unsafe-eval'", ""))
        self.assertNotIn("*", csp)
        # every directive is a known one
        names = {d.strip().split(" ")[0] for d in csp.split(";") if d.strip()}
        self.assertEqual(names, {"default-src", "script-src", "style-src", "img-src", "connect-src", "base-uri", "form-action"})


class RepositoryDocuments(unittest.TestCase):
    """The real files under docs/site render cleanly and their links resolve."""

    def setUp(self):
        self.env = Env(config_overrides={"docs_dir": str(REPO_DOCS)})
        self.c = self.env.client
        dist = self.env.config.client_dir
        with open(os.path.join(dist, "wds-1.0.0.js"), "wb") as fh:
            fh.write(b"library")

    def tearDown(self):
        self.env.close()

    def names(self):
        return sorted(p.stem for p in REPO_DOCS.glob("*.md"))

    def test_expected_documents_exist(self):
        self.assertTrue({"integration", "porting", "users.de", "users.en", "operator"} <= set(self.names()))
        self.assertTrue((REPO_DOCS / "llms.txt").is_file())
        self.assertTrue((REPO_DOCS / "export.html").is_file())

    def test_every_document_renders_without_leftovers(self):
        for name in self.names():
            raw = self.c.get(f"/datastore/docs/{name}.md")
            page = self.c.get(f"/datastore/docs/{name}")
            self.assertEqual((raw.status, page.status), (200, 200), name)
            self.assertNotRegex(raw.text, r"\{\{[a-z_]+\}\}", name)
            self.assertNotIn("<script", page.text, name)  # shown as text only
            self.assertRegex(page.text, r"<h1 id=", name)
        llms = self.c.get("/datastore/llms.txt")
        self.assertEqual(llms.status, 200)
        self.assertNotRegex(llms.text, r"\{\{[a-z_]+\}\}")

    def test_every_document_renders_without_leftovers_with_a_sandbox(self):
        from wds_server.config import SandboxConfig
        self.env.config.sandbox = SandboxConfig(scope_id="sandbox-000000")
        for name in self.names():
            self.assertNotRegex(self.c.get(f"/datastore/docs/{name}.md").text, r"\{\{[a-z_]+\}\}", name)
        llms = self.c.get("/datastore/llms.txt").text
        self.assertNotRegex(llms, r"\{\{[a-z_]+\}\}")

    def test_llms_txt_sandbox_section_depends_on_the_configuration(self):
        from wds_server.config import SandboxConfig
        without = self.c.get("/datastore/llms.txt").text
        self.assertIn("This server has no public sandbox", without)
        self.assertNotIn("Open enrollment (no join code), -", without)
        self.env.config.sandbox = SandboxConfig(scope_id="sandbox-000000")
        with_sb = self.c.get("/datastore/llms.txt").text
        self.assertIn("public sandbox scope on this service: sandbox-000000", with_sb)
        self.assertNotIn("This server has no public sandbox", with_sb)

    def test_links_to_own_documents_resolve(self):
        base = "https://wiai.uni-bamberg.de/datastore"
        texts = [self.c.get(f"/datastore/docs/{n}.md").text for n in self.names()] + [self.c.get("/datastore/llms.txt").text]
        seen = set()
        for text in texts:
            for m in re.finditer(re.escape(base) + r"/(docs/[A-Za-z0-9.-]+|llms\.txt|export/|api/v1)", text):
                seen.add(m.group(1))
        self.assertTrue(seen)
        for path in sorted(seen):
            if path == "api/v1":
                continue
            r = self.c.get("/datastore/" + path)
            self.assertEqual(r.status, 200, path)

    def test_integration_guide_has_the_load_bearing_parts(self):
        text = self.c.get("/datastore/docs/integration.md").text
        self.assertIn('integrity="sha384-', text)
        self.assertIn("Content-Security-Policy", text)
        self.assertIn("'wasm-unsafe-eval'", text)
        self.assertIn("onerror=", text)
        for api in ("WDS.connect", "store.unlock", "store.get", "store.set", "store.list", "store.remove", "store.autosave",
                    "store.onConflict", "store.share", "store.exportAll", "store.history", "store.restore", "store.lock",
                    "wds-verify", "wds-verify.json"):
            self.assertIn(api, text, api)
        for error in ("OfflineError", "ConflictError", "QuotaError", "AuthError", "IntegrityError", "VersionError"):
            self.assertIn(error, text, error)

    def test_the_official_privacy_sentence_is_the_same_everywhere(self):
        from wds_server.prompt import PRIVACY_DE, PRIVACY_EN
        self.assertEqual(PRIVACY_EN, "Data is end-to-end encrypted; the faculty holds a recovery key for emergencies.")
        self.assertEqual(PRIVACY_DE, "Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel.")
        guide = self.c.get("/datastore/docs/integration.md").text
        self.assertIn(PRIVACY_EN, guide)
        self.assertIn(PRIVACY_DE, guide)
        self.assertGreaterEqual(guide.count(PRIVACY_EN), 2)  # the top of the guide and the text for users (section 13)
        self.assertGreaterEqual(guide.count(PRIVACY_DE), 2)
        llms = self.c.get("/datastore/llms.txt").text
        self.assertIn(PRIVACY_EN, llms)
        self.assertIn(PRIVACY_DE, llms)
        self.assertIn(PRIVACY_EN, self.c.get("/datastore/docs/users.en.md").text)
        self.assertIn(PRIVACY_DE, self.c.get("/datastore/docs/users.de.md").text)
        porting = self.c.get("/datastore/docs/porting.md").text  # a ported app replaces "your data stays on this device" with the official sentence
        self.assertIn(PRIVACY_EN, porting)
        self.assertIn(PRIVACY_DE, porting)

    def test_the_breach_check_sentence_is_the_same_everywhere(self):
        from wds_server.prompt import HIBP_DE, HIBP_EN
        self.assertIn("Pwned Passwords", HIBP_EN)
        self.assertIn("checksum", HIBP_EN)
        self.assertNotIn("hash", HIBP_EN.lower())
        self.assertIn("Prüfsumme", HIBP_DE)
        self.assertNotIn("Hash", HIBP_DE)
        guide = self.c.get("/datastore/docs/integration.md").text
        self.assertGreaterEqual(guide.count(HIBP_EN), 2)  # the top of the guide and the text for users (section 13)
        self.assertGreaterEqual(guide.count(HIBP_DE), 2)
        self.assertIn(HIBP_EN, self.c.get("/datastore/llms.txt").text)
        self.assertIn(HIBP_DE, self.c.get("/datastore/llms.txt").text)
        self.assertIn(HIBP_EN, self.c.get("/datastore/docs/users.en.md").text)
        self.assertIn(HIBP_DE, self.c.get("/datastore/docs/users.de.md").text)
        porting = self.c.get("/datastore/docs/porting.md").text
        self.assertIn(HIBP_EN, porting)
        self.assertIn(HIBP_DE, porting)
        # the example app of the repository carries both sentences in its privacy text
        app = (REPO_DOCS.parents[1] / "examples" / "zeit-notizen" / "index.html").read_text(encoding="utf-8")
        self.assertIn(HIBP_EN, app)
        self.assertIn(HIBP_DE, app)

    def test_integration_guide_documents_set_created_dialogs_and_the_new_views(self):
        text = self.c.get("/datastore/docs/integration.md").text
        for part in ("**`set` and `created`.**", "upsert", "### Driving the library's dialogs in your own end-to-end tests", "tools/lib/drive-library.mjs",
                     "| `migrate` |", "| `migrate-differs` |", "| `migrate-large` |", "migrate-large-ack", "migrate-differs-keep-both", "aria-busy",
                     "### The library's dialogs and your own modal dialogs", "dialog:not(.wds-dialog)", "store.setLocale(\"de\")", "get(id, { fresh })", "window.open(\"\", \"_blank\")",
                     "redeemInvite", "1 MB = 1,048,576 bytes"):
            self.assertIn(part, text, part)
        # `set` takes the option created (for a new entry; an existing entry keeps its date), in the method list and in the paragraph
        self.assertIn("`set(id, value, { meta, mime, created })`", text)
        self.assertIn("`col.set(id, value, { meta, mime, created })` is an **upsert**", text)
        self.assertIn("**for an entry that exists it is ignored**", text)
        self.assertNotIn("`set` has no `created` option", text)
        self.assertNotIn("`set(id, value, { meta, mime })`", text)

    def test_integration_section_16_is_a_pointer_and_the_hand_recipe_is_gone_from_every_document(self):
        text = self.c.get("/datastore/docs/integration.md").text
        start = text.index("## 16. Porting an existing app")
        section = text[start:text.index("## 17. The sandbox")]
        self.assertLess(len(section.splitlines()), 14)  # a pointer, not a guide
        self.assertIn("/docs/porting.md", section)
        self.assertIn("/docs/porting.md", self.c.get("/datastore/llms.txt").text)
        self.assertRegex(self.c.get("/datastore/docs/").text, r"/docs/porting")
        for path in sorted(REPO_DOCS.iterdir()):
            if path.suffix not in (".md", ".txt", ".html"):
                continue
            body = path.read_text(encoding="utf-8")
            for gone in ("openOldDb", "keepInSandbox", "migratedSettings", "settingsDone", "toNewRecords", "migrateOldData", "WDS_JOIN_CODE=", "export WDS_JOIN_CODE", "MiB", "GiB", "Hashwert"):
                self.assertNotIn(gone, body, path.name + " still has " + gone)

    def test_porting_guide_has_the_load_bearing_parts(self):
        raw = self.c.get("/datastore/docs/porting.md")
        self.assertEqual(raw.status, 200)
        self.assertEqual(raw.headers["content-type"], "text/markdown; charset=utf-8")
        text = raw.text
        page = self.c.get("/datastore/docs/porting")
        self.assertEqual(page.status, 200)
        self.assertIn("<title>Porting an existing app to WIAI Datastore - WIAI Datastore</title>", page.text)
        self.assertIn("/docs/porting.md", page.text)  # the Markdown link in the header
        for part in ("store.migrateLocal", "from", "h.skip", "h.fail", "h.ref", "h.id", "h.blob", "h.created", "WDS.fillGaps", "tagged: false", "**The new ids contain `-` and `%`**",
                     "**Do you need the tag in the item ids? Decide by the old ids.**", "### Example 1:", "### Example 2:", "### What your app does with the result",
                     "migrate-differs", "migrate-large", "Entries that differ", "The join code for tests", "(umask 077; cat > ~/.wds/join-code)", "mkdir -p ~/.wds && chmod 700 ~/.wds",
                     "WDS_JOIN_CODE_FILE", "never read, print, copy or list that file", "redeemInvite", "deleteVault", "--migration-delete", "context.addInitScript", "__WDS_MIGRATION_TEST__",
                     "## 7. Checklist for apps with forms and modal dialogs", "dialog:not(.wds-dialog)", "CSS.escape", "window.open(\"\", \"_blank\")", "setLocale(\"de\")",
                     "same folder, same file name", "sessionStorage", "fresh browser profile", "1 MB = 1,048,576 bytes", "nothing", "busy", "skipped", "declined", "partial", "failed", "migrated"):
            self.assertIn(part, text, part)
        # the seed run is described in its order: old app, new app, dialogs, steps, filling, reload
        order = [text.index(x) for x in ("1. **The old app.**", "2. **The new app**", "3. **The library's dialogs.**", "4. **The steps**", "5. **Automatic filling", "6. **The reload**")]
        self.assertEqual(order, sorted(order))
        # the guide has to say what no code can: units once, and that the file with the join code is the person's own
        self.assertIn("Units: 1 MB = 1,048,576 bytes", text)
        self.assertNotIn("{{", text)

    def test_users_documents_explain_the_old_data_question(self):
        en = self.c.get("/datastore/docs/users.en.md").text
        de = self.c.get("/datastore/docs/users.de.md").text
        self.assertIn("## Data from an earlier version of the app", en)
        self.assertIn("## Daten aus einer früheren Version der App", de)
        self.assertIn("**not encrypted**", en)
        self.assertIn("**nicht verschlüsselt**", de)
        self.assertIn("checksum", en)
        self.assertIn("Prüfsumme", de)
        self.assertIn("app ID", en)
        self.assertIn("App-ID", de)

    def test_export_page_is_standalone(self):
        page = self.c.get("/datastore/export/").text
        self.assertIn('src="https://wiai.uni-bamberg.de/datastore/client/wds-1.0.0.js"', page)
        self.assertIn('integrity="sha384-', page)
        self.assertIn('crossorigin="anonymous"', page)
        self.assertIn('var BASE = "https://wiai.uni-bamberg.de/datastore/";', page)
        self.assertNotRegex(page, r'(?:src|href)="/')  # no site-relative URLs: the saved copy must work from file://
        self.assertNotRegex(page, r"\{\{[a-z_]+\}\}")


class Markdown(unittest.TestCase):
    def html(self, text):
        return docs.render_markdown(text)[0]

    def test_headings_get_unique_ids_and_title(self):
        body, title = docs.render_markdown("# Main *title*\n\n## Part\n\n## Part\n")
        self.assertEqual(title, "Main <em>title</em>".replace("<em>", "").replace("</em>", ""))
        self.assertIn('<h2 id="part">', body)
        self.assertIn('<h2 id="part-2">', body)

    def test_paragraph_inline_and_escaping(self):
        self.assertEqual(self.html("a **b** *c* `d<e>` <i>x</i> & y"),
                         "<p>a <strong>b</strong> <em>c</em> <code>d&lt;e&gt;</code> &lt;i&gt;x&lt;/i&gt; &amp; y</p>")
        self.assertEqual(self.html("snake_case_name and 2*3*4"), "<p>snake_case_name and 2*3*4</p>")

    def test_links_only_safe_schemes(self):
        out = self.html("[ok](https://a.example/x?y=1&z=2) [rel](other.md) [abs](/p) [anchor](#a) [bad](javascript:alert(1)) "
                        "[data](data:text/html,x) <https://auto.example/p>")
        self.assertIn('<a href="https://a.example/x?y=1&amp;z=2">ok</a>', out)
        self.assertIn('<a href="other.md">rel</a>', out)
        self.assertIn('<a href="/p">abs</a>', out)
        self.assertIn('<a href="#a">anchor</a>', out)
        self.assertNotIn('href="javascript', out)
        self.assertNotIn('href="data', out)
        self.assertIn('<a href="https://auto.example/p">https://auto.example/p</a>', out)

    def test_link_text_cannot_inject_attributes(self):
        out = self.html('[x" onclick="evil](https://a.example/"onmouseover="y)')
        tag = re.match(r"<p>(<a [^>]*>)", out).group(1)
        self.assertRegex(tag, r'^<a href="[^"]*">$')  # one attribute; the quotes of the URL are escaped
        self.assertNotIn("onmouseover=\"", tag)

    def test_fenced_code_is_verbatim(self):
        out = self.html("text\n\n```html\n<script>alert(1)</script>\n# not a heading\n  indented **no**\n```\n\nafter")
        self.assertIn('<pre><code class="language-html">&lt;script&gt;alert(1)&lt;/script&gt;\n# not a heading\n  indented **no**\n</code></pre>', out)
        self.assertNotIn("<h1", out)
        self.assertTrue(out.endswith("<p>after</p>"))

    def test_unterminated_fence_runs_to_the_end(self):
        self.assertIn("<pre>", self.html("```\ncode\nmore"))

    def test_lists_nested_ordered_and_with_code(self):
        out = self.html("- one\n- two\n  - nested a\n  - nested b\n- three\n\n1. first\n2. second\n   ```sh\n   run\n   ```\n")
        self.assertIn("<ul><li>one</li><li>two<ul><li>nested a</li><li>nested b</li></ul></li><li>three</li></ul>", out.replace("\n<", "<"))
        self.assertIn("<ol><li>first</li><li>second", out)
        self.assertIn('<pre><code class="language-sh">run\n</code></pre></li></ol>', out)

    def test_ordered_list_keeps_its_start_number_and_blocks_stay_inside_items(self):
        out = self.html("3. three\n\n   ```sh\n   x\n   ```\n\n   more text\n4. four\n")
        self.assertTrue(out.startswith('<ol start="3">'), out)
        self.assertEqual(out.count("<li>"), 2)
        self.assertIn("<pre><code class=\"language-sh\">x\n</code></pre>", out)
        self.assertIn("more text", out)

    def test_list_continuation_line(self):
        self.assertEqual(self.html("- one\n  continues\n- two"), "<ul><li>one continues</li><li>two</li></ul>")

    def test_table(self):
        out = self.html("| A | B |\n|---|:-:|\n| 1 | `x\\|y` |\n| 2 | **z** |\n")
        self.assertIn("<th>A</th>", out)
        self.assertIn('<th style="text-align:center">B</th>', out)
        self.assertIn("<td>1</td>", out)
        self.assertIn('<td style="text-align:center"><strong>z</strong></td>', out)
        self.assertIn("<code>x|y</code>", out)
        self.assertEqual(out.count("<tr>"), 3)

    def test_blockquote_rule_and_paragraph_breaks(self):
        out = self.html("> quoted\n> text\n\n---\n\nlast\nline")
        self.assertIn("<blockquote><p>quoted text</p></blockquote>", out)
        self.assertIn("<hr>", out)
        self.assertIn("<p>last line</p>", out)

    def test_pipe_in_paragraph_is_not_a_table(self):
        self.assertEqual(self.html("a | b\nc"), "<p>a | b c</p>")

    def test_empty_input(self):
        self.assertEqual(docs.render_markdown(""), ("", None))
