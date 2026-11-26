"""Shared HTML plumbing for the dashboard and the privacy page: language, layout, CSS, escaping, formatting.

No external assets, no inline event handlers; the page's single style and script element carry a per-response nonce
that the Content-Security-Policy allows.
"""

from __future__ import annotations

import datetime
import html
import re
import secrets
import urllib.parse

from starlette.responses import HTMLResponse

from .texts import TEXTS

try:  # staff read times in local time; without tz data the pages fall back to UTC and say so
    from zoneinfo import ZoneInfo
    LOCAL_TZ = ZoneInfo("Europe/Berlin")
    TZ_NAME = "Europe/Berlin"
except Exception:  # pragma: no cover - depends on the system's tz database
    LOCAL_TZ = datetime.timezone.utc
    TZ_NAME = "UTC"

LANGS = ("de", "en")
DEFAULT_LANG = "de"
BASE = "/datastore"

CSS = """
:root{--bg:#fff;--fg:#1b1f23;--muted:#56606b;--line:#cfd6dd;--accent:#005a8c;--accent-fg:#fff;--soft:#f2f5f8;--danger:#b42318;--ok:#1a7f37;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#14181c;--fg:#e6eaee;--muted:#a0abb6;--line:#38414a;--accent:#6bb7e6;--accent-fg:#0b1a24;--soft:#1d2329;--danger:#ff8a80;--ok:#56d364;--warn:#e3b341}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.skip{position:absolute;left:-999px;top:0;background:var(--bg);padding:.5rem 1rem;z-index:10}.skip:focus{left:0}
header.top{border-bottom:1px solid var(--line);background:var(--soft)}
.bar{max-width:62rem;margin:0 auto;padding:.6rem 1rem;display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;align-items:center}
.brand{font-weight:700;text-decoration:none;color:var(--fg);margin-right:auto}
.bar nav{display:flex;gap:1rem;flex-wrap:wrap}
.bar form{display:inline;margin:0}
main{max-width:62rem;margin:0 auto;padding:1.25rem 1rem 3rem}
footer{max-width:62rem;margin:0 auto;padding:1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem;display:flex;flex-wrap:wrap;gap:.5rem 1.5rem}
h1{font-size:1.7rem;line-height:1.25;margin:.2rem 0 1rem}h2{font-size:1.25rem;margin:2rem 0 .6rem;padding-top:.4rem;border-top:1px solid var(--line)}h3{font-size:1.05rem;margin:1.2rem 0 .4rem}
p,ul,ol{margin:.5rem 0 .8rem}
.muted{color:var(--muted)}.small{font-size:.9rem}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
pre{background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:.7rem .8rem;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:.4rem 0}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:.4rem 0 1rem}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;background:var(--soft)}
td.num,th.num{text-align:right;white-space:nowrap}td.nowrap{white-space:nowrap}
td.wrap{min-width:12rem;overflow-wrap:anywhere}td code{overflow-wrap:anywhere}
label{display:block;font-weight:600;margin:.8rem 0 .2rem}
label.inline{display:inline;font-weight:400}
input[type=text],input[type=email],input[type=number],select,textarea{width:100%;max-width:34rem;padding:.5rem .6rem;border:1px solid var(--muted);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
input[type=number]{max-width:12rem}
textarea{min-height:5rem}
.hint{color:var(--muted);font-size:.9rem;margin:.15rem 0}
button,.btn{display:inline-block;padding:.5rem 1rem;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer;text-decoration:none;margin:.6rem .4rem .2rem 0}
button.secondary,.btn.secondary{background:transparent;color:var(--accent)}
button.danger{background:transparent;border-color:var(--danger);color:var(--danger)}
button.small{padding:.2rem .6rem;margin:0;font-size:.9rem}
.notice,.error{padding:.6rem .9rem;border-radius:6px;border:1px solid;margin:.8rem 0}
.notice{border-color:var(--ok);background:var(--soft)}.error{border-color:var(--danger);background:var(--soft)}
.field-error{color:var(--danger);font-weight:600;margin:.3rem 0 0}.error:focus{outline:3px solid var(--danger);outline-offset:2px}
input[aria-invalid=true]{border-color:var(--danger);border-width:2px}
.badge{display:inline-block;padding:0 .5rem;border:1px solid var(--line);border-radius:1rem;font-size:.85rem;background:var(--soft)}
.badge.warn{border-color:var(--warn);color:var(--warn)}.badge.bad{border-color:var(--danger);color:var(--danger)}.badge.good{border-color:var(--ok);color:var(--ok)}
details{margin:.8rem 0}summary{cursor:pointer;font-weight:600}
details.expert{border:1px solid var(--line);border-radius:8px;padding:.2rem .9rem .6rem;margin:2rem 0 1rem}
details.expert>summary{font-size:1.15rem;padding:.5rem 0}details.expert h3{border-top:1px solid var(--line);padding-top:.8rem;margin-top:1.8rem;font-size:1.15rem}
details.expert h4{font-size:1rem;margin:1.1rem 0 .3rem}
ol.steps{padding-left:1.4rem}ol.steps>li{margin:0 0 1.2rem;padding-left:.3rem}ol.steps>li::marker{font-weight:700;color:var(--accent)}
.step-title{font-weight:600;margin:0 0 .3rem}
.scrollbox{max-height:15rem;overflow:auto;border-radius:6px}.scrollbox pre{margin:0}
dl.facts{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem}dl.facts dt{font-weight:600}dl.facts dd{margin:0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:.8rem}
.card{border:1px solid var(--line);border-radius:8px;padding:.7rem .9rem;background:var(--soft)}
.box{border:1px solid var(--warn);border-radius:8px;padding:.6rem .9rem;margin:1rem 0;background:var(--soft)}
.big{font-size:1.3rem}
.row{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center}
.toc{columns:2;font-size:.95rem}
@media (max-width:40rem){dl.facts{grid-template-columns:1fr}.toc{columns:1}
.scroll{overflow:visible}.scroll table,.scroll tbody,.scroll tr,.scroll td{display:block;width:100%}
.scroll thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.scroll tr{border:1px solid var(--line);border-radius:8px;margin:0 0 .7rem;padding:.25rem .7rem}
.scroll td{display:grid;grid-template-columns:minmax(5.5rem,36%) minmax(0,1fr);gap:.2rem .7rem;border:0;padding:.3rem 0}
.scroll td::before{content:attr(data-label);font-weight:600;color:var(--muted)}
.scroll td[data-label=""]{display:block}.scroll td[data-label=""]::before{content:none}
.scroll td.num{text-align:left}.scroll td.wrap{min-width:0}.scroll td:empty{display:none}}
"""

