// store.migrateLocal against the REAL server and the REAL bundle, in Chromium, Firefox and WebKit (playwright.integration.config.mjs).
// Every case seeds an "old" browser storage (IndexedDB + localStorage) from the same http://127.0.0.1 page that then runs the new code: the old app and the
// new app are the same URL, as they must be in a real browser. (WebKit keeps no IndexedDB for file:// pages, so the pages are served over http.)
// Contract: the header comment of src/wds-ui.js and docs/site/porting.md.
import { test as base, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { startStack, startSandboxServer, SHOTS } from './integration-env.mjs';

const PASS = 'purple-elephant-marching-slowly';

const test = base.extend({
  stack: [async ({}, use) => {
    const stack = await startStack();
    stack.sandbox = await startSandboxServer(stack);
    stack.pages = join(stack.tmp, 'migrate-pages');
    mkdirSync(stack.pages, { recursive: true });
    const pageServer = createServer((req, res) => {
      const name = basename(decodeURIComponent((req.url || '').split('?')[0]));
      try {
        const body = readFileSync(name === 'bundle.js' ? stack.bundleFile : join(stack.pages, name));
        res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' }).end(body);
      } catch (e) { res.writeHead(404).end('not found'); }
    });
    await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
    stack.pageOrigin = 'http://127.0.0.1:' + pageServer.address().port;
    try { await use(stack); } finally { await new Promise((resolve) => pageServer.close(resolve)); await stack.sandbox.stop(); await stack.stop(); }
  }, { scope: 'worker' }],
});
test.setTimeout(240000);

// The new app of the Literaturliste example: the old IndexedDB "literatur" (refs, pdfs) and its localStorage preferences. A row of refs that is no entry
// (a cache) is left out by map: it is never deleted. A pdf row points back to its reference (a reverse ref).
const APP_SCRIPT = String.raw`
window.revive = function revive(v) {
  if (v && v.__blob !== undefined) { const bytes = typeof v.__blob === 'string' ? new TextEncoder().encode(v.__blob) : new Uint8Array(v.__blob); return v.name ? new File([bytes], v.name, { type: v.type || '' }) : new Blob([bytes], { type: v.type || '' }); }
  if (v && v.__bytes) { const b = new Uint8Array(v.__bytes); let x = v.seed || 1; for (let i = 0; i < b.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255; } return v.name ? new File([b], v.name, { type: v.type || '' }) : new Blob([b], { type: v.type || '' }); }
  if (v && v.__date) return new Date(v.__date);
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = revive(v[k]); return o; }
  return v;
};
window.seed = async function (spec) {
  for (const d of spec.idb || []) {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open(d.name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of d.stores) {
          const os = db.createObjectStore(s.name, s.keyPath ? { keyPath: s.keyPath } : s.autoIncrement ? { autoIncrement: true } : undefined);
          for (const v of s.rows || []) os.add(revive(v));
          for (const [k, v] of s.kv || []) os.put(revive(v), k);
        }
      };
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });
  }
  for (const [k, v] of Object.entries(spec.local || {})) localStorage.setItem(k, v);
};
window.oldState = async function (dbName, storeNames) {
  const out = { local: {}, stores: {} };
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k.startsWith('wds:')) out.local[k] = localStorage.getItem(k); }
  const db = await new Promise((resolve) => { const r = indexedDB.open(dbName); r.onupgradeneeded = () => { r.transaction.abort(); resolve(null); }; r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null); });
  if (!db) return out;
  for (const s of storeNames) {
    if (!db.objectStoreNames.contains(s)) continue;
    out.stores[s] = await new Promise((resolve) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => resolve(r.result.length); });
  }
  db.close();
  return out;
};
window.rawStore = async function (dbName, storeName) {   // [{key, value}] of an old store
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open(dbName); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const os = db.transaction(storeName).objectStore(storeName);
  const keys = await new Promise((resolve) => { const r = os.getAllKeys(); r.onsuccess = () => resolve(r.result); });
  const vals = await new Promise((resolve) => { const r = os.getAll(); r.onsuccess = () => resolve(r.result); });
  db.close();
  return keys.map((k, i) => ({ key: k, value: vals[i] }));
};
window.mutateOld = async function (dbName, storeName, fn) {   // fn(objectStore, resolve-callback) inside a readwrite transaction
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open(dbName); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  await new Promise((resolve, reject) => { const tx = db.transaction(storeName, 'readwrite'); fn(tx.objectStore(storeName)); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
};
window.setupApp = function () {
  window.refCol = store.collection('refs/', { meta: (r) => ({ title: String(r.title || '').slice(0, 80) }) });
  window.pdfCol = store.collection('pdfs/');
  window.MIGRATION = {
    id: 'literatur',
    indexedDB: { literatur: ['refs', 'pdfs'] },
    map(old, ref) {
      if (old.source === 'literatur/refs') {
        if (old.value.cache) return;
        const { pdfId, ...rest } = old.value;
        return { collection: 'refs/', id: old.id, value: { ...rest, pdfId: pdfId == null ? null : ref(pdfId, 'literatur/pdfs') } };
      }
      return { collection: 'pdfs/', id: old.id, value: old.value.blob, meta: { name: old.value.name, ref: ref(old.value.refId, 'literatur/refs') } };
    },
  };
};
`;

let pageCount = 0;
function appUrl(stack, lang) {
  const file = join(stack.pages, 'app' + (++pageCount) + '.html');
  writeFileSync(file, '<!doctype html><html' + (lang ? ' lang="' + lang + '"' : '') + '><head><meta charset="utf-8"><title>Literaturliste</title><script src="/bundle.js"></script></head>'
    + '<body><main id="app"><h1>Literaturliste</h1><button id="app-button">App</button></main><script>' + APP_SCRIPT + '</script></body></html>');
  return stack.pageOrigin + '/' + basename(file);
}

// WebKit can keep Blobs in IndexedDB only in a persistent profile (an ephemeral context aborts the write), so there it is a persistent context in a temporary folder.
const persistent = [];
test.afterEach(async () => { while (persistent.length) { const p = persistent.pop(); await p.ctx.close().catch(() => {}); rmSync(p.dir, { recursive: true, force: true }); } });
async function newCtx(browser, { webdriver } = {}) {
  const options = { acceptDownloads: true, viewport: { width: 1100, height: 900 }, locale: 'en-US' };
  let ctx;
  if (browser.browserType().name() === 'webkit') {
    const dir = mkdtempSync(join(tmpdir(), 'wds-webkit-'));
    ctx = await browser.browserType().launchPersistentContext(dir, { ...(test.info().project.use.launchOptions || {}), ...options });
    persistent.push({ ctx, dir });
  } else ctx = await browser.newContext(options);
  await ctx.route('**/api/v1/pwned/*', (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n' }));
  if (webdriver === false) await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); });
  return ctx;
}
// Opens the app page (a fresh load of the same URL) and connects the store.
async function openApp(ctx, url, target) {
  const page = await ctx.newPage();
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push('pageerror: ' + e));
  page.consoleLines = [];
  page.on('console', (m) => page.consoleLines.push(m.text()));
  await page.goto(url);
  await page.evaluate(({ scope, service }) => { window.store = WDS.connect({ scope, baseUrl: service }); window.setupApp(); }, { scope: target.scope, service: target.service });
  return page;
}
const wds = (page, name) => page.locator('dialog.wds-dialog [data-wds="' + name + '"]').last();
const dlgView = (page) => page.locator('dialog.wds-dialog').last();

