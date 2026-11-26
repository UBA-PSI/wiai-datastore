"""Documentation served by the app: /datastore/llms.txt, /datastore/docs/<name>[.md] and /datastore/export/.

The sources are plain files in the docs directory (config [server] docs_dir, default <app>/docs/site next to the server
package): *.md, llms.txt and export.html. Nothing is built. At request time the placeholders below are replaced, so the
script tag with its Subresource Integrity hash always names the library that is deployed next to the server:

    {{script_tag}}   the complete <script> tag for the newest library (with SRI, crossorigin and the onerror fallback)
    {{version}}      library version, e.g. 1.0.0
    {{sri}}          sha384-... hash of that file
    {{library_url}}  absolute URL of the file
    {{base}}         public base URL of the service (config public_base), no trailing slash
    {{api_url}}      {{base}}/api/v1
    {{csp}}          the content security policy that works for apps (see csp_policy)
    {{escrow_ids}}   key IDs of the pinned escrow sets (current, spare), comma separated
    {{repo_url}}     the public repository (REPO_URL)
    {{sandbox_scope}}   scope ID of the public sandbox, or "(no sandbox on this server)"
    {{sandbox_wipe}}    nightly wipe time with time zone, e.g. "03:30 Europe/Berlin" ("-" without a sandbox)
    {{sandbox_limits}}  sandbox limits in words, e.g. "512 KB per record, 2 MB per vault, 2 versions" ("-" without a sandbox)
    {{sandbox_section}} the whole paragraph block of llms.txt about the sandbox (one sentence when there is none)
    {{index_integration}}, {{index_porting}}   only in llms.txt: the sections of that guide with their line ranges in the text as served
                        (section_index; computed from the served document, so it cannot go stale)

A few lines of Markdown are enough for these pages, so a small renderer is built in (no third-party package): headings,
paragraphs, fenced code, lists (nested), tables, block quotes, rules, links, bold, italic and code spans. Raw HTML in a
Markdown file is always escaped.
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import re
from pathlib import Path

from starlette.responses import HTMLResponse, RedirectResponse, Response

from .errors import not_found
from .routing import endpoint, svc_of

NAME_RE = re.compile(r"[a-z0-9]+(?:[.-][a-z0-9]+)*")
PLACEHOLDER_RE = re.compile(r"\{\{([a-z_]+)\}\}")

REPO_URL = "https://github.com/UBA-PSI/wiai-datastore"
ONERROR = "document.body.textContent='Storage service unreachable. Check your connection and reload this page.'"
HIBP_ORIGIN = "https://api.pwnedpasswords.com"

TEXT_HEADERS = {"Cache-Control": "no-cache"}
# Documentation pages load nothing and run nothing.
DOC_CSP = ("default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; "
           "frame-ancestors 'none'")


def csp_policy(base: str) -> str:
    """The policy every app should carry as <meta http-equiv="Content-Security-Policy"> (docs/site/integration.md).

    Verified from file:// pages in Chromium, Firefox and WebKit with the real bundle (client/test/docs.spec.mjs):
    'wasm-unsafe-eval' is what Argon2id needs, 'unsafe-inline' lets the app's own inline script and the onerror handler run,
    'self' is left out because its meaning on file:// differs between browsers."""
    base = base.rstrip("/")
    return ("default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' " + base + "/client/; "
            "style-src 'unsafe-inline'; img-src data: blob:; connect-src " + base + "/api/ " + HIBP_ORIGIN + "; "
            "base-uri 'none'; form-action 'none'")


# -- library facts ---------------------------------------------------------------------------------------------------


def _read_bytes(path: Path):
    try:
        return path.read_bytes()
    except OSError:
        return None


def library_info(svc) -> dict:
    """Version, file name and SRI hash of the newest library, from <client_dir>/hashes.json (written by the build),
    else from the .sri file, else computed from the file. sri is None when the file is not deployed."""
    version = svc.library_latest()
    filename = "wds-" + version + ".js"
    sri = None
    raw = _read_bytes(svc.client_dir / "hashes.json")
    if raw is not None:
        try:
            entry = json.loads(raw).get(version) or {}
            if isinstance(entry.get("sri"), str) and entry.get("file", filename) == filename:
                sri = entry["sri"]
        except (ValueError, AttributeError):
            sri = None
    if sri is None:
        data = _read_bytes(svc.client_dir / (filename + ".sri"))
        if data and data.strip().startswith(b"sha384-"):
            sri = data.decode("ascii", "replace").strip()
    if sri is None:
        data = _read_bytes(svc.client_dir / filename)
        if data is not None:
            sri = "sha384-" + base64.b64encode(hashlib.sha384(data).digest()).decode("ascii")
    return {"version": version, "file": filename, "sri": sri}


