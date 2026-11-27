// Helpers for the browser tests (ui.spec.mjs).
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { expect } from '@playwright/test';
import { startWorld, DIST } from './ui-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
export const VERSION = pkg.version;
export const BUNDLE = join(DIST, 'wds-' + VERSION + '.js');
export const SRI = readFileSync(BUNDLE + '.sri', 'utf8');
export const SHOTS = join(HERE, '..', 'test-results', 'shots');
export const core = require('../src/wds-core.js');
export const hashwasm = require('../vendor/hash-wasm-argon2.umd.min.js');

let tmp = null;
export function tmpDir() {
  if (!tmp) {
    tmp = mkdtempSync(join(tmpdir(), 'wds-ui-'));
    process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
  }
  return tmp;
}

// A file:// page that loads the bundle (from disk, or from the test server with SRI).
export function writePage(name, { src, integrity, css, lang } = {}) {   // no <html lang> unless asked for: the library then follows navigator.language
  const dir = tmpDir();
  const tag = integrity
    ? '<script src="' + src + '" integrity="' + integrity + '" crossorigin="anonymous"></script>'
    : '<script src="' + (src || ('file://' + BUNDLE)) + '"></script>';
  const html = '<!doctype html><html' + (lang ? ' lang="' + lang + '"' : '') + '><head><meta charset="utf-8"><title>wds ui test</title>' + (css ? '<style>' + css + '</style>' : '') + tag + '</head>' +
    '<body><main id="app"><h1>Test app</h1><p id="out"></p><input type="file" id="file"><button id="app-button">App button</button></main></body></html>';
  const p = join(dir, name);
  writeFileSync(p, html);
  return 'file://' + p;
}

export async function startTestWorld(opts) { return startWorld(opts); }

// The colour [r, g, b] of one pixel of a PNG (8 bit, RGB or RGBA, not interlaced; what Playwright's screenshot() returns).
export function pixelAt(png, x, y) {
  let pos = 8, width = 0, bpp = 4;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos), type = png.toString('latin1', pos + 4, pos + 8), data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); bpp = data[9] === 6 ? 4 : 3; if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG'); }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * bpp, rows = [];
  let prev = Buffer.alloc(stride);
  for (let r = 0; r <= y; r++) {
    const f = raw[r * (stride + 1)], line = Buffer.from(raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = (line[i] + add) & 255;
    }
    prev = line;
  }
  return [prev[x * bpp], prev[x * bpp + 1], prev[x * bpp + 2]];
}

// Open the page and create the store: window.store. The store is created again after every load, so after a lock (which reloads the page) `store` is a fresh one.
export async function openApp(context, w, { page: url, cfg } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((c) => { document.addEventListener('DOMContentLoaded', () => { window.store = WDS.connect(c); }); }, Object.assign({ scope: w.scope, baseUrl: w.service, escrowPins: w.pins }, cfg || {}));
  await page.goto(url || writePage('app.html'));
  page.errors = errors;
  return page;
}

// store.lock() saves what is pending and reloads the page: resolves when the new page has loaded (its store is locked).
export async function lockPage(page) {
  const loaded = page.waitForEvent('load');
  await page.evaluate(() => { void store.lock(); });
  await loaded;
}

// HIBP stand-in: the passphrase in opts.pwned is "found"; everything else is padded noise.
export async function mockHibp(page, { pwned = [], down = false } = {}) {
  const seen = [];
  const sha1 = (s) => createHash('sha1').update(s.normalize('NFC')).digest('hex').toUpperCase();
  await page.route('https://api.pwnedpasswords.com/range/*', async (route) => {
    const req = route.request();
    const prefix = req.url().split('/range/')[1];
    seen.push({ prefix, padding: req.headers()['add-padding'] });
    if (down) return route.abort('connectionrefused');
    const lines = ['0018A45C4D1DEF81644B54AB7F969B88D65:0', '00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0'];
    pwned.forEach((p) => { const h = sha1(p); if (h.startsWith(prefix)) lines.push(h.slice(5) + ':42'); });
    return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: lines.join('\r\n') });
  });
  return seen;
}

export async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, name + '.png') });
}

export function dialog(page) { return page.getByRole('dialog').last(); }

