// store.migrateLocal against the REAL server and the REAL bundle, in Chromium, Firefox and WebKit (playwright.integration.config.mjs).
// Every case seeds an "old" browser storage (IndexedDB + localStorage) from the same http://127.0.0.1 page that then runs the new code: the old app and the
// new app are the same URL, as they must be in a real browser. (WebKit keeps no IndexedDB for file:// pages, so the pages are served over http.) Contract: the header comment of src/wds-ui.js.
import { test as base, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { startStack, startSandboxServer, api, operatorAuth, SHOTS } from './integration-env.mjs';

const PASS = 'purple-elephant-marching-slowly';
const MIB = 1024 * 1024;

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

// The new app of the Literaturliste example (design B7), in one page: the old IndexedDB "literatur" (refs, pdfs) and its localStorage settings.
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
    indexedDB: { name: 'literatur', stores: ['refs', 'pdfs'] },   // the preferences key stays in localStorage and is not named
    map(old, h) {
      const owner = new Map();
      for (const row of old.rows('refs')) if (row.value && row.value.pdfId != null) owner.set(JSON.stringify(row.value.pdfId), h.id(row.key));
      const items = old.rows('refs').map((row) => {
        const v = row.value;
        const { id, ...rest } = v;
        const pdfId = h.ref('pdfs', v.pdfId, '.pdf');
        return { col: refCol, id: h.id(row.key), value: { ...rest, pdfId, pdfName: pdfId ? v.pdfName || null : null }, created: h.created(v.created), from: row };
      });
      for (const row of old.rows('pdfs')) {
        const ref = owner.get(JSON.stringify(row.key));
        items.push({ col: pdfCol, id: h.id(row.key, '.pdf'), value: h.blob(row.value), meta: { name: String(row.value.name || 'dokument.pdf').slice(0, 200), ...(ref ? { ref } : {}) }, from: row });
      }
      return { items };
    },
  };
};
`;

let pageCount = 0;
function appUrl(stack) {
  const file = join(stack.pages, 'app' + (++pageCount) + '.html');
  writeFileSync(file, '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Literaturliste</title><script src="/bundle.js"></script></head>'
    + '<body><main id="app"><h1>Literaturliste</h1><button id="app-button">App</button></main><script>' + APP_SCRIPT + '</script></body></html>');
  return stack.pageOrigin + '/' + basename(file);
}

// service: the normal server (join code) or the sandbox server.
// WebKit can keep Blobs in IndexedDB only in a persistent profile (an ephemeral context aborts the write), so there it is a persistent context in a temporary folder.
const persistent = [];
test.afterEach(async () => { while (persistent.length) { const p = persistent.pop(); await p.ctx.close().catch(() => {}); rmSync(p.dir, { recursive: true, force: true }); } });
async function newCtx(browser, { migrationTest = false, webdriver } = {}) {
  const options = { acceptDownloads: true, viewport: { width: 1100, height: 900 }, locale: 'en-US' };
  let ctx;
  if (browser.browserType().name() === 'webkit') {
    const dir = mkdtempSync(join(tmpdir(), 'wds-webkit-'));
    ctx = await browser.browserType().launchPersistentContext(dir, { ...(test.info().project.use.launchOptions || {}), ...options });
    persistent.push({ ctx, dir });
  } else ctx = await browser.newContext(options);
  await ctx.route('https://api.pwnedpasswords.com/range/*', (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n' }));
  if (migrationTest) await ctx.addInitScript(() => { window.__WDS_MIGRATION_TEST__ = true; });
  if (webdriver === false) await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); });
  return ctx;
}
// Opens the app page (a fresh load of the same URL) and connects the store.
async function openApp(ctx, url, target, { locale = 'en' } = {}) {
  const page = await ctx.newPage();
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push('pageerror: ' + e));
  page.on('console', (m) => { if (/wds:/.test(m.text())) console.log('[page] ' + m.text()); });
  await page.goto(url);
  await page.evaluate(({ scope, service, locale }) => { window.store = WDS.connect({ scope, baseUrl: service, locale }); window.setupApp(); }, { scope: target.scope, service: target.service, locale });
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

// The old Literaturliste: 3 references (numeric autoIncrement ids 1..3), ref 1 with the pdf 1, ref 2 points to a pdf that does not exist, ref 3 has none; 1 pdf; preferences in localStorage.
const PDF1 = { __blob: 'PDF-1.4 old pdf one %%EOF', type: 'application/pdf', name: 'eins.pdf' };
const OLD = {
  idb: [{ name: 'literatur', stores: [
    { name: 'refs', autoIncrement: true, rows: [
      { title: 'Alpha', authors: 'A. Author', year: 2001, pdfId: 1, pdfName: 'eins.pdf', created: '2024-03-01T10:00:00.000Z' },
      { title: 'Beta', authors: 'B. Author', year: 2002, pdfId: 99, pdfName: 'weg.pdf', created: '2024-03-02T10:00:00.000Z' },
      { title: 'Gamma', authors: 'C. Author', year: 2003, created: '2024-03-03T10:00:00.000Z' },
    ] },
    { name: 'pdfs', autoIncrement: true, rows: [{ name: 'eins.pdf', blob: PDF1 }] },
  ] }],
  local: { 'literaturliste.einstellungen': JSON.stringify({ theme: 'dark', sort: 'year', statsOpen: true, filter: '' }), 'other.app.key': 'keep me' },
};

// What the vault holds after the migration of OLD (tagged ids: <tag>-j1 ...).
async function vaultState(page) {
  return page.evaluate(async () => {
    const tag = localStorage.getItem('wds:migrate:literatur:tag');
    await refCol.load(); await pdfCol.load();
    const refs = await refCol.getAll(), pdfs = [];
    for (const e of pdfCol.items()) { const b = await store.getBlob(e.name); pdfs.push({ id: e.id, meta: e.meta, size: b.size, type: b.type, text: await b.text() }); }
    return { tag, refs: refs.map((r) => ({ id: r.id, meta: r.meta, value: r.value })), pdfs, records: (await store.list()).map((r) => r.name) };
  });
}

test('owner: the old data is copied, checked and deleted; references in both directions, a dead reference becomes null, the preferences key stays', async ({ browser, stack }) => {
  const ctx = await newCtx(browser);
  const url = appUrl(stack);
  const page = await openApp(ctx, url, stack);
  const accessId = await createVault(page, stack.joinCode);
  await seed(page, OLD);
  await start(page);
  await expect(dlgView(page)).toHaveAttribute('data-wds-view', 'migrate');
  await expect(dlgView(page)).not.toHaveAttribute('aria-busy', /.*/);
  await expect(dlgView(page)).toContainText('3 entries'.replace('3', '4'));
  const dl = page.waitForEvent('download');
  await wds(page, 'migrate-backup').click();
  expect((await dl).suggestedFilename()).toMatch(/^literatur-old-data-\d{4}-\d{2}-\d{2}\.zip$/);
  await wds(page, 'migrate-yes').click();
  const res = await finish(page);
  expect(res).toEqual({ status: 'migrated', deleted: 'deleted' });
  const st = await vaultState(page);
  expect(st.refs).toHaveLength(3);
  const byTitle = Object.fromEntries(st.refs.map((r) => [r.value.title, r]));
  expect(byTitle.Alpha.id).toBe(st.tag + '-j1');
  expect(byTitle.Alpha.value.pdfId).toBe(st.tag + '-j1.pdf');
  expect(byTitle.Alpha.value.pdfName).toBe('eins.pdf');
  expect(byTitle.Beta.value.pdfId).toBeNull();
  expect(byTitle.Beta.value.pdfName).toBeNull();
  expect(byTitle.Gamma.value.pdfId).toBeNull();
  expect(byTitle.Alpha.meta).toEqual({ title: 'Alpha' });
  expect(st.pdfs).toEqual([{ id: st.tag + '-j1.pdf', meta: { name: 'eins.pdf', ref: st.tag + '-j1' }, size: 25, type: 'application/pdf', text: 'PDF-1.4 old pdf one %%EOF' }]);
  expect(st.records).not.toContain('.wds/migration/literatur/' + st.tag);   // the marker is hidden from list()
  const old = await page.evaluate(() => window.oldState('literatur', ['refs', 'pdfs']));
  expect(old.stores).toEqual({ refs: 0, pdfs: 0 });
  expect(old.local).toEqual(OLD.local);   // personal preferences are not named in migrateLocal: never read, copied or deleted
  await expect(dlgView(page)).toHaveCount(0);
  await expect(page.locator('[data-wds-toast=migration]')).toContainText('4 entries are now in your vault');
  // a later start finds nothing
  const page2 = await openApp(ctx, url, stack);
  await unlock(page2, accessId);
  await start(page2);
  expect(await finish(page2)).toEqual({ status: 'nothing' });
  expect(page.problems).toEqual([]);
});

const yes = async (page) => { await expect(dlgView(page)).toHaveAttribute('data-wds-view', 'migrate'); await wds(page, 'migrate-yes').click(); };
const run = async (page) => { await start(page); await yes(page); return finish(page); };
async function ownerWithOld(browser, stack, target = stack, joinCode = stack.joinCode, ctxOpts) {
  const ctx = await newCtx(browser, ctxOpts);
  const url = appUrl(stack);
  const page = await openApp(ctx, url, target);
  const accessId = await createVault(page, joinCode);
  await seed(page, OLD);
  return { ctx, url, page, accessId, target };
}
async function reopen(o) { const page = await openApp(o.ctx, o.url, o.target); await unlock(page, o.accessId); return page; }
const oldCount = (page) => page.evaluate(() => window.oldState('literatur', ['refs', 'pdfs']));
const toastText = (page) => page.locator('[data-wds-toast=migration]').innerText();

test('a member is not asked: status skipped with a notice and a backup action, once per page; the old data stays', async ({ browser, stack }) => {
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
  expect(await finish(page)).toEqual({ status: 'skipped', why: 'not-owner' });
  await expect(dlgView(page)).toHaveCount(0);
  await expect(page.locator('[data-wds-toast=migration]')).toContainText('only be taken over into a vault of your own');
  const dl = page.waitForEvent('download');
  await page.locator('[data-wds-toast=migration] [data-wds=toast-action]').click();
  expect((await dl).suggestedFilename()).toMatch(/\.zip$/);
  await page.locator('[data-wds-toast=migration] [data-wds=toast-dismiss]').click();
  await start(page);
  expect((await finish(page)).status).toBe('skipped');
  await expect(page.locator('[data-wds-toast=migration]')).toHaveCount(0);   // not shown again in this page
  expect((await oldCount(page)).stores).toEqual({ refs: 3, pdfs: 1 });
  expect(await page.evaluate(() => store.list())).toEqual([]);
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

test('declined (Not now, Escape, close) writes nothing and asks again at the next start', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  await start(o.page);
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', 'migrate');
  await wds(o.page, 'migrate-no').click();
  expect(await finish(o.page)).toEqual({ status: 'declined' });
  expect(await o.page.evaluate(() => store.list())).toEqual([]);
  expect((await oldCount(o.page)).stores).toEqual({ refs: 3, pdfs: 1 });
  await start(o.page);                                     // Escape
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', 'migrate');
  await o.page.keyboard.press('Escape');
  expect((await finish(o.page)).status).toBe('declined');
  await start(o.page);                                     // the close button
  await wds(o.page, 'close').click();
  expect((await finish(o.page)).status).toBe('declined');
  const again = await run(o.page);                         // and the next start still offers it
  expect(again.status).toBe('migrated');
  expect(again.deleted).toBe('deleted');
});

test('sandbox: copies and keeps the old data; later starts ask nothing, show nothing and leave edits and deletions alone', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack, stack.sandbox, null);
  await start(o.page);
  await expect(dlgView(o.page)).toContainText('Sandbox: the old data stays in this browser');
  await wds(o.page, 'migrate-yes').click();
  expect(await finish(o.page)).toEqual({ status: 'migrated', deleted: 'kept' });
  await expect(o.page.locator('[data-wds-toast=migration]')).toContainText('Sandbox: the old data stays in this browser');
  expect((await oldCount(o.page)).stores).toEqual({ refs: 3, pdfs: 1 });
  // the person works with the new app: edits one entry and its settings, deletes another
  const alpha = await o.page.evaluate(async () => {
    await refCol.load();
    const a = refCol.items().find((e) => e.meta.title === 'Alpha'), g = refCol.items().find((e) => e.meta.title === 'Gamma');
    const v = await refCol.get(a.id);
    await refCol.set(a.id, { ...v, title: 'Alpha edited' });
    await refCol.remove(g.id);
    await store.set('settings', { theme: 'light', sort: 'title' });
    return a.id;
  });
  for (let i = 0; i < 3; i++) {
    const p = await reopen(o);
    await start(p);
    expect(await finish(p)).toEqual({ status: 'migrated', deleted: 'kept' });
    await expect(p.locator('dialog.wds-dialog')).toHaveCount(0);
    await expect(p.locator('[data-wds-toast=migration]')).toHaveCount(0);
    const now = await p.evaluate(async () => { await refCol.load(); return { titles: refCol.items().map((e) => e.meta.title).sort(), settings: await store.get('settings') }; });
    expect(now.titles).toEqual(['Alpha edited', 'Beta']);
    expect(now.settings).toEqual({ theme: 'light', sort: 'title' });
    await p.close();
  }
  expect(alpha).toMatch(/-j1$/);
});

test('sandbox with the test global in an automated browser deletes (the way wds-verify checks the delete); without webdriver the global is ignored', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack, stack.sandbox, null, { migrationTest: true });
  expect(await o.page.evaluate(() => navigator.webdriver)).toBe(true);
  expect(await run(o.page)).toEqual({ status: 'migrated', deleted: 'deleted' });
  expect((await oldCount(o.page)).stores).toEqual({ refs: 0, pdfs: 0 });
  const p = await newCtx(browser, { migrationTest: true, webdriver: false });
  const url = appUrl(stack), page = await openApp(p, url, stack.sandbox);
  await createVault(page, null);
  await seed(page, OLD);
  expect(await page.evaluate(() => navigator.webdriver)).toBe(false);
  const res = await run(page);
  expect(res.deleted).toBe('kept');
  expect((await oldCount(page)).stores).toEqual({ refs: 3, pdfs: 1 });
});

test('crash between copy and delete: the next start deletes without asking and without copying again', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack, stack.sandbox, null);
  expect((await run(o.page)).deleted).toBe('kept');               // marker written, old data still there: the state after a crash before the delete
  const p = await reopen(o);
  await p.evaluate(() => { window.__WDS_MIGRATION_TEST__ = true; });   // now the sandbox rule is lifted (automated browser)
  await start(p);
  expect(await finish(p)).toEqual({ status: 'migrated', deleted: 'deleted' });
  await expect(p.locator('dialog.wds-dialog')).toHaveCount(0);
  await expect(p.locator('[data-wds-toast=migration]')).toContainText('already copied');
  expect((await oldCount(p)).stores).toEqual({ refs: 0, pdfs: 0 });
});

test('an interrupted run (connection lost after two writes) continues: what was copied is recognised, the rest written', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  let puts = 0;
  await o.page.route(/\/records\//, (route) => { if (route.request().method() === 'PUT' && ++puts > 2) return route.abort('failed'); return route.continue(); });
  await start(o.page);
  await yes(o.page);
  const first = await finish(o.page);
  expect(first.status).toBe('failed');
  expect(first.why).toMatch(/offline/i);
  expect((await oldCount(o.page)).stores).toEqual({ refs: 3, pdfs: 1 });
  await o.page.close();
  const p = await reopen(o);
  const second = await run(p);
  expect(second.status).toBe('migrated');
  expect(second.deleted).toBe('deleted');
  const st = await vaultState(p);
  expect(st.refs).toHaveLength(3);
  expect(st.pdfs).toHaveLength(1);
});

test('a shared record that the vault holds with other content: the old value is written as "<name>~<tag>-<hash>", listed in result.copies and kept in the export', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  await o.page.evaluate(() => {
    const baseMap = window.MIGRATION.map;
    window.MIGRATION = { ...window.MIGRATION, localStorage: { keys: ['literaturliste.einstellungen'] }, map(old, h) {
      return { items: baseMap(old, h).items, records: [{ name: 'units', value: { unit: old.json('literaturliste.einstellungen').sort }, from: 'literaturliste.einstellungen' }] };
    } };
  });
  await o.page.evaluate(() => store.set('units', { unit: 'cm' }));   // the app wrote the record before the person agreed
  const res = await run(o.page);
  const tag = await o.page.evaluate(() => localStorage.getItem('wds:migrate:literatur:tag'));
  expect(res).toEqual({ status: 'migrated', deleted: 'deleted', copies: [expect.stringMatching(new RegExp('^units~' + tag + '-[0-9a-f]{6}$'))] });
  expect(await o.page.evaluate(() => store.get('units'))).toEqual({ unit: 'cm' });            // nothing is overwritten
  expect(await o.page.evaluate((n) => store.get(n), res.copies[0])).toEqual({ unit: 'year' });   // the old value is kept next to it, and the app can learn its name
  await expect(o.page.locator('[data-wds-toast=migration]')).toContainText('Entries that already existed in your vault with other content: 1');
  expect((await oldCount(o.page)).local).toEqual({ 'other.app.key': 'keep me' });
});

test('old data changed while the question was open: nothing is deleted ("changed"); the next start copies the rest', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  await start(o.page);
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', 'migrate');
  await o.page.evaluate(() => window.mutateOld('literatur', 'refs', (os) => os.add({ title: 'Delta', authors: 'D. Author', year: 2004, created: '2024-03-04T10:00:00.000Z' })));
  await wds(o.page, 'migrate-yes').click();
  const first = await finish(o.page);
  expect(first).toEqual({ status: 'migrated', deleted: 'changed' });
  await expect(o.page.locator('[data-wds-toast=migration]')).toContainText('used again in the meantime');
  expect((await oldCount(o.page)).stores).toEqual({ refs: 4, pdfs: 1 });
  const p = await reopen(o);
  const second = await run(p);
  expect(second).toEqual({ status: 'migrated', deleted: 'deleted' });
  expect((await vaultState(p)).refs.map((r) => r.value.title).sort()).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
  expect((await oldCount(p)).stores).toEqual({ refs: 0, pdfs: 0 });
});

test('a file replaced by one of the same size with other bytes while the question was open is noticed', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  await start(o.page);
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', 'migrate');
  await o.page.evaluate(() => window.mutateOld('literatur', 'pdfs', (os) => os.put({ name: 'eins.pdf', blob: new File([new TextEncoder().encode('PDF-1.4 NEW pdf one ##EOF')], 'eins.pdf', { type: 'application/pdf' }) }, 1)));
  await wds(o.page, 'migrate-yes').click();
  const res = await finish(o.page);
  if (res.status === 'migrated') expect(['changed', 'kept']).toContain(res.deleted);
  else expect(res.status).toBe('failed');   // Firefox cannot read the replaced file any more and stops: safe as well
  const rows = await o.page.evaluate(() => window.rawStore('literatur', 'pdfs').then((r) => r[0].value.blob.text()));
  expect(rows).toBe('PDF-1.4 NEW pdf one ##EOF');
});

// An entry that was copied, then changed in the old app: the next start finds it different in the vault.
async function differsSetup(browser, stack) {
  const o = await ownerWithOld(browser, stack);
  await start(o.page);
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', 'migrate');
  await o.page.evaluate(() => window.mutateOld('literatur', 'refs', (os) => os.put({ title: 'Alpha changed in the old app', authors: 'A. Author', year: 2001, pdfId: 1, pdfName: 'eins.pdf', created: '2024-03-01T10:00:00.000Z' }, 1)));
  await wds(o.page, 'migrate-yes').click();
  expect((await finish(o.page)).deleted).toBe('changed');
  const p = await reopen(o);
  await start(p);
  return { o, p, tag: await p.evaluate(() => localStorage.getItem('wds:migrate:literatur:tag')) };
}
const copyId = (tag) => new RegExp('^refs/' + tag + '-j1~' + tag + '-[0-9a-f]{6}$');
test('an entry that differs from the vault is written next to it as "<id>~<tag>-<hash>" without a question; it counts as copied and the old data is deleted', async ({ browser, stack }) => {
  const { p } = await differsSetup(browser, stack);
  await yes(p);
  const res = await finish(p);
  const st = await vaultState(p);
  expect(res).toEqual({ status: 'migrated', deleted: 'deleted', copies: [expect.stringMatching(copyId(st.tag))] });
  expect(st.refs.map((r) => r.value.title).sort()).toEqual(['Alpha', 'Alpha changed in the old app', 'Beta', 'Gamma']);
  expect(st.refs.find((r) => r.value.title.endsWith('old app')).id).toMatch(new RegExp('^' + st.tag + '-j1~' + st.tag + '-[0-9a-f]{6}$'));
  await expect(p.locator('[data-wds-toast=migration]')).toContainText('Entries that already existed in your vault with other content: 1');
  expect((await oldCount(p)).stores).toEqual({ refs: 0, pdfs: 0 });
});
test('an entry that differs a second time with other content gets a second copy: migrated, never stuck on partial', async ({ browser, stack }) => {
  const { o, p } = await differsSetup(browser, stack);
  await expect(dlgView(p)).toHaveAttribute('data-wds-view', 'migrate');   // the snapshot of the old data is taken
  await p.evaluate(() => window.mutateOld('literatur', 'refs', (os) => os.put({ title: 'Alpha changed twice', authors: 'A. Author', year: 2001, pdfId: 1, pdfName: 'eins.pdf', created: '2024-03-01T10:00:00.000Z' }, 1)));   // while the question is open
  await yes(p);
  expect((await finish(p)).deleted).toBe('changed');
  const p2 = await reopen(o);
  const res = await run(p2);
  expect(res).toMatchObject({ status: 'migrated', deleted: 'deleted' });
  const st = await vaultState(p2);
  expect(st.refs.map((r) => r.value.title).sort()).toEqual(['Alpha', 'Alpha changed in the old app', 'Alpha changed twice', 'Beta', 'Gamma']);
  expect((await oldCount(p2)).stores).toEqual({ refs: 0, pdfs: 0 });
});

async function limitedScope(stack, slug, limits) {
  const r = await api(stack, 'POST', '/admin/scopes', { auth: operatorAuth(stack), json: { slug, name: slug, enrollment: 'join_code', join_code: null, hibp: false, limits } });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { scope: r.json.scope, service: stack.service, joinCode: r.json.join_code };
}
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
const BIG = (n, seed, name) => ({ __bytes: n, seed, name, type: 'application/pdf' });
test('entries that are too large, or do not fit, become downloads; the old data stays until the person decides; references to them become null', async ({ browser, stack }) => {
  const target = await limitedScope(stack, 'migratelimit', { max_value_bytes: 1 * MIB, vault_bytes: 3 * MIB });
  const ctx = await newCtx(browser), url = appUrl(stack), page = await openApp(ctx, url, target);
  const accessId = await createVault(page, target.joinCode);
  await seed(page, { idb: [{ name: 'literatur', stores: [
    { name: 'refs', autoIncrement: true, rows: [{ title: 'With big', pdfId: 1, pdfName: 'big.pdf' }, { title: 'With medium', pdfId: 2, pdfName: 'm.pdf' }, { title: 'Plain' }] },
    { name: 'pdfs', autoIncrement: true, rows: [{ name: 'big.pdf', blob: BIG(1200000, 1, 'big.pdf') }, { name: 'm.pdf', blob: BIG(900000, 2, 'm.pdf') }] },
  ] }] });
  await start(page);
  await expect(dlgView(page)).toContainText('1 of them cannot be copied');
  await wds(page, 'migrate-yes').click();
  await expect(dlgView(page)).toHaveAttribute('data-wds-view', 'migrate-large');
  await expect(wds(page, 'migrate-delete')).toBeDisabled();
  const dl = page.waitForEvent('download');
  await wds(page, 'migrate-large-download').click();
  const zip = await dl;
  expect(zip.suggestedFilename()).toBe('literatur-too-large.zip');
  const files = zipEntries(readFileSync(await zip.path()));
  expect(Object.keys(files)).toEqual(['big.pdf']);
  expect(files['big.pdf'].length).toBe(1200000);
  await expect(wds(page, 'migrate-delete')).toBeEnabled();     // the files were handed over
  await wds(page, 'migrate-keep').click();
  expect(await finish(page)).toEqual({ status: 'partial', why: 'too-large' });
  const st = await vaultState(page);
  expect(st.refs.find((r) => r.value.title === 'With big').value.pdfId).toBeNull();
  expect(st.refs.find((r) => r.value.title === 'With medium').value.pdfId).toMatch(/-j2\.pdf$/);
  expect(st.pdfs).toHaveLength(1);
  expect((await page.evaluate(() => window.oldState('literatur', ['refs', 'pdfs']))).stores).toEqual({ refs: 3, pdfs: 2 });
  // the next start asks about the file that is left; the delete waits for the download
  const p = await openApp(ctx, url, target); await unlock(p, accessId);
  await start(p); await yes(p);
  await expect(dlgView(p)).toHaveAttribute('data-wds-view', 'migrate-large');
  await expect(wds(p, 'migrate-delete')).toBeDisabled();
  await wds(p, 'migrate-large-download').click();
  await wds(p, 'migrate-delete').click();
  expect(await finish(p)).toEqual({ status: 'migrated', deleted: 'deleted' });
  expect((await p.evaluate(() => window.oldState('literatur', ['refs', 'pdfs']))).stores).toEqual({ refs: 0, pdfs: 0 });
});

test('a vault that is too full for everything: the largest files are left out first, nothing fails for size', async ({ browser, stack }) => {
  const target = await limitedScope(stack, 'migrateroom', { max_value_bytes: 2 * MIB, vault_bytes: 1.5 * MIB });
  const ctx = await newCtx(browser), page = await openApp(ctx, appUrl(stack), target);
  await createVault(page, target.joinCode);
  await seed(page, { idb: [{ name: 'literatur', stores: [
    { name: 'refs', autoIncrement: true, rows: [{ title: 'One', pdfId: 1 }, { title: 'Two', pdfId: 2 }, { title: 'Three', pdfId: 3 }] },
    { name: 'pdfs', autoIncrement: true, rows: [{ name: 'a.pdf', blob: BIG(500000, 1, 'a.pdf') }, { name: 'b.pdf', blob: BIG(900000, 2, 'b.pdf') }, { name: 'c.pdf', blob: BIG(1100000, 3, 'c.pdf') }] },
  ] }] });
  await start(page); await yes(page);
  await expect(dlgView(page)).toHaveAttribute('data-wds-view', 'migrate-large');
  await expect(dlgView(page).locator('li')).toHaveCount(2);   // the 1.1 MB and the 0.9 MB file
  const dl = page.waitForEvent('download');
  await wds(page, 'migrate-large-download').click();
  const files = zipEntries(readFileSync(await (await dl).path()));
  expect(Object.values(files).map((b) => b.length).sort((a, b) => a - b)).toEqual([900000, 1100000]);
  await wds(page, 'migrate-keep').click();
  expect(await finish(page)).toEqual({ status: 'partial', why: 'too-large' });
  const st = await vaultState(page);
  expect(st.pdfs.map((x) => x.size)).toEqual([500000]);
  expect(st.refs.map((r) => r.value.pdfId).filter(Boolean)).toHaveLength(1);
});

test('two browsers with the same old ids get two copies: the ids carry the tag of the browser', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  expect((await run(o.page)).status).toBe('migrated');
  const ctx2 = await newCtx(browser), url2 = appUrl(stack), p2 = await openApp(ctx2, url2, stack);
  await unlock(p2, o.accessId);
  await seed(p2, OLD);
  expect((await run(p2)).status).toBe('migrated');
  const st = await vaultState(p2);
  expect(st.refs).toHaveLength(6);
  expect(new Set(st.refs.map((r) => r.id)).size).toBe(6);
});

test('a key-value store and a localStorage prefix: records, keys as ids, several keys claimed with one "from"', async ({ browser, stack }) => {
  const ctx = await newCtx(browser), page = await openApp(ctx, appUrl(stack), stack);
  await createVault(page, stack.joinCode);
  await seed(page, { idb: [{ name: 'kvdb', stores: [{ name: 'meta', kv: [['timer', { running: true, since: 5 }], ['lang', 'de']] }] }], local: { 'zn.a': '1', 'zn.b': '2', 'zn.c': '3', 'unrelated': 'x', 'zr.d': '4' } });
  await page.evaluate(() => {
    window.MIGRATION = {
      id: 'kv', indexedDB: { name: 'kvdb', stores: ['meta'] }, localStorage: { prefixes: ['zn.'] },
      map(old, h) {
        const records = old.rows('meta').map((row) => ({ name: 'kv-' + row.key, value: row.value, from: row }));
        const keys = Object.keys(old.local).filter((k) => k.startsWith('zn.'));
        records.push({ name: 'zn-all', value: Object.fromEntries(keys.map((k) => [k, old.local[k]])), from: keys });
        return { records };
      },
    };
  });
  const res = await run(page);
  expect(res).toEqual({ status: 'migrated', deleted: 'deleted' });
  expect(await page.evaluate(async () => ({ timer: await store.get('kv-timer'), lang: await store.get('kv-lang'), zn: await store.get('zn-all') }))).toEqual({ timer: { running: true, since: 5 }, lang: 'de', zn: { 'zn.a': '1', 'zn.b': '2', 'zn.c': '3' } });
  const left = await page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k.startsWith('wds:')) o[k] = localStorage.getItem(k); } return o; });
  expect(left).toEqual({ unrelated: 'x', 'zr.d': '4' });
});

test('map errors: nothing is written and nothing is deleted; mistakes of the app are results ("failed") with a message that says what to change; only wrong options reject', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  const base = (body) => page_eval(o.page, body);
  async function page_eval(page, src) {
    return page.evaluate(async (src) => {
      const orig = window.MIGRATION;
      window.MIGRATION = { ...orig, map: eval('(' + src + ')') };
      try { return { result: await store.migrateLocal(window.MIGRATION) }; } catch (e) { return { rejected: e.name + ': ' + e.message }; } finally { window.MIGRATION = orig; }
    }, src);
  }
  const throwing = await base('(old, h) => { throw new Error("boom"); }');
  expect(throwing.result).toEqual({ status: 'failed', why: 'map threw: boom' });
  const settings = await base('(old, h) => ({ settings: { record: "settings", value: { theme: "dark" }, from: "literaturliste.einstellungen" } })');
  expect(settings.result.status).toBe('failed');
  expect(settings.result.why).toBe('map returned "settings": personal preferences stay in localStorage and are not named in migrateLocal; shared values are a record');
  const unclaimed = await base('(old, h) => ({ items: old.rows("refs").slice(0, 1).map((row) => ({ col: refCol, id: h.id(row.key), value: { title: "x" }, from: row })) })');
  expect(unclaimed.result.status).toBe('failed');
  expect(unclaimed.result.why).toMatch(/^3 old row\(s\) were neither copied nor skipped/);
  const noFrom = await base('(old, h) => ({ items: [{ col: refCol, id: "x", value: { title: "x" } }] })');
  expect(noFrom.result.status).toBe('failed');
  expect(noFrom.result.why).toMatch(/^items\[0\] \("refs\/x"\): "from" is missing/);
  const random = await base('(old, h) => ({ items: old.rows("refs").map((row) => ({ col: refCol, id: Math.random().toString(36).slice(2), value: { title: "x" }, from: row })).concat(old.rows("pdfs").map((row) => ({ col: pdfCol, id: h.id(row.key), value: h.blob(row.value), from: row }))) })');
  expect(random.result.status).toBe('failed');
  expect(random.result.why).toMatch(/^map gave different results when it ran twice/);
  const dup = await base('(old, h) => ({ items: old.rows("refs").map((row) => ({ col: refCol, id: "same", value: { title: "x" }, from: row })) })');
  expect(dup.result.status).toBe('failed');
  expect(dup.result.why).toMatch(/two entries would get the same name "refs\/same"/);
  const deadRef = await base('(old, h) => ({ items: old.rows("refs").map((row) => ({ col: refCol, id: h.id(row.key), value: { title: "x", pdf: h.ref("pdfs", row.value.pdfId, ".pdf") }, from: row })).concat(old.rows("pdfs").map((row) => ({ col: pdfCol, id: h.id(row.key), value: h.blob(row.value), from: row }))) })');
  expect(deadRef.result.status).toBe('failed');
  expect(deadRef.result.why).toMatch(/^h\.ref returned ".*-j1.pdf", but no item has this id/);
  const nested = await base('(old, h) => ({ items: old.rows("refs").map((row) => ({ col: refCol, id: h.id(row.key), value: { title: "x", file: new Blob(["x"]) }, from: row })) })');
  expect(nested.result.status).toBe('failed');
  expect(nested.result.why).toMatch(/contains a Blob\/File inside a JSON value/);
  const notCol = await base('(old, h) => ({ items: [{ col: {}, id: "x", value: 1, from: old.rows("refs")[0] }] })');
  expect(notCol.result.why).toMatch(/^items\[0\]: col must be a collection/);
  const inCol = await base('(old, h) => ({ records: [{ name: "refs/oops", value: 1, from: old.rows("refs")[0] }] })');
  expect(inCol.result.why).toMatch(/lies inside the collection "refs\/"/);
  const reserved = await base('(old, h) => ({ records: [{ name: ".wds/x", value: 1, from: old.rows("refs")[0] }] })');
  expect(reserved.result.why).toMatch(/record names starting with ".wds\/" are reserved/);
  const badStore = await base('(old, h) => ({ items: old.rows("nope") })');
  expect(badStore.result.why).toMatch(/old\.rows\("nope"\): not a configured store/);
  // a mistake that depends on one user's data (an id with a slash) is a result as well: the page must still start
  const slashId = await base('(old, h) => ({ items: old.rows("refs").map((row) => ({ col: refCol, id: "a/b", value: { title: "x" }, from: row })) })');
  expect(slashId.result.status).toBe('failed');
  expect(slashId.result.why).toMatch(/id must be a string of 1 to 200 characters without "\/"/);
  const sameKeys = await base('(old, h) => ({ items: old.rows("refs").map((row) => ({ col: refCol, id: "n", value: { title: "x" }, from: row })) })');
  expect(sameKeys.result.why).toMatch(/If two stores share keys .* h\.id\(\["notes", row\.key\]\)/);
  // wrong options: before anything happens
  const opts = await o.page.evaluate(async () => {
    const tries = [{}, { id: 'Bad Id', map() {}, localStorage: { keys: ['a'] } }, { id: 'x', map() {} }, { id: 'x', map() {}, localStorage: { prefixes: [''] } }, { id: 'x', map() {}, localStorage: { prefixes: ['wds:x'] } },
      { id: 'x', map() {}, indexedDB: [{ name: 'a', stores: ['s'] }, { name: 'a', stores: ['t'] }] }, { id: 'x', map() {}, indexedDB: { name: 'a', stores: ['s', 's'] } },
      { id: 'x', map() {}, localStorage: { keys: ['a'] }, applySettings() {} }, { id: 'x', map() {}, localStorage: { keys: ['a'] }, tagged: false }, { id: 'x', map() {}, localStorage: { keys: ['a'] }, texts: {} }];
    const out = [];
    for (const t of tries) { try { await store.migrateLocal(t); out.push('no error'); } catch (e) { out.push(e.name + ': ' + e.message.slice(0, 70)); } }
    return out;
  });
  expect(opts.every((s) => s.startsWith('UsageError'))).toBe(true);
  expect(opts[7]).toMatch(/applySettings/);
  expect(opts[8]).toMatch(/unknown option "tagged"/);
  expect(opts[9]).toMatch(/unknown option "texts"/);
  expect((await oldCount(o.page)).stores).toEqual({ refs: 3, pdfs: 1 });
  expect(await o.page.evaluate(() => store.list())).toEqual([]);
  await expect(o.page.locator('dialog.wds-dialog')).toHaveCount(0);
});

test('two tabs: one migrates, the other gets "busy" at once and loads normally', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  await start(o.page);
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', 'migrate');
  const p2 = await openApp(o.ctx, o.url, o.target);
  await start(p2);
  expect(await finish(p2)).toEqual({ status: 'busy' });
  await expect(p2.locator('dialog.wds-dialog')).toHaveCount(0);
  await wds(o.page, 'migrate-yes').click();
  expect((await finish(o.page)).status).toBe('migrated');
});

test('the backup is a ZIP with data.json and every file; Blobs and Dates are described, the localStorage text is there', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  await o.page.evaluate(() => { const base = window.MIGRATION.map; window.MIGRATION = { ...window.MIGRATION, localStorage: { keys: ['literaturliste.einstellungen'] }, map(old, h) { h.skip('literaturliste.einstellungen', 'a preference'); return base(old, h); } }; });
  await start(o.page);
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', 'migrate');
  const dl = o.page.waitForEvent('download');
  await wds(o.page, 'migrate-backup').click();
  const entries = zipEntries(readFileSync(await (await dl).path()));
  expect(Object.keys(entries).sort()).toEqual(['data.json', 'files/0001-eins.pdf']);
  const doc = JSON.parse(entries['data.json'].toString());
  expect(doc.app).toBe('literatur');
  expect(doc.indexedDB.literatur.refs).toHaveLength(3);
  expect(doc.indexedDB.literatur.refs[0]).toMatchObject({ key: 1, value: { title: 'Alpha', pdfId: 1 } });
  expect(doc.indexedDB.literatur.pdfs[0].value.blob).toEqual({ $file: 'files/0001-eins.pdf', size: 25, type: 'application/pdf', name: 'eins.pdf' });
  expect(doc.local['literaturliste.einstellungen']).toContain('"theme":"dark"');
  expect(entries['files/0001-eins.pdf'].toString()).toBe('PDF-1.4 old pdf one %%EOF');
  await wds(o.page, 'migrate-no').click();
  await finish(o.page);
});

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

test('German by locale; the dialog names stay', async ({ browser, stack }) => {
  const ctx = await newCtx(browser), url = appUrl(stack), page = await openApp(ctx, url, stack, { locale: 'de' });
  await createVault(page, stack.joinCode);
  await seed(page, OLD);
  await start(page);
  await expect(dlgView(page)).toHaveAttribute('data-wds-view', 'migrate');
  await expect(dlgView(page).locator('h2')).toHaveText('Daten der früheren Version übernehmen');
  await expect(dlgView(page)).toContainText('In diesem Browser liegen 4 Einträge aus einer früheren Version dieser App, unverschlüsselt und nur auf diesem Gerät.');
  await expect(wds(page, 'migrate-yes')).toHaveText('Übernehmen');
  await expect(wds(page, 'migrate-no')).toHaveText('Später');
  await expect(wds(page, 'migrate-backup')).toHaveText('Sicherung herunterladen (nicht verschlüsselt)');
  mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'migrate-de.png') });
  await wds(page, 'migrate-yes').click();
  expect((await finish(page)).status).toBe('migrated');
  await expect(page.locator('[data-wds-toast=migration]')).toContainText('4 Einträge sind jetzt in Ihrem Tresor');
});

test('the session ends during the copy: the run stops with "locked", nothing is deleted, the next start continues', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  await o.page.route(/\/records\//, async (route) => { if (route.request().method() === 'PUT') await new Promise((r) => setTimeout(r, 400)); return route.continue(); });
  await start(o.page);
  await yes(o.page);
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', 'progress');
  await o.page.evaluate(() => store.lock());
  const res = await finish(o.page);
  expect(res.status).toBe('failed');
  expect(res.why).toMatch(/^locked/);
  expect((await oldCount(o.page)).stores).toEqual({ refs: 3, pdfs: 1 });
  await expect(o.page.locator('[data-wds-toast=migration]')).toHaveCount(0);
  await o.page.close();
  const p = await reopen(o);
  expect((await run(p)).status).toBe('migrated');
  expect((await oldCount(p)).stores).toEqual({ refs: 0, pdfs: 0 });
});

// ---- round F, review fixes ----
const setMap = (page, src) => page.evaluate((src) => { window.MIGRATION = { ...window.MIGRATION, map: eval('(' + src + ')') }; }, src);

test('map may change the rows it is given (also in a classic script): the copy gets the change, the old rows are not touched', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack, stack.sandbox, null);
  await setMap(o.page, '(old, h) => ({ items: old.rows("refs").map(function (row) { var v = row.value; v.title = v.title + "!"; v.extra = 1; return { col: refCol, id: h.id(row.key), value: v, from: row }; }).concat(old.rows("pdfs").map((row) => ({ col: pdfCol, id: h.id(row.key, ".pdf"), value: h.blob(row.value), from: row }))) })');
  const res = await run(o.page);
  expect(res).toEqual({ status: 'migrated', deleted: 'kept' });
  const st = await vaultState(o.page);
  expect(st.refs.map((r) => r.value.title).sort()).toEqual(['Alpha!', 'Beta!', 'Gamma!']);
  expect(st.refs.every((r) => r.value.extra === 1)).toBe(true);
  const raw = await o.page.evaluate(() => window.rawStore('literatur', 'refs'));
  expect(raw.map((r) => r.value.title).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
  expect(raw[0].value.extra).toBeUndefined();
});

test('only a personal preference exists in localStorage: it is not named in migrateLocal, so there is nothing to take over and the key stays', async ({ browser, stack }) => {
  const ctx = await newCtx(browser), page = await openApp(ctx, appUrl(stack), stack);
  await seed(page, { local: OLD.local });
  await start(page);
  expect(await finish(page)).toEqual({ status: 'nothing' });
  await expect(dlgView(page)).toHaveCount(0);
  expect((await oldCount(page)).local).toEqual(OLD.local);
});

// A map that skips the pdf rows: they are deleted with the old data, so the person has to say that this is fine.
const SKIP_PDFS = '(old, h) => ({ items: old.rows("refs").map((row) => ({ col: refCol, id: h.id(row.key), value: { title: row.value.title }, from: row })).concat(old.rows("pdfs").map((row) => { h.skip(row, "a cache"); return null; }).filter(Boolean)) })';
test('rows that map skips are deleted with the old data: Take over waits for the box or the backup, and the skipped rows are in the backup', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  await setMap(o.page, SKIP_PDFS);
  await start(o.page);
  await expect(dlgView(o.page)).toHaveAttribute('data-wds-view', 'migrate');
  await expect(dlgView(o.page)).toContainText('1 entries are not taken over');
  await expect(dlgView(o.page)).toContainText('deleted with the rest of the old data');
  await expect(wds(o.page, 'migrate-yes')).toBeDisabled();
  const dl = o.page.waitForEvent('download');
  await wds(o.page, 'migrate-backup').click();
  await dl;
  await expect(wds(o.page, 'migrate-yes')).toBeEnabled();           // the backup counts as the confirmation
  await wds(o.page, 'migrate-no').click();
  expect((await finish(o.page)).status).toBe('declined');
  await start(o.page);
  await expect(wds(o.page, 'migrate-yes')).toBeDisabled();
  await wds(o.page, 'migrate-skip-ack').check();
  await expect(wds(o.page, 'migrate-yes')).toBeEnabled();
  await wds(o.page, 'migrate-yes').click();
  expect(await finish(o.page)).toEqual({ status: 'migrated', deleted: 'deleted' });
  expect((await oldCount(o.page)).stores).toEqual({ refs: 0, pdfs: 0 });
});

test('a failed run offers the backup in its notice; nothing is deleted', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack);
  await setMap(o.page, '(old, h) => { throw new Error("boom"); }');
  await start(o.page);
  expect(await finish(o.page)).toEqual({ status: 'failed', why: 'map threw: boom' });
  const toast = o.page.locator('[data-wds-toast=migration]');
  await expect(toast).toContainText('Nothing was deleted');
  const dl = o.page.waitForEvent('download');
  await toast.locator('[data-wds=toast-action]').click();
  expect((await dl).suggestedFilename()).toMatch(/^literatur-old-data-.*\.zip$/);
  expect((await oldCount(o.page)).stores).toEqual({ refs: 3, pdfs: 1 });
});

test('a changed map is not ignored: entries that map now makes differently are asked about again (sandbox keeps the old data)', async ({ browser, stack }) => {
  const o = await ownerWithOld(browser, stack, stack.sandbox, null);
  expect((await run(o.page)).status).toBe('migrated');
  const p = await reopen(o);
  await setMap(p, '(old, h) => ({ items: old.rows("refs").map((row) => ({ col: refCol, id: h.id(row.key), value: { title: row.value.title + " (fixed)" }, from: row })).concat(old.rows("pdfs").map((row) => ({ col: pdfCol, id: h.id(row.key, ".pdf"), value: h.blob(row.value), from: row }))) })');
  await start(p);
  await expect(dlgView(p)).toHaveAttribute('data-wds-view', 'migrate');
  await expect(dlgView(p)).toContainText('4 entries');           // the references and the file (its meta changed) are made differently now
  await wds(p, 'migrate-no').click();
  expect((await finish(p)).status).toBe('declined');
});

test('one localStorage key that holds many entries: after one more entry appears in it, only that entry is new', async ({ browser, stack }) => {
  const ctx = await newCtx(browser), url = appUrl(stack), page = await openApp(ctx, url, stack.sandbox);
  const accessId = await createVault(page, null);
  const DOC = (items) => JSON.stringify({ items });
  await seed(page, { local: { 'zn.data': DOC([{ id: 1, name: 'one' }, { id: 2, name: 'two' }]) } });
  await page.evaluate(() => {
    window.entCol = store.collection('ent/');
    window.MIGRATION = { id: 'zn', localStorage: { keys: ['zn.data'] }, map(old, h) { const d = old.json('zn.data'); return { items: d.items.map((x) => ({ col: entCol, id: h.id(x.id), value: x, from: 'zn.data' })) }; } };
  });
  const first = await run(page);
  expect(first).toEqual({ status: 'migrated', deleted: 'kept' });
  await page.evaluate(async () => { await entCol.load(); const e = entCol.items()[0]; await entCol.set(e.id, { id: 1, name: 'edited in the new app' }); });
  const edited = await page.evaluate(async () => (await entCol.getAll()).map((x) => x.value.name).sort());
  // the old app adds a third entry
  const p2 = await openApp(ctx, url, stack.sandbox);
  await unlock(p2, accessId);
  await p2.evaluate((doc) => { localStorage.setItem('zn.data', doc); }, DOC([{ id: 1, name: 'one' }, { id: 2, name: 'two' }, { id: 3, name: 'three' }]));
  await p2.evaluate(() => {
    window.entCol = store.collection('ent/');
    window.MIGRATION = { id: 'zn', localStorage: { keys: ['zn.data'] }, map(old, h) { const d = old.json('zn.data'); return { items: d.items.map((x) => ({ col: entCol, id: h.id(x.id), value: x, from: 'zn.data' })) }; } };
  });
  await start(p2);
  await expect(dlgView(p2)).toHaveAttribute('data-wds-view', 'migrate');
  await expect(dlgView(p2)).toContainText('1 entries');
  await wds(p2, 'migrate-yes').click();
  expect((await finish(p2)).status).toBe('migrated');
  const names = await p2.evaluate(async () => { await entCol.load(); return (await entCol.getAll()).map((x) => x.value.name).sort(); });
  expect(names).toEqual([...edited, 'three'].sort());
});