def _size(n: int) -> str:
    """512 KB, 2 MB, 1 GB: whole numbers of binary units, the way the sandbox limits are quoted in the docs."""
    for unit, factor in (("GB", 1 << 30), ("MB", 1 << 20), ("KB", 1 << 10)):
        if n >= factor:
            value = n / factor
            return (str(int(value)) if value == int(value) else f"{value:.1f}") + " " + unit
    return f"{n} B"


NO_SANDBOX_SECTION = (
    "This server has no public sandbox. Test with wds-verify against its built-in mock (--target mock; needs Python, "
    "integration.md, section \"wds-verify\"), or tell the person that the end-to-end run is still open.")


def sandbox_placeholders(svc) -> dict:
    sb = svc.config.sandbox
    if sb is None:
        return {"sandbox_scope": "(no sandbox on this server)", "sandbox_wipe": "-", "sandbox_limits": "-",
                "sandbox_section": NO_SANDBOX_SECTION}
    wipe, limits = sb.wipe_time + " " + sb.timezone, (f"{_size(sb.max_value_bytes)} per record, {_size(sb.vault_bytes)} per vault, "
                                                      f"{sb.history_versions} versions")
    section = (
        f"For a real end-to-end test there is a public sandbox scope on this service: {sb.scope_id}. Open enrollment (no join code), {limits}, "
        f"and everything is deleted every night between {wipe} and one hour later.\n"
        "The library's dialogs say \"Sandbox\". Use it through wds-verify --target sandbox (real library, real service, no Python) "
        "or wds-verify --sandbox-copy out-sandbox.html (a copy that a person opens in a browser).\n"
        "**Never write the sandbox scope ID into the app file** (the app would lose its data every night; wds-verify fails such a file). "
        "Never enter real data there. There is no recovery in the sandbox.\n"
        "Details: integration.md, section \"The sandbox\".")
    return {"sandbox_scope": sb.scope_id, "sandbox_wipe": wipe, "sandbox_limits": limits, "sandbox_section": section}


def placeholders(svc) -> dict:
    base = svc.config.public_base.rstrip("/")
    lib = library_info(svc)
    url = base + "/client/" + lib["file"]
    sri = lib["sri"] or "sha384-LIBRARY-NOT-DEPLOYED"
    tag = ('<script src="' + url + '" integrity="' + sri + '" crossorigin="anonymous"\n'
           '        onerror="' + ONERROR + '"></script>')
    return {
        "base": base, "version": lib["version"], "sri": sri, "library_url": url, "script_tag": tag,
        "api_url": base + "/api/v1", "csp": csp_policy(base),
        "escrow_ids": ", ".join(e.key_id for e in svc.config.escrow),
        "repo_url": REPO_URL, **sandbox_placeholders(svc),
    }


def fill(text: str, values: dict) -> str:
    return PLACEHOLDER_RE.sub(lambda m: values.get(m.group(1), m.group(0)), text)


# -- the index of a guide, for llms.txt ---------------------------------------------------------------------------------

INDEX_DOCS = {"index_integration": "integration", "index_porting": "porting"}
INDEX_SUBSECTION_LINES = 20   # a "###" subsection is listed when it spans at least this many lines
_INDEX_HEADING_RE = re.compile(r"(##|###)[ \t]+(.*?)[ \t]*$")
_INDEX_TITLE_RE = re.compile(r"#[ \t]+(.*?)[ \t]*$")