JS = """
function wdsDone(b){var o=b.textContent;b.textContent=b.getAttribute('data-done')||'OK';setTimeout(function(){b.textContent=o;},1500);}
document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){
var el=document.getElementById(b.getAttribute('data-copy'));if(!el){return;}
function fallback(){var r=document.createRange();r.selectNodeContents(el);var s=window.getSelection();s.removeAllRanges();s.addRange(r);
try{if(document.execCommand('copy')){wdsDone(b);}}catch(e){}}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(el.textContent.trim()).then(function(){wdsDone(b);},fallback);}else{fallback();}});});
function wdsOpen(){var h=location.hash,el=null;if(h.length<2){return;}try{el=document.getElementById(decodeURIComponent(h.slice(1)));}catch(e){return;}if(!el){return;}
var d=el.closest('details'),ch=false;while(d){if(!d.open){d.open=true;ch=true;}d=d.parentElement?d.parentElement.closest('details'):null;}if(ch){el.scrollIntoView();}}
wdsOpen();window.addEventListener('hashchange',wdsOpen);
document.querySelectorAll('form[data-confirm]').forEach(function(f){f.addEventListener('submit',function(e){if(!window.confirm(f.getAttribute('data-confirm'))){e.preventDefault();}});});
"""


def esc(value) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def pick_lang(request) -> tuple[str, bool]:
    """(language, explicit): ?lang= wins, then Accept-Language by quality, then German."""
    wanted = request.query_params.get("lang", "").lower()
    if wanted in LANGS:
        return wanted, True
    best, best_q = None, -1.0
    for part in request.headers.get("accept-language", "").split(","):
        tag, _, params = part.strip().partition(";")
        primary = tag.strip().lower().split("-")[0]
        if primary not in LANGS:
            continue
        q = 1.0
        for p in params.split(";"):
            k, _, v = p.strip().partition("=")
            if k == "q":
                try:
                    q = float(v)
                except ValueError:
                    q = 0.0
        if q > best_q and q > 0:
            best, best_q = primary, q
    return best or DEFAULT_LANG, False


