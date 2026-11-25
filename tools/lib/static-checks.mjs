// Static checks of wds-verify (PLAN 9.6, first group): what the HTML of an app says before it runs.
//
// Every check returns findings {id, level: 'pass' | 'fail' | 'warn' | 'info', title, detail}. A 'fail' makes wds-verify exit non-zero.

import { SANDBOX_SCOPE, scopeSites } from './targets.mjs';

export const DATASTORE_HOST = 'wiai.uni-bamberg.de';
export const DATASTORE_BASE = 'https://' + DATASTORE_HOST + '/datastore/';

// The recommended CSP (PLAN 9, item 3): the policy that docs/site/integration.md prints, built by docs.csp_policy in the server. The test
// verify-static.test.mjs compares the two, so they cannot drift apart. An app's CSP may be stricter, never broader; the only additions
// that integration.md allows are inert ones (see INERT_EXTRA and imgHosts).
export const CSP_TEMPLATE = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' https://wiai.uni-bamberg.de/datastore/client/; "
  + "style-src 'unsafe-inline'; img-src data: blob:; connect-src https://wiai.uni-bamberg.de/datastore/api/ https://api.pwnedpasswords.com; "
  + "base-uri 'none'; form-action 'none'";
// Directives that the policy has to carry and that may only be 'none' (a missing one leaves <base> and form targets open).
const MUST_BE_NONE = ['base-uri', 'form-action'];
// Additions that integration.md section 3 allows because they cannot run code or reach an API: fonts and media from data: / blob: URLs.
const INERT_EXTRA = { 'font-src': ['data:'], 'media-src': ['blob:', 'data:'] };
const IMG_HOST = /^https:\/\/[^\s*'";,]+$/i;   // img-src may name one https host (no wildcard, no bare https:)
const inertExtra = (name, token) => (INERT_EXTRA[name] || []).includes(token) || (name === 'img-src' && IMG_HOST.test(token));
// The https hosts a policy additionally allows images from (reported as information).
export function imgHosts(policy) {
  const list = effective(policy, 'img-src') || [];
  return list.filter((t) => IMG_HOST.test(t) && !sourceAllowed(t, ['data:', 'blob:']));
}

const LIB_RE = /^https:\/\/wiai\.uni-bamberg\.de\/datastore\/client\/wds-(\d+\.\d+\.\d+)\.js$/;

// ---- a small HTML scanner (no dependencies): tags with attributes, script contents, positions ----
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
function parseAttrs(s) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
  }
  return attrs;
}
const unentity = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export function scanHtml(html) {
  // Comments hide nothing from the browser's scanner of this tool: blank them out but keep offsets.
  const text = html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const tags = [], scripts = [];
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1].toLowerCase();
    const tag = { name, attrs: parseAttrs(m[2]), index: m.index, end: re.lastIndex, raw: m[0] };
    tags.push(tag);
    if (name === 'script' || name === 'style') {
      const close = text.toLowerCase().indexOf('</' + name, re.lastIndex);
      const stop = close < 0 ? text.length : close;
      tag.content = text.slice(re.lastIndex, stop);
      if (name === 'script') scripts.push(tag);
      re.lastIndex = stop;
    }
  }
  return { text, tags, scripts };
}

// Remove // and /* */ comments from JavaScript, leaving strings alone (good enough for pattern checks, not a parser).
export function stripJsComments(code) {
  let out = '', i = 0;
  while (i < code.length) {
    const c = code[i], d = code[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) { if (code[j] === '\\') j++; j++; }
      out += code.slice(i, j + 1); i = j + 1;
    } else if (c === '/' && d === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      const j = code.indexOf('*/', i + 2);
      i = j < 0 ? code.length : j + 2;
    } else { out += c; i++; }
  }
  return out;
}