def doc_sections(text: str) -> tuple[int, str, list[tuple[int, int, int, str]]]:
    """(number of lines, the title of the page, [(first line, last line, level 2 or 3, title)]) of a Markdown text as it is served.

    Lines count from 1, the way a reader with line numbers (the Read tool) sees them. A "##" section runs up to the line before the next "##"
    (its "###" subsections inside), a "###" up to the line before the next "##" or "###". Headings inside a fenced block are no headings."""
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    heads, title, fence = [], "", None
    for n, line in enumerate(lines, 1):
        s = line.strip()
        m = FENCE_RE.match(s)
        if fence is None and m:
            fence = m.group(1)
            continue
        if fence is not None:
            if s.startswith(fence):
                fence = None
            continue
        t = _INDEX_TITLE_RE.fullmatch(line)
        if t and not title:
            title = t.group(1).replace("`", "")
            continue
        h = _INDEX_HEADING_RE.fullmatch(line)
        if h:
            heads.append((n, len(h.group(1)), h.group(2).replace("`", "").replace("**", "")))
    out = []
    for i, (n, level, name) in enumerate(heads):
        end = len(lines)
        for n2, level2, _ in heads[i + 1:]:
            if level2 <= level:
                end = n2 - 1
                break
        out.append((n, end, level, name))
    return len(lines), title, out


def section_index(text: str, filename: str) -> str:
    """The lines for llms.txt: every "##" section of the served guide with its line range, and the "###" subsections of at least
    INDEX_SUBSECTION_LINES lines, indented. The text before the first section is listed as the introduction."""
    total, title, sections = doc_sections(text)
    rows = []
    if sections and sections[0][0] > 1:
        rows.append((1, sections[0][0] - 1, 2, "Introduction" + (": " + title if title else "")))
    for first, last, level, name in sections:
        if level == 2 or last - first + 1 >= INDEX_SUBSECTION_LINES:
            rows.append((first, last, level, name))
    width = max((len(f"{a}-{b}") for a, b, _, _ in rows), default=0)
    body = "\n".join("  " + ("" if level == 2 else "  ") + f"{a}-{b}".ljust(width) + "  " + name for a, b, level, name in rows)
    return f"{filename}, {total} lines:\n{body}"


def index_placeholders(svc, text: str, values: dict) -> dict:
    """The index placeholders that `text` (llms.txt) uses: computed from the guide as it is served (placeholders filled)."""
    out = {}
    for key, stem in INDEX_DOCS.items():
        if "{{" + key + "}}" not in text:
            continue
        doc = _read_text(svc.docs_dir / (stem + ".md"))
        out[key] = section_index(fill(doc, values), stem + ".md") if doc is not None else stem + ".md: (not available on this server)"
    return out


# -- Markdown --------------------------------------------------------------------------------------------------------

_esc = html.escape
HEADING_RE = re.compile(r"(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$")
FENCE_RE = re.compile(r"(```|~~~)[ \t]*([\w+-]*)[ \t]*$")
RULE_RE = re.compile(r"(?:-{3,}|\*{3,}|_{3,})[ \t]*$")
ITEM_RE = re.compile(r"([ \t]*)([-*+]|\d{1,3}[.)])([ \t]+)(.*)$")
TABLE_SEP_RE = re.compile(r"\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$")
CODE_SPAN_RE = re.compile(r"(`+)(.+?)\1")
LINK_RE = re.compile(r"\[([^\]\n]+)\]\(([^)\s]+)\)")
AUTOLINK_RE = re.compile(r"&lt;((?:https?://|mailto:)[^\s&]+)&gt;")
BOLD_RE = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*")
ITALIC_RE = re.compile(r"(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])")


def safe_href(url: str):
    """http(s), mailto, absolute paths, anchors and plain relative paths; nothing with another scheme."""
    if re.match(r"(https?://|mailto:)\S+$", url, re.I) or url.startswith(("/", "#")):
        return url
    if re.match(r"[\w./-]+(#[\w-]*)?$", url):
        return url
    return None


def _inline_text(text: str) -> str:
    text = _esc(text, quote=False)

    def link(m):
        href = safe_href(html.unescape(m.group(2)))
        if href is None:
            return m.group(0)
        return '<a href="' + _esc(href) + '">' + m.group(1) + "</a>"

    text = LINK_RE.sub(link, text)
    text = AUTOLINK_RE.sub(lambda m: '<a href="' + _esc(html.unescape(m.group(1))) + '">' + m.group(1) + "</a>", text)
    text = BOLD_RE.sub(r"<strong>\1</strong>", text)
    return ITALIC_RE.sub(r"<em>\1</em>", text)