async function createVault(page, joinCode) {
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  await wds(page, 'to-create').click();
  if (joinCode) await wds(page, 'join-code').fill(joinCode);
  await wds(page, 'passphrase').fill(PASS); await wds(page, 'passphrase-repeat').fill(PASS);
  await wds(page, 'create-submit').click();
  await expect(wds(page, 'access-id')).toBeVisible();
  const accessId = (await wds(page, 'access-id').innerText()).trim();
  await wds(page, 'sheet-confirm').check(); await wds(page, 'sheet-continue').click();
  await page.evaluate(() => window.unlockP);
  return accessId;
}
async function unlock(page, accessId) {
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  await wds(page, 'access-id-input').fill(accessId);
  await wds(page, 'passphrase').fill(PASS);
  await wds(page, 'unlock-submit').click();
  await page.evaluate(() => window.unlockP);
}
// An engine without (Blob) IndexedDB has no old database to seed: such cases are skipped there. Over http all three engines keep both.
async function needIdb(page, blobs) {
  const ok = await page.evaluate((blobs) => new Promise((res) => {
    try {
      const r = indexedDB.open('probe-' + Math.random());
      r.onupgradeneeded = () => { const os = r.result.createObjectStore('s'); os.put(blobs ? new Blob(['x']) : 'x', 'k'); };
      r.onsuccess = () => { r.result.close(); res(true); };
      r.onerror = () => res(false); r.onblocked = () => res(false);
    } catch (e) { res(false); }
  }), blobs);
  test.skip(!ok, 'this engine cannot keep ' + (blobs ? 'Blobs in ' : '') + 'IndexedDB');
}
const seed = async (page, spec) => { if (spec.idb) await needIdb(page, JSON.stringify(spec).includes('__blob') || JSON.stringify(spec).includes('__bytes')); return page.evaluate((s) => window.seed(s), spec); };
const start = (page) => page.evaluate(() => { window.migP = store.migrateLocal(window.MIGRATION).then((r) => r, (e) => ({ rejected: e.name + ': ' + e.message })); });
const finish = (page) => page.evaluate(() => window.migP);
const yes = async (page) => { await expect(dlgView(page)).toHaveAttribute('data-wds-view', 'migrate'); await expect(dlgView(page)).not.toHaveAttribute('aria-busy', /.*/); await wds(page, 'migrate-yes').click(); };
const run = async (page) => { await start(page); await yes(page); return finish(page); };
// The second start: the copied rows are still in the old storage, and the library asks whether to delete them. button: the data-wds name of the answer.
async function secondStart(o, button = 'migrate-delete-yes', prep) {
  const page = await reopen(o);
  if (prep) await page.evaluate(prep);
  await start(page);
  await expect(dlgView(page)).toHaveAttribute('data-wds-view', 'migrate-delete');
  await expect(dlgView(page)).not.toHaveAttribute('aria-busy', /.*/);
  await wds(page, button).click();
  return { page, result: await finish(page) };
}
const oldCount = (page) => page.evaluate(() => window.oldState('literatur', ['refs', 'pdfs']));
const idOf = (page, source, key) => page.evaluate(([s, k]) => WDS.internals.migrate.rowId(localStorage.getItem('wds:migrate:literatur:tag'), s, k), [source, key]);