// ---- CSP ----
export function parseCsp(text) {
  const policy = {};
  for (const part of String(text).split(';')) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const name = toks[0].toLowerCase();
    if (!(name in policy)) policy[name] = toks.slice(1);
  }
  return policy;
}
const FALLBACK = {
  'script-src-elem': ['script-src', 'default-src'], 'script-src-attr': ['script-src', 'default-src'],
  'style-src-elem': ['style-src', 'default-src'], 'style-src-attr': ['style-src', 'default-src'],
  'worker-src': ['child-src', 'script-src', 'default-src'], 'frame-src': ['child-src', 'default-src'],
};
const FETCH_DIRECTIVES = ['default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem', 'style-src-attr', 'img-src', 'connect-src',
  'font-src', 'media-src', 'object-src', 'frame-src', 'child-src', 'worker-src', 'manifest-src', 'prefetch-src'];
// The source list that applies to a directive (with the fallback chain), or null when the policy leaves it open.
function effective(policy, name) {
  for (const n of [name, ...(FALLBACK[name] || ['default-src'])]) {
    if (n in policy) {
      const list = policy[n].map((t) => (t.startsWith("'") ? t.toLowerCase() : t));
      return list.length ? list : ["'none'"];
    }
  }
  return null;
}
function sourceAllowed(token, tplList) {
  if (token === "'none'") return true;
  if (tplList.includes(token)) return true;
  if (/^'(sha256|sha384|sha512|nonce)-/i.test(token)) return tplList.includes("'unsafe-inline'"); // a hash or nonce narrows 'unsafe-inline'
  // a URL below a template URL that ends in a slash (the library file below .../client/)
  return tplList.some((t) => /^https:\/\//.test(t) && t.endsWith('/') && token.startsWith(t) && /^https:\/\//.test(token));
}
// Why is `policy` broader than `template`? Returns a list of messages (empty: it is not broader).
export function cspBroaderThan(policy, template) {
  const tpl = parseCsp(template), problems = [];
  const names = new Set(FETCH_DIRECTIVES.filter((n) => n in policy || n in tpl));
  names.add('default-src');
  for (const name of names) {
    const mine = effective(policy, name), theirs = effective(tpl, name) || ["'none'"];
    const shown = (policy[name] ? name : (FALLBACK[name] || ['default-src']).find((n) => n in policy) || 'default-src');
    if (mine === null) { problems.push(name + ': no restriction (add default-src \'none\')'); continue; }
    const real = mine.length > 1 ? mine.filter((t) => t !== "'none'") : mine;
    const bad = real.filter((t) => !sourceAllowed(t, theirs) && !inertExtra(name, t));
    if (bad.length) problems.push(name + (shown !== name ? ' (from ' + shown + ')' : '') + ': ' + bad.join(' ') + ' is not in the recommended policy');
  }
  for (const name of MUST_BE_NONE) {
    if (!(name in tpl)) continue;
    if (!(name in policy)) problems.push(name + ": missing (add " + name + " 'none')");
    else if (policy[name].length !== 1 || policy[name][0].toLowerCase() !== "'none'") problems.push(name + ': ' + policy[name].join(' ') + " is not in the recommended policy (only 'none')");
  }
  return problems;
}

// Does the policy let the page connect to this origin? (the effective connect-src, with the fallback to default-src)
export function connectAllows(cspText, origin) {
  const list = effective(parseCsp(cspText || ''), 'connect-src');
  if (list === null) return true;   // no restriction at all (another check fails for that)
  return list.some((t) => t === origin || t === origin + '/' || (t.startsWith(origin) && t.endsWith('/')));
}

// ---- CSS that hides the library's dialogs and the sandbox label ----
// Rules whose selector names the library's markup (the .wds- classes, [data-wds...] attributes) and whose declarations touch display,
// visibility or opacity. A simple scan of the rule blocks, nested at-rules included; not a CSS parser.
export function hidingRules(styleTexts) {
  const out = [];
  for (const css of styleTexts) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(clean))) {
      const selector = m[1].trim();
      if (selector.startsWith('@')) continue;
      if (!/\.wds-|\[data-wds(?!-verify)/.test(selector)) continue;
      if (!/(^|[;\s])(display|visibility|opacity)\s*:/i.test(m[2])) continue;
      out.push(selector.replace(/\s+/g, ' ').slice(0, 80));
    }
  }
  return out;
}

