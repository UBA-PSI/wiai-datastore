// A local WIAI Datastore for tools and their tests: the REAL server (server/wds_server, Python) with a temporary database, freshly
// generated escrow keys (or keys you hand in), an operator token, and optionally a bundle of the library built from client/src with
// exactly those escrow keys pinned. Used by wds-verify (the "mock" of PLAN 9.5) and by the tests of the tools.
// Needs Python with the packages of server/requirements.txt: WDS_PYTHON, then <repo>/.venv/bin/python, then python3.13 on the PATH.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { ROOT, MockUnavailable, findPython } from './python.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export { ROOT, MockUnavailable, findPython };
export const SERVER_DIR = join(ROOT, 'server');
const require = createRequire(import.meta.url);
export const core = require('../../client/src/wds-core.js');
const I = core.internals;
const b64u = (b) => Buffer.from(b).toString('base64url');

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// Fresh escrow key set with its private parts (never written to disk by this module).
export async function generateEscrowSet() {
  const e = await I.generateKeyPair('E'), s = await I.generateKeyPair('S');
  return { e, s, e_pub: I.b64u(e.pub), s_pub: I.b64u(s.pub), id: await I.escrowKeyId(e.pub, s.pub) };
}

// Every server process this module started and that is still running: killed when this process ends, on an error as well as on
// Ctrl-C or a timeout from outside, so that no mock server is left behind with its temporary database.
const LIVE = new Set();
let hooked = false;
function hookExit() {
  if (hooked) return;
  hooked = true;
  const killAll = () => { for (const c of LIVE) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } } LIVE.clear(); };
  process.on('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { killAll(); process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[sig]); });
}

