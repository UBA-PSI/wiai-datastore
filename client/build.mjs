// Builds client/dist/wds-<version>.js: vendored hash-wasm (Argon2id) + wds-core.js + wds-ui.js in one classic script.
//
//   node build.mjs [--freeze] [--force] [--escrow-pins=<id>,<id>] [--retired-escrow=<id>:<until>,...]
//
// Version: client/package.json. Escrow pins (SHA-256 based IDs of the faculty's current and spare escrow key sets,
// PROTOCOL.md 3.4): --escrow-pins, the environment variable WDS_ESCROW_PINS, or client/escrow-pins.json (a JSON array,
// or {"pins": [...], "retired": [{"id": "...", "until": <unix seconds>}]}), in that order. Retired escrow sets (pinned by
// earlier library versions, valid for vault history only): --retired-escrow, WDS_RETIRED_ESCROW or the "retired" list.
// Without pins the bundle still builds but vault creation needs the "escrowPins" option (tests only; a bundle that has
// pins ignores that option).
//
// The bundle is one function scope: the vendored hash-wasm runs in a private scope (it sees no AMD/CommonJS loader of the
// page and sets no global), its Argon2id function is handed to wds-core.js through a private variable, and wds-core.js is
// built with PRODUCTION = true (no setRandom, setArgon2 or internals on WDSCore), and without the lines of wds-ui.js that set TEST_HOOKS (opts.testHooks keeps them for the test bundles).
//
// Outputs (in dist/, or in opts.dist for test bundles): dist/wds-<version>.js, dist/wds-<version>.js.sri ("sha384-<base64>", no newline) and dist/hashes.json, which
// records every built version (file, sri, sha256, size, escrow pins, frozen). A released version is immutable: after
// "--freeze" the build refuses to produce different bytes for that version unless "--force" is given.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PIN_RE = /^[A-Za-z0-9_-]{43}$/;

function replaceOnce(text, re, replacement, what) {
  const hits = text.match(new RegExp(re.source, 'g'));
  if (!hits || hits.length !== 1) throw new Error('build: expected exactly one match for ' + what + ', found ' + (hits ? hits.length : 0));
  return text.replace(re, () => replacement);
}
function parseRetired(text) {
  return text.split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const [id, until] = s.split(':'); return { id, until: Number(until) }; });
}
function semverKey(v) { return v.split('.').map((n) => String(Number(n)).padStart(6, '0')).join('.'); }

