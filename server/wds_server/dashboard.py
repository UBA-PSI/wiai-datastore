"""Dashboard, login.psi login and privacy page (PLAN 6, 10, 13). Server-rendered HTML under /datastore/.

The API under /datastore/api/v1 never reads cookies; this module never touches API tokens. Scope, limit, audit and vault
logic is shared with the operator API through scopes.py and the service object.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import secrets
import urllib.parse

from starlette.responses import HTMLResponse, RedirectResponse, Response
from starlette.routing import Route

from . import access
from . import prompt as prompt_mod
from .config import CEILING_LIMITS, DEFAULT_LIMITS, LIMIT_KEYS
from .docs import REPO_URL
from .db import transaction
from .errors import ApiError
from .loginpsi import LoginPsi, LoginRejected
from .privacy import privacy_page
from .sandbox import sandbox_doc
from .texts import TEXTS
from .scopes import (ENROLLMENTS, MAX_SCOPES_PER_CREATOR, SLUG_RE, check_disk_budget, create_scope, delete_scope,
                     new_join_code, patch_scope, soft_delete_vault, validate_contact_email, validate_limits, validate_name)
from .service import AUDIT_RETENTION, DELETED_VAULT_TTL
from .ui import BASE, TZ_NAME, Ctx, esc, render, table, tr
from .util import b64u_encode, sha256
from .validate import valid_scope_id, valid_vault_id

log = logging.getLogger("wds_server")

EXPERT_COOKIE = "wds_expert"  # "1": show the expert settings opened (a display preference of this browser, no personal data)
EXPERT_COOKIE_AGE = 365 * 86400
SESSION_COOKIE = "__Host-wds_session"
NONCE_COOKIE = "__Host-wds_login"
PRE_COOKIE = "__Host-wds_pre"  # dev login only: binds the form token to the browser
DEFAULT_NEXT = BASE + "/"
FORM_LIMIT = 65536
MIB = 1048576


def whole_bytes(text: str) -> str:
    """"10,0 MB" -> "10 MB" (the prompt is read by Claude and by people: no decimal for whole numbers)."""
    return re.sub(r"[.,]0( [KMGT]B)$", r"\1", text)


BYTE_LIMITS = ("max_value_bytes", "vault_bytes", "scope_bytes")
NOTICES = {"created", "saved", "limits", "code_rotated", "admin_added", "admin_removed", "vault_deleted", "suspended",
           "resumed", "blocked", "unblocked", "locked"}
EXPERT_NOTICES = {"saved", "limits", "admin_added", "admin_removed", "vault_deleted", "suspended"}  # results of forms in the expert area: show it opened


class DashError(Exception):
    def __init__(self, status: int, key: str, detail: str = "", **params):
        super().__init__(key)
        self.status = status
        self.key = key
        self.detail = detail
        self.params = params

    def text(self, t) -> str:
        return t(self.key, detail=self.detail, **self.params)


# --- small helpers -----------------------------------------------------------------------------------------------------


def safe_next(value) -> str:
    """Only paths below /datastore/ (and not the login machinery or the API) are valid targets after login."""
    if not isinstance(value, str) or not value or len(value) > 500 or not value.isprintable() or "\\" in value:
        return DEFAULT_NEXT
    parts = urllib.parse.urlsplit(value)
    if parts.scheme or parts.netloc or parts.fragment:
        return DEFAULT_NEXT
    path = parts.path
    decoded = urllib.parse.unquote(path)
    if path == BASE:
        return DEFAULT_NEXT
    if (not path.startswith(BASE + "/") or "//" in path or "//" in decoded or "\\" in decoded
            or ".." in decoded.split("/") or not decoded.isprintable()):
        return DEFAULT_NEXT
    if decoded.startswith((BASE + "/_lpmiddleware", BASE + "/_dev_login", BASE + "/api/", BASE + "/login")):
        return DEFAULT_NEXT
    return value


def cookie_header(name: str, value: str, *, samesite: str = "Strict", max_age: int | None = None) -> str:
    parts = [f"{name}={value}", "Path=/", "Secure", "HttpOnly", f"SameSite={samesite}"]
    if max_age is not None:
        parts.append(f"Max-Age={max_age}")
    return "; ".join(parts)


def with_cookies(response: Response, *cookies: str) -> Response:
    for c in cookies:
        response.headers.append("set-cookie", c)
    return response


def slugify(text: str) -> str:
    import unicodedata
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    text = re.sub(r"^[^a-z]+", "", text)
    return text[:30].strip("-") or "app"


def parse_int(value: str, key: str, lo: int | None = None, hi: int | None = None, unit: str = "") -> int:
    """A whole number; with lo and hi, one inside that range. Two different messages: not a number, and out of range."""
    value = (value or "").strip()
    digits = value[1:] if value[:1] == "-" else value
    if not value.isascii() or not digits.isdigit() or len(value) > 12:
        raise DashError(400, "err_number", key)
    n = int(value)
    if lo is not None and hi is not None and not lo <= n <= hi:
        raise DashError(400, "err_range", key, lo=lo, hi=hi, unit=(" " + unit) if unit else "")
    return n


def actor_of(ctx: Ctx, operator_view: bool = False) -> str:
    return ("operator:" if operator_view else "user:") + ctx.ident.username


# --- the dashboard -------------------------------------------------------------------------------------------------------


class Dashboard:
    def __init__(self, svc, loginpsi: LoginPsi | None):
        self.svc = svc
        self.loginpsi = loginpsi
        self.cfg = svc.config
        self._pre_secret = secrets.token_bytes(32)
        self.origin = "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(self.cfg.public_base))
        if self.cfg.dev_login:
            log.warning("dashboard dev_login is ON: anyone can log in as anybody. Never use this in production.")

    # -- request plumbing ---------------------------------------------------------------------------------------------

    async def ctx(self, request) -> Ctx:
        token = request.cookies.get(SESSION_COOKIE)

        def work():
            if not token:
                return None
            with self.svc.db.connection() as conn:
                return access.load_identity(self.svc, conn, token)

        return Ctx(self.svc, request, await self.svc.run(work))

    def route(self, handler, *, post: bool = False):
        async def endpoint(request):
            ctx = await self.ctx(request)
            try:
                if post:
                    form = await self.read_form(request, ctx)
                    return await handler(request, ctx, form)
                return await handler(request, ctx)
            except DashError as err:
                return self.error_page(ctx, err.status, err.text(ctx.t))
            except ApiError as err:
                return self.error_page(ctx, err.status if err.status < 500 else 500, esc(err.message))

        return endpoint

    def error_page(self, ctx: Ctx, status: int, message_html: str) -> Response:
        t = ctx.t
        again = (f'<p><a class="btn" href="{ctx.url("/")}">{t("back_home")}</a></p>')
        return render(ctx, t("error_title"), f'<h1>{t("error_title")}</h1><div class="error" role="alert">{message_html}</div>{again}',
                      status=status)

    def check_origin(self, request) -> None:
        """Defence in depth next to the CSRF token and SameSite=Strict: refuse requests that browsers mark as coming
        from another site (Sec-Fetch-Site) or whose Origin is not ours."""
        site = request.headers.get("sec-fetch-site")
        origin = request.headers.get("origin")
        if (site is not None and site not in ("same-origin", "none")) or (origin is not None and origin != self.origin):
            raise DashError(403, "err_origin")

    async def read_form(self, request, ctx: Ctx) -> dict[str, str]:
        """x-www-form-urlencoded body, same-origin check, CSRF token of the session (all forms carry one)."""
        self.check_origin(request)
        media = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media != "application/x-www-form-urlencoded":
            raise DashError(415, "err_form_type")
        chunks, total = [], 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > FORM_LIMIT:
                raise DashError(413, "err_form_size")
            chunks.append(chunk)
        try:
            pairs = urllib.parse.parse_qs(b"".join(chunks).decode("utf-8"), keep_blank_values=True, max_num_fields=80,
                                          strict_parsing=False)
        except (UnicodeDecodeError, ValueError):
            raise DashError(400, "err_form_type") from None
        form = {k: v[0] for k, v in pairs.items()}
        if ctx.ident is not None and not hmac.compare_digest(form.get("csrf", "").encode(), ctx.ident.csrf.encode()):
            raise DashError(403, "err_csrf")
        return form

    def need_login(self, request, ctx: Ctx):
        """None when logged in, else the redirect that starts the login for this very page."""
        if ctx.ident:
            return None
        target = request.url.path + ("?" + request.url.query if request.url.query else "")
        return RedirectResponse(f"{BASE}/login?" + urllib.parse.urlencode({"next": target}), status_code=303)

    def redirect(self, ctx: Ctx, path: str, notice: str | None = None, **params) -> Response:
        return RedirectResponse(ctx.href(path, notice=notice, **params), status_code=303)

    # -- login ---------------------------------------------------------------------------------------------------------

    def pre_token(self, cookie: str) -> str:
        return b64u_encode(hmac.new(self._pre_secret, cookie.encode(), hashlib.sha256).digest())

    async def login_page(self, request, ctx: Ctx) -> Response:
        t = ctx.t
        target = safe_next(request.query_params.get("next"))
        parts = [f'<h1>{t("login_title")}</h1><p>{t("login_intro")}</p>']
        cookies = []
        if self.loginpsi:
            parts.append(f'<p><a class="btn" href="{ctx.url("/login", next=target)}">{t("login_button")}</a></p>'
                         f'<p class="hint">{t("login_via")}</p>')
        else:
            parts.append(f'<div class="error" role="alert">{t("login_unconfigured")}</div>')
        if self.cfg.dev_login:
            pre = request.cookies.get(PRE_COOKIE) or secrets.token_urlsafe(24)
            cookies.append(cookie_header(PRE_COOKIE, pre, max_age=3600))
            field = lambda n, label, extra="": (f'<label for="d_{n}">{label}</label><input type="text" id="d_{n}" name="{n}" {extra}>')
            parts.append(
                f'<h2>{t("dev_title")}</h2><p class="hint">{t("dev_hint")}</p>'
                + ctx.form("/_dev_login", f'<input type="hidden" name="pre" value="{esc(self.pre_token(pre))}">'
                           f'<input type="hidden" name="next" value="{esc(target)}">'
                           + field("username", "login.psi user ID", "required")
                           + field("email", "E-Mail / e-mail") + field("name", "Name")
                           + field("matriculation_number", "matriculation_number")
                           + f'<button type="submit">{t("dev_button")}</button>'))
        resp = render(ctx, t("login_title"), "".join(parts), status=200)
        return with_cookies(resp, *cookies)

    async def login_start(self, request, ctx: Ctx) -> Response:
        target = safe_next(request.query_params.get("next"))
        if ctx.ident:
            return RedirectResponse(target, status_code=303)
        if not self.loginpsi:
            return render(ctx, ctx.t("login_title"), f'<h1>{ctx.t("login_title")}</h1><div class="error" role="alert">'
                          f'{ctx.t("login_unconfigured")}</div>', status=503)
        if ctx.lang_explicit and "lang=" not in target:  # the person chose a language: keep it after the round trip
            target += ("&" if "?" in target else "?") + "lang=" + ctx.lang
        nonce, url = self.loginpsi.begin(target)
        # Lax: the nonce cookie has to come back with the cross-site redirect from login.psi.
        return with_cookies(RedirectResponse(url, status_code=303), cookie_header(NONCE_COOKIE, nonce, samesite="Lax", max_age=600))

    async def login_callback(self, request, ctx: Ctx) -> Response:
        clear = cookie_header(NONCE_COOKIE, "", samesite="Lax", max_age=0)
        if not self.loginpsi:
            return with_cookies(render(ctx, ctx.t("login_title"), f'<div class="error" role="alert">{ctx.t("login_unconfigured")}</div>',
                                       status=503), clear)
        try:
            who = self.loginpsi.parse(request.query_params.get("token", ""), request.cookies.get(NONCE_COOKIE))
        except LoginRejected as err:
            return with_cookies(self.login_failed(ctx, "login_failed_" + str(err)), clear)
        return await self.finish_login(request, ctx, who.username, who.name, who.email, who.matriculation_number,
                                       safe_next(who.next), extra_cookies=[clear], interstitial=True)

    def login_failed(self, ctx: Ctx, key: str, status: int = 403) -> Response:
        t = ctx.t
        return render(ctx, t("login_title"), f'<h1>{t("login_failed_title")}</h1><div class="error" role="alert">{t(key)}</div>'
                      f'<p><a class="btn" href="{ctx.url("/login")}">{t("login_again")}</a></p>', status=status)

    async def finish_login(self, request, ctx: Ctx, username, name, email, matriculation, target, *, extra_cookies,
                           interstitial: bool) -> Response:
        staff = access.staff_rule(email, matriculation)
        old = request.cookies.get(SESSION_COOKIE)

        def work():
            with self.svc.db.connection() as conn:
                why = access.may_log_in(self.svc, conn, username, email, staff)
                if why:
                    with transaction(conn):  # who tried, no IP address
                        self.svc.audit(conn, "user:" + username.lower()[:64], "login_denied", None, None, why)
                    return why, None
                with transaction(conn):
                    self.svc.audit(conn, "user:" + username.lower()[:64], "login")
                    if old:
                        conn.execute("DELETE FROM sessions WHERE token_hash=?", (sha256(old.encode("utf-8", "replace")),))
                    return None, access.create_session(self.svc, conn, username, name, email, staff)

        why, token = await self.svc.run(work)
        if why:
            return with_cookies(self.login_failed(ctx, "login_denied_" + why), *extra_cookies)
        session = cookie_header(SESSION_COOKIE, token)
        if not interstitial:
            return with_cookies(RedirectResponse(target, status_code=303), session, *extra_cookies)
        # A redirect that continues a cross-site navigation would not carry the SameSite=Strict cookie. A small page that
        # navigates on its own (meta refresh, link) starts a same-site navigation instead.
        href = esc(target)
        page = render(ctx, ctx.t("login_done_title"),
                      f'<h1>{ctx.t("login_done_title")}</h1><p><a class="btn" href="{href}">{ctx.t("login_continue")}</a></p>',
                      head_extra=f'<meta http-equiv="refresh" content="0;url={href}">')
        return with_cookies(page, session, *extra_cookies)

    async def dev_login(self, request, ctx: Ctx) -> Response:
        if not self.cfg.dev_login:
            return Response("Not found", status_code=404)
        self.check_origin(request)
        raw = (await request.body())[:FORM_LIMIT]
        form = {k: v[0] for k, v in urllib.parse.parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True).items()}
        pre = request.cookies.get(PRE_COOKIE, "")
        if not pre or not hmac.compare_digest(form.get("pre", "").encode(), self.pre_token(pre).encode()):
            raise DashError(403, "err_csrf")
        username = form.get("username", "").strip().lower()
        if not username:
            raise DashError(400, "err_required")
        return await self.finish_login(request, ctx, username, form.get("name", "").strip(), form.get("email", "").strip(),
                                       form.get("matriculation_number", "").strip(), safe_next(form.get("next")),
                                       extra_cookies=[], interstitial=False)

    async def logout(self, request, ctx: Ctx, form) -> Response:
        if ctx.ident:
            await self.svc.run(self._end_session, ctx.ident.token_hash)
        return with_cookies(RedirectResponse(ctx.href("/"), status_code=303),
                            cookie_header(SESSION_COOKIE, "", max_age=0))

    def _end_session(self, token_hash):
        with self.svc.db.connection() as conn:
            access.end_session(conn, token_hash)

    # -- home -------------------------------------------------------------------------------------------------------------

    def scope_rows(self, conn, where: str = "", params=()):
        return conn.execute(
            "SELECT s.*, (SELECT COUNT(*) FROM vaults v WHERE v.scope_id=s.scope_id AND v.deleted IS NULL) AS nvaults,"
            " (SELECT COALESCE(SUM(v.bytes+v.roster_bytes),0) FROM vaults v WHERE v.scope_id=s.scope_id) AS size"
            " FROM scopes s WHERE s.deleted IS NULL" + where + " ORDER BY s.name COLLATE NOCASE, s.scope_id", params).fetchall()

    def status_badge(self, ctx: Ctx, row) -> str:
        if row["status"] == "active":
            return f'<span class="badge good">{ctx.t("status_active")}</span>'
        who = "operator" if row["suspended_by"] != "admin" else "admin"
        return f'<span class="badge bad">{ctx.t("status_suspended_" + who)}</span>'

    async def home(self, request, ctx: Ctx) -> Response:
        if not ctx.ident:
            return await self.login_page(request, ctx)
        return await self.render_home(request, ctx)

    async def render_home(self, request, ctx: Ctx, *, error: str | None = None, values: dict | None = None,
                          status: int = 200) -> Response:
        ident = ctx.ident
        t = ctx.t

        def work():
            with self.svc.db.connection() as conn:
                mine = {r["scope_id"] for r in access.my_scopes(conn, ident)}
                rows = [r for r in self.scope_rows(conn) if r["scope_id"] in mine]
                return rows

        rows = await self.svc.run(work)
        notice = request.query_params.get("notice")
        parts = [f'<h1>{t("home_title")}</h1>', f'<p id="home-intro">{t("home_intro")}</p>']
        if notice in NOTICES:
            parts.append(f'<div class="notice" role="status">{t("notice_" + notice)}</div>')
        body_rows = [tr(f'<a href="{ctx.url("/scopes/" + r["scope_id"])}">{esc(r["name"])}</a>', f'<code>{esc(r["scope_id"])}</code>',
                        self.status_badge(ctx, r), (str(r["nvaults"]), "num"), (ctx.bytes(r["size"]), "num")) for r in rows]
        parts.append(table([(t("col_name"), ""), (t("col_scope_id"), ""), (t("col_status"), ""), (t("col_vaults"), "num"),
                            (t("col_size"), "num")], body_rows, t("no_scopes")))
        if rows:
            parts.append(f'<p class="hint" id="home-table-hint">{t("home_table_hint")}</p>')
        if ident.can_create:
            parts.append(self.create_form(ctx, values or {}, open_=bool(error) or not rows, error=error, expert=self.expert_pref(request)))
        else:
            parts.append(f'<p class="muted">{t("cannot_create")}</p>')
        return render(ctx, t("home_title"), "".join(parts), status=status)

    def create_form(self, ctx: Ctx, v: dict, open_: bool, error: str | None = None, expert: bool = False) -> str:
        """The standard variant needs three answers (name, contact, description). Slug, enrollment and breach check sit in a
        collapsed part; the form submits their defaults when nobody opens it (join code, breach check on)."""
        t = ctx.t
        enroll = v.get("enrollment", "join_code")
        opts = "".join(f'<option value="{e}"{" selected" if e == enroll else ""}>{t("enroll_" + e)}</option>' for e in ENROLLMENTS)
        hibp_checked = "" if v and not v.get("hibp") else " checked"
        contact = v["contact_email"] if "contact_email" in v else (ctx.ident.email or "")
        d_ = self.cfg.limit_defaults
        defaults = t("create_defaults", vault=whole_bytes(ctx.bytes(d_["vault_bytes"])), value=whole_bytes(ctx.bytes(d_["max_value_bytes"])),
                     versions=d_["history_versions"], vaults=d_["max_vaults"])
        more_open = expert or bool(error and v and (v.get("slug") or enroll != "join_code" or not v.get("hibp")))
        more = (f'<details class="expert" id="create-more"{" open" if more_open else ""}><summary>{t("create_more")}</summary>'
                f'<label for="c_slug">{t("f_slug")}</label><input type="text" id="c_slug" name="slug" maxlength="30" pattern="[a-z][a-z0-9\\-]*" value="{esc(v.get("slug"))}">'
                f'<p class="hint">{t("f_slug_hint")}</p>'
                f'<label for="c_enroll">{t("f_enrollment")}</label><select id="c_enroll" name="enrollment">{opts}</select>'
                f'<p class="hint">{t("f_enrollment_hint")}</p>'
                f'<p><input type="checkbox" id="c_hibp" name="hibp" value="1"{hibp_checked}> <label class="inline" for="c_hibp">{t("f_hibp")}</label></p>'
                f'<p class="hint">{t("f_hibp_hint")}</p></details>')
        inner = (
            f'<label for="c_name">{t("f_name")}</label><input type="text" id="c_name" name="name" required maxlength="100" value="{esc(v.get("name"))}">'
            f'<p class="hint">{t("f_name_hint")}</p>'
            f'<label for="c_mail">{t("f_contact")}</label><input type="email" id="c_mail" name="contact_email" required maxlength="254" value="{esc(contact)}">'
            f'<p class="hint">{t("f_contact_hint")}</p>'
            f'<label for="c_desc">{t("f_description")}</label><textarea id="c_desc" name="description" maxlength="1000">{esc(v.get("description"))}</textarea>'
            f'<p class="hint">{t("f_description_hint")}</p>'
            f'<p class="box" id="create-defaults">{defaults}</p>' + more
            + (self.form_error("create", error) if error else "") + f'<button type="submit">{t("create_scope")}</button>')
        return (f'<h2>{t("create_title")}</h2><details{" open" if open_ else ""}><summary>{t("create_summary")}</summary>'
                + ctx.form("/scopes", inner) + "</details>")

    async def create(self, request, ctx: Ctx, form) -> Response:
        if not ctx.ident:
            raise DashError(401, "err_login")
        if not ctx.ident.can_create:
            raise DashError(403, "err_not_staff")
        v = {"name": form.get("name", ""), "slug": form.get("slug", ""), "description": form.get("description", ""),
             "contact_email": form.get("contact_email", ""), "enrollment": form.get("enrollment", "join_code"),
             "hibp": form.get("hibp") == "1"}

        def work():
            if self.svc.read_only():
                raise DashError(503, "err_read_only")
            name = validate_name(v["name"])
            contact = validate_contact_email(v["contact_email"], required=True)
            slug = v["slug"].strip().lower() or slugify(name)
            if not SLUG_RE.fullmatch(slug) or len(slug) > 30:
                raise DashError(400, "err_slug")
            with self.svc.db.connection() as conn:
                with transaction(conn):
                    if not ctx.ident.operator and conn.execute(
                            "SELECT COUNT(*) FROM scopes WHERE creator=? AND deleted IS NULL",
                            (ctx.ident.username,)).fetchone()[0] >= MAX_SCOPES_PER_CREATOR:
                        raise DashError(409, "err_scope_cap", str(MAX_SCOPES_PER_CREATOR))
                    check_disk_budget(self.svc, conn, None, {})
                    row = create_scope(self.svc, conn, slug=slug, name=name, enrollment=v["enrollment"], hibp=v["hibp"],
                                       description=v["description"], contact_email=contact, creator=ctx.ident.username)
                    conn.execute("INSERT INTO scope_admins (scope_id, admin, role, added_by, added) VALUES (?,?,?,?,?)",
                                 (row["scope_id"], ctx.ident.username, "creator", ctx.ident.username, self.svc.now()))
                    self.svc.audit(conn, actor_of(ctx), "scope_created", row["scope_id"])
                    return row["scope_id"]

        try:
            scope_id = await self.svc.run(work)
        except (DashError, ApiError) as err:
            msg = err.text(ctx.t) if isinstance(err, DashError) else esc(err.message)
            return await self.render_home(request, ctx, error=msg, values=v, status=err.status if err.status < 500 else 503)
        return self.redirect(ctx, "/scopes/" + scope_id, "created")

    # -- one scope ----------------------------------------------------------------------------------------------------------

    def access(self, conn, ctx: Ctx, scope_id: str, *, admin: bool = False, operator_ok: bool = False):
        """(scope row, role) with role creator, admin or operator; unknown or foreign scopes look like 404."""
        if not ctx.ident:
            raise DashError(401, "err_login")
        row = conn.execute("SELECT * FROM scopes WHERE scope_id=? AND deleted IS NULL", (scope_id,)).fetchone() \
            if valid_scope_id(scope_id) else None
        if row is None:
            raise DashError(404, "err_not_found")
        role = access.scope_admin_role(conn, ctx.ident, scope_id)
        if role:
            return row, role
        if ctx.ident.operator and (operator_ok or not admin):
            return row, "operator"
        if ctx.ident.operator:
            raise DashError(403, "err_forbidden")
        raise DashError(404, "err_not_found")

    @staticmethod
    def locked_for(ctx: Ctx, row) -> bool:
        """True when the operator holds the scope suspended: its admins cannot change anything until the operator resumes it."""
        return row["status"] == "suspended" and row["suspended_by"] != "admin" and not ctx.ident.operator

    def library_tag(self) -> str | None:
        try:
            hashes = json.loads((self.svc.client_dir / "hashes.json").read_text(encoding="utf-8"))
            entry = hashes.get(self.svc.library_latest())
            if entry is None:
                version = max(hashes, key=lambda s: [int(x) if x.isdigit() else 0 for x in re.split(r"[.-]", s)])
                entry = hashes[version]
            base = self.cfg.public_base.rstrip("/")
            return f'<script src="{base}/client/{entry["file"]}" integrity="{entry["sri"]}" crossorigin="anonymous"></script>'
        except (OSError, ValueError, KeyError):
            return None

    def prompt(self, ctx: Ctx, row, tag: str | None) -> tuple[str, str]:
        """(prompt, CLAUDE.md snippet) for a scope: its settings as of today, the library tag, the porting pointer and, when
        the server has a sandbox, how to test against it. Plain text; the page escapes it."""
        sid = row["scope_id"]
        base = self.cfg.public_base.rstrip("/")
        limits = self.svc.scope_limits(row)
        sb = self.cfg.sandbox
        sandbox_id = sb.scope_id if sb else None
        snippet = prompt_mod.claude_md(sid=sid, base=base, repo_url=REPO_URL, sandbox_id=sandbox_id, enrollment=row["enrollment"])
        text = prompt_mod.prompt(
            ctx.lang, sid=sid, date=ctx.date(self.svc.now()), base=base, repo_url=REPO_URL, sandbox_id=sandbox_id,
            tag=tag or ctx.pick("(Das Skript-Tag steht in llms.txt.)", "(The script tag is in llms.txt.)"),
            enrollment=row["enrollment"], hibp=bool(row["hibp"]), max_vaults=limits["max_vaults"],
            max_value=whole_bytes(ctx.bytes(limits["max_value_bytes"])), vault_bytes=whole_bytes(ctx.bytes(limits["vault_bytes"])),
            history_versions=limits["history_versions"], snippet=snippet)
        return text, snippet

    def load_scope(self, ctx: Ctx, scope_id: str):
        with self.svc.db.connection() as conn:
            row, role = self.access(conn, ctx, scope_id)
            vaults = conn.execute(
                "SELECT v.vault_id, v.created, v.last_write, v.bytes, v.roster_bytes, v.deleted, v.epoch,"
                " (SELECT COUNT(*) FROM slots s WHERE s.vault_id=v.vault_id AND s.revoked IS NULL"
                "   AND (s.kind='passphrase' OR s.redeemed IS NOT NULL)) AS members,"
                " (SELECT COUNT(*) FROM record_versions rv WHERE rv.vault_id=v.vault_id AND rv.epoch IS NOT NULL"
                "   AND rv.epoch < v.epoch) AS old_blobs"
                " FROM vaults v WHERE v.scope_id=? ORDER BY v.created DESC, v.vault_id LIMIT 1000", (scope_id,)).fetchall()
            admins = conn.execute("SELECT * FROM scope_admins WHERE scope_id=? ORDER BY role, admin", (scope_id,)).fetchall()
            audit = conn.execute("SELECT * FROM audit WHERE scope_id=? ORDER BY id DESC LIMIT 15", (scope_id,)).fetchall()
            return row, role, vaults, admins, audit

    async def scope_page(self, request, ctx: Ctx) -> Response:
        redirect = self.need_login(request, ctx)
        if redirect:
            return redirect
        return await self.render_scope(request, ctx, request.path_params["scope"])

    def expert_pref(self, request) -> bool:
        """The person asked this browser to show the expert settings opened (cookie wds_expert=1)."""
        return request.cookies.get(EXPERT_COOKIE) == "1"

    async def render_scope(self, request, ctx: Ctx, scope_id: str, *, error: str | None = None, status: int = 200,
                           values: dict | None = None, field: str | None = None) -> Response:
        t = ctx.t
        values = values or {}
        top_error = error if error and not field else None   # an error that belongs to a form is shown there

        def err_for(name: str) -> str:
            return self.form_error(name, error) if error and field == name else ""
        row, role, vaults, admins, audit = await self.svc.run(self.load_scope, ctx, scope_id)
        can_edit = role in ("creator", "admin") and not self.locked_for(ctx, row)
        limits = self.svc.scope_limits(row)
        own = json.loads(row["limits"] or "{}")
        tag = self.library_tag()
        notice = request.query_params.get("notice")
        sid = row["scope_id"]
        is_sb = self.svc.is_sandbox(sid)
        suspended = row["status"] == "suspended"
        title = esc(row["name"]) + (f' <span class="small">{self.status_badge(ctx, row)}</span>' if suspended else "")
        p = [f'<p><a href="{ctx.url("/")}">&larr; {t("my_scopes")}</a></p><h1>{title}</h1>']
        if notice in NOTICES:
            p.append(f'<div class="notice" role="status">{t("notice_" + notice)}</div>')
        if top_error:
            p.append(f'<div class="error" role="alert">{top_error}</div>')
        if is_sb:
            p.append(f'<div class="box">{t("sandbox_readonly")}</div>')
            can_edit = False
        elif role == "operator":
            p.append(f'<div class="box">{t("operator_view")}</div>')
        # ---- the default view: what a person who is not a developer needs ------------------------------------------------
        if not is_sb:
            if suspended:
                p.append(self.suspend_controls(ctx, row, role))
            p.append(self.steps_section(ctx, row, tag, can_edit, limits))
            p.append(self.usage_section(ctx, row, vaults, limits, can_edit))
            p.append(self.help_section(ctx, row))
        # ---- the expert area -------------------------------------------------------------------------------------------------
        x = []
        to_here = ctx.href("/scopes/" + sid)
        pref_on = self.expert_pref(request)
        x.append(ctx.form("/prefs/expert", f'<input type="hidden" name="on" value="{0 if pref_on else 1}">'
                          f'<input type="hidden" name="next" value="{esc(to_here)}">'
                          f'<button type="submit" class="secondary small">{t("expert_forget" if pref_on else "expert_remember")}</button> '
                          f'<span class="hint">{t("expert_remember_hint")}</span>'))
        x.append(f'<dl class="facts">'
                 + (f'<dt>{t("col_scope_id")}</dt><dd><code id="sid">{esc(sid)}</code></dd>' if is_sb else "")
                 + f'<dt>{t("col_status")}</dt><dd>{self.status_badge(ctx, row)}</dd>'
                 f'<dt>{t("f_contact")}</dt><dd>{esc(row["contact_email"]) or "–"}</dd>'
                 f'<dt>{t("created")}</dt><dd>{ctx.time(row["created"])}</dd>'
                 f'<dt>{t("f_enrollment")}</dt><dd>{t("enroll_" + row["enrollment"])}</dd>'
                 f'<dt>{t("f_hibp")}</dt><dd>{t("yes") if row["hibp"] else t("no")}</dd></dl>')
        if row["description"]:
            p_desc = f'<p>{esc(row["description"])}</p>'
            x.append(p_desc)
        if is_sb:
            x.append(self.sandbox_facts(ctx))
        else:
            x.append(self.integration_section(ctx, row, tag))
        if can_edit:
            retyped = field == "settings" and bool(values)
            hibp_checked = " checked" if (values.get("hibp") == "1" if retyped else row["hibp"]) else ""

            def shown(key: str) -> str:
                return esc(values.get(key, "") if retyped else row[key])
            x.append(f'<h3>{t("sec_settings")}</h3>' + ctx.form(f"/scopes/{sid}/settings",
                f'<label for="s_name">{t("f_name")}</label><input type="text" id="s_name" name="name" required maxlength="100" value="{shown("name")}">'
                f'<label for="s_desc">{t("f_description")}</label><textarea id="s_desc" name="description" maxlength="1000">{shown("description")}</textarea>'
                f'<label for="s_mail">{t("f_contact")}</label><input type="email" id="s_mail" name="contact_email" required maxlength="254" value="{shown("contact_email")}">'
                f'<p class="hint">{t("f_contact_hint")}</p>'
                f'<p><input type="checkbox" id="s_hibp" name="hibp" value="1"{hibp_checked}> <label class="inline" for="s_hibp">{t("f_hibp")}</label></p>'
                f'<p class="hint">{t("f_hibp_hint")}</p>{err_for("settings")}<button type="submit">{t("save")}</button>'))
            opts = "".join(f'<option value="{e}"{" selected" if e == row["enrollment"] else ""}>{t("enroll_" + e)}</option>' for e in ENROLLMENTS)
            x.append(f'<h3 id="enrollment">{t("sec_enrollment")}</h3><p>{t("f_enrollment_hint")}</p>'
                     + ctx.form(f"/scopes/{sid}/enrollment", f'<label for="e_mode">{t("f_enrollment")}</label><select id="e_mode" name="enrollment">{opts}</select>'
                                f'<button type="submit">{t("save")}</button>'))
            x.append(self.limits_form(ctx, row, limits, own, err_for("limits"), values if field == "limits" else {}))
        else:
            x.append(f'<h3 id="limits">{t("sec_limits")}</h3>' + self.limits_table(ctx, limits, own))
        if is_sb:  # the configuration file owns the sandbox: no admin list to show or to edit
            x.append(f'<h3>{t("sec_admins")}</h3><p>{t("sandbox_admins")}</p>')
        else:
            x.append(self.admins_section(ctx, row, admins, can_edit, err_for("admin"), values.get("admin", "") if field == "admin" else ""))
        x.append(self.vaults_section(ctx, row, vaults, can_edit))
        x.append(f'<h3>{t("sec_audit")}</h3><p class="hint">{t("audit_hint", tz=TZ_NAME)}</p>' + self.audit_table(ctx, audit)
                 + f'<p><a href="{ctx.url("/scopes/" + sid + "/audit")}">{t("audit_all")}</a></p>')
        if not is_sb and not suspended:
            x.append(f'<h3>{t("suspend")}</h3>' + self.suspend_controls(ctx, row, role))
        # the operator may delete a scope, too: it frees the disk budget
        if (can_edit or role == "operator") and not is_sb:
            x.append(f'<h3>{t("sec_danger")}</h3><p>{t("delete_scope_text", days=DELETED_VAULT_TTL // 86400)}</p>'
                     + ctx.form(f"/scopes/{sid}/delete",
                                f'<label for="d_conf">{t("delete_scope_confirm", scope=sid)}</label>'
                                f'<input type="text" id="d_conf" name="confirm" autocomplete="off" required{self.invalid_attrs(err_for("danger"))}>'
                                f'{err_for("danger")}<button type="submit" class="danger">{t("delete_scope")}</button>'))
        opened = bool(ctx.ident.operator or pref_on or field or notice in EXPERT_NOTICES)
        p.append(f'<details class="expert" id="expert"{" open" if opened else ""}><summary>{t("expert_title")}</summary>'
                 f'<p class="hint">{t("expert_hint")}</p>' + "".join(x) + "</details>")
        return render(ctx, row["name"], "".join(p), status=status)

    def steps_section(self, ctx: Ctx, row, tag: str | None, can_edit: bool, limits: dict) -> str:
        """"Next steps": the text for Claude, the join code (or what the enrollment setting means), the guide for the users."""
        t = ctx.t
        sid = row["scope_id"]
        prompt_text, _snippet = self.prompt(ctx, row, tag)
        copy = lambda target: (f'<button type="button" class="secondary small" data-copy="{target}" data-done="{t("copied")}">{t("copy")}</button>')
        steps = [f'<li><p class="step-title">{t("step_prompt")}</p><p class="hint">{t("claude_prompt_hint")}</p>'
                 f'<div class="scrollbox" role="group" tabindex="0" aria-label="{t("claude_prompt")}"><pre id="prompt">{esc(prompt_text)}</pre></div>{copy("prompt")}'
                 + ("" if tag else f'<div class="error">{t("no_hashes")}</div>') + "</li>"]
        mode = row["enrollment"]
        if mode == "join_code":
            if can_edit:
                steps.append(f'<li><p class="step-title">{t("step_code")}</p><p><code id="jc" class="big">{esc(row["join_code"])}</code> {copy("jc")}</p>'
                             f'<p class="hint">{t("join_code_hint")}</p><p class="hint">{t("join_code_claude_hint")}</p>'
                             + ctx.form(f"/scopes/{sid}/join-code", f'<button type="submit" class="secondary small">{t("rotate_code")}</button>',
                                        confirm=t("rotate_confirm")) + "</li>")
        elif mode == "open":
            steps.append(f'<li><p class="step-title">{t("step_code")}</p><p>{t("step_code_open", n=limits["max_vaults"])}</p></li>')
        else:
            steps.append(f'<li><p class="step-title">{t("step_code")}</p><p>{t("step_code_closed")}</p></li>')
        users = esc(BASE + "/docs/" + ctx.pick("users.de", "users.en"))
        steps.append(f'<li><p class="step-title">{t("step_users")}</p><p>{t("step_users_hint")} <a href="{users}">{t("users_doc")}</a></p></li>')
        return f'<h2 id="next-steps">{t("next_steps")}</h2><ol class="steps">{"".join(steps)}</ol>'

    def usage_section(self, ctx: Ctx, row, vaults, limits: dict, can_edit: bool) -> str:
        t = ctx.t
        active = [v for v in vaults if not v["deleted"]]
        used = sum(v["bytes"] + v["roster_bytes"] for v in active)
        near = len(active) >= 0.8 * limits["max_vaults"] or used >= 0.8 * limits["scope_bytes"]
        official = prompt_mod.PRIVACY_EN if ctx.lang == "en" else prompt_mod.PRIVACY_DE
        out = (f'<h2 id="usage">{t("usage_title")}</h2><p><strong>{t("usage_text", n=len(active), max=limits["max_vaults"], size=ctx.bytes(used), quota=ctx.bytes(limits["scope_bytes"]))}</strong></p>'
               + (f'<div class="box" role="status">{t("usage_near")}</div>' if near else "")
               + f'<p>{t("vault_explain")}</p><p>{t("who_reads", official=official, privacy_url=ctx.href("/privacy"))}</p>')
        return out

    def help_section(self, ctx: Ctx, row) -> str:
        t = ctx.t
        contact = self.cfg.help_contact
        line = ""
        if contact:
            shown = esc(contact)
            link = f'<a href="mailto:{shown}">{shown}</a>' if re.fullmatch(r"[^@\s<>\"]+@[^@\s<>\"]+", contact) else shown
            line = f'<p>{t("help_contact", contact="@@C@@").replace("@@C@@", link)}</p>'
        return (f'<h2 id="help">{t("help_title")}</h2><p>{t("help_text", docs=BASE + "/docs/", porting=BASE + "/docs/porting", users=BASE + "/docs/" + ctx.pick("users.de", "users.en"))}</p>{line}'
                f'<p><strong>{t("col_scope_id")}</strong> <code id="sid">{esc(row["scope_id"])}</code> '
                f'<button type="button" class="secondary small" data-copy="sid" data-done="{t("copied")}">{t("copy")}</button></p>'
                f'<p class="hint">{t("sid_hint")}</p>')

    def integration_section(self, ctx: Ctx, row, tag: str | None) -> str:
        """For developers (inside the expert area): the script tag and the section for CLAUDE.md / AGENTS.md."""
        t = ctx.t
        p: list[str] = [f'<h3 id="integration">{t("sec_integration")}</h3><p>{t("integration_intro")}</p>']
        if tag:
            p.append(f'<h4>{t("script_tag")}</h4><pre id="tag">{esc(tag)}</pre>'
                     f'<button type="button" class="secondary small" data-copy="tag" data-done="{t("copied")}">{t("copy")}</button>')
        _prompt_text, snippet = self.prompt(ctx, row, tag)
        p.append(f'<h4>{t("claude_md_title")}</h4><p class="hint">{t("claude_md_hint")}</p><pre id="claude-md">{esc(snippet)}</pre>'
                 f'<button type="button" class="secondary small" data-copy="claude-md" data-done="{t("copied")}">{t("copy")}</button>')
        return "".join(p)

    def sandbox_facts(self, ctx: Ctx) -> str:
        """Operator view of the sandbox scope: when it is wiped next and when it was wiped last (read-only)."""
        t = ctx.t
        doc = sandbox_doc(self.svc, self.cfg.sandbox.scope_id)
        return (f'<dl class="facts"><dt>{t("sb_enabled")}</dt><dd>{t("yes") if doc["enabled"] else t("no")}</dd>'
                f'<dt>{t("sb_wipe_at")}</dt><dd>{esc(doc["wipe_at"])} ({esc(doc["timezone"])})</dd>'
                f'<dt>{t("sb_next_wipe")}</dt><dd>{ctx.time(doc["next_wipe"])}</dd>'
                f'<dt>{t("sb_last_wipe")}</dt><dd>{ctx.time(doc["last_wipe"])}</dd></dl>')

    def suspend_controls(self, ctx: Ctx, row, role: str) -> str:
        t = ctx.t
        sid = row["scope_id"]
        if row["status"] == "active":
            btn = ctx.form(f"/scopes/{sid}/suspend", f'<button type="submit" class="danger">{t("suspend")}</button>',
                           confirm=t("suspend_confirm"))
            return f'<div class="row">{btn}<span class="hint">{t("suspend_hint")}</span></div>'
        if role == "operator" or row["suspended_by"] == "admin" or ctx.ident.operator:
            lock = ""
            if ctx.ident.operator and row["suspended_by"] == "admin":  # an admin suspension that the admins could undo
                lock = (ctx.form(f"/scopes/{sid}/suspend", f'<button type="submit" class="danger">{t("lock_scope")}</button>',
                                 confirm=t("lock_confirm")) + f'<span class="hint">{t("lock_hint")}</span>')
            return (f'<div class="row">' + ctx.form(f"/scopes/{sid}/resume", f'<button type="submit">{t("resume")}</button>')
                    + lock + "</div>")
        return f'<p class="muted">{t("suspended_by_operator")}</p>'

    def limits_table(self, ctx: Ctx, limits: dict, own: dict) -> str:
        t = ctx.t
        rows = []
        for k in LIMIT_KEYS:
            rows.append(tr(t("lim_" + k), (self.fmt_limit(ctx, k, self.cfg.limit_defaults[k]), "num"),
                           (self.fmt_limit(ctx, k, self.cfg.limit_ceilings[k]), "num"), (self.fmt_limit(ctx, k, limits[k]), "num")))
        return table([(t("col_limit"), ""), (t("col_default"), "num"), (t("col_ceiling"), "num"), (t("col_current"), "num")], rows)

    @staticmethod
    def fmt_limit(ctx: Ctx, key: str, value: int) -> str:
        return ctx.bytes(value) if key in BYTE_LIMITS else str(value)

    @staticmethod
    def form_error(name: str, message: str) -> str:
        """An error shown inside the form it belongs to: announced, and focused so that the page scrolls to it."""
        return f'<div class="error" role="alert" id="{name}-err" tabindex="-1" autofocus>{message}</div>'

    @staticmethod
    def invalid_attrs(error_html: str) -> str:
        return ' aria-invalid="true"' if error_html else ""

    def limits_form(self, ctx: Ctx, row, limits: dict, own: dict, error_html: str = "", typed: dict | None = None) -> str:
        t = ctx.t
        typed = typed or {}
        rows = []
        for k in LIMIT_KEYS:
            unit = "MB" if k in BYTE_LIMITS else ""
            div = MIB if k in BYTE_LIMITS else 1
            ceil = -(-self.cfg.limit_ceilings[k] // div)
            default = self.cfg.limit_defaults[k] // div
            value = esc(typed[k]) if k in typed else (str(own[k] // div) if k in own else "")
            field = (f'<input type="number" id="l_{k}" name="{k}" min="1" max="{ceil}" value="{value}" placeholder="{default}" '
                     f'aria-label="{esc(t("lim_" + k))} {unit}">')
            rows.append(tr(f'<label class="inline" for="l_{k}">{t("lim_" + k)}</label>',
                           (self.fmt_limit(ctx, k, self.cfg.limit_defaults[k]), "num"), (self.fmt_limit(ctx, k, self.cfg.limit_ceilings[k]), "num"),
                           (self.fmt_limit(ctx, k, limits[k]), "num"), field + (f' <span class="muted">{unit}</span>' if unit else "")))
        tbl = table([(t("col_limit"), ""), (t("col_default"), "num"), (t("col_ceiling"), "num"), (t("col_current"), "num"),
                     (t("col_new_value"), "")], rows)
        return (f'<h3 id="limits">{t("sec_limits")}</h3><p>{t("limits_hint")}</p>'
                + ctx.form(f"/scopes/{row['scope_id']}/limits", tbl + error_html + f'<button type="submit">{t("save")}</button>'))

    def admins_section(self, ctx: Ctx, row, admins, can_edit: bool, error_html: str = "", typed: str = "") -> str:
        t = ctx.t
        sid = row["scope_id"]
        rows = []
        for a in admins:
            remove = ""
            if can_edit and a["role"] != "creator":
                remove = ctx.form(f"/scopes/{sid}/admins/remove", f'<input type="hidden" name="admin" value="{esc(a["admin"])}">'
                                  f'<button type="submit" class="danger small">{t("remove")}</button>', confirm=t("remove_confirm"))
            rows.append(tr(esc(a["admin"]), f'<span class="badge">{t("role_" + a["role"])}</span>', esc(a["added_by"] or "–"),
                           ctx.time(a["added"]), remove))
        out = f'<h3 id="admins">{t("sec_admins")}</h3><p>{t("admins_hint")}</p>'
        out += table([(t("col_admin"), ""), (t("col_role"), ""), (t("col_added_by"), ""), (t("col_added"), ""), ("", "")], rows, t("no_admins"))
        if can_edit:
            out += ctx.form(f"/scopes/{sid}/admins", f'<label for="a_new">{t("add_admin")}</label>'
                            f'<input type="text" id="a_new" name="admin" required maxlength="254" autocomplete="off" value="{esc(typed)}"'
                            f'{self.invalid_attrs(error_html)}>'
                            f'{error_html}<p class="hint">{t("add_admin_hint")}</p><button type="submit">{t("add")}</button>')
        return out

    def vaults_section(self, ctx: Ctx, row, vaults, can_edit: bool) -> str:
        t = ctx.t
        sid = row["scope_id"]
        rows = []
        for v in vaults:
            if v["deleted"]:
                state = f'<span class="badge bad">{t("vault_deleted")}</span> <span class="small muted">{t("purge_on", when=ctx.time(v["deleted"] + DELETED_VAULT_TTL))}</span>'
            else:
                state = f'<span class="badge good">{t("vault_active")}</span>'
            reenc = (f'<span class="badge warn">{t("yes")} ({v["old_blobs"]})</span>' if v["old_blobs"] else t("no"))
            action = ""
            if can_edit and not v["deleted"]:
                action = ctx.form(f"/scopes/{sid}/vaults/{v['vault_id']}/delete", f'<button type="submit" class="danger small">{t("delete")}</button>',
                                  confirm=t("delete_vault_confirm"))
            rows.append(tr(f'<code>{esc(v["vault_id"])}</code>', ctx.time(v["created"]), ctx.time(v["last_write"]),
                           (ctx.bytes(v["bytes"] + v["roster_bytes"]), "num"), (str(v["members"]), "num"), reenc, state, action))
        return (f'<h3 id="vaults">{t("sec_vaults")}</h3><p>{t("vaults_hint")}</p><p>{t("vault_explain")}</p>'
                + table([(t("col_vault"), ""), (t("created"), ""), (t("col_last_write"), ""), (t("col_size"), "num"),
                         (t("col_members"), "num"), (t("col_reencrypt"), ""), (t("col_state"), ""), ("", "")], rows, t("no_vaults")))

    @staticmethod
    def audit_actor(ctx: Ctx, actor: str) -> str:
        """The actor column in words: "user:alice" is "Nutzer:in alice", "slot" is an access without a name."""
        t = ctx.t
        kind, _, name = (actor or "").partition(":")
        if name and kind == "user":
            return t("actor_user", name=name)
        if name and kind == "operator":
            return t("actor_operator_user", name=name)
        known = {"slot": "actor_slot", "operator": "actor_operator", "system": "actor_system", "cli": "actor_cli"}
        return t(known[actor]) if actor in known else esc(actor)

    def audit_detail(self, ctx: Ctx, action: str, detail: str | None) -> str:
        """The detail column in words where the entry is a known one; anything else is shown as stored."""
        t = ctx.t
        if not detail:
            return ""
        if action == "limits_updated":
            parts = []
            for item in detail.split(","):
                key, _, value = item.partition("=")
                if key not in LIMIT_KEYS:
                    return esc(detail)
                shown = t("detail_default") if value == "default" else (self.fmt_limit(ctx, key, int(value)) if value.isdigit() else esc(value))
                parts.append(f"{t('lim_' + key)}: {shown}")
            return "; ".join(parts)
        if action in ("revocation", "roster_updated", "recovery_completed") and detail.startswith("version=") and detail[8:].isdigit():
            return t("detail_version", n=detail[8:])
        if action == "enrollment_changed" and detail in ENROLLMENTS:
            return t("enroll_" + detail)
        if action == "login_denied" and detail in ("not_allowed", "blocked"):
            return t("detail_" + detail)
        if action == "vault_purged" and detail in ("deleted", "empty"):
            return t("detail_" + detail)
        if action in ("sandbox_evicted", "vault_deleted") and detail in ("capacity", "owner"):
            return t("detail_" + detail)
        if action == "sandbox_wiped" and detail.isdigit():
            return t("detail_sandbox_wiped", n=detail)
        if action == "scope_updated":
            names = {"name": "f_name", "description": "f_description", "contact_email": "f_contact", "hibp": "detail_hibp",
                     "enrollment": "f_enrollment", "limits": "sec_limits"}
            out = []
            for item in detail.split(", "):
                word, _, rest = item.partition(" ")
                out.append((t(names[word]) + (" " + esc(rest) if rest else "")) if word in names else esc(item))
            return ", ".join(out)
        return esc(detail)

    def audit_table(self, ctx: Ctx, rows, show_scope: bool = False) -> str:
        t = ctx.t
        body = []
        for a in rows:
            known = "act_" + a["action"] in TEXTS
            action = t("act_" + a["action"]) if known else f'<code>{esc(a["action"])}</code>'
            cells = [(ctx.time(a["ts"]), "nowrap"), self.audit_actor(ctx, a["actor"]), action]
            if show_scope:
                cells.append(f'<code>{esc(a["scope_id"])}</code>' if a["scope_id"] else "")
            cells += [f'<code class="small">{esc(a["vault_id"])}</code>' if a["vault_id"] else "", (self.audit_detail(ctx, a["action"], a["detail"]), "wrap")]
            body.append(tr(*cells))
        heads = [(t("col_time"), ""), (t("col_actor"), ""), (t("col_action"), "")] + ([(t("col_scope_id"), "")] if show_scope else []) \
            + [(t("col_vault"), ""), (t("col_detail"), "")]
        return table(heads, body, t("no_audit"))

    async def audit_page(self, request, ctx: Ctx) -> Response:
        redirect = self.need_login(request, ctx)
        if redirect:
            return redirect
        scope_id = request.path_params["scope"]

        def work():
            with self.svc.db.connection() as conn:
                row, role = self.access(conn, ctx, scope_id)
                return row, conn.execute("SELECT * FROM audit WHERE scope_id=? ORDER BY id DESC LIMIT 500", (scope_id,)).fetchall()

        row, rows = await self.svc.run(work)
        t = ctx.t
        body = (f'<p><a href="{ctx.url("/scopes/" + scope_id)}">&larr; {esc(row["name"])}</a></p><h1>{t("sec_audit")}</h1>'
                f'<p class="hint">{t("audit_hint", tz=TZ_NAME)} {t("audit_retention", days=AUDIT_RETENTION // 86400)}</p>' + self.audit_table(ctx, rows))
        return render(ctx, t("sec_audit"), body)

    # -- scope actions --------------------------------------------------------------------------------------------------

    async def action(self, request, ctx: Ctx, scope_id: str, fn, notice: str, *, admin: bool = True, operator_ok: bool = False,
                     field: str | None = None, form: dict | None = None):
        """Run fn(conn, row, role) in one transaction, then redirect with a notice or show the scope page with the error.
        field names the form the error belongs to: the page then shows it inside that form (and keeps what was typed in).
        Without field the error is shown at the top."""
        if not ctx.ident:
            raise DashError(401, "err_login")

        def work():
            with self.svc.db.connection() as conn:
                with transaction(conn):
                    if ctx.ident.operator and self.svc.is_sandbox(scope_id):  # before the role check: the answer is the same for every action
                        raise DashError(403, "err_sandbox_config")
                    row, role = self.access(conn, ctx, scope_id, admin=admin, operator_ok=operator_ok)
                    if self.svc.is_sandbox(row["scope_id"]):  # the configuration file owns it: nothing here may change it
                        raise DashError(403, "err_sandbox_config")
                    if admin and self.locked_for(ctx, row):
                        raise DashError(403, "err_suspended_operator_locked")
                    return fn(conn, row, role)

        try:
            result = await self.svc.run(work)
        except ApiError as err:
            if err.status >= 500:
                raise
            return await self.render_scope(request, ctx, scope_id, error=esc(err.message), status=err.status, field=field, values=form)
        except DashError as err:
            if err.status in (401, 403, 404):
                raise
            return await self.render_scope(request, ctx, scope_id, error=err.text(ctx.t), status=err.status,
                                           field=field, values=form)
        if isinstance(result, Response):
            return result
        return self.redirect(ctx, "/scopes/" + scope_id, notice)

    async def post_settings(self, request, ctx: Ctx, form) -> Response:
        def fn(conn, row, role):
            changes = {"name": form.get("name", ""), "description": form.get("description", ""),
                       "contact_email": form.get("contact_email", ""), "hibp": form.get("hibp") == "1"}
            if not changes["contact_email"].strip():
                raise DashError(400, "err_required")
            new = patch_scope(self.svc, conn, row["scope_id"], changes)
            what = [k for k in ("name", "description", "hibp") if row[k] != new[k]]
            if row["contact_email"] != new["contact_email"]:
                what.append(f"contact_email {row['contact_email'] or '-'} -> {new['contact_email'] or '-'}")
            if what:  # a save that changes nothing leaves no entry
                self.svc.audit(conn, actor_of(ctx), "scope_updated", row["scope_id"], None, ", ".join(what))

        return await self.action(request, ctx, request.path_params["scope"], fn, "saved", field="settings", form=form)

    async def post_enrollment(self, request, ctx: Ctx, form) -> Response:
        def fn(conn, row, role):
            patch_scope(self.svc, conn, row["scope_id"], {"enrollment": form.get("enrollment", "")})
            self.svc.audit(conn, actor_of(ctx), "enrollment_changed", row["scope_id"], None, form.get("enrollment"))

        return await self.action(request, ctx, request.path_params["scope"], fn, "saved")

    async def post_join_code(self, request, ctx: Ctx, form) -> Response:
        def fn(conn, row, role):
            patch_scope(self.svc, conn, row["scope_id"], {"join_code": new_join_code()})
            self.svc.audit(conn, actor_of(ctx), "join_code_rotated", row["scope_id"])

        return await self.action(request, ctx, request.path_params["scope"], fn, "code_rotated")

    async def post_limits(self, request, ctx: Ctx, form) -> Response:
        def fn(conn, row, role):
            changes = {}
            for k in LIMIT_KEYS:
                raw = form.get(k, "").strip()
                if raw == "":
                    changes[k] = None
                else:
                    div = MIB if k in BYTE_LIMITS else 1
                    hi = -(-self.cfg.limit_ceilings[k] // div)            # the same ceiling the form shows
                    n = parse_int(raw, ctx.t("lim_" + k), 1, hi, "MB" if k in BYTE_LIMITS else "")
                    changes[k] = n * div
            merged = {k: v for k, v in json.loads(row["limits"] or "{}").items() if k not in changes}
            merged.update({k: v for k, v in changes.items() if v is not None})
            validate_limits(self.svc, changes, allow_reset=True)  # ceilings first, so their message wins
            check_disk_budget(self.svc, conn, row["scope_id"], merged)  # before the update: it reads the stored limits
            patch_scope(self.svc, conn, row["scope_id"], {"limits": changes})  # also refuses values below stored data
            self.svc.audit(conn, actor_of(ctx), "limits_updated", row["scope_id"], None,
                           ",".join(f"{k}={'default' if v is None else v}" for k, v in changes.items()))

        return await self.action(request, ctx, request.path_params["scope"], fn, "limits", field="limits", form=form)

    async def post_admin_add(self, request, ctx: Ctx, form) -> Response:
        def fn(conn, row, role):
            who = access.normalise_admin(form.get("admin", ""))
            if who is None:
                raise DashError(400, "err_admin_format")
            if conn.execute("SELECT 1 FROM scope_admins WHERE scope_id=? AND admin=?", (row["scope_id"], who)).fetchone():
                raise DashError(409, "err_admin_exists")
            if conn.execute("SELECT COUNT(*) FROM scope_admins WHERE scope_id=?", (row["scope_id"],)).fetchone()[0] >= 20:
                raise DashError(409, "err_admin_limit")
            conn.execute("INSERT INTO scope_admins (scope_id, admin, role, added_by, added) VALUES (?,?,?,?,?)",
                         (row["scope_id"], who, "admin", ctx.ident.username, self.svc.now()))
            self.svc.audit(conn, actor_of(ctx), "admin_added", row["scope_id"], None, who)

        return await self.action(request, ctx, request.path_params["scope"], fn, "admin_added", field="admin", form=form)

    async def post_admin_remove(self, request, ctx: Ctx, form) -> Response:
        def fn(conn, row, role):
            who = form.get("admin", "").strip().lower()
            n = conn.execute("DELETE FROM scope_admins WHERE scope_id=? AND admin=? AND role='admin'", (row["scope_id"], who)).rowcount
            if not n:
                raise DashError(404, "err_not_found")
            self.svc.audit(conn, actor_of(ctx), "admin_removed", row["scope_id"], None, who)

        return await self.action(request, ctx, request.path_params["scope"], fn, "admin_removed")

    async def post_vault_delete(self, request, ctx: Ctx, form) -> Response:
        vault_id = request.path_params["vault"]

        def fn(conn, row, role):
            v = conn.execute("SELECT deleted FROM vaults WHERE vault_id=? AND scope_id=?", (vault_id, row["scope_id"])).fetchone() \
                if valid_vault_id(vault_id) else None
            if v is None or v["deleted"] is not None:
                raise DashError(404, "err_not_found")
            soft_delete_vault(self.svc, conn, vault_id, row["scope_id"], actor_of(ctx))

        return await self.action(request, ctx, request.path_params["scope"], fn, "vault_deleted")

    async def post_suspend(self, request, ctx: Ctx, form) -> Response:
        def fn(conn, row, role):
            by = "operator" if ctx.ident.operator else "admin"
            if row["status"] != "suspended":
                patch_scope(self.svc, conn, row["scope_id"], {"status": "suspended"}, suspended_by=by)
                self.svc.audit(conn, actor_of(ctx, role == "operator"), "scope_suspended", row["scope_id"])
            elif by == "operator" and row["suspended_by"] == "admin":  # the operator takes over: admins can no longer resume
                patch_scope(self.svc, conn, row["scope_id"], {"status": "suspended"}, suspended_by="operator")
                self.svc.audit(conn, actor_of(ctx, True), "scope_locked", row["scope_id"])
                return self.redirect(ctx, "/scopes/" + row["scope_id"], "locked")

        return await self.action(request, ctx, request.path_params["scope"], fn, "suspended", admin=False)

    async def post_resume(self, request, ctx: Ctx, form) -> Response:
        def fn(conn, row, role):
            if row["status"] == "suspended":
                if row["suspended_by"] != "admin" and not ctx.ident.operator:
                    raise DashError(403, "err_suspended_operator")
                patch_scope(self.svc, conn, row["scope_id"], {"status": "active"})
                self.svc.audit(conn, actor_of(ctx, role == "operator"), "scope_resumed", row["scope_id"])

        return await self.action(request, ctx, request.path_params["scope"], fn, "resumed", admin=False)

    async def post_prefs_expert(self, request, ctx: Ctx, form) -> Response:
        """Remember in this browser (a cookie, no database row) that the expert settings are shown opened, or forget it."""
        if not ctx.ident:
            raise DashError(401, "err_login")
        target = safe_next(form.get("next")).split("#")[0]
        if form.get("on") == "1":
            cookie = cookie_header(EXPERT_COOKIE, "1", max_age=EXPERT_COOKIE_AGE)
        else:
            cookie = cookie_header(EXPERT_COOKIE, "", max_age=0)
        return with_cookies(RedirectResponse(target + "#expert", status_code=303), cookie)

    async def post_scope_delete(self, request, ctx: Ctx, form) -> Response:
        def fn(conn, row, role):
            if form.get("confirm", "").strip() != row["scope_id"]:
                raise DashError(400, "err_confirm")
            delete_scope(self.svc, conn, row["scope_id"], actor_of(ctx, role == "operator"))
            return self.redirect(ctx, "/", None)

        return await self.action(request, ctx, request.path_params["scope"], fn, "", operator_ok=True, field="danger", form=form)

    # -- operator ---------------------------------------------------------------------------------------------------------

    def need_operator(self, request, ctx: Ctx):
        redirect = self.need_login(request, ctx)
        if redirect:
            return redirect
        if not ctx.ident.operator:
            raise DashError(403, "err_forbidden")
        return None

    def escrow_status(self, conn) -> dict:
        known = {(e.e_pub, e.s_pub): e.status for e in self.cfg.escrow}
        counts = {"current": 0, "spare": 0, "other": 0}
        for r in conn.execute("SELECT v.escrow_slot, r.body FROM vaults v JOIN rosters r ON r.vault_id=v.vault_id"
                              " AND r.version=v.roster_version WHERE v.deleted IS NULL"):
            try:
                slot = next(s for s in json.loads(r["body"])["slots"] if s["id"] == r["escrow_slot"])
                counts[known.get((slot["e_pub"], slot["s_pub"]), "other")] += 1
            except (StopIteration, KeyError, ValueError):
                counts["other"] += 1
        return counts

    async def operator_page(self, request, ctx: Ctx) -> Response:
        redirect = self.need_operator(request, ctx)
        if redirect:
            return redirect
        return await self.render_operator(request, ctx)

    async def render_operator(self, request, ctx: Ctx, *, error: str | None = None, status: int = 200, typed: dict | None = None) -> Response:
        t = ctx.t

        def work():
            with self.svc.db.connection() as conn:
                scopes = self.scope_rows(conn)
                blocked = conn.execute("SELECT * FROM blocked_users ORDER BY username").fetchall()
                recoveries = conn.execute(
                    "SELECT r.*, v.scope_id FROM recoveries r LEFT JOIN vaults v ON v.vault_id=r.vault_id"
                    " ORDER BY r.id DESC LIMIT 50").fetchall()
                audit = conn.execute("SELECT * FROM audit WHERE action LIKE 'recovery%' OR action LIKE 'escrow%'"
                                     " ORDER BY id DESC LIMIT 30").fetchall()
                committed = sum(self.svc.scope_limits(s)["scope_bytes"] for s in scopes)
                return scopes, blocked, recoveries, audit, self.escrow_status(conn), committed

        scopes, blocked, recoveries, audit, escrow, committed = await self.svc.run(work)
        notice = request.query_params.get("notice")
        p = [f'<h1>{t("nav_operator")}</h1>']
        if notice in NOTICES:
            p.append(f'<div class="notice" role="status">{t("notice_" + notice)}</div>')
        # server state
        frac = self.svc.disk_fraction()
        total = self.svc.disk_total_bytes()
        ro = self.svc.read_only()
        p.append(f'<h2>{t("sec_server")}</h2><div class="cards">'
                 f'<div class="card"><strong>{t("disk_use")}</strong><br>{ctx.number(frac * 100)} % ({ctx.bytes(total)})</div>'
                 f'<div class="card"><strong>{t("read_only")}</strong><br>'
                 f'<span class="badge {"bad" if ro else "good"}">{t("yes") if ro else t("no")}</span>'
                 f' <span class="small muted">≥ {ctx.number(self.cfg.read_only_threshold * 100, 0)} %</span></div>'
                 f'<div class="card"><strong>{t("disk_budget")}</strong><br>{ctx.bytes(committed)} / {ctx.bytes(int(total * 0.7))}</div></div>')
        # scopes
        rows = [tr(f'<a href="{ctx.url("/scopes/" + s["scope_id"])}">{esc(s["name"])}</a>'
                   + (f' <span class="badge">{t("badge_sandbox")}</span>' if self.svc.is_sandbox(s["scope_id"]) else ""),
                   f'<code>{esc(s["scope_id"])}</code>',
                   self.status_badge(ctx, s), esc(s["creator"] or "–"), (str(s["nvaults"]), "num"),
                   (ctx.bytes(s["size"]), "num"), (ctx.bytes(self.svc.scope_limits(s)["scope_bytes"]), "num")) for s in scopes]
        p.append(f'<h2>{t("sec_all_scopes")}</h2>' + table([(t("col_name"), ""), (t("col_scope_id"), ""), (t("col_status"), ""),
                 (t("col_creator"), ""), (t("col_vaults"), "num"), (t("col_size"), "num"), (t("lim_scope_bytes"), "num")], rows, t("no_scopes")))
        # global limits
        lrows = [tr(t("lim_" + k), (self.fmt_limit(ctx, k, self.cfg.limit_defaults[k]), "num"), (self.fmt_limit(ctx, k, self.cfg.limit_ceilings[k]), "num"))
                 for k in LIMIT_KEYS]
        p.append(f'<h2>{t("sec_global")}</h2><p class="hint">{t("global_hint")}</p>'
                 + table([(t("col_limit"), ""), (t("col_default"), "num"), (t("col_ceiling"), "num")], lrows))
        # blocked users
        brow = []
        for b in blocked:
            brow.append(tr(esc(b["username"]), esc(b["reason"]), esc(b["blocked_by"]), ctx.time(b["created"]),
                           ctx.form("/operator/unblock", f'<input type="hidden" name="username" value="{esc(b["username"])}">'
                                    f'<button type="submit" class="secondary small">{t("unblock")}</button>')))
        p.append(f'<h2>{t("sec_blocked")}</h2><p>{t("blocked_hint")}</p>'
                 + table([(t("col_admin"), ""), (t("col_reason"), ""), (t("col_added_by"), ""), (t("col_added"), ""), ("", "")], brow, t("no_blocked"))
                 + ctx.form("/operator/block", f'<label for="b_user">{t("block_user")}</label><input type="text" id="b_user" name="username" required maxlength="64" autocomplete="off" value="{esc((typed or {}).get("username"))}"{self.invalid_attrs(error or "")}>'
                            f'{self.form_error("block", error) if error else ""}'
                            f'<label for="b_reason">{t("col_reason")}</label><input type="text" id="b_reason" name="reason" maxlength="200" value="{esc((typed or {}).get("reason"))}">'
                            f'<button type="submit" class="danger">{t("block")}</button>'))
        # escrow
        p.append(f'<h2>{t("sec_escrow")}</h2><p class="hint">{t("escrow_hint")}</p>'
                 + table([(t("col_key_set"), ""), (t("col_key_id"), ""), (t("col_vaults"), "num")],
                         [tr(t("escrow_" + e.status), f'<code class="small">{esc(e.key_id)}</code>', (str(escrow[e.status]), "num")) for e in self.cfg.escrow]
                         + [tr(t("escrow_other"), "–", (str(escrow["other"]), "num"))]))
        # recoveries
        rrows = [tr(f'<code class="small">{esc(r["vault_id"])}</code>', f'<code>{esc(r["scope_id"] or "")}</code>', esc(r["method"]),
                    ctx.time(r["requested"]), ctx.time(r["ready_at"]), esc(r["state"]), ctx.time(r["finished"])) for r in recoveries]
        p.append(f'<h2>{t("sec_recovery")}</h2>' + table([(t("col_vault"), ""), (t("col_scope_id"), ""), (t("col_method"), ""), (t("col_requested"), ""),
                 (t("col_ready"), ""), (t("col_state"), ""), (t("col_finished"), "")], rrows, t("no_recoveries"))
                 + f'<h3>{t("recovery_audit")}</h3>' + self.audit_table(ctx, audit, show_scope=True)
                 + f'<p><a href="{ctx.url("/operator/audit")}">{t("audit_all")}</a></p>')
        return render(ctx, t("nav_operator"), "".join(p), status=status)

    async def operator_audit(self, request, ctx: Ctx) -> Response:
        redirect = self.need_operator(request, ctx)
        if redirect:
            return redirect

        def work():
            with self.svc.db.connection() as conn:
                return conn.execute("SELECT * FROM audit ORDER BY id DESC LIMIT 500").fetchall()

        rows = await self.svc.run(work)
        t = ctx.t
        return render(ctx, t("sec_audit"), f'<p><a href="{ctx.url("/operator")}">&larr; {t("nav_operator")}</a></p><h1>{t("sec_audit")}</h1>'
                      f'<p class="hint">{t("audit_retention", days=AUDIT_RETENTION // 86400)}</p>' + self.audit_table(ctx, rows, show_scope=True))

    async def operator_post(self, request, ctx: Ctx, form, kind: str) -> Response:
        if not ctx.ident:
            raise DashError(401, "err_login")
        if not ctx.ident.operator:
            raise DashError(403, "err_forbidden")
        username = form.get("username", "").strip().lower()

        def work():
            with self.svc.db.connection() as conn:
                with transaction(conn):
                    if not access.UNI_ID_RE.fullmatch(username):
                        raise DashError(400, "err_admin_format")
                    if kind == "block":
                        if access.is_operator(self.cfg, username, ""):
                            raise DashError(409, "err_block_operator")
                        conn.execute("INSERT OR REPLACE INTO blocked_users (username, reason, blocked_by, created) VALUES (?,?,?,?)",
                                     (username, form.get("reason", "").strip()[:200], ctx.ident.username, self.svc.now()))
                        conn.execute("DELETE FROM sessions WHERE username=?", (username,))
                        self.svc.audit(conn, actor_of(ctx, True), "user_blocked", None, None, username)
                    else:
                        conn.execute("DELETE FROM blocked_users WHERE username=?", (username,))
                        self.svc.audit(conn, actor_of(ctx, True), "user_unblocked", None, None, username)

        try:
            await self.svc.run(work)
        except DashError as err:
            return await self.render_operator(request, ctx, error=err.text(ctx.t), status=err.status, typed=form)
        return self.redirect(ctx, "/operator", "blocked" if kind == "block" else "unblocked")

    # -- privacy ---------------------------------------------------------------------------------------------------------

    async def privacy(self, request, ctx: Ctx) -> Response:
        return privacy_page(ctx, self.cfg)

    # -- routes ----------------------------------------------------------------------------------------------------------

    def routes(self) -> list[Route]:
        r = self.route
        scope = BASE + "/scopes/{scope}"
        gets = [
            (BASE + "/", self.home), (BASE + "/login", self.login_start), (BASE + "/_lpmiddleware/login", self.login_callback),
            (BASE + "/privacy", self.privacy), (scope, self.scope_page), (scope + "/audit", self.audit_page),
            (BASE + "/operator", self.operator_page), (BASE + "/operator/audit", self.operator_audit),
        ]
        posts = [
            (BASE + "/logout", self.logout), (BASE + "/prefs/expert", self.post_prefs_expert), (BASE + "/scopes", self.create), (scope + "/settings", self.post_settings),
            (scope + "/enrollment", self.post_enrollment), (scope + "/join-code", self.post_join_code),
            (scope + "/limits", self.post_limits), (scope + "/admins", self.post_admin_add),
            (scope + "/admins/remove", self.post_admin_remove), (scope + "/vaults/{vault}/delete", self.post_vault_delete),
            (scope + "/suspend", self.post_suspend), (scope + "/resume", self.post_resume), (scope + "/delete", self.post_scope_delete),
            (BASE + "/operator/block", lambda rq, c, f: self.operator_post(rq, c, f, "block")),
            (BASE + "/operator/unblock", lambda rq, c, f: self.operator_post(rq, c, f, "unblock")),
        ]
        routes = [Route(path, r(h), methods=["GET", "HEAD"]) for path, h in gets]
        routes += [Route(path, r(h, post=True), methods=["POST"]) for path, h in posts]
        routes.append(Route(BASE + "/_dev_login", r(self.dev_login), methods=["POST"]))
        return routes


def routes(svc) -> list[Route]:
    return Dashboard(svc, LoginPsi.from_config(svc.config, clock=svc.clock)).routes()
