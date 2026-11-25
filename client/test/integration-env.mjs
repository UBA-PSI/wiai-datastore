// Environment for the integration tests (integration.spec.mjs): the REAL server (server/wds_server, started with the project
// venv), a temporary database and config with freshly generated escrow keys, a scope created with the dev CLI, and a REAL
// bundle built from client/src with exactly those escrow keys pinned (so the production code path for pinned escrow keys is
// the one under test). Nothing here talks to the fake server of the UI tests.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { build } from '../build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLIENT_DIR = join(HERE, '..');
export const ROOT = join(CLIENT_DIR, '..');
export const SERVER_DIR = join(ROOT, 'server');
export const SHOTS = join(CLIENT_DIR, 'test-results', 'shots');
const require = createRequire(import.meta.url);
// wds-core.js loaded as a Node module has the low-level building blocks (internals); the bundle in the browser has not.
export const core = require('../src/wds-core.js');
export const I = core.internals;

export function pythonBin() {
  if (process.env.WDS_PYTHON) return process.env.WDS_PYTHON;
  const venv = join(ROOT, '.venv', 'bin', 'python');
  if (!existsSync(venv)) throw new Error('no Python venv at ' + venv + ' (see scripts/test-integration.sh)');
  return venv;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const b64u = (b) => Buffer.from(b).toString('base64url');

function runCli(args, cfg, db) {
  const r = spawnSync(pythonBin(), ['-m', 'wds_server.cli', ...args, '--db', db, '--config', cfg], { cwd: SERVER_DIR, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('wds_server.cli ' + args[0] + ' failed: ' + r.stdout + r.stderr);
  return r.stdout;
}

async function waitHealthy(base, child, log) {
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error('server exited early (' + child.exitCode + '):\n' + log());
    try { const r = await fetch(base + 'healthz'); if (r.ok) return; } catch (e) { /* not yet */ }
    if (Date.now() - t0 > 30000) throw new Error('server did not become healthy:\n' + log());
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Start the stack. Returns {service, scope, joinCode, ..., startServer(opts), stop()}.
export async function startStack() {
  const tmp = mkdtempSync(join(tmpdir(), 'wds-int-'));
  const children = [];
  const db = join(tmp, 'wds.db');
  const gen = async () => {
    const e = await I.generateKeyPair('E'), s = await I.generateKeyPair('S');
    return { e, s, e_pub: I.b64u(e.pub), s_pub: I.b64u(s.pub), id: await I.escrowKeyId(e.pub, s.pub) };
  };
  const escrow = { current: await gen(), spare: await gen() };
  const pins = [escrow.current.id, escrow.spare.id];
  const bundleDir = join(tmp, 'bundle');
  const built = build({ escrowPins: pins, retiredEscrow: [], dist: bundleDir });
  const operatorToken = 'wdsop.' + b64u(randomBytes(32));
  const operatorHash = b64u(createHash('sha256').update(operatorToken).digest());
  const configText = (readOnlyThreshold, ratelimit, extraServer = '') => '[server]\nclient_dir = ' + bundleDir + '\nread_only_threshold = ' + readOnlyThreshold + '\nsweep_interval = 0\n' + extraServer
    + '[escrow]\ncurrent_e_pub = ' + escrow.current.e_pub + '\ncurrent_s_pub = ' + escrow.current.s_pub + '\n'
    + 'spare_e_pub = ' + escrow.spare.e_pub + '\nspare_s_pub = ' + escrow.spare.s_pub + '\n[operator]\ntoken_hashes = ' + operatorHash + '\n'
    + (ratelimit ? '[ratelimit]\n' + Object.entries(ratelimit).map(([k, v]) => k + ' = ' + v + '\n').join('') : '');
  // The development machine's real disk is often above the 85 % default, so the normal server never goes read-only by itself.
  const cfgNormal = join(tmp, 'normal.ini'), cfgReadOnly = join(tmp, 'readonly.ini');
  writeFileSync(cfgNormal, configText(1.0));
  // Any disk is "in use" by more than 0.01 %: this server is in read-only mode (PROTOCOL.md 8.6).
  writeFileSync(cfgReadOnly, configText(0.0001));

  const joinCode = 'K7M2QX9A';
  const scopeDoc = JSON.parse(runCli(['create-scope', '--slug', 'itest', '--name', 'Integration test', '--enrollment', 'join_code', '--join-code', joinCode], cfgNormal, db));

  // publicBase: the server names itself as the public address (http://127.0.0.1:<port>/datastore), as the production server
  // names https://wiai.uni-bamberg.de/datastore. The documentation and export page take their absolute URLs from it.
  async function startServer({ readOnly = false, ratelimit = null, publicBase = false } = {}) {
    const port = await freePort();
    let cfg = readOnly ? cfgReadOnly : cfgNormal;
    if (ratelimit || publicBase) {
      cfg = join(tmp, 'x-' + port + '.ini');
      writeFileSync(cfg, configText(readOnly ? 0.0001 : 1.0, ratelimit, publicBase ? 'public_base = http://127.0.0.1:' + port + '/datastore\n' : ''));
    }
    let out = '';
    const child = spawn(pythonBin(), ['-m', 'wds_server', '--db', db, '--host', '127.0.0.1', '--port', String(port), '--config', cfg],
      { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    children.push(child);
    const origin = 'http://127.0.0.1:' + port;
    const base = origin + '/datastore/';
    await waitHealthy(base, child, () => out);
    return { origin, service: base, port, readOnly, log: () => out, stop: () => stopChild(child) };
  }
  const normal = await startServer();
  return {
    tmp, db, scope: scopeDoc.scope, joinCode, pins, escrow, bundleDir, bundleFile: built.file, sri: built.sri, version: built.version,
    operatorToken, service: normal.service, origin: normal.origin, server: normal, startServer,
    // All bytes of the database files (main file and write-ahead log), for the "no plaintext at rest" check.
    dbBytes() {
      return readdirSync(tmp).filter((f) => f.startsWith('wds.db')).map((f) => ({ file: f, bytes: readFileSync(join(tmp, f)) }));
    },
    async stop() {
      await Promise.all(children.map(stopChild));
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

// ---- raw HTTP against the API, for checks that must not go through the client library ----
export async function api(stack, method, path, { auth, headers = {}, body, json, service } = {}) {
  const h = Object.assign({}, headers);
  if (auth) h.Authorization = auth;
  let payload = body;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
  const res = await fetch((service || stack.service) + 'api/v1' + path, { method, headers: h, body: payload });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let parsed = null;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { /* binary or empty */ }
  return { status: res.status, headers: res.headers, bytes, json: parsed };
}
export const operatorAuth = (stack) => 'Bearer ' + stack.operatorToken;

// Header of a record envelope (PROTOCOL.md 4.1): magic, type, flags, epoch.
export function envelopeHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { magic: new TextDecoder().decode(bytes.subarray(0, 4)), type: bytes[4], flags: bytes[5], epoch: dv.getUint32(6) };
}

export function containsBytes(hay, needle) {
  return Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).includes(Buffer.from(needle));
}

// ---- the operator side of a faculty recovery (PROTOCOL.md 9; this is what tools/wds-recover does with the escrow private keys) ----
// Time travel for the 72 h / 7 day waiting period: the recovery row of this run's temporary database is made ready.
export function makeRecoveryReady(stack) {
  const code = 'import sqlite3,sys,time\nc=sqlite3.connect(sys.argv[1],timeout=30)\nc.execute("UPDATE recoveries SET ready_at=? WHERE state=\'pending\'",(int(time.time())-1,))\nc.commit()\n';
  const r = spawnSync(pythonBin(), ['-I', '-c', code, stack.db], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not advance the recovery: ' + r.stderr);
}

// Time travel for invite expiry (a real invite lives at least an hour): the server's own expiry of these slots is moved into
// the past. The signed roster still shows the original expiry; the server reports the slots as expired and refuses their tokens.
export function expireInvites(stack, slotIds) {
  const code = 'import sqlite3,sys,time\nc=sqlite3.connect(sys.argv[1],timeout=30)\nfor s in sys.argv[2:]:\n    c.execute("UPDATE slots SET expires=? WHERE slot_id=? AND redeemed IS NULL",(int(time.time())-5,s))\nc.commit()\n';
  const r = spawnSync(pythonBin(), ['-I', '-c', code, stack.db, ...slotIds], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not expire the invites: ' + r.stderr);
}

// Fetch the escrow material, open the escrow slot's keyring entry with the escrow private key, and sign a roster version that
// adds exactly one owner invite (PROTOCOL.md 9). Returns {code: invite code of the new owner, version, response}.
export async function recoverAsOperator(stack, vaultId, { expiresIn = 86400 } = {}) {
  const auth = operatorAuth(stack);
  const esc = await api(stack, 'GET', '/admin/vaults/' + vaultId + '/escrow', { auth });
  if (esc.status !== 200) throw new Error('escrow fetch refused: ' + esc.status + ' ' + JSON.stringify(esc.json));
  const { roster, escrow_slot: escrowSlot, scope } = esc.json;
  const headDoc = roster.versions[roster.versions.length - 1];
  const entry = headDoc.body.slots.find((s) => s.id === escrowSlot);
  const set = [stack.escrow.current, stack.escrow.spare].find((x) => x.e_pub === entry.e_pub && x.s_pub === entry.s_pub);
  if (!set) throw new Error('the roster names an escrow key set that this run does not hold');
  const ePriv = await I.importPrivate('E', set.e.d, set.e.pub);
  const plain = await I.eciesOpen({ recipientPriv: ePriv, recipientPub: set.e.pub, envelope: I.b64uDecode(esc.json.keyring_entry),
    aadTail: I.aadKeyring(scope, vaultId, escrowSlot, headDoc.body.version, set.e.pub) });
  const kr = I.parseKeyringPlaintext(plain);
  const vmk = new Map(kr.epochs.map((x) => [x.e, x.k]));

  const newE = await I.generateKeyPair('E'), newS = await I.generateKeyPair('S');
  const slotId = I.randomSlotId(), secret = I.randomBytes(17), idBytes = I.randomBytes(12), accessId = await I.b32cEncode(idBytes);
  const sk = await I.deriveSlotKeys(secret);
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.parse(JSON.stringify(headDoc.body));
  body.version++; body.prev = roster.head_hash; body.signer = escrowSlot; body.time = Math.max(body.time + 1, now);
  body.slots.push({ e_pub: I.b64u(newE.pub), expires: now + expiresIn, id: slotId, kind: 'invite', role: 'owner', s_pub: I.b64u(newS.pub) });
  body.slots.sort((a, b) => (a.id < b.id ? -1 : 1));
  const keyring = await I.makeKeyring(scope, body, vmk, kr.nk);
  const signed = await I.signRoster(body, await I.importPrivate('S', set.s.d, set.s.pub));
  const wrapped = await I.wrapSlot({ kWrapRaw: sk.kWrap, scope, vault: vaultId, accessId, kdf: { alg: 'invite' }, slotId, keySets: [{ e: newE, s: newS }] });
  const res = await api(stack, 'POST', '/admin/vaults/' + vaultId + '/recovery/complete', { auth, json: {
    roster: signed, keyring,
    new_slots: [{ slot: slotId, access_id: accessId, kdf: { alg: 'invite' }, token_hash: I.b64u(sk.tokenHash), wrapped: I.b64u(wrapped) }],
  } });
  if (res.status !== 200) throw new Error('recovery completion refused: ' + res.status + ' ' + JSON.stringify(res.json));
  return { code: (await I.makeInviteCode(idBytes, secret)).display, version: body.version, slotId, response: res.json };
}