function stopChild(child) {
  LIVE.delete(child);
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

// opts: escrow {current:{e_pub,s_pub}, spare:{e_pub,s_pub}} (default: generated, returned as mock.escrow with private parts),
//       bundle: true to build the library with the escrow pins into <tmp>/bundle (default false),
//       python: path of the Python binary (default findPython()),
//       sandbox: true, or an object of [sandbox] keys, to start the server with the public sandbox scope (spec 2.1); the scope ID
//                is mock.sandboxId (default "sandbox-000000"), and create_per_ip is high unless you set it.
export async function startMock(opts = {}) {
  const python = opts.python || findPython();
  const tmp = mkdtempSync(join(tmpdir(), 'wds-mock-'));
  let child = null;
  try {
    const escrow = opts.escrow || { current: await generateEscrowSet(), spare: await generateEscrowSet() };
    const idOf = async (x) => x.id || await I.escrowKeyId(I.b64uDecode(x.e_pub), I.b64uDecode(x.s_pub));
    const pins = [await idOf(escrow.current), await idOf(escrow.spare)];
    const bundleDir = join(tmp, 'bundle');
    let built = null;
    if (opts.bundle) {
      const { build } = await import('../../client/build.mjs');
      built = build({ escrowPins: pins, retiredEscrow: [], dist: bundleDir, testHooks: true });
    }
    const sandbox = opts.sandbox ? { scope_id: 'sandbox-000000', create_per_ip: 1000, create_global: 100000, ...(opts.sandbox === true ? {} : opts.sandbox) } : null;
    const operatorToken = 'wdsop.' + b64u(randomBytes(32));
    const operatorHash = b64u(createHash('sha256').update(operatorToken).digest());
    const db = join(tmp, 'wds.db');
    const cfg = join(tmp, 'config.ini');
    // The development machine's disk is often above the 85 % default; the mock must never be read-only.
    writeFileSync(cfg, '[server]\n' + (built ? 'client_dir = ' + bundleDir + '\n' : '') + 'read_only_threshold = 1.0\nsweep_interval = 0\n'
      + '[escrow]\ncurrent_e_pub = ' + escrow.current.e_pub + '\ncurrent_s_pub = ' + escrow.current.s_pub + '\n'
      + 'spare_e_pub = ' + escrow.spare.e_pub + '\nspare_s_pub = ' + escrow.spare.s_pub + '\n'
      + '[operator]\ntoken_hashes = ' + operatorHash + '\n'
      + (sandbox ? '[sandbox]\n' + Object.entries(sandbox).map(([k, v]) => k + ' = ' + v + '\n').join('') : '')
      + (opts.ratelimit ? '[ratelimit]\n' + Object.entries(opts.ratelimit).map(([k, v]) => k + ' = ' + v + '\n').join('') : ''));
    const port = await freePort();
    let out = '';
    child = spawn(python, ['-m', 'wds_server', '--db', db, '--host', '127.0.0.1', '--port', String(port), '--config', cfg],
      { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    LIVE.add(child); hookExit();
    child.once('exit', () => LIVE.delete(child));
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const origin = 'http://127.0.0.1:' + port;
    const service = origin + '/datastore/';
    const t0 = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new MockUnavailable('the local mock server exited early (' + child.exitCode + '):\n' + out);
      try { const r = await fetch(service + 'healthz'); if (r.ok) break; } catch (e) { /* not yet */ }
      if (Date.now() - t0 > 30000) throw new MockUnavailable('the local mock server did not become healthy:\n' + out);
      await new Promise((r) => setTimeout(r, 100));
    }
    const mock = {
      tmp, db, cfg, python, origin, service, port, escrow, pins, sandboxId: sandbox ? sandbox.scope_id : null, operatorToken, bundleDir, bundle: built,
      log: () => out,
      exited: () => child.exitCode !== null || child.signalCode !== null,
      authorization: 'Bearer ' + operatorToken,
      // Operator call; resolves {status, json}.
      async admin(method, path, json) {
        const res = await fetch(service + 'api/v1/admin' + path, { method, headers: { Authorization: 'Bearer ' + operatorToken, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
        let body = null; try { body = await res.json(); } catch (e) { /* none */ }
        return { status: res.status, json: body };
      },
      // Create a scope (idempotent per slug within this mock); resolves the full scope id.
      async createScope(slug, { enrollment = 'open', joinCode = null } = {}) {
        const r = await this.admin('POST', '/scopes', { slug, name: slug, enrollment, join_code: joinCode, hibp: false, limits: null });
        if (r.status !== 201) throw new Error('creating the scope failed: ' + r.status + ' ' + JSON.stringify(r.json));
        return r.json;
      },
      // Create a scope with a given full scope ID (an app's WDS.connect({scope}) names it): the scope the server makes for the slug gets
      // the wanted ID. Only for a fresh scope without vaults. Needs the mock's config file for the server's own code.
      createScopeWithId(scopeId) {
        const code = 'import sys\nsys.path.insert(0, sys.argv[1])\n'
          + 'from wds_server.config import load_config\nfrom wds_server.service import Service\nfrom wds_server.scopes import create_scope\nfrom wds_server.db import transaction\n'
          + 'svc = Service(load_config(sys.argv[3]), sys.argv[2], validate=False)\n'
          + 'with svc.db.connection() as conn:\n    with transaction(conn):\n'
          + '        row = create_scope(svc, conn, slug=sys.argv[4][:-7], name="wds-verify mock", enrollment="open", join_code=None, hibp=False, limits=None)\n'
          + '        conn.execute("UPDATE scopes SET scope_id=? WHERE scope_id=?", (sys.argv[4], row["scope_id"]))\n';
        const r = spawnSync(python, ['-I', '-c', code, SERVER_DIR, db, cfg, scopeId], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error('could not create the scope ' + scopeId + ' in the mock: ' + r.stderr);
      },
      // Make the pending recovery of this mock ready (time travel over the 72 hour or 7 day waiting period).
      makeRecoveryReady() {
        const code = 'import sqlite3,sys,time\nc=sqlite3.connect(sys.argv[1],timeout=30)\nc.execute("UPDATE recoveries SET ready_at=? WHERE state=\'pending\'",(int(time.time())-1,))\nc.commit()\n';
        const r = spawnSync(python, ['-I', '-c', code, db], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error('could not advance the recovery: ' + r.stderr);
      },
      async stop() {
        await stopChild(child);
        rmSync(tmp, { recursive: true, force: true });
      },
    };
    return mock;
  } catch (e) {
    if (child) await stopChild(child);
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}
