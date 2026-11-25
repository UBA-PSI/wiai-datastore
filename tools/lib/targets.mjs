// Where wds-verify gets its facts from: the public service (library hashes, scope documents, the sandbox) and the local clone.
//
// Test hooks (documented in tools/README.md, not meant for everyday use):
//   WDS_VERIFY_SERVICE       base URL of the service instead of the production one (a local mock, a stub in the tests)
//   WDS_VERIFY_HASHES_URL    where to fetch hashes.json (default: <service>/client/hashes.json); "off" skips the online lookup
//   WDS_VERIFY_OFFLINE=1     no optional online lookups (hashes, scope check); the sandbox target still needs the service
//   WDS_VERIFY_LIBRARY       a library file served instead of the production one (sandbox target against a local mock)
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_URL = 'https://github.com/UBA-PSI/wiai-datastore';
export const PRODUCTION_SERVICE = 'https://wiai.uni-bamberg.de/datastore';
export const SANDBOX_SCOPE = 'sandbox-000000';
export const DEFAULT_HASHES = join(HERE, '..', '..', 'client', 'dist', 'hashes.json');
export const RE_SCOPE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*-[0-9a-hjkmnp-tv-z]{6}$/;

export class UsageError extends Error {}
// The chosen target cannot be used right now, through no fault of the app (exit code 3).
export class TargetUnavailable extends Error {}

export const serviceBase = () => (process.env.WDS_VERIFY_SERVICE || PRODUCTION_SERVICE).replace(/\/+$/, '');
export const offline = () => !!process.env.WDS_VERIFY_OFFLINE;

// GET a JSON document with a time limit. Never throws: {status, json, headers, error}.
export async function getJson(url, ms = 4000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { Accept: 'application/json' } });
    let json = null;
    try { json = await res.json(); } catch (e) { /* not JSON */ }
    return { status: res.status, json, headers: res.headers, error: null };
  } catch (e) {
    const cause = e && e.cause && e.cause.code ? e.cause.code : '';
    return { status: 0, json: null, headers: null, error: (e && e.name === 'TimeoutError' ? 'timed out after ' + ms / 1000 + ' s' : String((e && e.message) || e)) + (cause ? ' (' + cause + ')' : '') };
  }
}

const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

// The published library hashes: from the service first (3 s), then from the local clone. --hashes <file> overrides both.
// Returns {known, source, differs, note}.
export async function loadKnownHashes(flags = {}) {
  const readLocal = (file) => {
    if (!existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new UsageError('cannot read ' + file + ': ' + e.message); }
  };
  if (flags.hashes && flags.hashes !== true) {
    const known = readLocal(flags.hashes);
    if (!known) throw new UsageError('published hashes not found at ' + flags.hashes);
    return { known, source: 'the file ' + flags.hashes + ' (--hashes)', differs: false, note: '' };
  }
  const local = readLocal(DEFAULT_HASHES);
  const url = process.env.WDS_VERIFY_HASHES_URL || serviceBase() + '/client/hashes.json';
  let online = null, why = '';
  if (offline() || url === 'off') why = offline() ? 'online lookup switched off (WDS_VERIFY_OFFLINE)' : 'online lookup switched off';
  else {
    const r = await getJson(url, 3000);
    const isHashes = (j) => j && typeof j === 'object' && !Array.isArray(j) && Object.keys(j).length > 0 && Object.values(j).every((e) => e && typeof e.sri === 'string' && /^sha384-/.test(e.sri));
    if (r.status === 200 && isHashes(r.json)) online = r.json;
    else why = r.error ? 'not reachable: ' + r.error : 'answered HTTP ' + r.status + ' without a hashes document';
  }
  if (online) {
    const differs = !!local && canonical(online) !== canonical(local);
    return { known: online, source: url, differs, note: differs ? 'Your clone of the repository has different library hashes than the service: it is outdated; run git pull in the clone (' + REPO_URL + ').' : '' };
  }
  if (local) return { known: local, source: 'the local clone (client/dist/hashes.json); ' + url + ' ' + why, differs: false, note: '' };
  throw new UsageError('the published library hashes are not available: ' + url + ' ' + why + ', and there is no local clone with client/dist/hashes.json. Clone ' + REPO_URL + ' and run wds-verify from the clone, or pass --hashes <file>.');
}