// The old Literaturliste: 3 references (numeric autoIncrement ids 1..3) and a cache row (id 4) that map leaves out; ref 1 has the pdf 1, ref 2 points to a pdf that does not
// exist, ref 3 has none; 1 pdf that points back to ref 1; preferences in localStorage.
const PDF1 = { __blob: 'PDF-1.4 old pdf one %%EOF', type: 'application/pdf', name: 'eins.pdf' };
const OLD = {
  idb: [{ name: 'literatur', stores: [
    { name: 'refs', autoIncrement: true, rows: [
      { title: 'Alpha', authors: 'A. Author', year: 2001, pdfId: 1, created: '2024-03-01T10:00:00.000Z' },
      { title: 'Beta', authors: 'B. Author', year: 2002, pdfId: 99, created: '2024-03-02T10:00:00.000Z' },
      { title: 'Gamma', authors: 'C. Author', year: 2003, created: '2024-03-03T10:00:00.000Z' },
      { cache: true, note: 'a row that is no entry' },
    ] },
    { name: 'pdfs', autoIncrement: true, rows: [{ name: 'eins.pdf', refId: 1, blob: PDF1 }] },
  ] }],
  local: { 'literaturliste.einstellungen': JSON.stringify({ theme: 'dark', sort: 'year' }), 'other.app.key': 'keep me' },
};

// What the vault holds after the migration of OLD.
async function vaultState(page) {
  return page.evaluate(async () => {
    await refCol.load(); await pdfCol.load();
    const refs = await refCol.getAll(), pdfs = [];
    for (const e of pdfCol.items()) { const b = await store.get(e.name); pdfs.push({ id: e.id, meta: e.meta, size: b.size, type: b.type, text: await b.text() }); }
    return { refs: refs.map((r) => ({ id: r.id, meta: r.meta, value: r.value })), pdfs };
  });
}
async function ownerWithOld(browser, stack, { target = stack, joinCode = stack.joinCode, ctxOpts, spec = OLD } = {}) {
  const ctx = await newCtx(browser, ctxOpts);
  const url = appUrl(stack);
  const page = await openApp(ctx, url, target);
  const accessId = await createVault(page, joinCode);
  await seed(page, spec);
  return { ctx, url, page, accessId, target };
}
async function reopen(o) { const page = await openApp(o.ctx, o.url, o.target); await unlock(page, o.accessId); return page; }