export function build(opts = {}) {
  const root = opts.root || HERE;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('build: package.json version must be MAJOR.MINOR.PATCH, got ' + version);

  let pins = opts.escrowPins;
  if (!pins && process.env.WDS_ESCROW_PINS) pins = process.env.WDS_ESCROW_PINS.split(',').map((s) => s.trim()).filter(Boolean);
  const pinFile = join(root, 'escrow-pins.json');
  let fileRetired = null;
  if (existsSync(pinFile)) {
    const j = JSON.parse(readFileSync(pinFile, 'utf8'));
    if (Array.isArray(j)) { if (!pins) pins = j; } else { if (!pins) pins = j.pins; fileRetired = j.retired || null; }
  }
  pins = pins || [];
  pins.forEach((p) => { if (!PIN_RE.test(p)) throw new Error('build: escrow pin is not a 43-character base64url ID: ' + p); });
  if (pins.length !== 0 && pins.length !== 2 && !opts.allowAnyPinCount) throw new Error('build: expected the current and the spare escrow ID (2 pins), got ' + pins.length);

  let retired = opts.retiredEscrow;
  if (!retired && process.env.WDS_RETIRED_ESCROW) retired = parseRetired(process.env.WDS_RETIRED_ESCROW);
  if (!retired && fileRetired) retired = fileRetired;
  retired = retired || [];
  retired.forEach((r) => {
    if (!r || !PIN_RE.test(r.id) || !Number.isSafeInteger(r.until) || r.until <= 0) throw new Error('build: retired escrow entries need a 43-character id and a positive integer "until": ' + JSON.stringify(r));
    if (pins.includes(r.id)) throw new Error('build: an escrow ID cannot be both pinned and retired: ' + r.id);
  });

  const vendor = readFileSync(join(root, 'vendor', 'hash-wasm-argon2.umd.min.js'), 'utf8');
  let core = readFileSync(join(root, 'src', 'wds-core.js'), 'utf8');
  let ui = readFileSync(join(root, 'src', 'wds-ui.js'), 'utf8');
  core = replaceOnce(core, /var VERSION = '[^']*';/, "var VERSION = '" + version + "';", 'core VERSION');
  core = replaceOnce(core, /var BUILTIN_ESCROW_PINS = \[[^\]]*\];/, 'var BUILTIN_ESCROW_PINS = ' + JSON.stringify(pins) + ';', 'BUILTIN_ESCROW_PINS');
  core = replaceOnce(core, /var BUILTIN_RETIRED_ESCROW = \[[^\]]*\];/, 'var BUILTIN_RETIRED_ESCROW = ' + JSON.stringify(retired) + ';', 'BUILTIN_RETIRED_ESCROW');
  core = replaceOnce(core, /var PRODUCTION = false;/, 'var PRODUCTION = true;', 'PRODUCTION');
  ui = replaceOnce(ui, /var UI_VERSION = '[^']*';/, "var UI_VERSION = '" + version + "';", 'ui UI_VERSION');
  if (!opts.testHooks) ui = ui.split('\n').filter((l) => !/^\s*TEST_HOOKS\.\w+ = /.test(l)).join('\n');   // the hooks of the library's own tests are not in a published bundle

  const banner = '/*! WIAI Datastore client library ' + version + ' - hash-wasm Argon2id (MIT, see client/vendor/LICENSE), wds-core.js, wds-ui.js */\n';
  // One function scope. "module", "exports" and "define" are hidden from wds-core.js and wds-ui.js, so their UMD headers
  // always register the globals WDSCore and WDS, whatever loader the page has; the vendored build gets its own CommonJS-like
  // pair and never touches a global.
  const bundle = banner + '(function () {\nvar module, exports, define;\n'
    + 'var WDS_VENDOR_ARGON2 = (function () {\nvar exports = {}, module = { exports: exports }, define;\n' + vendor.trim()
    + '\nif (typeof module.exports.argon2id !== "function") throw new Error("wds: the bundled Argon2id function is missing");\nreturn module.exports.argon2id;\n})();\n;\n'
    + core.trim() + '\n;\n' + ui.trim() + '\n})();\n';
  const bytes = Buffer.from(bundle, 'utf8');
  const sri = 'sha384-' + createHash('sha384').update(bytes).digest('base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const dist = opts.dist || join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  const hashFile = join(dist, 'hashes.json');
  const hashes = existsSync(hashFile) ? JSON.parse(readFileSync(hashFile, 'utf8')) : {};
  const prev = hashes[version];
  if (prev && prev.frozen && prev.sha256 !== sha256 && !opts.force) {
    throw new Error('build: version ' + version + ' is frozen (released) and the new bytes differ; bump the version in package.json or pass --force');
  }
  hashes[version] = { file: 'wds-' + version + '.js', sri: sri, sha256: sha256, bytes: bytes.length, escrow_pins: pins, retired_escrow: retired, frozen: !!(opts.freeze || (prev && prev.frozen)) };
  const sorted = {};
  Object.keys(hashes).sort((a, b) => (semverKey(a) < semverKey(b) ? -1 : 1)).forEach((k) => { sorted[k] = hashes[k]; });

  const out = join(dist, 'wds-' + version + '.js');
  writeFileSync(out, bytes);
  writeFileSync(out + '.sri', sri);
  writeFileSync(hashFile, JSON.stringify(sorted, null, 2) + '\n');
  return { version, file: out, sri, sha256, bytes: bytes.length, pins };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const pinArg = args.find((a) => a.startsWith('--escrow-pins='));
  const retArg = args.find((a) => a.startsWith('--retired-escrow='));
  try {
    const r = build({
      freeze: args.includes('--freeze'), force: args.includes('--force'),
      escrowPins: pinArg ? pinArg.slice('--escrow-pins='.length).split(',').filter(Boolean) : undefined,
      retiredEscrow: retArg ? parseRetired(retArg.slice('--retired-escrow='.length)) : undefined,
    });
    console.log('built ' + r.file + ' (' + r.bytes + ' bytes)');
    console.log('integrity="' + r.sri + '"');
    if (!r.pins.length) console.warn('warning: no escrow pins in this build; apps must pass escrowPins (tests only) or vault creation fails');
  } catch (e) { console.error(e.message); process.exit(1); }
}