export function sriOfFile(file) { return 'sha384-' + createHash('sha384').update(readFileSync(file)).digest('base64'); }

// The sandbox scope document of the service. Returns {ok, scopeId, doc, reason}.
export async function sandboxInfo(service = serviceBase()) {
  const url = service + '/api/v1/scopes/' + SANDBOX_SCOPE;
  const r = await getJson(url, 4000);
  if (r.error) return { ok: false, reason: 'the service is not reachable (' + r.error + ')' };
  if (r.status === 404) return { ok: false, reason: 'the service has no sandbox scope (' + SANDBOX_SCOPE + ')' };
  if (r.status !== 200 || !r.json) return { ok: false, reason: 'the scope document of the sandbox answered HTTP ' + r.status };
  const sb = r.json.sandbox;
  if (!sb) return { ok: false, reason: 'the scope ' + SANDBOX_SCOPE + ' is not a sandbox scope on this service' };
  if (sb.enabled === false) return { ok: false, reason: 'the sandbox is switched off on the service (enabled = false)', doc: r.json };
  return { ok: true, scopeId: r.json.scope || SANDBOX_SCOPE, doc: r.json };
}

// Where a script names the app's scope: the literal in `WDS.connect({ scope: "..." })`, and the literal of a constant that is passed
// as `scope: NAME` (or as the shorthand `{ scope }`) when that constant is declared in the same script. Nothing else is a scope:
// "note-search" or "btn-danger" have the shape of a scope ID and are ordinary strings. Returns [{start, end, id}] (offsets in code).
const ID_SRC = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9a-hjkmnp-tv-z]{6}';
function matchingParen(code, open) {   // index of the ")" that closes the "(" before `open`, skipping strings and template text
  let depth = 1;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') { for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return code.length;
}
export function scopeSites(code) {
  const sites = [];
  const connect = /\bWDS\s*\.\s*connect\s*\(/g;
  let m;
  while ((m = connect.exec(code))) {
    const open = m.index + m[0].length, args = code.slice(open, matchingParen(code, open));
    const lit = new RegExp('\\bscope\\s*:\\s*(["\'`])(' + ID_SRC + ')\\1').exec(args);
    if (lit) { const end = open + lit.index + lit[0].length - 1; sites.push({ start: end - lit[2].length, end, id: lit[2] }); continue; }
    const ref = /\bscope\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(args) || (/[{,]\s*scope\s*[,}]/.test(args) ? [null, 'scope'] : null);
    if (!ref) continue;
    const decl = new RegExp('\\b(?:const|let|var)\\s+' + ref[1].replace(/\$/g, '\\$') + '\\s*=\\s*(["\'`])(' + ID_SRC + ')\\1').exec(code);
    if (decl) { const end = decl.index + decl[0].length - 1; sites.push({ start: end - decl[2].length, end, id: decl[2] }); }
  }
  return sites;
}

// The scope IDs that WDS.connect uses in the inline scripts of the page become the sandbox ID. Returns {html, replaced: [old ids],
// sites: number of places that name a scope (the sandbox ID included)}. Nothing else that looks like an ID is touched.
export function rewriteScopes(html, scripts, sandboxId) {
  const replaced = [];
  let out = html, sites = 0;
  for (const s of [...scripts].filter((t) => t.content).sort((a, b) => b.end - a.end)) {
    const body = html.slice(s.end, s.end + s.content.length);
    let next = body;
    for (const site of scopeSites(body).sort((a, b) => b.start - a.start)) {
      sites++;
      if (site.id !== sandboxId && !replaced.includes(site.id)) replaced.push(site.id);
      next = next.slice(0, site.start) + sandboxId + next.slice(site.end);
    }
    out = out.slice(0, s.end) + next + out.slice(s.end + body.length);
  }
  return { html: out, replaced, sites };
}