test('owner: the first start copies and keeps the old data; the second start asks and deletes only the rows that produced writes; references both ways; a row that map leaves out and the preferences stay', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  const { page } = o;
  await start(page);
  await expect(dlgView(page)).toHaveAttribute('data-wds-view', 'migrate');
  await expect(dlgView(page)).not.toHaveAttribute('aria-busy', /.*/);
  await expect(dlgView(page)).toContainText('4 entries');
  const dl = page.waitForEvent('download');
  await wds(page, 'migrate-backup').click();
  expect((await dl).suggestedFilename()).toMatch(/^literatur-old-data-\d{4}-\d{2}-\d{2}\.zip$/);
  await wds(page, 'migrate-yes').click();
  expect(await finish(page)).toEqual({ status: 'migrated' });
  const st = await vaultState(page);
  const aId = await idOf(page, 'literatur/refs', 1), pdfId = await idOf(page, 'literatur/pdfs', 1);
  expect(st.refs).toHaveLength(3);
  const byTitle = Object.fromEntries(st.refs.map((r) => [r.value.title, r]));
  expect(byTitle.Alpha.id).toBe(aId);
  expect(byTitle.Alpha.value.pdfId).toBe(pdfId);                                                  // ref(): the id the other row gets
  expect(byTitle.Beta.value.pdfId).toBe(await idOf(page, 'literatur/pdfs', 99));                  // a reference to a row that does not exist stays a plain id
  expect(byTitle.Gamma.value.pdfId).toBeNull();
  expect(byTitle.Alpha.meta).toEqual({ title: 'Alpha' });                                         // meta from the collection's meta function
  expect(st.pdfs).toEqual([{ id: pdfId, meta: { name: 'eins.pdf', ref: aId }, size: 25, type: 'application/pdf', text: 'PDF-1.4 old pdf one %%EOF' }]);   // the reverse ref
  expect((await oldCount(page)).stores).toEqual({ refs: 4, pdfs: 1 });                           // the copy run never deletes
  await expect(dlgView(page)).toHaveCount(0);
  await expect(page.locator('[data-wds-notice=migration]')).toContainText('4 entries were copied into your vault');
  // the second start: a question with the number of copied rows, a link to the copy; "Not now" changes nothing
  const later = await secondStart(o, 'migrate-no');
  expect(later.result).toEqual({ status: 'nothing' });
  expect((await oldCount(later.page)).stores).toEqual({ refs: 4, pdfs: 1 });
  const del = await reopen(o);
  await start(del);
  await expect(dlgView(del)).toContainText('4 entries of an earlier version');
  await expect(wds(del, 'migrate-backup')).toBeVisible();
  await wds(del, 'migrate-delete-yes').click();
  expect(await finish(del)).toEqual({ status: 'nothing' });
  const old = await oldCount(del);
  expect(old.stores).toEqual({ refs: 1, pdfs: 0 });                                               // the cache row was not claimed: it stays
  expect(old.local).toEqual(OLD.local);                                                           // preferences are not named in migrateLocal
  await expect(page.locator('dialog.wds-dialog')).toHaveCount(0);
  await expect(del.locator('[data-wds-notice=migration]')).toContainText('4 old entries were deleted');
  // a later start: the row that map leaves out is no entry, so there is nothing to ask
  const page3 = await reopen(o);
  await start(page3);
  expect(await finish(page3)).toEqual({ status: 'nothing' });
  await expect(page3.locator('dialog.wds-dialog')).toHaveCount(0);
  expect(page.problems).toEqual([]);
});

test('a member is not asked: declined with why "not-owner", one line in the console; the old data stays', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  const invite = await o.page.evaluate(async ({ scope, service, accessId, pass }) => {
    const c = new WDSCore.Client({ scope, service }); await c.unlock({ accessId, passphrase: pass });
    return (await c.createInvite({ role: 'write' })).code.display;
  }, { scope: stack.scope, service: stack.service, accessId: o.accessId, pass: PASS });
  const ctx = await newCtx(browser), url = appUrl(stack), page = await openApp(ctx, url, stack);
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  await wds(page, 'to-redeem').click();
  await wds(page, 'invite-code-input').fill(invite);
  await wds(page, 'passphrase').fill(PASS); await wds(page, 'passphrase-repeat').fill(PASS);
  await wds(page, 'redeem-submit').click();
  await wds(page, 'sheet-confirm').check(); await wds(page, 'sheet-continue').click();
  await page.evaluate(() => window.unlockP);
  await seed(page, OLD);
  await start(page);
  expect(await finish(page)).toEqual({ status: 'declined', why: 'not-owner' });
  await expect(page.locator('dialog.wds-dialog')).toHaveCount(0);
  expect(page.consoleLines.filter((l) => /migrateLocal "literatur"/.test(l))).toHaveLength(1);
  expect((await oldCount(page)).stores).toEqual({ refs: 4, pdfs: 1 });
});