def fmt_number(value, lang: str = "en", digits: int = 1) -> str:
    """A decimal number as a person of that language writes it: 10,5 in German, 10.5 in English."""
    text = f"{value:.{digits}f}"
    return text.replace(".", ",") if lang == "de" else text


def fmt_time(ts, lang: str = "de") -> str:
    """Local time (Europe/Berlin) in the usual format of the page language: 24.11.2026, 23:42 or 24 Nov 2026, 23:42."""
    if not ts:
        return "–"
    when = datetime.datetime.fromtimestamp(int(ts), LOCAL_TZ)
    if lang == "de":
        text = f"{when.day:02d}.{when.month:02d}.{when.year}, {when.hour:02d}:{when.minute:02d}"
    else:
        text = f"{when.day} {_EN_MONTHS[when.month - 1]} {when.year}, {when.hour:02d}:{when.minute:02d}"
    return text if LOCAL_TZ is not datetime.timezone.utc else text + " UTC"


def fmt_date(ts, lang: str = "de") -> str:
    """The date only (24.11.2026 or 24 Nov 2026), local time."""
    when = datetime.datetime.fromtimestamp(int(ts), LOCAL_TZ)
    return f"{when.day:02d}.{when.month:02d}.{when.year}" if lang == "de" else f"{when.day} {_EN_MONTHS[when.month - 1]} {when.year}"


_EN_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def fmt_bytes(n, lang: str = "en") -> str:
    """Sizes as people read them: B, KB, MB, GB, TB, where 1 KB = 1024 bytes and 1 MB = 1,048,576 bytes (the docs say so once)."""
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{int(n)} B" if unit == "B" else f"{fmt_number(n, lang)} {unit}"
        n /= 1024
    return str(n)


class Ctx:
    """Per-request view: language, identity, CSP nonce, translation and link helpers."""

    def __init__(self, svc, request, ident=None):
        self.svc = svc
        self.request = request
        self.ident = ident
        self.lang, self.lang_explicit = pick_lang(request)
        self.nonce = secrets.token_urlsafe(16)

    def t(self, key: str, **kw) -> str:
        """Translation; the catalogue holds trusted markup, arguments are escaped."""
        text = TEXTS[key][LANGS.index(self.lang)]
        return text.format(**{k: esc(v) for k, v in kw.items()}) if kw else text

    def time(self, ts) -> str:
        return fmt_time(ts, self.lang)

    def date(self, ts) -> str:
        return fmt_date(ts, self.lang)

    def bytes(self, n) -> str:
        return fmt_bytes(n, self.lang)

    def number(self, value, digits: int = 1) -> str:
        return fmt_number(value, self.lang, digits)

    def pick(self, de: str, en: str) -> str:
        return en if self.lang == "en" else de

    def href(self, path: str, **params) -> str:
        """Raw href below /datastore/; the language is carried along when it was chosen explicitly."""
        q = {k: v for k, v in params.items() if v is not None}
        if self.lang_explicit:
            q["lang"] = self.lang
        return BASE + path + ("?" + urllib.parse.urlencode(q) if q else "")

    def url(self, path: str, **params) -> str:
        """The same, escaped for use inside an HTML attribute."""
        return esc(self.href(path, **params))

    def csrf_field(self) -> str:
        return f'<input type="hidden" name="csrf" value="{esc(self.ident.csrf)}">' if self.ident else ""

    def form(self, path: str, inner: str, *, confirm: str | None = None, cls: str = "", **params) -> str:
        attr = f' data-confirm="{esc(confirm)}"' if confirm else ""
        cls_attr = f' class="{cls}"' if cls else ""
        return (f'<form method="post" action="{self.url(path, **params)}"{attr}{cls_attr}>{self.csrf_field()}{inner}</form>')

    def lang_links(self) -> str:
        out = []
        base_q = [(k, v) for k, v in self.request.query_params.multi_items() if k not in ("lang", "token")]
        for code, label in (("de", "Deutsch"), ("en", "English")):
            if code == self.lang:
                out.append(f'<span lang="{code}" aria-current="true"><strong>{label}</strong></span>')
            else:
                href = esc(self.request.url.path + "?" + urllib.parse.urlencode(base_q + [("lang", code)]))
                out.append(f'<a lang="{code}" hreflang="{code}" href="{href}">{label}</a>')
        return " · ".join(out)