// Drive the create-vault flow through the dialogs. Returns {accessId, recovery, passphrase, keyFile}.
export async function createVaultViaUi(page, passphrase = 'purple-elephant-marching-slowly', { shots } = {}) {
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const dlg = dialog(page);
  await dlg.getByRole('button', { name: 'Create a new vault' }).click();
  await dlg.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await dlg.getByLabel('Repeat passphrase').fill(passphrase);
  if (shots) await shot(page, shots + '-create');
  await dlg.getByRole('button', { name: 'Create vault' }).click();
  await expect(dlg.getByRole('heading', { name: 'Save your access sheet' })).toBeVisible();
  const accessId = (await dlg.locator('[data-wds=access-id]').innerText()).trim();
  const recovery = (await dlg.locator('[data-wds=recovery-code]').innerText()).trim();
  let keyFile = null;
  const dl = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'Download key file' }).click();
  const d = await dl;
  keyFile = { name: d.suggestedFilename(), path: join(tmpDir(), 'key-' + Date.now() + '.wds.json') };
  await d.saveAs(keyFile.path);
  if (shots) await shot(page, shots + '-sheet');
  await dlg.getByLabel('I have saved the access sheet and the recovery code.').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();
  await page.evaluate(() => window.unlockP);
  return { accessId, recovery, passphrase, keyFile };
}

export async function unlockViaUi(page, accessId, passphrase, { useKeyFile } = {}) {
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const dlg = dialog(page);
  if (useKeyFile) await dlg.locator('[data-wds=keyfile]').setInputFiles(useKeyFile);
  else if (accessId) await dlg.getByLabel('Access ID').fill(accessId);
  await dlg.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await dlg.getByRole('button', { name: 'Unlock' }).click();
  await page.evaluate(() => window.unlockP);
}

// A Node-side client acting as "another device" on the same fake server (real Argon2id, same as the browser).
export function nodeClient(w, storage) {
  return new core.Client({ scope: w.scope, service: w.service, escrowPins: w.pins, argon2: hashwasm.argon2id, storage: storage || core.memoryStorage() });
}

export const I = core.internals;

// The operator's recovery step (PROTOCOL.md 9): an escrow-signed roster version adds exactly one owner invite.
// "founder" is a Node-side client that is unlocked as the vault owner (it lends its copy of the keys, standing in
// for the escrow keyring entry that wds-recover would decrypt). Returns the invite code of the new owner.
export async function recoverByFaculty(w, founder) {
  const esc = w.world.escrow.current, s = founder.s, head = s.head;
  const escSlot = head.body.slots.find((x) => x.kind === 'escrow');
  const ownerE = await I.generateKeyPair('E'), ownerS = await I.generateKeyPair('S');
  const slotId = I.randomSlotId(), secret = I.randomBytes(17), idBytes = I.randomBytes(12), accessId = await I.b32cEncode(idBytes);
  const sk = await I.deriveSlotKeys(secret);
  const body = JSON.parse(JSON.stringify(head.body));
  body.version++; body.prev = head.hash; body.signer = escSlot.id; body.time += 1;
  body.slots.push({ e_pub: I.b64u(ownerE.pub), expires: Math.floor(Date.now() / 1000) + 86400, id: slotId, kind: 'invite', role: 'owner', s_pub: I.b64u(ownerS.pub) });
  body.slots.sort((a, b) => (a.id < b.id ? -1 : 1));
  const keyring = await I.makeKeyring(w.scope, body, s.vmk, s.nk);
  const roster = await I.signRoster(body, await I.importPrivate('S', esc.s.d, esc.s.pub));
  const wrapped = await I.wrapSlot({ kWrapRaw: sk.kWrap, scope: w.scope, vault: s.vaultId, accessId, kdf: { alg: 'invite' }, slotId, keySets: [{ e: ownerE, s: ownerS }] });
  const res = await fetch(w.service + 'api/v1/vaults/' + s.vaultId + '/roster', {
    method: 'POST', headers: { Authorization: I.bearerHeader(s.accessId, s.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ roster, keyring, new_slots: [{ slot: slotId, access_id: accessId, kdf: { alg: 'invite' }, token_hash: I.b64u(sk.tokenHash), wrapped: I.b64u(wrapped) }] }),
  });
  if (res.status !== 200) throw new Error('recovery roster refused: ' + res.status + ' ' + await res.text());
  return (await I.makeInviteCode(idBytes, secret)).display;
}

// Redeem an invite code through the dialogs; leaves the store unlocked.
export async function redeemViaUi(page, code, passphrase) {
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const dlg = dialog(page);
  await dlg.getByRole('button', { name: 'I have an invite code' }).click();
  await dlg.getByLabel('Invite code').fill(code);
  await dlg.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await dlg.getByLabel('Repeat passphrase').fill(passphrase);
  await dlg.getByRole('button', { name: 'Join' }).click();
  await expect(dlg.getByRole('heading', { name: 'You now have access' })).toBeVisible();
  await dlg.getByLabel('I have saved my access ID.').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();
  return page.evaluate(() => window.unlockP);
}