def inline(text: str) -> str:
    out, pos = [], 0
    for m in CODE_SPAN_RE.finditer(text):
        out.append(_inline_text(text[pos:m.start()]))
        out.append("<code>" + _esc(m.group(2).strip(" "), quote=False) + "</code>")
        pos = m.end()
    out.append(_inline_text(text[pos:]))
    return "".join(out)


def slugify(text: str) -> str:
    text = re.sub(r"[^\w\s-]", "", re.sub(r"<[^>]*>", "", text).lower())
    return re.sub(r"[\s_-]+", "-", text).strip("-") or "section"


def _split_row(line: str) -> list[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", line)]


def _starts_block(line: str) -> bool:
    s = line.strip()
    return bool(not s or FENCE_RE.match(s) or HEADING_RE.match(s) or RULE_RE.match(s) or s.startswith(">")
                or ITEM_RE.match(line))


class Renderer:
    def __init__(self):
        self.title = None
        self.ids: dict[str, int] = {}

    def heading_id(self, text: str) -> str:
        slug = slugify(text)
        n = self.ids.get(slug, 0)
        self.ids[slug] = n + 1
        return slug if n == 0 else slug + "-" + str(n + 1)

    def blocks(self, lines: list[str]) -> str:
        out, i, n = [], 0, len(lines)
        while i < n:
            line = lines[i]
            s = line.strip()
            if not s:
                i += 1
                continue
            m = FENCE_RE.match(s)
            if m:
                fence, lang = m.group(1), m.group(2)
                indent = len(line) - len(line.lstrip())
                i += 1
                code = []
                while i < n and not lines[i].strip().startswith(fence):
                    code.append(lines[i][indent:] if lines[i][:indent].strip() == "" else lines[i])
                    i += 1
                i += 1
                cls = ' class="language-' + _esc(lang) + '"' if lang else ""
                out.append("<pre><code" + cls + ">" + _esc("\n".join(code), quote=False) + "\n</code></pre>")
                continue
            m = HEADING_RE.match(s)
            if m:
                level, text = len(m.group(1)), m.group(2)
                if level == 1 and self.title is None:
                    self.title = re.sub(r"<[^>]*>", "", inline(text))
                out.append('<h%d id="%s">%s</h%d>' % (level, _esc(self.heading_id(text)), inline(text), level))
                i += 1
                continue
            if RULE_RE.match(s):
                out.append("<hr>")
                i += 1
                continue
            if s.startswith(">"):
                quote = []
                while i < n and lines[i].strip().startswith(">"):
                    quote.append(re.sub(r"^\s*>\s?", "", lines[i]))
                    i += 1
                out.append("<blockquote>" + self.blocks(quote) + "</blockquote>")
                continue
            if "|" in s and i + 1 < n and "-" in lines[i + 1] and TABLE_SEP_RE.match(lines[i + 1].strip()):
                head = _split_row(s)
                aligns = []
                for cell in _split_row(lines[i + 1]):
                    aligns.append("center" if cell.startswith(":") and cell.endswith(":") else
                                  "right" if cell.endswith(":") else "")
                i += 2
                rows = []
                while i < n and lines[i].strip() and "|" in lines[i]:
                    rows.append(_split_row(lines[i]))
                    i += 1

                def cells(tag, row):
                    parts = []
                    for k, c in enumerate(row):
                        a = aligns[k] if k < len(aligns) else ""
                        parts.append("<%s%s>%s</%s>" % (tag, ' style="text-align:' + a + '"' if a else "", inline(c), tag))
                    return "<tr>" + "".join(parts) + "</tr>"

                out.append("<table><thead>" + cells("th", head) + "</thead><tbody>"
                           + "".join(cells("td", r) for r in rows) + "</tbody></table>")
                continue
            if ITEM_RE.match(line):
                i = self.list_block(lines, i, out)
                continue
            para = [s]
            i += 1
            while i < n and not _starts_block(lines[i]):
                para.append(lines[i].strip())
                i += 1
            out.append("<p>" + inline(" ".join(para)) + "</p>")
        return "\n".join(out)

    def list_block(self, lines, i, out) -> int:
        n = len(lines)
        first = ITEM_RE.match(lines[i])
        base_indent = len(first.group(1).expandtabs(4))
        ordered = first.group(2)[0].isdigit()
        items = []
        while i < n:
            m = ITEM_RE.match(lines[i])
            if not m or len(m.group(1).expandtabs(4)) != base_indent or m.group(2)[0].isdigit() != ordered:
                break
            content_indent = base_indent + len(m.group(2)) + len(m.group(3).expandtabs(4))
            body = [m.group(4)]
            i += 1
            while i < n:
                line = lines[i].expandtabs(4)
                if not line.strip():
                    j = i
                    while j < n and not lines[j].strip():
                        j += 1
                    if j < n and len(lines[j].expandtabs(4)) - len(lines[j].expandtabs(4).lstrip()) >= content_indent:
                        body.extend([""] * (j - i))
                        i = j
                        continue
                    break
                ind = len(line) - len(line.lstrip())
                if ind >= content_indent:
                    body.append(line[content_indent:])
                elif ITEM_RE.match(line) and ind <= base_indent:
                    break
                elif _starts_block(line):
                    break
                else:
                    body.append(line.strip())  # lazy continuation of the paragraph
                i += 1
            items.append(body)
        tag = "ol" if ordered else "ul"
        start = int(re.match(r"\d+", first.group(2)).group()) if ordered else 1
        rendered = []
        for body in items:
            inner = self.blocks(body)
            if inner.startswith("<p>"):  # tight list: the first paragraph of an item is not wrapped
                head, _, rest = inner.partition("</p>")
                inner = head[3:] + rest
            rendered.append("<li>" + inner + "</li>")
        attr = ' start="%d"' % start if ordered and start != 1 else ""
        out.append("<%s%s>%s</%s>" % (tag, attr, "".join(rendered), tag))
        return i


def render_markdown(text: str) -> tuple[str, str | None]:
    """Markdown to an HTML fragment. Returns (html, title of the first level-1 heading or None)."""
    r = Renderer()
    body = r.blocks(text.replace("\r\n", "\n").replace("\r", "\n").split("\n"))
    return body, r.title


PAGE_CSS = """
:root{color-scheme:light dark;--fg:#1b1f23;--bg:#fff;--muted:#59636e;--line:#d0d7de;--code:#f3f4f6;--accent:#0b5cad}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0f1318;--muted:#9aa4af;--line:#30363d;--code:#1b2128;--accent:#6cb2f5}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{border-bottom:1px solid var(--line);padding:.6rem 1rem;font-size:.9rem;display:flex;gap:1rem;flex-wrap:wrap}
header a{color:var(--muted)}header a:first-child{color:var(--fg);font-weight:600}
main{max-width:50rem;margin:0 auto;padding:1rem 1rem 4rem}
a{color:var(--accent)}h1,h2,h3{line-height:1.25}h2{margin-top:2rem;border-bottom:1px solid var(--line);padding-bottom:.2rem}
code,pre{font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}code{background:var(--code);padding:.1em .3em;border-radius:3px}
pre{background:var(--code);padding:.8rem 1rem;overflow:auto;border-radius:6px;line-height:1.4}pre code{background:none;padding:0}
table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid var(--line);padding:.3rem .6rem;text-align:left;vertical-align:top}
blockquote{margin:1rem 0;padding:.1rem 1rem;border-left:4px solid var(--line);color:var(--muted)}hr{border:0;border-top:1px solid var(--line)}
"""


def html_page(title: str, body: str, *, lang: str, base: str, raw_name: str | None) -> str:
    de = lang == "de"   # the navigation speaks the language of the page
    nav = ['<a href="' + _esc(base) + '/">WIAI Datastore</a>', '<a href="' + _esc(base) + '/docs/">' + ("Dokumentation" if de else "Documentation") + "</a>",
           '<a href="' + _esc(base) + '/llms.txt">llms.txt</a>']
    if raw_name:
        nav.append('<a href="' + _esc(base) + "/docs/" + _esc(raw_name) + '.md">' + ("Markdown-Quelltext" if de else "Markdown") + "</a>")
    return ('<!doctype html>\n<html lang="' + _esc(lang) + '"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,">'
            "<title>" + _esc(title) + " - WIAI Datastore</title><style>" + PAGE_CSS + "</style></head><body>"
            "<header>" + "".join(nav) + "</header><main>\n" + body + "\n</main></body></html>\n")


# -- routes ----------------------------------------------------------------------------------------------------------


def _read_text(path: Path):
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _language(stem: str) -> str:
    return "de" if stem.endswith(".de") else "en"


async def llms_txt(request):
    svc = svc_of(request)
    text = await svc.run(_read_text, svc.docs_dir / "llms.txt")
    if text is None:
        raise not_found("No such document.")
    values = await svc.run(placeholders, svc)
    values = {**values, **await svc.run(index_placeholders, svc, text, values)}
    return Response(fill(text, values), media_type=None,
                    headers={**TEXT_HEADERS, "Content-Type": "text/plain; charset=utf-8"})


async def doc_page(request):
    svc = svc_of(request)
    name = request.path_params["name"]
    raw = name.endswith(".md")
    stem = name[:-3] if raw else name
    if not NAME_RE.fullmatch(stem):
        raise not_found("No such document.")
    text = await svc.run(_read_text, svc.docs_dir / (stem + ".md"))
    if text is None:
        raise not_found("No such document.")
    values = await svc.run(placeholders, svc)
    text = fill(text, values)
    if raw:
        return Response(text, media_type=None, headers={**TEXT_HEADERS, "Content-Type": "text/markdown; charset=utf-8"})
    body, title = render_markdown(text)
    page = html_page(title or stem, body, lang=_language(stem), base=values["base"], raw_name=stem)
    return HTMLResponse(page, headers={**TEXT_HEADERS, "Content-Security-Policy": DOC_CSP})


def _titles(docs_dir: Path) -> list[tuple[str, str]]:
    out = []
    try:
        files = sorted(docs_dir.glob("*.md"))
    except OSError:
        files = []
    for p in files:
        if not NAME_RE.fullmatch(p.stem):
            continue
        m = re.search(r"^#[ \t]+(.+?)[ \t]*$", _read_text(p) or "", re.M)
        out.append((p.stem, m.group(1).replace("`", "").replace("*", "") if m else p.stem))
    return out


async def doc_index(request):
    svc = svc_of(request)
    base = svc.config.public_base.rstrip("/")
    titles = await svc.run(_titles, svc.docs_dir)
    items = "".join('<li><a href="%s/docs/%s">%s</a> (<a href="%s/docs/%s.md">md</a>)</li>'
                    % (_esc(base), _esc(s), _esc(t), _esc(base), _esc(s)) for s, t in titles)
    body = ('<h1>Documentation</h1><p>For the developer\'s Claude start with <a href="' + _esc(base) + '/llms.txt">llms.txt</a>.</p>'
            "<ul>" + items + '</ul><p>The tool to export a vault is at <a href="' + _esc(base) + '/export/">'
            + _esc(base) + "/export/</a>.</p>")
    return HTMLResponse(html_page("Documentation", body, lang="en", base=base, raw_name=None),
                        headers={**TEXT_HEADERS, "Content-Security-Policy": DOC_CSP})


async def _export_html(svc) -> str:
    text = await svc.run(_read_text, svc.docs_dir / "export.html")
    if text is None:
        raise not_found("No such document.")
    return fill(text, await svc.run(placeholders, svc))


async def export_page(request):
    return HTMLResponse(await _export_html(svc_of(request)), headers=TEXT_HEADERS)


async def export_download(request):
    return HTMLResponse(await _export_html(svc_of(request)),
                        headers={**TEXT_HEADERS, "Content-Disposition": 'attachment; filename="wds-export.html"'})


async def redirect_to(request):
    return RedirectResponse(request.url.path + "/", status_code=308)


def routes():
    return [
        endpoint("/datastore/llms.txt", GET=llms_txt),
        endpoint("/datastore/docs", GET=redirect_to),
        endpoint("/datastore/docs/", GET=doc_index),
        endpoint("/datastore/docs/{name}", GET=doc_page),
        endpoint("/datastore/export", GET=redirect_to),
        endpoint("/datastore/export/", GET=export_page),
        endpoint("/datastore/export/wds-export.html", GET=export_download),
    ]