test('nothing to take over: no dialog, no unlock, no request', async ({ browser, stack }) => {
  const ctx = await newCtx(browser), page = await openApp(ctx, appUrl(stack), stack);
  const requests = [];
  page.on('request', (r) => { if (r.url().includes('/datastore/api/')) requests.push(r.url()); });
  await start(page);
  expect(await finish(page)).toEqual({ status: 'nothing' });
  await expect(page.locator('dialog.wds-dialog')).toHaveCount(0);
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => store.status().unlocked)).toBe(false);
});

test('declined (Not now, Escape, close) writes nothing and asks again at the next start; a second call in the same page gives the same result', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  await start(o.page);
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', 'migrate');
  await wds(o.page, 'migrate-no').click();
  expect(await finish(o.page)).toEqual({ status: 'declined' });
  expect(await o.page.evaluate(() => store.migrateLocal(window.MIGRATION).then((r) => r.status))).toBe('declined');   // once per start
  expect((await oldCount(o.page)).stores).toEqual({ refs: 4, pdfs: 1 });
  const p2 = await reopen(o);                              // Escape
  await start(p2);
  await expect(dlgView(p2)).toHaveAttribute('data-wds-view', 'migrate');
  await p2.keyboard.press('Escape');
  expect((await finish(p2)).status).toBe('declined');
  const p3 = await reopen(o);                              // the close button
  await start(p3);
  await wds(p3, 'close').click();
  expect((await finish(p3)).status).toBe('declined');
  expect(await p3.evaluate(() => refCol.load().then((l) => l.length))).toBe(0);
  const p4 = await reopen(o);
  expect(await run(p4)).toEqual({ status: 'migrated' });
});

test('sandbox: copies and keeps the old data; later starts ask nothing, not even about deleting', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack, { target: stack.sandbox, joinCode: null });
  await start(o.page);
  await expect(dlgView(o.page)).toContainText('Sandbox: the old data stays in this browser');
  await yes(o.page);
  expect(await finish(o.page)).toEqual({ status: 'migrated' });
  await expect(o.page.locator('[data-wds-notice=migration]')).toContainText('The old data stays in this browser');
  expect((await oldCount(o.page)).stores).toEqual({ refs: 4, pdfs: 1 });
  for (let i = 0; i < 2; i++) {
    const p2 = await reopen(o);
    await start(p2);
    expect(await finish(p2)).toEqual({ status: 'nothing' });   // remembered per vault: the old data is still there, but it was taken over
    await expect(p2.locator('dialog.wds-dialog')).toHaveCount(0);
  }
  expect((await oldCount(o.page)).stores).toEqual({ refs: 4, pdfs: 1 });
});

test('the marker belongs to the vault: the same old data in another vault (another scope) is asked about again', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack, { target: stack.sandbox, joinCode: null });
  expect(await run(o.page)).toEqual({ status: 'migrated' });
  const real = await openApp(o.ctx, o.url, stack);            // same browser profile, the real scope of the app
  await createVault(real, stack.joinCode);
  await start(real);
  await expect(dlgView(real)).toHaveAttribute('data-wds-view', 'migrate');
  await wds(real, 'migrate-no').click();
  expect(await finish(real)).toEqual({ status: 'declined' });
});

