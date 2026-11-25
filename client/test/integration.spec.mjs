// Integration tests: the REAL server (Python, temp database, scope created with the dev CLI) and the REAL client bundle built
// from client/src (escrow keys of this run pinned), driven by Chromium, Firefox and WebKit (see playwright.integration.config.mjs).
// Run with scripts/test-integration.sh. Pages are file:// pages (or load the bundle from the server's /datastore/client/ with SRI);
// every request body that leaves a browser is captured and searched for canary plaintexts at the end.
import { test as base, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startStack, api, operatorAuth, envelopeHeader, containsBytes, makeRecoveryReady, recoverAsOperator, expireInvites, core, I, SHOTS } from './integration-env.mjs';

const CANARY = 'CANARY-7f3a9c1e-plaintext-that-must-never-leave-the-browser';
const PASS_CANARY = 'PASSCANARY-91b2d4c8';
const NAME_CANARY = 'CANARYNAME-5d0e77b3';
const BINARY_CANARY = 'CANARYBINARY-3c19aa02';
const CANARIES = [CANARY, PASS_CANARY, NAME_CANARY, BINARY_CANARY];
const MIB = 1024 * 1024;

// Everything the browsers sent to the API, over the whole run of one project.
const captured = [];

const test = base.extend({
  stack: [async ({}, use) => {
    const stack = await startStack();
    try { await use(stack); } finally { await stack.stop(); }
  }, { scope: 'worker' }],
});
test.describe.configure({ mode: 'serial' });
test.setTimeout(240000);

// Helpers that run inside every page (before the bundle loads).
const INIT = '(' + function () {
  window.T = (p) => Promise.resolve(p).then((v) => ({ ok: v }), (e) => ({ err: {
    name: e && e.name, status: e && e.status, code: e && e.code, message: String(e && e.message), current: e && e.current,
    theirs: e && e.theirs ? e.theirs.value : undefined, mine: e && e.mine ? { value: e.mine.value } : undefined,
  } }));
  window.b64u = (u8) => btoa(String.fromCharCode.apply(null, Array.from(u8))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  window.bearer = (client) => 'Bearer wds1.' + client.s.accessId + '.' + b64u(client.s.token);
  window.sha = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', u8))).map((b) => b.toString(16).padStart(2, '0')).join('');
  // Deterministic pseudo-random bytes (xorshift), with an optional text planted at the start.
  window.pattern = (n, seed, plant) => {
    const b = new Uint8Array(n);
    let x = (seed >>> 0) || 1;
    for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255; }
    if (plant) b.set(new TextEncoder().encode(plant), 0);
    return b;
  };
} + ')()';

function newContext(browser) {
  return browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 800 }, locale: 'en-US' }).then(async (ctx) => {
    await ctx.addInitScript(INIT);
    ctx.on('request', (r) => {
      if (!r.url().includes('/datastore/api/')) return;
      const body = r.postDataBuffer();
      captured.push({ method: r.method(), url: r.url(), type: r.headers()['content-type'] || '', body: body ? Buffer.from(body) : null });
    });
    return ctx;
  });
}

let pageCount = 0;
function pageUrl(stack, via) {
  const dir = join(stack.tmp, 'pages');
  mkdirSync(dir, { recursive: true });
  const tag = via === 'server'
    ? '<script src="' + stack.origin + '/datastore/client/wds-' + stack.version + '.js" integrity="' + stack.sri + '" crossorigin="anonymous"></script>'
    : '<script src="file://' + stack.bundleFile + '"></script>';
  const file = join(dir, 'app' + (++pageCount) + '.html');
  writeFileSync(file, '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>wds integration</title>' + tag + '</head>'
    + '<body><main id="app"><h1>Integration test app</h1><p id="out"></p></main></body></html>');
  return 'file://' + file;
}

// A file:// page with the bundle loaded and window.c = a core client. via: 'server' (bundle from /datastore/client/ with SRI) or 'file'.
async function openApp(ctx, stack, { via = 'file', service, ui } = {}) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.goto(pageUrl(stack, via));
  await page.evaluate(({ scope, service: svc, ui: withUi }) => {
    if (typeof WDSCore === 'undefined') throw new Error('the bundle did not load');
    if (withUi) window.store = WDS.connect({ scope, baseUrl: svc });
    else window.c = new WDSCore.Client({ scope, service: svc });
  }, { scope: stack.scope, service: service || stack.service, ui: !!ui });
  return page;
}
// Replace window.c by a client that talks to another service URL (the read-only server shares the database).
const useService = (page, stack, service) => page.evaluate(({ scope, service: svc }) => { window.c = new WDSCore.Client({ scope, service: svc }); }, { scope: stack.scope, service });

let counter = 0;
async function createOwner(browser, stack, { via = 'file', recoveryContact } = {}) {
  const ctx = await newContext(browser);
  const page = await openApp(ctx, stack, { via });
  const passphrase = 'owner ' + (++counter) + ' ' + PASS_CANARY;
  const r = await page.evaluate(async ({ passphrase, joinCode, recoveryContact }) => {
    const v = await c.createVault({ passphrase, joinCode, recoveryContact });
    return { accessId: v.accessId, vaultId: v.vaultId, recovery: v.recoveryCode.canonical, keyFile: v.keyFile.text };
  }, { passphrase, joinCode: stack.joinCode, recoveryContact });
  return { ctx, page, passphrase, ...r };
}
async function unlockElsewhere(browser, stack, vault, passphrase, opts = {}) {
  const ctx = await newContext(browser);
  const page = await openApp(ctx, stack, opts);
  const status = await page.evaluate(({ accessId, passphrase }) => T(c.unlock({ accessId, passphrase })), { accessId: vault.accessId, passphrase });
  return { ctx, page, status };
}
async function invite(owner, role) {
  return owner.page.evaluate(async (role) => { const r = await c.createInvite({ role }); return { code: r.code.display, slotId: r.slotId, accessId: r.accessId }; }, role);
}
async function redeem(browser, stack, code, passphrase, opts = {}) {
  const ctx = await newContext(browser);
  const page = await openApp(ctx, stack, opts);
  const st = await page.evaluate(({ code, passphrase }) => T(c.redeemInvite({ inviteCode: code, passphrase })), { code, passphrase });
  expect(st.err, JSON.stringify(st.err)).toBeUndefined();
  return { ctx, page, status: st.ok };
}
const authOf = (page) => page.evaluate(() => bearer(c));
const shot = async (page, name) => { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'integration-' + name + '.png') }); };
const errOf = (r) => (r.err ? r.err.name + ' ' + (r.err.status || '') + ' ' + (r.err.code || '') : 'no error');

test('the server answers: health, redirect, public scope document, bundle with CORS and the published SRI hash', async ({ stack }) => {
  const h = await fetch(stack.service + 'healthz');
  expect(h.status).toBe(200);
  const red = await fetch(stack.origin + '/datastore', { redirect: 'manual' });
  expect(red.status).toBe(308);
  expect(red.headers.get('location')).toBe('/datastore/');
  const sc = await api(stack, 'GET', '/scopes/' + stack.scope);
  expect(sc.status).toBe(200);
  expect(sc.json.enrollment).toBe('join_code');
  expect(sc.json.join_code).toBeUndefined();
  expect(sc.json.escrow.map((e) => e.id).sort()).toEqual([...stack.pins].sort());
  expect(sc.headers.get('access-control-allow-origin')).toBe('*');
  expect(sc.headers.get('cache-control')).toBe('no-store');
  const lib = await fetch(stack.origin + '/datastore/client/wds-' + stack.version + '.js');
  expect(lib.status).toBe(200);
  expect(lib.headers.get('access-control-allow-origin')).toBe('*');
  expect(lib.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  const sri = await (await fetch(stack.origin + '/datastore/client/wds-' + stack.version + '.js.sri')).text();
  expect(sri).toBe(stack.sri);
  const pre = await fetch(stack.service + 'api/v1/scopes/' + stack.scope, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'PUT' } });
  expect(pre.status).toBe(204);
  expect(pre.headers.get('access-control-allow-headers')).toContain('WDS-Commit');
  expect(pre.headers.get('access-control-allow-origin')).toBe('*');
});