// ---- deleting local data (the one-time migration of a ported app) ----
const maskStrings = (code) => {
  let out = '', i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) { if (code[j] === '\\') j++; j++; }
      j = Math.min(j, code.length - 1);
      out += c + ' '.repeat(Math.max(0, j - i - 1)) + code[j];
      i = j + 1;
    } else { out += c; i++; }
  }
  return out;
};
const FN_HEADER = /\bfunction\b|=>|^\s*(?:async\s+)?(?:static\s+)?(?!(?:if|for|while|switch|catch|with)\b)[\w$]+\s*\([^)]*\)\s*$/;
// The text of the function that contains position pos (the whole code when there is none).
function enclosingFunction(code, masked, pos) {
  let depth = 0;
  for (let i = Math.min(pos, masked.length) - 1; i >= 0; i--) {
    const ch = masked[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth > 0) { depth--; continue; }
      const start = Math.max(masked.lastIndexOf(';', i - 1), masked.lastIndexOf('{', i - 1), masked.lastIndexOf('}', i - 1)) + 1;
      if (!FN_HEADER.test(masked.slice(start, i))) continue;
      let d = 0, end = masked.length;
      for (let k = i; k < masked.length; k++) { if (masked[k] === '{') d++; else if (masked[k] === '}') { d--; if (d === 0) { end = k + 1; break; } } }
      return code.slice(start, end);
    }
  }
  return code;
}
const DELETE_CALLS = [
  ['indexedDB.deleteDatabase', /\bindexedDB\s*\.\s*deleteDatabase\s*\(/g, false],
  ['localStorage.removeItem', /\blocalStorage\s*\.\s*removeItem\s*\(/g, false],
  ['localStorage.clear', /\blocalStorage\s*\.\s*clear\s*\(/g, true],
];
// Calls that delete local data. Returns {unguarded: [names], clears: n}: a call is unguarded when its function never mentions "sandbox";
// localStorage.clear( is always reported.
export function localDeletes(code) {
  const masked = maskStrings(code);
  const unguarded = new Set();
  let clears = 0;
  for (const [name, re, always] of DELETE_CALLS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked))) {
      if (always) { clears++; continue; }
      if (!/sandbox/i.test(enclosingFunction(code, masked, m.index))) unguarded.add(name);
    }
  }
  return { unguarded: [...unguarded], clears };
}