def _cls(cls: str) -> str:
    return f' class="{cls}"' if cls else ""


def table(headers: list[tuple[str, str]], rows: list[str], empty: str = "") -> str:
    """headers: (label, css class); rows: ready-made <tr> strings."""
    if not rows:
        return f'<p class="muted">{empty}</p>' if empty else ""
    head = "".join(f'<th scope="col"{_cls(c)}>{h}</th>' for h, c in headers)
    # every cell carries its column title: on a narrow screen a row becomes a card (CSS) and the title is shown in front of the value
    labels = [html.escape(re.sub(r"<[^>]+>", "", html.unescape(h)), quote=True) for h, _ in headers]

    def label(row: str) -> str:
        count = [0]

        def put(m):
            i = count[0]
            count[0] += 1
            return f'<td data-label="{labels[i] if i < len(labels) else ""}"{m.group(1)}>'
        return re.sub(r'<td((?: class="[^"]*")?)>', put, row)
    return f'<div class="scroll"><table><thead><tr>{head}</tr></thead><tbody>{"".join(label(r) for r in rows)}</tbody></table></div>'


def tr(*cells: tuple[str, str] | str) -> str:
    out = []
    for c in cells:
        text, cls = (c, "") if isinstance(c, str) else c
        out.append(f"<td{_cls(cls)}>{text}</td>")
    return "<tr>" + "".join(out) + "</tr>"


def render(ctx: Ctx, title: str, body: str, *, status: int = 200, extra_headers: dict | None = None,
           head_extra: str = "") -> HTMLResponse:
    t = ctx.t
    ident = ctx.ident
    nav = []
    if ident:
        nav.append(f'<a href="{ctx.url("/")}">{t("nav_scopes")}</a>')
        if ident.operator:
            nav.append(f'<a href="{ctx.url("/operator")}">{t("nav_operator")}</a>')
        nav.append(f'<span class="muted">{esc(ident.name or ident.username)}</span>')
        nav.append(ctx.form("/logout", f'<button class="secondary small" type="submit">{t("logout")}</button>'))
    privacy = esc(BASE + "/privacy" + ("?lang=" + ctx.lang if ctx.lang_explicit else ""))
    doc = f"""<!doctype html>
<html lang="{ctx.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">
<title>{esc(title)} – WIAI Datastore</title><link rel="icon" href="data:,">{head_extra}<style nonce="{ctx.nonce}">{CSS}</style></head>
<body><a class="skip" href="#main">{t("skip")}</a>
<header class="top"><div class="bar"><a class="brand" href="{ctx.url("/")}">WIAI Datastore</a><nav aria-label="{t("nav_label")}">{"".join(nav)}</nav></div></header>
<main id="main">{body}</main>
<footer><a href="{privacy}">{t("privacy")}</a><span>{ctx.lang_links()}</span><span>{t("footer_owner")}</span></footer>
<script nonce="{ctx.nonce}">{JS}</script></body></html>"""
    headers = {
        "Content-Security-Policy": (f"default-src 'none'; style-src 'nonce-{ctx.nonce}'; script-src 'nonce-{ctx.nonce}'; "
                                    "img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"),
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        # no-referrer would make browsers send "Origin: null" on our own forms; same-origin leaks nothing to other sites
        "Referrer-Policy": "same-origin",
        "Content-Language": ctx.lang,
    }
    headers.update(extra_headers or {})
    return HTMLResponse(doc, status_code=status, headers=headers)