test('vault lifecycle: create, JSON and 5 MB binary, list, history and restore, unlock on a new device', async ({ browser, stack }) => {
  // the bundle is loaded from the server (Subresource Integrity from a file:// page) in this test
  const o = await createOwner(browser, stack, { via: 'server' });
  expect(o.accessId).toMatch(/^[0-9A-Z-]+$/);
  expect(o.recovery.length).toBe(28);

  const name = 'notes/' + NAME_CANARY;
  const res = await o.page.evaluate(async ({ name, canary, binCanary }) => {
    const out = {};
    await c.put(name, { text: canary, n: 1 });
    await c.put(name, { text: canary, n: 2 });
    await c.put(name, { text: canary, n: 3 });
    const big = pattern(5 * 1024 * 1024, 12345, binCanary);
    out.bigHash = await sha(big);
    out.putBig = (await c.put('files/big.bin', big, { mime: 'application/octet-stream' })).version;
    const back = await c.get('files/big.bin');
    out.backHash = await sha(back);
    out.backLength = back.length;
    out.get = await c.get(name);
    out.list = (await c.list()).map((r) => ({ name: r.name, version: r.version, kind: r.kind, length: r.length }));
    out.listNotes = (await c.list('notes/')).map((r) => r.name);
    out.history = (await c.history(name)).versions.map((v) => v.version);
    const restored = await c.restore(name, 1);
    out.restoredVersion = restored.version;
    out.afterRestore = await c.get(name);
    out.history2 = (await c.history(name)).versions.map((v) => v.version);
    out.usage = await c.usage();
    out.deleted = await c.delete('files/big.bin');
    out.afterDelete = await c.get('files/big.bin');
    return out;
  }, { name, canary: CANARY, binCanary: BINARY_CANARY });
  expect(res.backHash).toBe(res.bigHash);
  expect(res.backLength).toBe(5 * MIB);
  expect(res.get).toEqual({ text: CANARY, n: 3 });
  expect(res.list.map((r) => r.name)).toEqual(['files/big.bin', name]);
  expect(res.list.find((r) => r.name === 'files/big.bin').length).toBe(5 * MIB);
  expect(res.listNotes).toEqual([name]);
  expect(res.history).toEqual([3, 2, 1]);
  expect(res.restoredVersion).toBe(4);
  expect(res.afterRestore).toEqual({ text: CANARY, n: 1 });
  expect(res.history2).toEqual([4, 3, 2, 1]);
  expect(res.usage.bytes).toBeGreaterThan(5 * MIB);
  expect(res.usage.old_epoch_blobs).toBe(0);
  expect(res.deleted).toBe(true);
  expect(res.afterDelete === undefined || res.afterDelete === null).toBe(true);

  // what the server stores: opaque envelopes, record IDs that do not contain the name, no canary at all
  const auth = await authOf(o.page);
  const list = await api(stack, 'GET', '/vaults/' + o.vaultId + '/records', { auth });
  expect(list.status).toBe(200);
  expect(list.json.records.length).toBe(2);
  for (const rec of list.json.records) {
    expect(rec.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (rec.deleted) continue;
    const env = await api(stack, 'GET', '/vaults/' + o.vaultId + '/records/' + rec.id, { auth });
    expect(env.status).toBe(200);
    expect(envelopeHeader(env.bytes)).toEqual({ magic: 'WDS1', type: 1, flags: 0, epoch: 1 });
    expect(env.headers.get('etag')).toBe('"' + rec.version + '"');
    expect(env.headers.get('wds-commit')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const c of CANARIES) expect(containsBytes(env.bytes, c)).toBe(false);
  }

  // a second device: access ID and passphrase only
  const d = await unlockElsewhere(browser, stack, o, o.passphrase);
  expect(d.status.err, JSON.stringify(d.status.err)).toBeUndefined();
  expect(d.status.ok.role).toBe('owner');
  expect(d.status.ok.newDevice).toBe(true);
  expect(await d.page.evaluate((name) => c.get(name), name)).toEqual({ text: CANARY, n: 1 });
  expect(await d.page.evaluate(() => c.list().then((l) => l.map((r) => r.name)))).toEqual([name]);
  // wrong passphrase
  const bad = await d.page.evaluate(({ accessId }) => T(c.unlock({ accessId, passphrase: 'not the passphrase at all' })), { accessId: o.accessId });
  expect(bad.err && bad.err.name).toBe('AuthError');
  expect(d.page.errors).toEqual([]);
  expect(o.page.errors).toEqual([]);
});

test('conflicts: 412 for stale writes, deletes and create-only writes, resolved with the current version', async ({ browser, stack }) => {
  const a = await createOwner(browser, stack);
  const b = await unlockElsewhere(browser, stack, a, a.passphrase);
  expect(b.status.err).toBeUndefined();
  await a.page.evaluate(() => c.put('note', { text: 'v1' }));
  expect(await b.page.evaluate(() => c.get('note'))).toEqual({ text: 'v1' });
  await a.page.evaluate(() => c.put('note', { text: 'a v2' }));
  const stale = await b.page.evaluate(() => T(c.put('note', { text: 'b based on v1' })));
  expect(stale.err.name).toBe('ConflictError');
  expect(stale.err.status).toBe(412);
  expect(stale.err.code).toBe('precondition_failed');
  expect(stale.err.current).toBe(2);
  expect(stale.err.theirs).toEqual({ text: 'a v2' });
  expect(stale.err.mine.value).toEqual({ text: 'b based on v1' });
  const resolved = await b.page.evaluate(() => c.put('note', { text: 'b merged' }, { base: 2 }));
  expect(resolved.version).toBe(3);
  expect(await a.page.evaluate(() => c.get('note'))).toEqual({ text: 'b merged' }); // a reads the newer version
  // create-only write of an existing record
  const exists = await b.page.evaluate(() => T(c.put('note', { text: 'x' }, { base: null })));
  expect(errOf(exists)).toContain('ConflictError 412');
  // stale delete
  await a.page.evaluate(() => c.get('note'));
  await b.page.evaluate(() => c.put('note', { text: 'b again' }));
  const staleDel = await a.page.evaluate(() => T(c.delete('note')));
  expect(errOf(staleDel)).toContain('ConflictError 412');
  // a record that was deleted can be recreated; two writers racing for a new name: exactly one wins
  const race = await Promise.all([
    a.page.evaluate(() => T(c.put('race', { who: 'a' }, { base: null }))),
    b.page.evaluate(() => T(c.put('race', { who: 'b' }, { base: null }))),
  ]);
  expect(race.filter((r) => r.err).length).toBe(1);
  expect(race.filter((r) => r.ok).length).toBe(1);
  expect(race.find((r) => r.err).err.status).toBe(412);
});

test('conflict dialog in two browser contexts: the dialog offers both versions and keeps the user\'s choice', async ({ browser, stack }) => {
  // vault creation, unlock and the conflict dialog all go through the UI layer here
  const ctxA = await newContext(browser), ctxB = await newContext(browser);
  const A = await openApp(ctxA, stack, { ui: true });
  const passphrase = 'purple elephants marching slowly ' + PASS_CANARY;
  await A.evaluate(() => { window.unlockP = store.unlock(); });
  let dlg = A.getByRole('dialog').last();
  await dlg.getByRole('button', { name: 'Create a new vault' }).click();
  await dlg.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await dlg.getByLabel('Repeat passphrase').fill(passphrase);
  await dlg.getByLabel('Join code').fill(stack.joinCode.toLowerCase());
  await shot(A, 'create-dialog');
  await dlg.getByRole('button', { name: 'Create vault' }).click();
  await expect(dlg.getByRole('heading', { name: 'Save your access sheet' })).toBeVisible({ timeout: 60000 });
  const accessId = (await dlg.locator('[data-wds=access-id]').innerText()).trim();
  await shot(A, 'access-sheet');
  await dlg.getByLabel('I have saved the access sheet and the recovery code.').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();
  await A.evaluate(() => window.unlockP);
  await A.evaluate(() => store.set('note', { text: 'v1 from A' }));

  const B = await openApp(ctxB, stack, { ui: true });
  await B.evaluate(() => { window.unlockP = store.unlock(); });
  dlg = B.getByRole('dialog').last();
  await dlg.getByLabel('Access ID').fill(accessId);
  await dlg.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await dlg.getByRole('button', { name: 'Unlock' }).click();
  await B.evaluate(() => window.unlockP);
  expect(await B.evaluate(() => store.get('note'))).toEqual({ text: 'v1 from A' });

  await A.evaluate(() => store.set('note', { text: 'v2 from A' }));
  await B.evaluate(() => { window.setP = store.set('note', { text: 'v2 from B' }).then((r) => r, (e) => ({ err: e.name })); });
  dlg = B.getByRole('dialog').last();
  await expect(dlg.getByRole('heading', { name: 'Another device or person saved a newer version' })).toBeVisible();
  await expect(dlg.getByText('v2 from A')).toBeVisible();
  await expect(dlg.getByText('v2 from B')).toBeVisible();
  await shot(B, 'conflict-dialog');
  await dlg.getByRole('button', { name: 'Keep mine' }).click();
  const res = await B.evaluate(() => window.setP);
  expect(res.resolution).toBe('mine');
  expect(res.version).toBe(3);
  expect(await A.evaluate(() => store.get('note'))).toEqual({ text: 'v2 from B' });
  expect(await A.evaluate(() => store.history('note').then((h) => h.map ? h.length : h.versions.length))).toBe(3); // theirs stays in the history

  // the other way round: keep theirs
  await A.evaluate(() => store.set('note', { text: 'v4 from A' }));
  await B.evaluate(() => { window.setP = store.set('note', { text: 'v4 from B' }); });
  await B.getByRole('dialog').last().getByRole('button', { name: 'Keep theirs' }).click();
  const res2 = await B.evaluate(() => window.setP);
  expect(res2.resolution).toBe('theirs');
  expect(res2.value).toEqual({ text: 'v4 from A' });
});

// Collections against the real server (If-Match / If-None-Match on the index record): two devices and a third that loads the result.
async function uiCreate(page, stack, passphrase) {
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const dlg = page.getByRole('dialog').last();
  await dlg.getByRole('button', { name: 'Create a new vault' }).click();
  await dlg.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await dlg.getByLabel('Repeat passphrase').fill(passphrase);
  await dlg.getByLabel('Join code').fill(stack.joinCode.toLowerCase());
  await dlg.getByRole('button', { name: 'Create vault' }).click();
  await expect(dlg.getByRole('heading', { name: 'Save your access sheet' })).toBeVisible({ timeout: 60000 });
  const accessId = (await dlg.locator('[data-wds=access-id]').innerText()).trim();
  await dlg.getByLabel('I have saved the access sheet and the recovery code.').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();
  await page.evaluate(() => window.unlockP);
  return accessId;
}
async function uiUnlock(page, accessId, passphrase) {
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const dlg = page.getByRole('dialog').last();
  await dlg.getByLabel('Access ID').fill(accessId);
  await dlg.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await dlg.getByRole('button', { name: 'Unlock' }).click();
  await page.evaluate(() => window.unlockP);
}
test('collections on the real server: no lost update with two devices, and an item deleted on one device and edited on the other stays visible on both', async ({ browser, stack }) => {
  const passphrase = 'purple elephants marching slowly ' + PASS_CANARY;
  const ctxA = await newContext(browser), ctxB = await newContext(browser), ctxC = await newContext(browser);
  const A = await openApp(ctxA, stack, { ui: true });
  const accessId = await uiCreate(A, stack, passphrase);
  const B = await openApp(ctxB, stack, { ui: true });
  await uiUnlock(B, accessId, passphrase);
  const load = (p) => p.evaluate(() => { window.notes = store.collection('notes/', { meta: (v) => ({ t: v.t }) }); return notes.load().then((l) => l.length); });
  const ids = (p) => p.evaluate(() => notes.items().map((i) => i.id).sort());
  expect([await load(A), await load(B)]).toEqual([0, 0]);   // both loaded an index that does not exist yet

  // (a) lost update: B adds x, A (which has not seen x) adds y and z, B removes x, A adds w
  await B.evaluate(() => notes.add({ t: 'x' }, { id: 'x' }));
  await A.evaluate(() => notes.add({ t: 'y' }, { id: 'y' }));
  await A.evaluate(() => notes.add({ t: 'z' }, { id: 'z' }));
  expect(await ids(A)).toEqual(['x', 'y', 'z']);
  await B.evaluate(() => notes.remove('x'));
  await A.evaluate(() => notes.add({ t: 'w' }, { id: 'w' }));
  await A.evaluate(() => notes.refresh()); await B.evaluate(() => notes.refresh());
  expect(await ids(A)).toEqual(['w', 'y', 'z']);
  expect(await ids(B)).toEqual(['w', 'y', 'z']);
  const C = await openApp(ctxC, stack, { ui: true });
  await uiUnlock(C, accessId, passphrase);
  expect(await C.evaluate(() => store.collection('notes/').load().then((l) => l.map((i) => i.id + ':' + i.meta.t).sort()))).toEqual(['w:w', 'y:y', 'z:z']);

  // (c) A deletes k, B edits it without a meta change and keeps its version: k is visible on both
  await A.evaluate(() => notes.add({ t: 'same' }, { id: 'k' }));
  await B.evaluate(() => notes.refresh());
  await B.evaluate(() => { store.onConflict('notes/', (c) => c.keepMine()); });
  await A.evaluate(() => notes.remove('k'));
  const res = await B.evaluate(() => notes.set('k', { t: 'same', extra: 1 }));
  expect(res.resolution).toBe('mine');
  await A.evaluate(() => notes.refresh()); await B.evaluate(() => notes.refresh());
  expect(await ids(A)).toContain('k');
  expect(await ids(B)).toContain('k');
  expect(await A.evaluate(() => notes.get('k'))).toEqual({ t: 'same', extra: 1 });
  for (const p of [A, B, C]) expect(p.errors).toEqual([]);
});

test('read invite: redeem in a second context, the server refuses every write of the read member', async ({ browser, stack }) => {
  const o = await createOwner(browser, stack);
  await o.page.evaluate(() => c.put('shared', { hello: 'world' }));
  const inv = await invite(o, 'read');

  // before the redemption the invite token may open its own slot and nothing else (PROTOCOL.md 8.2)
  const parsed = await core.parseInviteCode(inv.code);
  const sk = await I.deriveSlotKeys(parsed.secret);
  const invAuth = I.bearerHeader(parsed.accessId, sk.token);
  expect((await api(stack, 'GET', '/slots/' + parsed.accessId, { auth: invAuth })).status).toBe(200);
  const early = await api(stack, 'GET', '/vaults/' + o.vaultId + '/records', { auth: invAuth });
  expect([early.status, early.json && early.json.error]).toEqual([403, 'forbidden']);

  const m = await redeem(browser, stack, inv.code, 'member passphrase ' + PASS_CANARY);
  expect(m.status.role).toBe('read');
  expect(m.status.kind).toBeTruthy();
  expect(await m.page.evaluate(() => c.get('shared'))).toEqual({ hello: 'world' });
  // the client refuses by itself ...
  const own = await m.page.evaluate(() => T(c.put('shared', { hello: 'changed' })));
  expect(own.err.name).toBe('AuthError');
  // ... and the server refuses when the client does not: raw requests with the member's token
  const auth = await authOf(m.page);
  const commit = Buffer.alloc(32, 7).toString('base64url');
  const rid = (await api(stack, 'GET', '/vaults/' + o.vaultId + '/records', { auth })).json.records[0].id;
  const put = await api(stack, 'PUT', '/vaults/' + o.vaultId + '/records/' + rid, {
    auth, headers: { 'Content-Type': 'application/octet-stream', 'If-Match': '"1"', 'WDS-Commit': commit }, body: new Uint8Array(100),
  });
  expect([put.status, put.json.error]).toEqual([403, 'forbidden']);
  const create = await api(stack, 'PUT', '/vaults/' + o.vaultId + '/records/' + Buffer.alloc(32, 9).toString('base64url'), {
    auth, headers: { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*', 'WDS-Commit': commit }, body: new Uint8Array(100),
  });
  expect([create.status, create.json.error]).toEqual([403, 'forbidden']);
  const del = await api(stack, 'DELETE', '/vaults/' + o.vaultId + '/records/' + rid, { auth, headers: { 'If-Match': '"1"' } });
  expect([del.status, del.json.error]).toEqual([403, 'forbidden']);
  expect((await api(stack, 'POST', '/vaults/' + o.vaultId + '/roster', { auth, json: {} })).status).toBe(403);
  expect((await api(stack, 'GET', '/vaults/' + o.vaultId + '/rekey', { auth })).status).toBe(403);
  expect((await api(stack, 'DELETE', '/vaults/' + o.vaultId + '/records/' + rid + '/versions', { auth })).status).toBe(403);
  expect((await api(stack, 'DELETE', '/vaults/' + o.vaultId, { auth })).status).toBe(403);
  // the record is untouched
  expect(await o.page.evaluate(() => c.get('shared'))).toEqual({ hello: 'world' });
  expect(await o.page.evaluate(() => c.history('shared').then((h) => h.versions.length))).toBe(1);
  // reads still work
  expect((await api(stack, 'GET', '/vaults/' + o.vaultId + '/records/' + rid, { auth })).status).toBe(200);
  expect((await api(stack, 'GET', '/vaults/' + o.vaultId + '/usage', { auth })).status).toBe(200);
  // a used invite cannot be redeemed twice
  const ctx2 = await newContext(browser);
  const p2 = await openApp(ctx2, stack);
  const again = await p2.evaluate(({ code }) => T(c.redeemInvite({ inviteCode: code, passphrase: 'second try ' + 'x'.repeat(20) })), { code: inv.code });
  expect(again.err).toBeTruthy();
});

test('cancelling an invite: unused ones leave quietly, one opened with its token needs a revocation (GET /slots already marks it used)', async ({ browser, stack }) => {
  const o = await createOwner(browser, stack);
  await o.page.evaluate(() => c.put('shared', { hello: 'world' }));
  const quiet = await invite(o, 'write');
  const opened = await invite(o, 'read');

  // the first request of a redemption, or of someone who intercepted the code: the response holds the keyring entry
  const parsed = await core.parseInviteCode(opened.code);
  const invAuth = I.bearerHeader(parsed.accessId, (await I.deriveSlotKeys(parsed.secret)).token);
  const first = await api(stack, 'GET', '/slots/' + parsed.accessId, { auth: invAuth });
  expect(first.status).toBe(200);
  expect(first.json.keyring.entry).toBeTruthy();
  // the owner's client sees the server's view (roster GET, "used")
  const view = await o.page.evaluate(async () => { await c.maintain(); return c.members().map((m) => ({ slotId: m.slotId, used: m.used, kind: m.kind })); });
  expect(view.find((m) => m.slotId === opened.slotId).used).toBe(true);
  expect(view.find((m) => m.slotId === quiet.slotId).used).toBe(false);

  // the unused invite: no new epoch
  const r1 = await o.page.evaluate((id) => T(c.cancelInvite(id)), quiet.slotId);
  expect(r1.ok, JSON.stringify(r1.err)).toEqual({ revoked: false });
  expect((await o.page.evaluate(() => c.status().epoch))).toBe(1);

  // the opened invite: the plain cancel is refused with revocation_required (what the UI turns into the Revoke dialog) ...
  const refused = await o.page.evaluate((id) => T(c.cancelInvite(id, { revoke: false })), opened.slotId);
  expect([refused.err.status, refused.err.code]).toEqual([409, 'revocation_required']);
  // ... and cancelInvite itself falls back to the revocation
  const r2 = await o.page.evaluate((id) => T(c.cancelInvite(id)), opened.slotId);
  expect(r2.ok, JSON.stringify(r2.err)).toMatchObject({ revoked: true, done: true });
  expect(await o.page.evaluate(() => c.status().epoch)).toBe(2);
  expect(await o.page.evaluate(() => c.members().map((m) => m.slotId))).not.toContain(opened.slotId);
  const dead = await api(stack, 'GET', '/slots/' + parsed.accessId, { auth: invAuth });
  expect([dead.status, dead.json.error]).toEqual([401, 'revoked']);
  expect(await o.page.evaluate(() => c.get('shared'))).toEqual({ hello: 'world' });
  const again = await unlockElsewhere(browser, stack, o, o.passphrase);
  expect(again.status.ok.epoch).toBe(2);
  expect(await again.page.evaluate(() => c.get('shared'))).toEqual({ hello: 'world' });
});

test('expired invites: the owner removes them on the next unlock (a used one by revocation), the server never does', async ({ browser, stack }) => {
  const o = await createOwner(browser, stack);
  await o.page.evaluate(() => c.put('shared', { hello: 'world' }));
  const idle = await invite(o, 'write');
  const seen = await invite(o, 'read');
  const keep = await invite(o, 'read');
  const parsed = await core.parseInviteCode(seen.code);
  const seenAuth = I.bearerHeader(parsed.accessId, (await I.deriveSlotKeys(parsed.secret)).token);
  expect((await api(stack, 'GET', '/slots/' + parsed.accessId, { auth: seenAuth })).status).toBe(200);
  expireInvites(stack, [idle.slotId, seen.slotId]);

  // the server keeps the slots in the roster (it cannot sign) but refuses the tokens
  expect((await api(stack, 'GET', '/slots/' + parsed.accessId, { auth: seenAuth })).status).toBe(410);
  const roster = await api(stack, 'GET', '/vaults/' + o.vaultId + '/roster', { auth: await authOf(o.page) });
  const ids = roster.json.versions[roster.json.versions.length - 1].body.slots.map((s) => s.id);
  expect(ids).toEqual(expect.arrayContaining([idle.slotId, seen.slotId, keep.slotId]));
  expect(roster.json.slots[idle.slotId].expired).toBe(true);

  const next = await unlockElsewhere(browser, stack, o, o.passphrase);
  expect(next.status.err, JSON.stringify(next.status.err)).toBeUndefined();
  const members = await next.page.evaluate(() => c.members().map((m) => m.slotId));
  expect(members).not.toContain(idle.slotId);
  expect(members).not.toContain(seen.slotId);
  expect(members).toContain(keep.slotId);
  expect(await next.page.evaluate(() => c.status().epoch)).toBe(2); // one of them had been used
  // the re-encryption is resumable and leaves a clean vault
  const done = await next.page.evaluate(() => T(c.resumeRekey()));
  expect(done.ok, JSON.stringify(done.err)).toMatchObject({ done: true });
  expect(await next.page.evaluate(() => c.get('shared'))).toEqual({ hello: 'world' });
  expect(await next.page.evaluate(() => c.usage().then((u) => u.old_epoch_blobs))).toBe(0);
});

test('key renewal: the owner adopts the redeemed invite\'s new keys automatically, member and owner renewals are accepted', async ({ browser, stack }) => {
  const o = await createOwner(browser, stack);
  await o.page.evaluate(() => c.put('shared', { hello: 'world' }));
  const inv = await invite(o, 'write');
  const rv0 = (await o.page.evaluate(() => c.status())).rosterVersion;
  const m = await redeem(browser, stack, inv.code, 'member passphrase ' + PASS_CANARY);
  const mAuth = await authOf(m.page);
  // the redemption left a pending renewal and the slot is still an invite in the roster
  let roster = await api(stack, 'GET', '/vaults/' + o.vaultId + '/roster', { auth: await authOf(o.page) });
  expect(roster.json.head).toBe(rv0);
  expect(roster.json.slots[inv.slotId].redeemed).toBeTruthy();
  expect(roster.json.slots[inv.slotId].renewal).toBeTruthy();
  expect(roster.json.versions.at(-1).body.slots.find((s) => s.id === inv.slotId).kind).toBe('invite');

  // the owner unlocks (on another device): the light maintenance on unlock signs the new keys into a roster version
  const o2 = await unlockElsewhere(browser, stack, o, o.passphrase);
  expect(o2.status.err).toBeUndefined();
  expect(o2.status.ok.rosterVersion).toBe(rv0 + 1);
  const members = await o2.page.evaluate(() => c.members());
  const entry = members.find((x) => x.slotId === inv.slotId);
  expect(entry.kind).toBe('passphrase');
  expect(entry.role).toBe('write');
  roster = await api(stack, 'GET', '/vaults/' + o.vaultId + '/roster', { auth: await authOf(o2.page) });
  expect(roster.json.head).toBe(rv0 + 1);
  expect(roster.json.slots[inv.slotId].renewal).toBeNull();
  const slot = await api(stack, 'GET', '/slots/' + inv.accessId, { auth: mAuth });
  expect(slot.json.kind).toBe('passphrase');
  expect(slot.json.renewal_pending).toBe(false);

  // the member still works with the adopted key set, also after a fresh unlock
  const m2 = await unlockElsewhere(browser, stack, { accessId: inv.accessId }, 'member passphrase ' + PASS_CANARY);
  expect(m2.status.err, JSON.stringify(m2.status.err)).toBeUndefined();
  expect(m2.status.ok.rosterVersion).toBe(rv0 + 1);
  expect(await m2.page.evaluate(() => c.put('from-member', { ok: true }).then((r) => r.version))).toBe(1);

  // a later renewal by the member (POST /slots/{id}/renewal), accepted by the owner's maintenance
  const renewed = await m2.page.evaluate(() => T(c.renewKeys()));
  expect(renewed.err, JSON.stringify(renewed.err)).toBeUndefined();
  roster = await api(stack, 'GET', '/vaults/' + o.vaultId + '/roster', { auth: await authOf(o2.page) });
  expect(roster.json.slots[inv.slotId].renewal).toBeTruthy();
  const adopted = await o2.page.evaluate(() => c.maintain().then((r) => r, (e) => ({ err: e.message })));
  expect(adopted.err, JSON.stringify(adopted)).toBeUndefined();
  roster = await api(stack, 'GET', '/vaults/' + o.vaultId + '/roster', { auth: await authOf(o2.page) });
  expect(roster.json.head).toBe(rv0 + 2);
  expect(roster.json.slots[inv.slotId].renewal).toBeNull();
  const m3 = await unlockElsewhere(browser, stack, { accessId: inv.accessId }, 'member passphrase ' + PASS_CANARY);
  expect(m3.status.err, JSON.stringify(m3.status.err)).toBeUndefined();
  expect(await m3.page.evaluate(() => c.get('shared'))).toEqual({ hello: 'world' });
  expect(await m3.page.evaluate(() => c.get('from-member'))).toEqual({ ok: true });

  // the owner renews its own keys (signed in directly), and a further device unlocks with the new set
  const own = await o2.page.evaluate(() => T(c.renewKeys()));
  expect(own.err, JSON.stringify(own.err)).toBeUndefined();
  const o3 = await unlockElsewhere(browser, stack, o, o.passphrase);
  expect(o3.status.err, JSON.stringify(o3.status.err)).toBeUndefined();
  expect(o3.status.ok.rosterVersion).toBeGreaterThan(rv0 + 2);
  expect(await o3.page.evaluate(() => c.get('from-member'))).toEqual({ ok: true });
});

test('revocation and re-encryption: interrupted and resumed, no old-epoch blob remains, history commitments still verify', async ({ browser, stack }) => {
  const o = await createOwner(browser, stack);
  const names = ['a', 'b', 'files/x.bin', 'gone'];
  await o.page.evaluate(async () => {
    for (let i = 1; i <= 3; i++) await c.put('a', { v: i });
    for (let i = 1; i <= 2; i++) await c.put('b', { v: i });
    for (let i = 1; i <= 2; i++) await c.put('files/x.bin', pattern(300000, i));
    await c.put('gone', { v: 1 });
    await c.delete('gone');
  });
  const inv = await invite(o, 'write');
  const m = await redeem(browser, stack, inv.code, 'member passphrase ' + PASS_CANARY);
  await m.page.evaluate(() => c.put('from-member', { v: 1 }).then(() => c.put('from-member', { v: 2 })));
  // the member's account: its token and the blobs it can read in epoch 1
  const mAuth = await authOf(m.page);
  const mSlot = await m.page.evaluate(() => c.status().slotId);
  const oAuth = await authOf(o.page);
  const v = o.vaultId;
  const before = await api(stack, 'GET', '/vaults/' + v + '/records', { auth: oAuth });
  const live = before.json.records.filter((r) => !r.deleted);
  expect(live.length).toBe(4);
  expect(live.every((r) => r.epoch === 1)).toBe(true);
  const oldBlobs = {};
  for (const r of live) oldBlobs[r.id] = Buffer.from((await api(stack, 'GET', '/vaults/' + v + '/records/' + r.id, { auth: mAuth })).bytes).toString('base64');

  // revoke without re-encrypting: the epoch is raised, every old blob is still there
  const rv = await o.page.evaluate(async (slot) => { await c.maintain(); const s0 = c.status(); await c.revoke([slot], { rekey: false }); return { before: s0.rosterVersion, st: c.status() }; }, mSlot);
  expect(rv.st.epoch).toBe(2);
  expect(rv.st.rekeyPending).toBe(true);
  const pending = await api(stack, 'GET', '/vaults/' + v + '/rekey', { auth: oAuth });
  expect(pending.json.epoch).toBe(2);
  expect(pending.json.remaining).toBeGreaterThan(5);
  const usage1 = await api(stack, 'GET', '/vaults/' + v + '/usage', { auth: oAuth });
  expect(usage1.json.old_epoch_blobs).toBeGreaterThan(5);
  // the revoked member is out at once
  const gone = await api(stack, 'GET', '/vaults/' + v + '/records', { auth: mAuth });
  expect([gone.status, gone.json.error]).toEqual([401, 'revoked']);
  const goneWrite = await m.page.evaluate(() => T(c.put('from-member', { v: 3 })));
  expect(goneWrite.err.name).toBe('AuthError');
  const kdf = await api(stack, 'GET', '/slots/' + inv.accessId + '/kdf');
  expect(kdf.status).toBe(404);
  // the owner keeps working in the new epoch while the old blobs are still waiting
  await o.page.evaluate(() => c.put('c-new-epoch', { v: 1 }));
  const mid = await api(stack, 'GET', '/vaults/' + v + '/records', { auth: oAuth });
  expect(mid.json.records.find((r) => r.id && r.epoch === 2)).toBeTruthy();

  // an interrupted re-encryption (maxItems), then resumed from another device (everything is derived from the server's state)
  const part = await o.page.evaluate(() => c.resumeRekey({ maxItems: 3 }));
  expect(part).toEqual({ done: false, rekeyed: 3 });
  expect((await api(stack, 'GET', '/vaults/' + v + '/rekey', { auth: oAuth })).json.remaining).toBe(pending.json.remaining - 3);
  const o2 = await unlockElsewhere(browser, stack, o, o.passphrase);
  expect(o2.status.err, JSON.stringify(o2.status.err)).toBeUndefined();
  expect(o2.status.ok.rekeyPending).toBe(true);
  const done = await o2.page.evaluate(() => c.resumeRekey());
  expect(done.done).toBe(true);
  expect(done.rekeyed).toBe(pending.json.remaining - 3);

  // verified through the API, not through the client: no blob of an old epoch remains anywhere
  const o2Auth = await authOf(o2.page);
  const rk = await api(stack, 'GET', '/vaults/' + v + '/rekey', { auth: o2Auth });
  expect(rk.json.items).toEqual([]);
  expect(rk.json.remaining).toBe(0);
  const usage2 = await api(stack, 'GET', '/vaults/' + v + '/usage', { auth: o2Auth });
  expect(usage2.json.old_epoch_blobs).toBe(0);
  const after = await api(stack, 'GET', '/vaults/' + v + '/records', { auth: o2Auth });
  let versionBlobs = 0;
  for (const r of after.json.records) {
    if (r.deleted) continue;
    expect(r.epoch).toBe(2);
    const hist = await api(stack, 'GET', '/vaults/' + v + '/records/' + r.id + '/versions', { auth: o2Auth });
    for (const ver of hist.json.versions) {
      if (ver.deleted) { expect(ver.epoch).toBeNull(); continue; }
      expect(ver.epoch).toBe(2);
      const env = await api(stack, 'GET', '/vaults/' + v + '/records/' + r.id + '/versions/' + ver.version, { auth: o2Auth });
      expect(envelopeHeader(env.bytes).epoch).toBe(2);
      expect(ver.commit).toMatch(/^[A-Za-z0-9_-]{43}$/);
      versionBlobs++;
    }
  }
  expect(versionBlobs).toBeGreaterThanOrEqual(10);
  for (const [id, b64] of Object.entries(oldBlobs)) { // the member's copies are stale: the blobs were replaced
    const now = await api(stack, 'GET', '/vaults/' + v + '/records/' + id, { auth: o2Auth });
    expect(Buffer.from(now.bytes).toString('base64')).not.toBe(b64);
  }
  // the history commitments still verify: the client checks the commitment of every version it opens (PROTOCOL.md 4.5)
  const all = await o2.page.evaluate(async (names) => {
    const out = {};
    for (const n of names) {
      const h = await c.history(n);
      out[n] = [];
      for (const ver of h.versions) {
        if (ver.deleted) { out[n].push({ version: ver.version, deleted: true }); continue; }
        const r = await T(c.getVersion(n, ver.version));
        out[n].push({ version: ver.version, ok: !r.err, err: r.err && r.err.message, value: r.ok && r.ok.kind === 'json' ? r.ok.value : undefined, length: r.ok && r.ok.length });
      }
    }
    return out;
  }, ['a', 'b', 'files/x.bin', 'gone', 'from-member', 'c-new-epoch']);
  for (const [n, vers] of Object.entries(all)) for (const x of vers) expect(x.deleted || x.ok, n + ' v' + x.version + ': ' + x.err).toBeTruthy();
  expect(all.a.map((x) => x.value)).toEqual([{ v: 3 }, { v: 2 }, { v: 1 }]);
  expect(all['from-member'].map((x) => x.value)).toEqual([{ v: 2 }, { v: 1 }]);
  expect(all['files/x.bin'].map((x) => x.length)).toEqual([300000, 300000]);
  expect(all.gone.some((x) => x.deleted)).toBe(true);
  // roster: member gone, epoch 2, old epoch commitment dropped only after the blobs were re-encrypted
  const roster = await api(stack, 'GET', '/vaults/' + v + '/roster', { auth: o2Auth });
  expect(roster.json.epoch).toBe(2);
  const head = roster.json.versions.at(-1).body;
  expect(head.slots.some((s) => s.id === mSlot)).toBe(false);
  expect(head.commit.epochs.map((e) => e.e)).toEqual([2]);
  // a third device derives everything from scratch
  const o3 = await unlockElsewhere(browser, stack, o, o.passphrase);
  expect(o3.status.err, JSON.stringify(o3.status.err)).toBeUndefined();
  expect(await o3.page.evaluate(() => c.get('a'))).toEqual({ v: 3 });
  expect(await o3.page.evaluate(() => c.get('from-member'))).toEqual({ v: 2 });
  expect(await o3.page.evaluate(() => c.get('c-new-epoch'))).toEqual({ v: 1 });
  // the revoked member cannot come back
  const back = await unlockElsewhere(browser, stack, { accessId: inv.accessId }, 'member passphrase ' + PASS_CANARY);
  expect(back.status.err).toBeTruthy();
  void names;
});

test('passphrase change: the old passphrase and the old token stop working at once, other devices unlock with the new one', async ({ browser, stack }) => {
  const o = await createOwner(browser, stack);
  await o.page.evaluate(() => c.put('keep', { v: 1 }));
  const oldAuth = await authOf(o.page);
  const second = await unlockElsewhere(browser, stack, o, o.passphrase);
  expect(second.status.err).toBeUndefined();
  const newPass = 'a completely new passphrase ' + PASS_CANARY;
  const r = await o.page.evaluate((p) => T(c.changePassphrase(p)), newPass);
  expect(r.err, JSON.stringify(r.err)).toBeUndefined();
  expect(r.ok.sv).toBeGreaterThan(1);
  // the old token is dead at the server
  const dead = await api(stack, 'GET', '/vaults/' + o.vaultId + '/records', { auth: oldAuth });
  expect([dead.status, dead.json.error]).toEqual([401, 'unauthorized']);
  const live = await api(stack, 'GET', '/vaults/' + o.vaultId + '/records', { auth: await authOf(o.page) });
  expect(live.status).toBe(200);
  // the other open session still holds the old token: its next call fails
  const stale = await second.page.evaluate(() => T(c.get('keep')));
  expect(stale.err ? stale.err.name : 'no error').toBe('AuthError');
  // old passphrase fails, new passphrase works, in a new context
  const oldTry = await unlockElsewhere(browser, stack, o, o.passphrase);
  expect(oldTry.status.err && oldTry.status.err.name).toBe('AuthError');
  const fresh = await unlockElsewhere(browser, stack, o, newPass);
  expect(fresh.status.err, JSON.stringify(fresh.status.err)).toBeUndefined();
  expect(await fresh.page.evaluate(() => c.get('keep'))).toEqual({ v: 1 });
  // the vault still verifies and works for writes after the change; the slot's key sets survived the re-wrap
  expect(await fresh.page.evaluate(() => c.put('after', { v: 2 }).then((x) => x.version))).toBe(1);
  expect(fresh.status.ok.role).toBe('owner');
});

test('the server rejects bodies that are not envelopes, even with a valid token', async ({ browser, stack }) => {
  const o = await createOwner(browser, stack);
  await o.page.evaluate(() => c.put('real', { v: 1 }));
  const auth = await authOf(o.page);
  const v = o.vaultId;
  const rid = Buffer.alloc(32, 5).toString('base64url');
  const commit = Buffer.alloc(32, 6).toString('base64url');
  const put = (body, extra = {}) => api(stack, 'PUT', '/vaults/' + v + '/records/' + rid, {
    auth, headers: Object.assign({ 'Content-Type': 'application/octet-stream', 'If-None-Match': '*', 'WDS-Commit': commit }, extra), body,
  });
  const plain = await put(new TextEncoder().encode(JSON.stringify({ text: CANARY, note: 'plaintext on purpose' })));
  expect([plain.status, plain.json.error]).toEqual([400, 'malformed_envelope']);
  const text = await put(new TextEncoder().encode('just some text, long enough to pass the minimum length of an envelope'));
  expect([text.status, text.json.error]).toEqual([400, 'malformed_envelope']);
  const zeros = await put(new Uint8Array(200));
  expect([zeros.status, zeros.json.error]).toEqual([400, 'malformed_envelope']);
  const magic = new Uint8Array(200); magic.set([0x57, 0x44, 0x53, 0x31, 0x02, 0, 0, 0, 0, 1]); // right magic, but a slot-key envelope
  const wrongType = await put(magic);
  expect([wrongType.status, wrongType.json.error]).toEqual([400, 'malformed_envelope']);
  const flags = new Uint8Array(200); flags.set([0x57, 0x44, 0x53, 0x31, 0x01, 1, 0, 0, 0, 1]);
  expect((await put(flags)).status).toBe(400);
  const wrongEpoch = new Uint8Array(200); wrongEpoch.set([0x57, 0x44, 0x53, 0x31, 0x01, 0, 0, 0, 0, 9]); // a well-formed record envelope of an epoch the vault does not have
  const we = await put(wrongEpoch);
  expect([we.status, we.json.error]).toEqual([409, 'epoch_changed']);
  const short = await put(new Uint8Array(20));
  expect(short.status).toBe(400);
  const json = await put(new TextEncoder().encode('{"a":1}'), { 'Content-Type': 'application/json' });
  expect(json.status).toBe(415);
  const noCommit = await api(stack, 'PUT', '/vaults/' + v + '/records/' + rid, { auth, headers: { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' }, body: wrongEpoch });
  expect(noCommit.status).toBe(400);
  const noPrecondition = await api(stack, 'PUT', '/vaults/' + v + '/records/' + rid, { auth, headers: { 'Content-Type': 'application/octet-stream', 'WDS-Commit': commit }, body: wrongEpoch });
  expect(noPrecondition.status).toBe(428);
  const huge = await put(new Uint8Array(30 * MIB));
  expect([huge.status, huge.json.error]).toEqual([413, 'value_too_large']);
  // none of it was stored, and the vault is intact
  const probe = await api(stack, 'GET', '/vaults/' + v + '/records/' + rid, { auth });
  expect(probe.status).toBe(404);
  expect((await api(stack, 'GET', '/vaults/' + v + '/records', { auth })).json.records.length).toBe(1);
  expect(await o.page.evaluate(() => c.get('real'))).toEqual({ v: 1 });
  // JSON endpoints: unknown keys and non-JSON are refused
  const odd = await api(stack, 'POST', '/vaults/' + v + '/roster', { auth, json: { roster: 1, keyring: {}, extra: true } });
  expect(odd.status).toBe(400);
  const notJson = await api(stack, 'POST', '/vaults/' + v + '/roster', { auth, headers: { 'Content-Type': 'application/json' }, body: 'not json' });
  expect(notJson.status).toBe(400);
});

test('join code enforcement, enrollment states, suspended scope (operator API)', async ({ browser, stack }) => {
  const ctx = await newContext(browser);
  const page = await openApp(ctx, stack);
  const pass = 'join test passphrase ' + PASS_CANARY;
  const create = (joinCode) => page.evaluate(({ passphrase, joinCode }) => T(c.createVault({ passphrase, joinCode }).then((v) => ({ accessId: v.accessId, vaultId: v.vaultId }))), { passphrase: pass, joinCode });
  const none = await create(undefined);
  expect([none.err.status, none.err.code]).toEqual([403, 'join_code_invalid']);
  const wrong = await create('WRONG-CODE-1');
  expect(wrong.err.status).toBe(403);
  expect(wrong.err.code).toBe('join_code_invalid');
  expect(await page.evaluate(() => c.status().unlocked)).toBe(false);
  // the join code is never part of the public scope document
  expect(JSON.stringify((await api(stack, 'GET', '/scopes/' + stack.scope)).json)).not.toContain(stack.joinCode);
  // the right code in a sloppy spelling (case, spaces, dashes) is accepted
  const sloppy = stack.joinCode.slice(0, 4).toLowerCase() + ' - ' + stack.joinCode.slice(4).toLowerCase();
  const ok = await create(sloppy);
  expect(ok.err, JSON.stringify(ok.err)).toBeUndefined();

  const op = (method, path, json) => api(stack, method, path, { auth: operatorAuth(stack), json });
  const noOp = await api(stack, 'PATCH', '/admin/scopes/' + stack.scope, { auth: 'Bearer wdsop.nope', json: { enrollment: 'closed' } });
  expect(noOp.status).toBe(401);
  // closed enrollment: the right code is not enough
  expect((await op('PATCH', '/admin/scopes/' + stack.scope, { enrollment: 'closed' })).status).toBe(200);
  const closed = await create(stack.joinCode);
  expect([closed.err.status, closed.err.code]).toEqual([403, 'enrollment_closed']);
  expect((await api(stack, 'GET', '/scopes/' + stack.scope)).json.enrollment).toBe('closed');
  // suspended scope: reads and unlock still work, record writes and vault creation are refused
  expect((await op('PATCH', '/admin/scopes/' + stack.scope, { enrollment: 'join_code', status: 'suspended' })).status).toBe(200);
  const susp = await create(stack.joinCode);
  expect([susp.err.status, susp.err.code]).toEqual([403, 'scope_suspended']);
  const st = await page.evaluate(({ accessId, passphrase }) => T(c.unlock({ accessId, passphrase })), { accessId: ok.ok.accessId, passphrase: pass });
  expect(st.err, JSON.stringify(st.err)).toBeUndefined();
  expect(await page.evaluate(() => c.get('nothing'))).toBeUndefined();
  const w = await page.evaluate(() => T(c.put('x', { v: 1 })));
  expect(w.err.status).toBe(403);
  expect(w.err.code).toBe('scope_suspended');
  expect((await op('PATCH', '/admin/scopes/' + stack.scope, { status: 'active' })).status).toBe(200);
  expect(await page.evaluate(() => c.put('x', { v: 1 }).then((r) => r.version))).toBe(1);
  // wrong join codes are counted as authentication failures but a handful does not lock anybody out
  expect((await create(stack.joinCode)).err).toBeUndefined();
});

test('read-only mode (server at its disk threshold): the allow-list of PROTOCOL.md 8.6', async ({ browser, stack }) => {
  // normal server: vault with data, an owner session, an invite for a write member, and one more record to delete later
  const o = await createOwner(browser, stack);
  await o.page.evaluate(async () => { await c.put('doc', { v: 1 }); await c.put('doc', { v: 2 }); await c.put('scratch', { v: 1 }); });
  const inv = await invite(o, 'write');
  const ro = await stack.startServer({ readOnly: true });
  try {
    const info = await (await fetch(ro.service + 'api/v1/scopes/' + stack.scope)).json();
    expect(info.read_only).toBe(true);
    expect((await (await fetch(stack.service + 'api/v1/scopes/' + stack.scope)).json()).read_only).toBe(false);
    await useService(o.page, stack, ro.service);
    // the invite is redeemed on the read-only server (allowed), the new member only reads
    const mctx = await newContext(browser);
    const mp = await openApp(mctx, stack, { service: ro.service });
    const m = await mp.evaluate(({ code }) => T(c.redeemInvite({ inviteCode: code, passphrase: 'member passphrase ' + 'RO' })), { code: inv.code });
    expect(m.err, JSON.stringify(m.err)).toBeUndefined();
    expect(await mp.evaluate(() => c.get('doc'))).toEqual({ v: 2 });
    // refused: vault creation, record writes (create and update), new invites (new_slots), a bare role change
    const create = await mp.evaluate(({ joinCode }) => T(c.createVault({ passphrase: 'another passphrase ' + 'RO2', joinCode })), { joinCode: stack.joinCode });
    expect([create.err.status, create.err.code, create.err.name]).toEqual([503, 'read_only', 'QuotaError']);
    const w1 = await mp.evaluate(() => T(c.put('new-record', { v: 1 })));
    expect([w1.err.status, w1.err.code]).toEqual([503, 'read_only']);
    const w2 = await mp.evaluate(() => T(c.put('doc', { v: 3 })));
    expect([w2.err.status, w2.err.code]).toEqual([503, 'read_only']);
    // the owner unlocks on the read-only server: maintenance adopts the member's renewal (a roster version without new_slots)
    const un = await o.page.evaluate(({ accessId, passphrase }) => T(c.unlock({ accessId, passphrase })), { accessId: o.accessId, passphrase: o.passphrase });
    expect(un.err, JSON.stringify(un.err)).toBeUndefined();
    expect((await o.page.evaluate(() => c.members())).find((x) => x.slotId === inv.slotId).kind).toBe('passphrase');
    const inv2 = await o.page.evaluate(() => T(c.createInvite({ role: 'read' })));
    expect([inv2.err.status, inv2.err.code]).toEqual([503, 'read_only']);
    const role = await o.page.evaluate((slot) => T(c.setRole(slot, 'read')), inv.slotId);
    expect([role.err.status, role.err.code]).toEqual([503, 'read_only']);
    const w3 = await o.page.evaluate(() => T(c.put('doc', { v: 3 })));
    expect([w3.err.status, w3.err.code]).toEqual([503, 'read_only']);
    const hdr = await api(stack, 'PUT', '/vaults/' + o.vaultId + '/records/' + Buffer.alloc(32, 3).toString('base64url'), {
      service: ro.service, auth: await authOf(o.page), headers: { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*', 'WDS-Commit': Buffer.alloc(32, 1).toString('base64url') }, body: new Uint8Array(100),
    });
    expect(hdr.status).toBe(503);
    expect(hdr.headers.get('retry-after')).toBe('3600');
    // allowed: reads, deleting a record (tombstone), changing the passphrase, renewing keys, purging history
    expect(await o.page.evaluate(() => c.get('doc'))).toEqual({ v: 2 });
    expect(await o.page.evaluate(() => c.delete('scratch'))).toBe(true);
    expect(await o.page.evaluate(() => c.deleteHistory('doc').then((r) => typeof r.freed))).toBe('number');
    const mr = await mp.evaluate(() => T(c.renewKeys()));
    expect(mr.err, JSON.stringify(mr.err)).toBeUndefined();
    const cp = await o.page.evaluate(() => T(c.changePassphrase('changed under read-only ' + 'RO3')));
    expect(cp.err, JSON.stringify(cp.err)).toBeUndefined();
    // revocation plus re-encryption (a roster version that removes a slot, then rekey PUTs) is allowed in read-only mode
    await o.page.evaluate(() => c.maintain());
    const rev = await o.page.evaluate((slot) => T(c.revoke([slot])), inv.slotId);
    expect(rev.err, JSON.stringify(rev.err)).toBeUndefined();
    expect(rev.ok.done).toBe(true);
    const usage = await api(stack, 'GET', '/vaults/' + o.vaultId + '/usage', { service: ro.service, auth: await authOf(o.page) });
    expect(usage.json.read_only).toBe(true);
    expect(usage.json.old_epoch_blobs).toBe(0);
    expect(await o.page.evaluate(() => c.get('doc'))).toEqual({ v: 2 });
    await shot(o.page, 'read-only-done');
  } finally {
    await ro.stop();
  }
  // back on the normal server writes work again, with everything that happened under read-only mode in place
  await useService(o.page, stack, stack.service);
  const again = await o.page.evaluate(({ accessId }) => T(c.unlock({ accessId, passphrase: 'changed under read-only RO3' }).then(() => c.get('doc')).then(() => c.put('doc', { v: 4 }).then((r) => r.version))), { accessId: o.accessId });
  expect(again.err, JSON.stringify(again.err)).toBeUndefined();
  expect(again.ok).toBe(3);
});

test('vault deletion: the vault answers 410 afterwards, the access ID cannot be used any more', async ({ browser, stack }) => {
  const o = await createOwner(browser, stack);
  await o.page.evaluate(() => c.put('x', { v: 1 }));
  const auth = await authOf(o.page);
  const del = await o.page.evaluate(() => T(c.deleteVault()));
  expect(del.err, JSON.stringify(del.err)).toBeUndefined();
  expect(del.ok.purge_after - del.ok.deleted).toBe(30 * 86400);
  const r = await api(stack, 'GET', '/vaults/' + o.vaultId + '/records', { auth });
  expect([r.status, r.json.error]).toEqual([410, 'vault_deleted']);
  const kdf = await api(stack, 'GET', '/slots/' + o.accessId + '/kdf');
  expect([kdf.status, kdf.json.error]).toEqual([410, 'vault_deleted']);
  const again = await unlockElsewhere(browser, stack, o, o.passphrase);
  expect(again.status.err && again.status.err.name).toBe('AuthError');
});

test('rate limits of the real server: failures are throttled per IP, a correct token never is', async ({ browser, stack }) => {
  const o = await createOwner(browser, stack);
  const auth = await authOf(o.page);
  const rl = await stack.startServer({ ratelimit: { ip_failures: 5, id_failures: 3 } });
  try {
    const bad = (n) => api(stack, 'GET', '/slots/' + o.accessId, { service: rl.service, auth: 'Bearer wds1.' + o.accessId + '.' + Buffer.alloc(32, n).toString('base64url') });
    const codes = [];
    for (let i = 1; i <= 5; i++) codes.push((await bad(i)).status);
    expect(codes).toEqual([401, 401, 401, 429, 429]); // the per-ID limit (3) is reached first
    const blocked = await bad(9);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toBe('rate_limited');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.headers.get('access-control-allow-origin')).toBe('*'); // the browser can read the 429
    // the right token still works, and so does the public KDF lookup of an existing access ID
    const good = await api(stack, 'GET', '/slots/' + o.accessId, { service: rl.service, auth });
    expect(good.status).toBe(200);
    expect((await api(stack, 'GET', '/slots/' + o.accessId + '/kdf', { service: rl.service })).status).toBe(200);
    expect((await api(stack, 'GET', '/scopes/' + stack.scope, { service: rl.service })).status).toBe(200);
    // unknown access IDs on the KDF lookup count as failures (enumeration is throttled) once the IP limit is reached
    const unknown = [];
    for (let i = 0; i < 8; i++) unknown.push((await api(stack, 'GET', '/slots/' + await I.b32cEncode(Buffer.from(I.randomBytes(12))) + '/kdf', { service: rl.service })).status);
    expect(unknown).toContain(429);
  } finally { await rl.stop(); }
});

test('recovery requests: wrong code refused, waiting periods, founder notice, cancel by the founder or the operator', async ({ browser, stack }) => {
  const o = await createOwner(browser, stack, { recoveryContact: 'owner@example.org' });
  const noContact = await createOwner(browser, stack);
  const op = (method, path, json) => api(stack, method, path, { auth: operatorAuth(stack), json });
  const v = o.vaultId;
  expect((await api(stack, 'POST', '/admin/vaults/' + v + '/recovery', { auth: 'Bearer wdsop.nope', json: { contact: true } })).status).toBe(401);
  const other = await I.makeRecoveryCode(); // a well-formed code that belongs to nobody
  const wrong = await op('POST', '/admin/vaults/' + v + '/recovery', { recovery_code: other.canonical });
  expect([wrong.status, wrong.json.error]).toEqual([403, 'recovery_code_invalid']);
  const none = await op('POST', '/admin/vaults/' + noContact.vaultId + '/recovery', { contact: true });
  expect([none.status, none.json.error]).toEqual([409, 'no_recovery_contact']);
  expect((await op('GET', '/admin/vaults/' + v)).json.has_recovery_contact).toBe(true);

  // the right code (as the client printed it) starts the 72 hour wait
  const started = await op('POST', '/admin/vaults/' + v + '/recovery', { recovery_code: o.recovery });
  expect(started.status).toBe(201);
  expect(started.json.method).toBe('code');
  expect(started.json.ready_at - started.json.requested).toBe(72 * 3600);
  expect((await op('POST', '/admin/vaults/' + v + '/recovery', { contact: true })).json.error).toBe('recovery_pending');
  const early = await op('GET', '/admin/vaults/' + v + '/escrow');
  expect([early.status, early.json.error]).toEqual([409, 'recovery_not_ready']);
  const earlyDone = await op('POST', '/admin/vaults/' + v + '/recovery/complete', { roster: {}, keyring: {} });
  expect([earlyDone.status, earlyDone.json.error]).toEqual([409, 'recovery_not_ready']);
  // the founder is told on the next unlock (also a read-only or write member's slot would not see it), and cancels
  const d = await unlockElsewhere(browser, stack, o, o.passphrase);
  expect(d.status.err).toBeUndefined();
  expect(d.status.ok.recovery).toMatchObject({ method: 'code', ready_at: started.json.ready_at });
  const cancelled = await d.page.evaluate(() => T(c.cancelRecovery()));
  expect(cancelled.ok).toEqual({ cancelled: true });
  expect((await d.page.evaluate(() => T(c.cancelRecovery()))).err.status).toBe(404);
  expect((await op('GET', '/admin/vaults/' + v)).json.recovery).toBeNull();
  // the recovery contact path waits 7 days; the operator can cancel as well
  const viaContact = await op('POST', '/admin/vaults/' + v + '/recovery', { contact: true });
  expect(viaContact.status).toBe(201);
  expect(viaContact.json.method).toBe('contact');
  expect(viaContact.json.ready_at - viaContact.json.requested).toBe(7 * 86400);
  const d2 = await unlockElsewhere(browser, stack, o, o.passphrase);
  expect(d2.status.ok.recovery).toMatchObject({ method: 'contact' });
  expect((await op('DELETE', '/admin/vaults/' + v + '/recovery')).json).toEqual({ cancelled: true });
  expect((await op('GET', '/admin/vaults/' + v)).json.recovery).toBeNull();
  // a member's token never sees the notice
  const inv = await invite(o, 'read');
  const m = await redeem(browser, stack, inv.code, 'member passphrase ' + PASS_CANARY);
  expect(m.status.recovery ?? null).toBeNull();
});

test('faculty recovery end to end: escrow keys open the vault, a new owner is added, acknowledgement, key adoption, revoking the old owner', async ({ browser, stack }) => {
  const f = await createOwner(browser, stack);
  await f.page.evaluate(async () => { await c.put('a', { v: 1 }); await c.put('a', { v: 2 }); await c.put('files/x.bin', pattern(100000, 3)); });
  const op = (method, path, json) => api(stack, method, path, { auth: operatorAuth(stack), json });
  expect((await op('POST', '/admin/vaults/' + f.vaultId + '/recovery', { recovery_code: f.recovery })).status).toBe(201);
  makeRecoveryReady(stack);
  const rec = await recoverAsOperator(stack, f.vaultId);
  expect(rec.response.version).toBe(rec.version);
  expect((await op('GET', '/admin/vaults/' + f.vaultId)).json.recovery).toBeNull(); // the recovery is completed
  expect((await op('GET', '/admin/vaults/' + f.vaultId + '/escrow')).status).toBe(409); // and the escrow material is closed again

  // the recovered owner redeems the invite WITHOUT the automatic maintenance (the state of a user who closed the tab at the access sheet)
  const rctx = await newContext(browser);
  const R = await openApp(rctx, stack);
  const rpass = 'recovered owner passphrase ' + PASS_CANARY;
  const red = await R.evaluate(({ code, passphrase }) => T(c.redeemInvite({ inviteCode: code, passphrase, maintain: false })), { code: rec.code, passphrase: rpass });
  expect(red.err, JSON.stringify(red.err)).toBeUndefined();
  expect(red.ok.role).toBe('owner');
  expect(red.ok.recoveredByFaculty).toBe(true);
  expect(await R.evaluate(() => c.get('a'))).toEqual({ v: 2 });
  expect(await R.evaluate(() => c.history('a').then((h) => h.versions.length))).toBe(2);

  // the founder: told about the faculty-added owner, must acknowledge before changing access; adopting renewals must not brick the vault
  const F = await unlockElsewhere(browser, stack, f, f.passphrase);
  expect(F.status.err, JSON.stringify(F.status.err)).toBeUndefined();
  expect(F.status.ok.recoveredByFaculty).toBe(true);
  expect(F.status.ok.recoverySlots).toEqual([rec.slotId]);
  const blocked = await F.page.evaluate(() => T(c.createInvite({ role: 'read' })));
  expect(blocked.err.code).toBe('recovery_unacknowledged');
  await shot(F.page, 'recovery-founder-unlocked');
  const acked = await F.page.evaluate(() => T(Promise.resolve(c.acknowledgeRecovery()).then(() => c.maintain()).then((s) => ({ rv: s.rosterVersion }))));
  expect(acked.err, JSON.stringify(acked.err)).toBeUndefined();
  // the founder did NOT sign the other owner's new keys in: the slot is still an invite, its renewal still pending
  const fAuth = await authOf(F.page);
  let roster = await api(stack, 'GET', '/vaults/' + f.vaultId + '/roster', { auth: fAuth });
  expect(roster.json.versions.at(-1).body.slots.find((s) => s.id === rec.slotId).kind).toBe('invite');
  expect(roster.json.slots[rec.slotId].renewal).toBeTruthy();
  const inv = await F.page.evaluate(() => c.createInvite({ role: 'read' }).then((r) => r.code.display)); // the founder keeps working
  expect(inv).toBeTruthy();
  // both owners unlock from scratch: the chain (founder, escrow-signed version, founder versions) verifies everywhere
  const F2 = await unlockElsewhere(browser, stack, f, f.passphrase);
  expect(F2.status.err, JSON.stringify(F2.status.err)).toBeUndefined();
  // the recovered owner unlocks later: the light maintenance adopts its OWN renewal
  const R2 = await unlockElsewhere(browser, stack, { accessId: red.ok.accessId }, rpass);
  expect(R2.status.err, JSON.stringify(R2.status.err)).toBeUndefined();
  expect(R2.status.ok.role).toBe('owner');
  roster = await api(stack, 'GET', '/vaults/' + f.vaultId + '/roster', { auth: await authOf(R2.page) });
  expect(roster.json.versions.at(-1).body.slots.find((s) => s.id === rec.slotId).kind).toBe('passphrase');
  expect(roster.json.slots[rec.slotId].renewal).toBeNull();
  const F3 = await unlockElsewhere(browser, stack, f, f.passphrase);
  expect(F3.status.err, JSON.stringify(F3.status.err)).toBeUndefined();
  expect(await F3.page.evaluate(() => c.get('a'))).toEqual({ v: 2 });

  // PLAN 5.7: the faculty-added owner may revoke the founder (a user who lost a device and recovered); everything is re-encrypted
  const founderSlot = F3.status.ok.slotId;
  await R2.page.evaluate(() => { c.acknowledgeRecovery(); });
  const rev = await R2.page.evaluate((slot) => T(c.revoke([slot])), founderSlot);
  expect(rev.err, JSON.stringify(rev.err)).toBeUndefined();
  expect(rev.ok.done).toBe(true);
  const gone = await api(stack, 'GET', '/vaults/' + f.vaultId + '/records', { auth: await authOf(F3.page) });
  expect([gone.status, gone.json.error]).toEqual([401, 'revoked']);
  expect((await api(stack, 'GET', '/vaults/' + f.vaultId + '/usage', { auth: await authOf(R2.page) })).json.old_epoch_blobs).toBe(0);
  expect(await R2.page.evaluate(() => c.get('a'))).toEqual({ v: 2 });
  const back = await unlockElsewhere(browser, stack, f, f.passphrase);
  expect(back.status.err).toBeTruthy();
  // and the escrow slot is still there for the next recovery
  roster = await api(stack, 'GET', '/vaults/' + f.vaultId + '/roster', { auth: await authOf(R2.page) });
  expect(roster.json.versions.at(-1).body.slots.filter((s) => s.kind === 'escrow').length).toBe(1);
});

// A scope of its own: the limits tests change settings that the other tests of this run (one shared scope) must not see, and
// lowering max_value_bytes is refused while the scope holds a larger value (see the test below).
async function ownScope(stack, slug) {
  const r = await api(stack, 'POST', '/admin/scopes', { auth: operatorAuth(stack), json: { slug, name: slug, enrollment: 'join_code', join_code: null, hibp: false, limits: null } });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return Object.assign(Object.create(stack), { scope: r.json.scope, joinCode: r.json.join_code });
}

test('lowering max_value_bytes below a stored value is refused, so nothing stored becomes unreadable or impossible to re-encrypt', async ({ browser, stack: shared }) => {
  const stack = await ownScope(shared, 'lowering');
  const op = (method, path, json) => api(stack, method, path, { auth: operatorAuth(stack), json });
  const o = await createOwner(browser, stack);
  await o.page.evaluate(() => c.put('attachment', pattern(3 * 1024 * 1024, 5)));
  const refused = await op('PATCH', '/admin/scopes/' + stack.scope, { limits: { max_value_bytes: 2 * MIB } });
  expect([refused.status, refused.json.error]).toEqual([409, 'limit_below_stored_value']);
  expect(refused.json.largest_envelope_bytes).toBeGreaterThan(3 * MIB);
  expect(refused.json.minimum_max_value_bytes).toBeGreaterThan(3 * MIB - 4096);
  expect((await api(stack, 'GET', '/scopes/' + stack.scope)).json.limits.max_value_bytes).toBe(10 * MIB);
  // the smallest accepted value works, and the attachment can be read and survives a revocation (re-encryption)
  const ok = await op('PATCH', '/admin/scopes/' + stack.scope, { limits: { max_value_bytes: refused.json.minimum_max_value_bytes } });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  const reread = await unlockElsewhere(browser, stack, o, o.passphrase);
  expect(await reread.page.evaluate(() => c.getRecord('attachment').then((r) => r.length))).toBe(3 * 1024 * 1024);
  const inv = await invite(o, 'write');
  const rv = await o.page.evaluate((id) => T(c.revoke(id)), inv.slotId);
  expect(rv.ok, JSON.stringify(rv.err)).toMatchObject({ done: true });
  expect(await o.page.evaluate(() => c.usage().then((u) => u.old_epoch_blobs))).toBe(0);
});

test('quotas and limits of the scope are enforced by the server: vault bytes, value size, number of vaults', async ({ browser, stack: shared }) => {
  const stack = await ownScope(shared, 'quotas');
  const op = (method, path, json) => api(stack, method, path, { auth: operatorAuth(stack), json });
  const o = await createOwner(browser, stack);
  try {
    expect((await op('PATCH', '/admin/scopes/' + stack.scope, { limits: { vault_bytes: 3 * MIB, max_value_bytes: 2 * MIB } })).status).toBe(200);
    const info = await api(stack, 'GET', '/scopes/' + stack.scope);
    expect(info.json.limits.vault_bytes).toBe(3 * MIB);
    // a fresh client reads the new limits from the scope document
    const q = await unlockElsewhere(browser, stack, o, o.passphrase);
    expect(q.status.err).toBeUndefined();
    const big = await q.page.evaluate(() => T(c.put('too-big', pattern(3 * 1024 * 1024, 1))));
    expect(big.err.name).toBe('QuotaError');
    // fill the vault with values under the per-value limit until the vault quota refuses
    const fill = await q.page.evaluate(async () => {
      const out = [];
      for (let i = 0; i < 4; i++) { const r = await T(c.put('fill/' + i, pattern(1024 * 1024, i + 10))); out.push(r.err ? { status: r.err.status, code: r.err.code, name: r.err.name } : 'ok'); }
      return out;
    });
    expect(fill[0]).toBe('ok');
    const refused = fill.find((x) => x !== 'ok');
    expect(refused).toEqual({ status: 507, code: 'quota_exceeded', name: 'QuotaError' });
    const usage = await q.page.evaluate(() => c.usage());
    expect(usage.limits.vault_bytes).toBe(3 * MIB);
    expect(usage.bytes).toBeLessThanOrEqual(3 * MIB);
    // deleting frees nothing until history is purged (history counts); purging history by the owner frees the space
    const del = await q.page.evaluate(async () => { await c.delete('fill/0'); return c.deleteHistory('fill/0'); });
    expect(del.freed).toBeGreaterThan(MIB);
    // number of vaults per scope
    expect((await op('PATCH', '/admin/scopes/' + stack.scope, { limits: { max_vaults: 1 } })).status).toBe(200);
    const ctx = await newContext(browser);
    const page = await openApp(ctx, stack);
    const create = await page.evaluate(({ joinCode }) => T(c.createVault({ passphrase: 'one vault too many ' + 'zzzz', joinCode })), { joinCode: stack.joinCode });
    expect([create.err.status, create.err.code]).toEqual([403, 'vault_limit_reached']);
  } finally {
    expect((await op('PATCH', '/admin/scopes/' + stack.scope, { limits: { vault_bytes: null, max_value_bytes: null, max_vaults: null } })).status).toBe(200);
  }
  expect((await api(stack, 'GET', '/scopes/' + stack.scope)).json.limits.vault_bytes).toBeGreaterThan(3 * MIB);
});

test('more records than one list page: the client follows the cursor', async ({ browser, stack }) => {
  const o = await createOwner(browser, stack);
  const n = 1013;
  await o.page.evaluate(async (n) => {
    const names = Array.from({ length: n }, (_, i) => 'many/' + String(i).padStart(4, '0'));
    for (let i = 0; i < names.length; i += 25) await Promise.all(names.slice(i, i + 25).map((name, j) => c.put(name, { i: i + j })));
  }, n);
  const auth = await authOf(o.page);
  const page1 = await api(stack, 'GET', '/vaults/' + o.vaultId + '/records?limit=1000', { auth });
  expect(page1.json.records.length).toBe(1000);
  expect(page1.json.next).toBeTruthy();
  const page2 = await api(stack, 'GET', '/vaults/' + o.vaultId + '/records?limit=1000&after=' + page1.json.next, { auth });
  expect(page2.json.records.length).toBe(n - 1000);
  expect(page2.json.next).toBeNull();
  const d = await unlockElsewhere(browser, stack, o, o.passphrase);
  const names = await d.page.evaluate(() => c.list('many/').then((l) => l.map((r) => r.name)));
  expect(names.length).toBe(n);
  expect(names[0]).toBe('many/0000');
  expect(names.at(-1)).toBe('many/' + String(n - 1));
  expect(await d.page.evaluate(() => c.get('many/0777'))).toEqual({ i: 777 });
});

test('no canary plaintext in any request body the browsers sent, and none in the database files', async ({ browser, stack }) => {
  // a vault written entirely through the UI layer too, with the canaries in names, values, attachments and passphrases
  const ctx = await newContext(browser);
  const page = await openApp(ctx, stack, { ui: true });
  const passphrase = 'ui passphrase with canary ' + PASS_CANARY;
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const dlg = page.getByRole('dialog').last();
  await dlg.getByRole('button', { name: 'Create a new vault' }).click();
  await dlg.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await dlg.getByLabel('Repeat passphrase').fill(passphrase);
  await dlg.getByLabel('Join code').fill(stack.joinCode);
  await dlg.getByRole('button', { name: 'Create vault' }).click();
  await expect(dlg.getByRole('heading', { name: 'Save your access sheet' })).toBeVisible({ timeout: 60000 });
  await dlg.getByLabel('I have saved the access sheet and the recovery code.').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();
  await page.evaluate(() => window.unlockP);
  await page.evaluate(async ({ name, canary, bin }) => {
    await store.set('ui/' + name, { text: canary });
    await store.set('ui/' + name + '.bin', pattern(200000, 7, bin));
    await store.set('ui/' + name, { text: canary + ' again' });
  }, { name: NAME_CANARY, canary: CANARY, bin: BINARY_CANARY });
  await page.evaluate(() => { window.shareP = store.share(); });
  await expect(page.getByRole('dialog').last().getByRole('heading', { name: 'Sharing and access' })).toBeVisible();
  await shot(page, 'share-dialog');
  await page.getByRole('dialog').last().getByRole('button', { name: 'Close' }).click();

  // everything captured over the whole run
  const withBody = captured.filter((r) => r.body && r.body.length);
  expect(withBody.length).toBeGreaterThan(50);
  expect(withBody.filter((r) => r.method === 'PUT' && r.type.startsWith('application/octet-stream')).length).toBeGreaterThan(20);
  expect(withBody.some((r) => r.body.length > 5 * MIB)).toBe(true); // the 5 MB attachment really was captured
  const needles = [];
  for (const cn of CANARIES) {
    needles.push(Buffer.from(cn), Buffer.from(cn.toLowerCase()), Buffer.from(Buffer.from(cn).toString('base64')), Buffer.from(Buffer.from(cn).toString('hex')));
    for (let shift = 0; shift < 3; shift++) { // base64 of the canary at the three possible alignments
      const padded = Buffer.concat([Buffer.alloc(shift, 0x41), Buffer.from(cn)]).toString('base64');
      needles.push(Buffer.from(padded.slice(4, padded.length - 4)));
    }
  }
  const b64uStrings = (body) => (body.toString('latin1').match(/[A-Za-z0-9_-]{24,}/g) || []);
  // Where a canary shows up in a captured request (null: nowhere). Raw bytes, hex, base64 at every alignment, and blobs inside JSON bodies.
  const leak = (r) => {
    for (const cn of CANARIES) if (decodeURIComponent(r.url).includes(cn)) return 'URL ' + cn;
    if (!r.body) return null;
    for (const nd of needles) if (r.body.includes(nd)) return nd.toString().slice(0, 24);
    if (r.type.startsWith('application/json')) {
      for (const str of b64uStrings(r.body)) {
        const raw = Buffer.from(str, 'base64url');
        for (const cn of CANARIES) if (raw.includes(Buffer.from(cn))) return 'blob in JSON ' + cn;
      }
    }
    return null;
  };
  // positive controls: the detector does find the canaries in each of the forms it claims to cover
  const ctl = (body, type = 'application/octet-stream') => ({ url: 'http://x/datastore/api/v1/x', type, body });
  expect(leak(ctl(Buffer.from('xx' + CANARY + 'yy')))).toBeTruthy();
  expect(leak(ctl(Buffer.from(JSON.stringify({ blob: Buffer.from('some bytes ' + NAME_CANARY).toString('base64url') })), 'application/json'))).toBeTruthy();
  expect(leak(ctl(Buffer.from(JSON.stringify({ t: Buffer.from('?' + BINARY_CANARY).toString('base64') })), 'application/json'))).toBeTruthy();
  expect(leak({ url: 'http://x/datastore/api/v1/records/' + CANARY, type: '', body: null })).toBeTruthy();
  expect(leak(ctl(Buffer.from('nothing to see here')))).toBeNull();
  const leaks = captured.map((r) => ({ r, l: leak(r) })).filter((x) => x.l);
  expect(leaks.map((x) => x.r.method + ' ' + x.r.url + ': ' + x.l)).toEqual([]);
  // at rest: the database and its write-ahead log hold no plaintext either
  const files = stack.dbBytes();
  expect(files.length).toBeGreaterThan(0);
  expect(files.reduce((n, f) => n + f.bytes.length, 0)).toBeGreaterThan(5 * MIB);
  for (const f of files) for (const cn of CANARIES) expect(f.bytes.includes(Buffer.from(cn)), f.file + ' contains ' + cn).toBe(false);
  // the server's own log shows no request lines and no secrets
  const log = stack.server.log();
  for (const cn of CANARIES) expect(log.includes(cn)).toBe(false);
  expect(log).not.toMatch(/GET \/datastore|PUT \/datastore/);
});