// ---- the test global of the migration ----
// window.__WDS_MIGRATION_TEST__ is set by wds-verify --migration-delete in a throw-away browser (and by nobody else): the recipe keeps old data in the sandbox unless it is true. An app that writes it
// itself would delete old data in the sandbox in any browser, and the copy of that data is gone with the sandbox vault tonight. True when the code assigns it, defines it or puts it into an object literal.
export function setsTestGlobal(code, name = '__WDS_MIGRATION_TEST__') {
  let from = 0;
  for (;;) {
    const at = code.indexOf(name, from);
    if (at < 0) return false;
    from = at + name.length;
    const after = code.slice(from, from + 24), before = code.slice(Math.max(0, at - 80), at);
    if (/^["'\]\s]*(?:=(?!=)|\+\+|--|\|\|=|&&=|\?\?=)/.test(after)) return true;                // x.NAME = ..., x["NAME"] = ...
    if (/defineProperty\s*\(\s*[\w$.]+\s*,\s*["'`]$/.test(before)) return true;                    // Object.defineProperty(window, "NAME", ...)
    if (/[{,]\s*["']?$/.test(before) && /^["']?\s*:/.test(after)) return true;                       // Object.assign(window, { NAME: true })
  }
}

// ---- the official privacy sentence ----
const PRIVACY = [
  'Data is end-to-end encrypted; the faculty holds a recovery key for emergencies.',
  'Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel.',
];
const ENTITIES = { auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', nbsp: ' ' };
const flat = (s) => unentity(String(s)).replace(/&([A-Za-z]+);/g, (m, n) => ENTITIES[n] || m).replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/\s+/g, ' ');

// ---- the checks ----
const NET_APIS = [
  ['fetch', /\bfetch\s*\(/], ['XMLHttpRequest', /\bXMLHttpRequest\b/], ['WebSocket', /\bWebSocket\b/],
  ['sendBeacon', /\bsendBeacon\b/], ['EventSource', /\bEventSource\b/],
];
const DATASTORE_REF = /wiai\.uni-bamberg\.de|\/datastore\/|api\/v1/i;

// `known`: parsed client/dist/hashes.json; readme: the text of the README next to the app (optional). Returns {findings, library, csp, scope}.
export function staticChecks(html, known, { readme = '' } = {}) {
  const findings = [];
  const add = (id, level, title, detail) => findings.push({ id, level, title, detail: detail || '' });
  const { tags, scripts } = scanHtml(html);

  // 1. library tag
  const external = scripts.filter((s) => s.attrs.src !== undefined);
  const libTags = external.filter((s) => /\/datastore\/client\/wds-[^/]*$/.test(s.attrs.src.split(/[?#]/)[0]));
  let library = null;
  if (!libTags.length) add('library-tag', 'fail', 'Library script tag', 'No <script src="https://wiai.uni-bamberg.de/datastore/client/wds-<version>.js"> found.');
  else if (libTags.length > 1) add('library-tag', 'fail', 'Library script tag', libTags.length + ' library script tags; include the library exactly once.');
  else {
    const tag = libTags[0], src = tag.attrs.src;
    const m = LIB_RE.exec(src);
    if (!m) add('library-tag', 'fail', 'Library script tag', 'The src is "' + src + '"; it must be exactly https://wiai.uni-bamberg.de/datastore/client/wds-<MAJOR.MINOR.PATCH>.js (no query, no other host).');
    else {
      library = { version: m[1], src, integrity: tag.attrs.integrity || '', tag };
      const entry = known && known[m[1]];
      if (!entry) add('library-version', 'fail', 'Library version', 'Version ' + m[1] + ' is not a published version. Known: ' + (known ? Object.keys(known).join(', ') : 'none') + '.');
      else {
        add('library-version', 'pass', 'Library version', m[1] + ' is a published version.');
        if (!entry.frozen) add('library-frozen', 'info', 'Library version released', 'Version ' + m[1] + ' is not marked as released (frozen) in hashes.json; its hash may still change. This is about the library, not about your app.');
        const sri = (tag.attrs.integrity || '').trim();
        if (!sri) add('library-integrity', 'fail', 'Subresource integrity', 'The script tag has no integrity attribute. Expected: integrity="' + entry.sri + '"');
        else if (sri !== entry.sri) add('library-integrity', 'fail', 'Subresource integrity', 'integrity="' + sri + '" does not match the published hash. Expected: integrity="' + entry.sri + '"');
        else add('library-integrity', 'pass', 'Subresource integrity', 'The integrity attribute matches the published hash of ' + m[1] + '.');
      }
      if ((tag.attrs.crossorigin || '').toLowerCase() !== 'anonymous') add('library-crossorigin', 'fail', 'crossorigin attribute', 'The library tag needs crossorigin="anonymous", otherwise the browser cannot check the integrity hash of a file from another origin.');
      else add('library-crossorigin', 'pass', 'crossorigin attribute', 'crossorigin="anonymous" is set.');
    }
  }
  const libTag = libTags.length === 1 ? libTags[0] : null;

  // 2. CSP
  const cspMetas = tags.filter((t) => t.name === 'meta' && (t.attrs['http-equiv'] || '').toLowerCase() === 'content-security-policy');
  let csp = null;
  if (!cspMetas.length) add('csp', 'fail', 'Content Security Policy', 'No <meta http-equiv="Content-Security-Policy"> found. Use the recommended policy:\n' + CSP_TEMPLATE);
  else {
    const results = cspMetas.map((t) => ({ tag: t, content: unentity(t.attrs.content || ''), problems: cspBroaderThan(parseCsp(unentity(t.attrs.content || '')), CSP_TEMPLATE) }));
    csp = results[0].content;
    const ok = results.find((r) => !r.problems.length);
    if (!ok) add('csp', 'fail', 'Content Security Policy', 'The policy is broader than the recommended one:\n' + results[0].problems.map((p) => '- ' + p).join('\n'));
    else {
      add('csp', 'pass', 'Content Security Policy', 'A meta policy is present and not broader than the recommended one.');
      const hosts = imgHosts(parseCsp(ok.content));
      if (hosts.length) add('csp-additions', 'info', 'Content Security Policy additions', 'img-src also allows images from ' + hosts.join(', ') + '. integration.md allows that. The dynamic test blocks every host except the datastore, so these images do not load during the run.');
      const firstScript = scripts.length ? Math.min(...scripts.map((s) => s.index)) : Infinity;
      if (ok.tag.index > firstScript) add('csp-position', 'fail', 'Content Security Policy position', 'The CSP meta tag comes after the first script tag; the browser applies it only to what follows it. Put it first in <head>.');
    }
  }

  // 3. external scripts and imports
  const strangers = external.filter((s) => s !== libTag);
  const stranger = strangers.map((s) => s.attrs.src);
  const preloads = tags.filter((t) => t.name === 'link' && /\b(modulepreload|preload|prefetch)\b/i.test(t.attrs.rel || '') && /^(https?:)?\/\//i.test(t.attrs.href || ''));
  const inlineCode = scripts.filter((s) => s.attrs.src === undefined).map((s) => stripJsComments(s.content || '')).join('\n;\n');
  const handlerCode = tags.flatMap((t) => Object.entries(t.attrs).filter(([k]) => /^on[a-z]+$/.test(k)).map(([, v]) => unentity(v))).join('\n;\n');
  const code = inlineCode + '\n;\n' + handlerCode;
  const importsFromUrl = /\bimport\s*\(\s*['"`]https?:|\bimport\s+[^;]*?from\s*['"]https?:|\bimportScripts\s*\(|new\s+(?:Shared)?Worker\s*\(\s*['"`]https?:|\.src\s*=\s*['"`]https?:|createElement\(\s*['"]script['"]\s*\)/.test(code);
  if (stranger.length || preloads.length || importsFromUrl) {
    const parts = [];
    if (stranger.length) parts.push('script tags with src: ' + stranger.join(', '));
    if (preloads.length) parts.push('preloaded from other hosts: ' + preloads.map((t) => t.attrs.href).join(', '));
    if (importsFromUrl) parts.push('code that loads a script at run time (import(), importScripts, Worker, script.src)');
    add('external-scripts', 'fail', 'No other scripts', 'The only external script is the library: ' + parts.join('; ') + '. Inline everything else into the page.');
  } else add('external-scripts', 'pass', 'No other scripts', 'The library is the only external script.');
  const extRes = tags.filter((t) => ['img', 'link', 'iframe', 'embed', 'object', 'audio', 'video', 'source', 'track'].includes(t.name)
    && /^(https?:)?\/\//i.test(t.attrs.src || t.attrs.href || t.attrs.data || '') && !preloads.includes(t));
  if (extRes.length) add('external-resources', 'warn', 'External resources', 'The page references other hosts: ' + extRes.map((t) => '<' + t.name + '> ' + (t.attrs.src || t.attrs.href || t.attrs.data)).join(', ') + '. The recommended CSP blocks them.');

  // 4. the datastore host outside the library
  const used = NET_APIS.filter(([, re]) => re.test(code)).map(([n]) => n);
  const refsDatastore = DATASTORE_REF.test(code);
  const forms = tags.filter((t) => t.name === 'form' || (t.attrs.formaction !== undefined));
  const formTargets = forms.map((t) => t.attrs.action !== undefined ? t.attrs.action : t.attrs.formaction).filter((a) => a);
  const badForms = formTargets.filter((a) => DATASTORE_REF.test(a));
  const otherForms = formTargets.filter((a) => /^(https?:)?\/\//i.test(a) && !DATASTORE_REF.test(a));
  if ((used.length && refsDatastore) || badForms.length) {
    add('datastore-direct', 'fail', 'No direct access to the datastore', (used.length && refsDatastore ? 'The code uses ' + used.join(', ') + ' and names the datastore host or API. ' : '')
      + (badForms.length ? 'Form action(s) point to the datastore: ' + badForms.join(', ') + '. ' : '') + 'Only the library talks to the datastore; use store.get/set/list.');
  } else {
    add('datastore-direct', 'pass', 'No direct access to the datastore', used.length
      ? 'The code uses ' + used.join(', ') + ' but names no datastore address; the dynamic test shows what it sends.'
      : refsDatastore ? 'The datastore host is named in the code, but no fetch, XMLHttpRequest, WebSocket, sendBeacon or EventSource is used.'
        : 'The code uses none of fetch, XMLHttpRequest, WebSocket, sendBeacon or EventSource, and has no form action to the datastore.');
  }
  if (used.length && !refsDatastore) add('network-apis', 'warn', 'Network calls in the page', 'The code uses ' + used.join(', ') + '. The recommended CSP only lets the page reach the datastore API (through the library) and the password-breach check; everything else is blocked. The dynamic test shows what is sent.');
  if (otherForms.length) add('form-action', 'warn', 'Form actions', 'Forms with an action to another host: ' + otherForms.join(', ') + '.');

  // 5. what the page does with the library
  const scopeMatch = /WDS\.connect\s*\(\s*\{[^}]*?\bscope\s*:\s*(['"])([^'"]+)\1/.exec(code);
  const siteScope = scopeSites(code)[0];
  const baseMatch = /WDS\.connect\s*\(\s*\{[^}]*?\bbaseUrl\s*:\s*(['"])(https?:\/\/[^'"]+)\1/.exec(code);
  if (library && !/WDS\.connect\s*\(/.test(code)) add('connect', 'warn', 'WDS.connect', 'No call of WDS.connect({ scope }) found in the page code.');

  // 6. the sandbox: never in the app file, never hidden, no local deletion without a sandbox guard (PLAN: sandbox, wds-verify 3.3)
  if (html.includes(SANDBOX_SCOPE)) add('sandbox-id', 'fail', 'Sandbox scope ID in the app', 'The page contains the sandbox scope ID "' + SANDBOX_SCOPE + '": this file would store its users\' data in the sandbox, where everything is deleted every night. Use the app\'s own scope ID. To test against the sandbox without editing the file, use wds-verify --target sandbox (or --sandbox-copy).');
  else add('sandbox-id', 'pass', 'No sandbox scope ID in the app', '');
  const hiding = hidingRules(tags.filter((t) => t.name === 'style').map((t) => t.content || ''));
  if (hiding.length) add('sandbox-label-css', 'fail', 'CSS hides the library\'s dialogs', 'The style sheet changes display, visibility or opacity of the library\'s own markup (' + hiding.slice(0, 4).join('; ') + '). That includes the sandbox label, which must stay visible, and the dialogs people need to unlock their data. Remove these rules.');
  const del = localDeletes(code);
  if (del.unguarded.length) add('local-delete', 'warn', 'Deleting local data', 'The code calls ' + del.unguarded.join(', ') + ' in a function that never mentions the sandbox. A one-time migration must not delete the old local data when the app runs against the sandbox (the sandbox is wiped every night, the old data would be gone for good); see "Porting an existing app" in integration.md.');
  if (setsTestGlobal(code)) add('migration-test-global', 'fail', 'The app sets the migration test global', 'The code assigns window.__WDS_MIGRATION_TEST__. Only wds-verify --migration-delete sets it, in a throw-away browser; the migration recipe reads it (=== true) to delete the old data in the sandbox as well. In a real browser that deletes data whose only copy is in a sandbox vault that is wiped tonight. Remove the assignment; to see the deletion, run wds-verify --target sandbox --migration-delete.');
  if (!PRIVACY.some((s) => flat(html).includes(s) || flat(readme).includes(s))) add('privacy-sentence', 'info', 'Privacy sentence', 'Neither the page nor README.md contains the official sentence. Wherever the app describes its privacy, use it word for word: "' + PRIVACY[0] + '" (German: "' + PRIVACY[1] + '"). For a text in another language use the English sentence.');
  if (del.clears) add('local-clear', 'warn', 'localStorage.clear()', 'localStorage.clear() deletes everything the page origin stored, including data of other parts of the app and of the library itself (the remembered access ID). Remove the named keys instead; and never in the sandbox.');
  return { findings, library, csp, scope: scopeMatch ? scopeMatch[2] : siteScope ? siteScope.id : null, baseUrl: baseMatch ? baseMatch[2] : null };
}