test('an interrupted run (connection lost after two writes) fails with a dialog; the next start recognises what was copied and finishes the copy', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  let puts = 0;
  await o.page.route(/\/records\//, (route) => (route.request().method() === 'PUT' && ++puts > 2 ? route.abort('failed') : route.continue()));
  await start(o.page);
  await yes(o.page);
  const res = await finish(o.page);
  expect(res.status).toBe('failed');
  expect(res.why).toMatch(/offline/);
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', /migrate-failed|offline/);
  expect((await oldCount(o.page)).stores).toEqual({ refs: 4, pdfs: 1 });
  await o.page.unroute(/\/records\//);
  const p2 = await reopen(o);
  expect(await run(p2)).toEqual({ status: 'migrated' });
  const st = await vaultState(p2);
  expect(st.refs).toHaveLength(3); expect(st.pdfs).toHaveLength(1);
  expect((await secondStart(o)).result).toEqual({ status: 'nothing' });
  expect((await oldCount(p2)).stores).toEqual({ refs: 1, pdfs: 0 });
});

test('a name that the vault holds with other content is a conflict: onConflict answers, else the dialog; the old rows stay until the person confirms the deletion', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  const prepare = async (page, accessId) => {
    await page.evaluate(() => localStorage.setItem('wds:migrate:literatur:tag', 'cafe0001'));
    const id = await idOf(page, 'literatur/refs', 1);
    await page.evaluate(async ({ scope, service, accessId, pass, id }) => {
      const c = new WDSCore.Client({ scope, service }); await c.unlock({ accessId, passphrase: pass });
      await c.put('refs/' + id, { title: 'Vault version' });
    }, { scope: stack.scope, service: stack.service, accessId, pass: PASS, id });
    return id;
  };
  const id = await prepare(o.page, o.accessId);
  // the page has read the record before: the old value is still not written over it without a conflict (the writes are create-only)
  await o.page.evaluate((id) => store.get('refs/' + id), id);
  await o.page.evaluate(() => { window.calls = []; store.onConflict((c) => { calls.push(c.name); return 'theirs'; }); });
  expect(await run(o.page)).toEqual({ status: 'migrated' });
  expect(await o.page.evaluate(() => calls)).toEqual(['refs/' + id]);
  let st = await vaultState(o.page);
  expect(st.refs.map((r) => r.value.title).sort()).toEqual(['Beta', 'Gamma', 'Vault version']);   // the vault kept its version
  expect((await oldCount(o.page)).stores).toEqual({ refs: 4, pdfs: 1 });                           // and the old rows stay: the person decides at the second start
  // no handler: the library's conflict dialog asks, "Keep mine" writes the old value
  const o2 = await ownerWithOld(browser, stack);
  await prepare(o2.page, o2.accessId);
  await start(o2.page);
  await yes(o2.page);
  await expect(dlgView(o2.page)).toHaveAttribute('data-wds-view', 'conflict');
  await wds(o2.page, 'conflict-mine').click();
  expect(await finish(o2.page)).toEqual({ status: 'migrated' });
  st = await vaultState(o2.page);
  expect(st.refs.map((r) => r.value.title).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
});

test('old data that changed after the copy is not deleted at the second start, and is asked about again at the third', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  expect(await run(o.page)).toEqual({ status: 'migrated' });
  await o.page.evaluate(() => window.mutateOld('literatur', 'refs', (os) => os.put({ title: 'Alpha edited', pdfId: 1, created: '2024-03-01T10:00:00.000Z' }, 1)));
  await o.page.evaluate(() => window.mutateOld('literatur', 'pdfs', (os) => { const f = new File([new TextEncoder().encode('PDF-1.4 old pdf ONE %%EOF')], 'eins.pdf', { type: 'application/pdf' }); os.put({ name: 'eins.pdf', refId: 1, blob: f }, 1); }));
  const p2 = await reopen(o);
  await start(p2);
  await expect(dlgView(p2)).toContainText('2 entries of an earlier version');   // the two refs that did not change
  await wds(p2, 'migrate-delete-yes').click();
  expect(await finish(p2)).toEqual({ status: 'nothing' });
  expect((await oldCount(p2)).stores).toEqual({ refs: 2, pdfs: 1 });          // the cache row, the changed ref, the changed file
  const p3 = await reopen(o);
  await start(p3);
  await expect(dlgView(p3)).toHaveAttribute('data-wds-view', 'migrate');       // asked about afresh: the marker was cleared
  await expect(dlgView(p3)).toContainText('2 entries');
  await wds(p3, 'migrate-no').click();
  expect((await finish(p3)).status).toBe('declined');
});

test('two tabs of the same browser run migrateLocal at once: no duplicates, no conflict dialog, nothing lost', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  const p2 = await reopen(o);
  await start(o.page);
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', 'migrate');   // the tag of this browser exists now
  await start(p2);
  await expect(dlgView(p2)).toHaveAttribute('data-wds-view', 'migrate');
  await Promise.all([wds(o.page, 'migrate-yes').click(), wds(p2, 'migrate-yes').click()]);
  const [r1, r2] = [await finish(o.page), await finish(p2)];
  expect([r1.status, r2.status]).toEqual(['migrated', 'migrated']);
  const st = await vaultState(o.page);
  expect(st.refs).toHaveLength(3); expect(st.pdfs).toHaveLength(1);
  expect((await oldCount(o.page)).stores).toEqual({ refs: 4, pdfs: 1 });
  expect((await secondStart(o)).result).toEqual({ status: 'nothing' });
});

