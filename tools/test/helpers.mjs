// Helpers of the tool tests: temporary directories, key files made by wds-keygen, command line runs, app variants.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TOOLS = join(HERE, '..');
export const ROOT = join(TOOLS, '..');
const require = createRequire(import.meta.url);
export const core = require('../../client/src/wds-core.js');
export const hashwasm = require('../../client/vendor/hash-wasm-argon2.umd.min.js');
export const HASHES = JSON.parse(readFileSync(join(ROOT, 'client', 'dist', 'hashes.json'), 'utf8'));
export const VERSION = Object.keys(HASHES).pop();

const dirs = [];
export function tmpDir(prefix = 'wds-tools-test-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch (e) { /* best effort */ } } });

// Run a tool (node tools/<name> args...) and collect output.
export function run(tool, args, { env = {}, input, cwd } = {}) {
  return new Promise((resolve) => {
    // No optional online lookups by default (hashes, scope check): the tests must not depend on the network or on production.
    const child = spawn(process.execPath, [join(TOOLS, tool), ...args], { env: { ...process.env, WDS_VERIFY_OFFLINE: '1', ...env }, cwd: cwd || ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input || '');
  });
}

// Escrow key sets made by the real tools/wds-keygen.mjs. Returns {current:{file, pub}, spare:{file, pub}} with the public documents.
export function makeEscrowFiles(dir) {
  const out = {};
  for (const label of ['current', 'spare']) {
    const r = spawnSync(process.execPath, [join(TOOLS, 'wds-keygen.mjs'), '--label', label, '--out', dir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('wds-keygen failed: ' + r.stderr);
    out[label] = { file: join(dir, 'wds-escrow-' + label + '-private.json'), pub: JSON.parse(r.stdout) };
  }
  return out;
}
export function writeToken(dir, token) {
  const file = join(dir, 'operator-token');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

// A copy of an app file with the library tag's integrity set to the published hash (the files in test-apps/ carry the hash of the
// build they were written for; a rebuild changes it).
export function freshHtml(html, version = VERSION) {
  const current = JSON.parse(readFileSync(join(ROOT, 'client', 'dist', 'hashes.json'), 'utf8'));   // read again: a rebuild of the library changes the hash
  return html.replace(/integrity="sha384-[^"]*"/, 'integrity="' + current[version].sri + '"').replace(/wds-\d+\.\d+\.\d+\.js/, 'wds-' + version + '.js');
}
export function readApp(name) { return freshHtml(readFileSync(join(TOOLS, 'test-apps', name, 'index.html'), 'utf8')); }
// Write an app (and optionally wds-verify.json) into a fresh directory; returns the directory.
export function writeApp(html, steps) {   // steps: an array of steps (written as {steps}), or the whole wds-verify.json object
  const dir = tmpDir('wds-app-');
  writeFileSync(join(dir, 'index.html'), html);
  if (steps) writeFileSync(join(dir, 'wds-verify.json'), JSON.stringify(Array.isArray(steps) && !steps.rawArray ? { steps } : steps));
  return dir;
}
// Replace exactly one occurrence, or fail the test loudly (a variant that silently stays unchanged would prove nothing).
export function variant(html, from, to) {
  const n = html.split(from).length - 1;
  if (n !== 1) throw new Error('variant: expected exactly one occurrence of ' + JSON.stringify(from) + ', found ' + n);
  return html.replace(from, () => to);
}

// A small app built on the head of the good example (CSP, library tag with the published hash, styles).
export function miniApp({ body, script, scope = 'wds-verify-mini-k7m2a9' }) {
  const good = readApp('good');
  const head = good.slice(0, good.indexOf('<body>'));
  return head + '<body>\n' + body + '\n<script>\n(function () {\n  var store = WDS.connect({ scope: ' + JSON.stringify(scope) + ' });\n  var $ = function (id) { return document.getElementById(id); };\n'
    + script + '\n})();\n</script>\n</body>\n</html>\n';
}
// A tiny HTTP server that plays the service: routes {'/path': json | (req) => [status, json, headers]}. Returns {url, close}. url ends in /datastore
// like the real base, so WDS_VERIFY_SERVICE can point at it.
export async function startStub(routes) {
  const { createServer } = await import('node:http');
  const hits = [];
  const server = createServer((req, res) => {
    const path = req.url.replace(/^\/datastore/, '').split('?')[0];
    hits.push(path);
    const r = routes[path];
    if (r === undefined) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not_found"}'); return; }
    const [status, body, headers] = typeof r === 'function' ? r(req) : [200, r, {}];
    res.writeHead(status, { 'Content-Type': 'application/json', ...(headers || {}) });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: 'http://127.0.0.1:' + server.address().port + '/datastore', hits, close: () => new Promise((ok) => { server.close(ok); server.closeAllConnections(); }) };
}
// The scope document of a sandbox as the server serves it (spec section 0).
export const sandboxDoc = (over = {}) => ({ scope: 'sandbox-000000', name: 'WIAI Datastore sandbox', status: 'active', enrollment: 'open', hibp: false,
  limits: { max_value_bytes: 524288, vault_bytes: 2097152, history_versions: 2 },
  sandbox: { enabled: true, wipe_at: '03:30', timezone: 'Europe/Berlin', next_wipe: Math.floor(Date.now() / 1000) + 3600, last_wipe: null }, ...over });
export const scopeDoc = (over = {}) => ({ scope: 'wds-verify-demo-k7m2a9', name: 'Demo', status: 'active', enrollment: 'join_code', hibp: true,
  limits: { max_value_bytes: 1048576, vault_bytes: 52428800, history_versions: 20 }, sandbox: null, ...over });

export const findingTitles = (jsonOut) => JSON.parse(jsonOut).findings.filter((f) => f.level === 'fail').map((f) => f.title);
export async function verify(dir, args = []) {
  const r = await run('wds-verify.mjs', [dir, '--json', ...args]);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (e) { /* the tool failed before it could report */ }
  const by = (level) => (parsed ? parsed.findings.filter((f) => f.level === level) : []);
  return { ...r, parsed, failures: by('fail'), warnings: by('warn'), passes: by('pass'),
    titles: (level) => by(level).map((f) => f.title), find: (id) => (parsed ? parsed.findings.find((f) => f.id === id) : undefined) };
}
