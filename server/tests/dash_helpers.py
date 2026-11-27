"""Test helpers for the dashboard: a cookie-jar browser and a test case with login.psi configured."""

import base64
import json
import os
import re
import shutil
import tempfile
import unittest
import urllib.parse

from nacl.secret import SecretBox

from .helpers import Env

D = "/datastore"
CSRF_RE = re.compile(r'name="csrf" value="([^"]+)"')


class Browser:
    """A cookie jar plus the CSRF token of the last page that carried one."""

    def __init__(self, env, lang_header=None):
        self.env = env
        self.cookies = {}
        self.csrf = None
        self.lang_header = lang_header
        self.raw_cookies = []

    def request(self, method, path, form=None, headers=None, csrf=True):
        h = dict(headers or {})
        if self.cookies:
            h["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        if self.lang_header:
            h.setdefault("Accept-Language", self.lang_header)
        body = None
        if form is not None:
            fields = dict(form)
            if csrf and self.csrf and "csrf" not in fields:
                fields["csrf"] = self.csrf
            body = urllib.parse.urlencode(fields).encode()
            h.setdefault("Content-Type", "application/x-www-form-urlencoded")
        r = self.env.client.request(method, D + path if path.startswith("/") and not path.startswith(D) else path, h, body)
        self.raw_cookies = [v for k, v in r.header_list if k.lower() == "set-cookie"]
        for raw in self.raw_cookies:
            name, _, rest = raw.partition("=")
            value = rest.split(";")[0]
            if "max-age=0" in raw.lower():
                self.cookies.pop(name, None)
            else:
                self.cookies[name] = value
        m = CSRF_RE.search(r.text) if r.headers.get("content-type", "").startswith("text/html") else None
        if m:
            self.csrf = m.group(1)
        return r

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def post(self, path, form, **kw):
        return self.request("POST", path, form, **kw)


class DashCase(unittest.TestCase):
    config = {}
    operators = ["boss"]
    with_login = True

    def setUp(self):
        self.keydir = tempfile.mkdtemp(prefix="wds-key-")
        self.key = os.urandom(32)
        keyfile = os.path.join(self.keydir, "key")
        with open(keyfile, "w") as fh:
            fh.write(base64.b64encode(self.key).decode() + "\n")
        overrides = {"operators": list(self.operators)}
        if self.with_login:
            overrides["loginpsi_key_file"] = keyfile
        overrides.update(self.config)
        self.env = Env(overrides)
        self.c = self.env.client
        self.box = SecretBox(self.key)
        hashes = {"1.0.0": {"file": "wds-1.0.0.js", "sri": "sha384-TESTHASH+/=", "sha256": "00", "bytes": 1,
                            "escrow_pins": [], "retired_escrow": [], "frozen": False}}
        with open(os.path.join(self.env.config.client_dir, "hashes.json"), "w") as fh:
            json.dump(hashes, fh)

    def tearDown(self):
        self.env.close()
        shutil.rmtree(self.keydir, ignore_errors=True)

    # --- helpers -----------------------------------------------------------------------------------------------------

    def browser(self, **kw):
        return Browser(self.env, **kw)

    def login_token(self, nonce, username="alice", email="alice@uni-bamberg.de", next_path="/datastore/", matriculation=None,
                    first="Alice", last="Example", box=None):
        data = {"username": username, "first_name": first, "last_name": last, "email": email, "session_key": nonce,
                "next": next_path}
        if matriculation:
            data["matriculation_number"] = matriculation
        return base64.b64encode((box or self.box).encrypt(json.dumps(data).encode())).decode()

    def start_login(self, b, next_path=None):
        path = "/login" + ("?" + urllib.parse.urlencode({"next": next_path}) if next_path else "")
        r = b.get(path)
        self.assertEqual(r.status, 303, r)
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(r.headers["location"]).query)
        sent = json.loads(self.box.decrypt(base64.b64decode(q["token"][0])))
        return r, sent

    def login(self, b, username="alice", email="alice@uni-bamberg.de", matriculation=None, next_path=None, **kw):
        r, sent = self.start_login(b, next_path)
        token = self.login_token(sent["session_key"], username, email, sent["next"], matriculation, **kw)
        r = b.get("/_lpmiddleware/login?token=" + urllib.parse.quote(token))
        b.login_cookies = list(b.raw_cookies)
        if r.status == 200:
            b.get("/")  # picks up the CSRF token
        return r

    def staff(self, username="alice", **kw):
        b = self.browser(**kw)
        r = self.login(b, username, username + "@uni-bamberg.de", first=username.capitalize())
        self.assertEqual(r.status, 200, r)
        return b

    def operator(self):
        b = self.browser()
        r = self.login(b, "boss", "boss@uni-bamberg.de")
        self.assertEqual(r.status, 200, r)
        return b

    def make_scope(self, b, name="My App", **over):
        form = {"name": name, "contact_email": "dev@uni-bamberg.de", "description": "A test app"}
        form.update(over)
        r = b.post("/scopes", form)
        self.assertEqual(r.status, 303, r.text[:500])
        return r.headers["location"].split("?")[0].rsplit("/", 1)[1]

    def row(self, scope_id):
        return self.env.sql("SELECT * FROM scopes WHERE scope_id=?", (scope_id,))[0]