test('the session ends during the copy: the run stops as failed with "locked" and the old data stays', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  let puts = 0;
  await o.page.route(/\/records\//, (route) => (route.request().method() === 'PUT' && ++puts > 1
    ? route.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'www-authenticate': 'Bearer realm="wds"' }, body: '{"error":"unauthorized"}' })
    : route.continue()));
  await start(o.page);
  await yes(o.page);
  const res = await finish(o.page);
  expect(res.status).toBe('failed');
  expect(res.why).toMatch(/^locked/);
  expect((await oldCount(o.page)).stores).toEqual({ refs: 4, pdfs: 1 });
});

test('map errors: nothing is written or deleted; the result is "failed" with a message, the person gets a dialog with the copy of the old data; only wrong options reject', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  const cases = {
    throws: [() => { throw new Error('boom'); }, /map threw for literatur\/refs key 1: boom/],
    noValue: [() => ({ collection: 'refs/', id: 'a' }), /must be \{ collection/],
    both: [() => ({ collection: 'refs/', id: 'a', name: 'x', value: 1 }), /must be \{ collection/],
    nested: [(old) => ({ name: 'x/' + old.id, value: { f: new Blob(['x']) } }), /file, Map or Set inside a JSON value/],
    same: [() => ({ name: 'same', value: 1 }), /two writes would get the name "same"/],
    badId: [() => ({ collection: 'refs/', id: 'a/b', value: 1 }), /id is 1 to 200 characters without "\/"/],
  };
  let page = o.page;
  for (const [name, [fn, re]] of Object.entries(cases)) {
    await page.evaluate('window.MIGRATION = { ...window.MIGRATION, map: ' + fn.toString() + ' }');
    await start(page);
    const res = await finish(page);
    expect(res.status, name).toBe('failed');
    expect(res.why, name).toMatch(re);
    await expect(dlgView(page), name).toHaveAttribute('data-wds-view', 'migrate-failed');
    await expect(wds(page, 'migrate-backup')).toBeVisible();
    expect((await oldCount(page)).stores, name).toEqual({ refs: 4, pdfs: 1 });
    expect(await page.evaluate(() => refCol.load().then((l) => l.length)), name).toBe(0);
    await wds(page, 'migrate-close').click();
    page = await reopen(o);
  }
  // wrong options reject before anything is read
  const rejected = await page.evaluate(() => store.migrateLocal({ id: 'literatur', map() {}, applySettings() {}, indexedDB: { literatur: ['refs'] } }).then(() => 'ok', (e) => e.name + ': ' + e.message));
  expect(rejected).toMatch(/^UsageError: .*unknown option "applySettings"/);
});

test('a localStorage key that holds many entries and a localStorage prefix: several writes from one row, all claimed rows deleted, other keys stay', async ({ browser, stack }) => {
  const spec = { local: { 'lit.items': JSON.stringify([{ t: 'one' }, { t: 'two' }, { t: 'three' }]), 'lit.k.a': 'text a', 'lit.k.b': 'text b', 'other.app.key': 'keep me' } };
  const o = await ownerWithOld(browser, stack, { spec });
  const prep = () => {
    window.MIGRATION = { id: 'literatur', localStorage: ['lit.items', 'lit.k.*'], map(old) {
      if (old.key === 'lit.items') return JSON.parse(old.value).map((e, i) => ({ name: 'items/' + i, value: e }));
      return { name: 'kv/' + old.key.slice(6), value: { text: old.value } };
    } };
  };
  await o.page.evaluate(prep);
  await start(o.page);
  await expect(dlgView(o.page)).toContainText('5 entries');
  await yes(o.page);
  expect(await finish(o.page)).toEqual({ status: 'migrated' });
  expect((await oldCount(o.page)).local).toEqual(spec.local);
  await secondStart(o, 'migrate-delete-yes', prep);
  const got = await o.page.evaluate(async () => [await store.get('items/0'), await store.get('items/2'), await store.get('kv/a'), await store.get('kv/b')]);
  expect(got).toEqual([{ t: 'one' }, { t: 'three' }, { text: 'text a' }, { text: 'text b' }]);
  expect((await oldCount(o.page)).local).toEqual({ 'other.app.key': 'keep me' });
});

test('two browsers with the same old ids get two copies: the ids carry the tag of the browser', async ({ browser, stack }) => {
  const a = await ownerWithOld(browser, stack);
  expect(await run(a.page)).toEqual({ status: 'migrated' });
  const ctx2 = await newCtx(browser), p2 = await openApp(ctx2, appUrl(stack), stack);
  await unlock(p2, a.accessId);
  await seed(p2, OLD);
  expect(await run(p2)).toEqual({ status: 'migrated' });
  const st = await vaultState(p2);
  expect(st.refs).toHaveLength(6); expect(st.pdfs).toHaveLength(2);
});

test('the backup is a ZIP with data.json and every file; Blobs and Dates are described, the localStorage text is there', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  await o.page.evaluate(() => { const base = window.MIGRATION.map; window.MIGRATION = { ...window.MIGRATION, localStorage: ['literaturliste.einstellungen'], map(old, ref) { return old.source === 'localStorage' ? undefined : base(old, ref); } }; });
  await start(o.page);
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', 'migrate');
  const dl = o.page.waitForEvent('download');
  await wds(o.page, 'migrate-backup').click();
  const entries = zipEntries(readFileSync(await (await dl).path()));
  expect(Object.keys(entries).sort()).toEqual(['data.json', 'files/0001-eins.pdf']);
  const doc = JSON.parse(entries['data.json'].toString());
  expect(doc.app).toBe('literatur');
  const row = (src, key) => doc.rows.find((r) => r.source === src && r.key === key);
  expect(row('literatur/refs', 1).value).toMatchObject({ title: 'Alpha', pdfId: 1 });
  expect(row('literatur/pdfs', 1).value.blob).toEqual({ $file: 'files/0001-eins.pdf', size: 25, type: 'application/pdf' });
  expect(row('localStorage', 'literaturliste.einstellungen').value).toContain('"theme":"dark"');
  expect(entries['files/0001-eins.pdf'].toString()).toBe('PDF-1.4 old pdf one %%EOF');
  await wds(o.page, 'migrate-no').click();
  await finish(o.page);
});

// The entries of a ZIP file without compression (what makeZip writes): name -> bytes.
function zipEntries(buf) {
  const entries = {};
  for (let pos = 0; buf.readUInt32LE(pos) === 0x04034b50;) {
    const size = buf.readUInt32LE(pos + 18), nl = buf.readUInt16LE(pos + 26), el = buf.readUInt16LE(pos + 28), name = buf.toString('utf8', pos + 30, pos + 30 + nl);
    entries[name] = buf.subarray(pos + 30 + nl + el, pos + 30 + nl + el + size);
    pos += 30 + nl + el + size;
  }
  return entries;
}

test('the question opens above an app dialog that is open with showModal(), and is answered there', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  await o.page.evaluate(() => { const d = document.createElement('dialog'); d.id = 'appdlg'; d.innerHTML = '<p>App</p><button id="appok" type="button">OK</button>'; document.body.appendChild(d); d.showModal(); });
  await start(o.page);
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', 'migrate');
  await wds(o.page, 'migrate-yes').click();                           // no force: it is on top
  expect((await finish(o.page)).status).toBe('migrated');
  expect(await o.page.evaluate(() => document.getElementById('appdlg').open)).toBe(true);
  await o.page.locator('#appok').click();
});

test('German by <html lang>; the dialog names stay', async ({ browser, stack }) => {
  const ctx = await newCtx(browser), page = await openApp(ctx, appUrl(stack, 'de'), stack);
  await createVault(page, stack.joinCode);
  await seed(page, OLD);
  await start(page);
  await expect(dlgView(page)).toHaveAttribute('data-wds-view', 'migrate');
  await expect(dlgView(page).locator('h2')).toHaveText('Daten der früheren Version übernehmen');
  await expect(dlgView(page)).toContainText('In diesem Browser liegen 4 Einträge aus einer früheren Version dieser App, unverschlüsselt und nur auf diesem Gerät.');
  await expect(wds(page, 'migrate-yes')).toHaveText('Übernehmen');
  await expect(wds(page, 'migrate-no')).toHaveText('Später');
  await expect(wds(page, 'migrate-backup')).toHaveText('Zuerst eine Kopie der alten Daten herunterladen (nicht verschlüsselt)');
  mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'migrate-de.png') });
  await wds(page, 'migrate-yes').click();
  expect((await finish(page)).status).toBe('migrated');
  await expect(page.locator('[data-wds-notice=migration]')).toContainText('4 Einträge wurden in Ihren Tresor kopiert');
});
