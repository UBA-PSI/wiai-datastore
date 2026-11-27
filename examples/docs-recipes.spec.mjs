// Tests of the code blocks of docs/site/integration.md and docs/site/porting.md, against the REAL server and the REAL bundle (scripts/test-examples.sh).
// Every block is taken from the served document (by its heading), put into a page that carries the documented Content-Security-Policy and script tag,
// and run from a file:// page. Nothing here re-types a block: if the document changes, the test runs the new text.
//  - integration.md: the public API of the store (exactly the documented names), autosave, collections (several devices, the focus check, onChange), files (add, delete in
//    reverse order, download link), conflicts in code (one handler, an if on c.name), a library dialog above a modal dialog of the app, the example app of section 12 and the
//    wds-verify.json of section 10 under wds-verify (mock and sandbox),
//  - porting.md: the import of an old export, the store.migrateLocal block against a seeded old database (real server: migrated and deleted; sandbox: kept), the seed block,
//  - every code block of both documents is accounted for (run, or syntax-checked), so that a new block cannot slip in untested,
//  - the documents: no placeholder left, the repository named, links resolve.
// The safety properties of the migration itself (interrupted runs, changed rows, differing entries, two tabs, ...) are tested by client/test/migrate.spec.mjs.
// Run with scripts/test-examples.sh (Chromium; WDS_BROWSERS=chromium,firefox,webkit for more).
import { test as base, expect } from '../client/node_modules/@playwright/test/index.mjs';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startStack, startSandboxServer, SANDBOX_ID, ROOT } from '../client/test/integration-env.mjs';
import { parseConfig } from '../tools/lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PASS = 'purple-elephant-marching-slowly';

// ---------------------------------------------------------------------------------------------------------------------------
// the stack: the real server with the documentation (public_base set), and a second server with a [sandbox] section for the sandbox cases

const test = base.extend({
  stack: [async ({}, use) => {
    const stack = await startStack();
    stack.docs = await stack.startServer({ publicBase: true });
    stack.sandbox = await startSandboxServer(stack);
    stack.pages = join(stack.tmp, 'recipe-pages');
    mkdirSync(stack.pages, { recursive: true });
    try { await use(stack); } finally { await stack.sandbox.stop(); await stack.stop(); }
  }, { scope: 'worker' }],
  md: [async ({ stack }, use) => {
    const r = await fetch(stack.docs.origin + '/datastore/docs/integration.md');
    expect(r.status).toBe(200);
    await use(await r.text());
  }, { scope: 'worker' }],
  porting: [async ({ stack }, use) => {
    const r = await fetch(stack.docs.origin + '/datastore/docs/porting.md');
    expect(r.status).toBe(200);
    await use(await r.text());
  }, { scope: 'worker' }],
});
test.setTimeout(240000);

// ---------------------------------------------------------------------------------------------------------------------------
// the document: code blocks by heading

// The n-th fenced block of the given language after the first line that matches heading (a RegExp), up to the next heading of the same or a higher level.
function blockAfter(md, heading, lang, n = 0) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) throw new Error('no heading ' + heading + ' in the document');
  const level = lines[start].match(/^#+/)[0].length;
  const blocks = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#+) /);
    if (h && h[1].length <= level) break;
    const f = lines[i].match(/^```(\w*)$/);
    if (f) {
      const body = [];
      for (i++; i < lines.length && !/^```$/.test(lines[i]); i++) body.push(lines[i]);
      if (f[1] === lang) blocks.push(body.join('\n'));
    }
  }
  if (!blocks[n]) throw new Error('no ' + lang + ' block #' + n + ' after ' + heading);
  return blocks[n];
}
const section12 = (md) => md.slice(md.indexOf('## 12.')).match(/```html\n([\s\S]*?)\n```/)[1];
const section10Json = (md) => md.slice(md.indexOf('## 10.')).match(/```json\n([\s\S]*?)\n```/)[1];

// ---------------------------------------------------------------------------------------------------------------------------
// pages

// The documented head (policy, script tag) of the example of section 12, for the given server origin.
function head(md, stack, origin) {
  const html = section12(md);
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
  const tag = html.match(/<script src=[\s\S]*?<\/script>/)[0];
  const swap = (s) => s.replaceAll(stack.docs.origin, origin);
  return { csp: swap(csp), tag: swap(tag) };
}

let pageCount = 0;
// A page with the documented policy and script tag, a store, and the recipe wrapped in an async function: window.__recipe(store, h) -> the names it returns.
function harness(md, stack, { recipe, params = [], ret = [], scope, origin, extraHead = '', extraBody = '' }) {
  const { csp, tag } = head(md, stack, origin || stack.docs.origin);
  const service = (origin || stack.docs.origin) + '/datastore/';
  const html = '<!doctype html><html><head><meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="' + csp + '">\n' + extraHead + '</head><body>\n'
    + '<ul id="list"></ul><textarea id="editor"></textarea><button id="unlock" hidden>Unlock</button><span id="status"></span>\n' + extraBody + '\n' + tag + '\n'
    + '<script>\n"use strict";\nconst store = WDS.connect({ scope: "' + scope + '", baseUrl: "' + service + '" });\nwindow.store = store;\n'
    + 'window.__recipe = async function (store, h) {\n' + (params.length ? 'const { ' + params.join(', ') + ' } = h;\n' : '') + recipe + '\nreturn { ' + ret.join(', ') + ' };\n};\n</script></body></html>';
  const file = join(stack.pages, (++pageCount) + '.html');
  writeFileSync(file, html);
  return 'file://' + file;
}

async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 800 }, locale: 'en-US', ...opts });
  await ctx.route('**/api/v1/pwned/*', (route) => route.fulfill({
    status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n' }));
  return ctx;
}
async function open(ctx, url) {
  const page = await ctx.newPage();
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push('pageerror: ' + e));
  page.on('console', (m) => {
    if (m.type() !== 'error' || /Failed to load resource/.test(m.text())) return;
    if (page.ignoreAborted && /Cross-Origin Request Blocked|Load failed|NetworkError|net::ERR/i.test(m.text())) return;     // the test aborts a request on purpose
    page.problems.push('console.error: ' + m.text());
  });
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI));
  });
  await page.goto(url);
  return page;
}
async function noProblems(...pages) {
  for (const p of pages) {
    expect(await p.evaluate(() => window.__violations), 'Content-Security-Policy violations').toEqual([]);
    expect(p.problems).toEqual([]);
  }
}

// The library's dialogs, driven by their stable attributes (any language).
const dlg = (page, view) => page.locator('[data-wds-view="' + view + '"]');
async function createVault(page, { joinCode } = {}) {
  await dlg(page, 'unlock').locator('[data-wds="to-create"]').click();
  const c = dlg(page, 'create');
  if (joinCode) await c.locator('[data-wds="join-code"]').fill(joinCode);
  await c.locator('[data-wds="passphrase"]').fill(PASS);
  await c.locator('[data-wds="passphrase-repeat"]').fill(PASS);
  await c.locator('[data-wds="create-submit"]').click();
  const sheet = dlg(page, 'sheet');
  await expect(sheet).toBeVisible({ timeout: 60000 });
  const accessId = (await sheet.locator('[data-wds="access-id"]').innerText()).trim();
  await sheet.locator('[data-wds="sheet-confirm"]').check();
  await sheet.locator('[data-wds="sheet-continue"]').click();
  await expect(page.locator('.wds-root dialog[open], dialog[data-wds-view]')).toHaveCount(0, { timeout: 30000 });
  return accessId;
}
async function unlockVault(page, accessId) {
  const u = dlg(page, 'unlock');
  await expect(u).toBeVisible({ timeout: 30000 });
  await u.locator('[data-wds="access-id-input"]').fill(accessId);
  await u.locator('[data-wds="passphrase"]').fill(PASS);
  await u.locator('[data-wds="unlock-submit"]').click();
  await expect(page.locator('dialog[data-wds-view]')).toHaveCount(0, { timeout: 60000 });
}
const openVault = async (page, stack) => { await page.evaluate(() => { window.__unlock = store.unlock(); }); return createVault(page, { joinCode: stack.joinCode }); };
const unlockLater = async (page, accessId) => { await page.evaluate(() => { window.__unlock = store.unlock(); }); await unlockVault(page, accessId); await page.evaluate(() => window.__unlock); };

// ---------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------
// tests: the documents

test('the documents: no placeholder left, the public repository named, links resolve, the guides fit one read', async ({ stack, md, porting }) => {
  const o = stack.docs.origin + '/datastore';
  const names = ['integration', 'porting', 'operator', 'users.en', 'users.de'];
  const texts = { llms: await (await fetch(o + '/llms.txt')).text() };
  for (const n of names) texts[n] = await (await fetch(o + '/docs/' + n + '.md')).text();
  texts.export = await (await fetch(o + '/export/')).text();
  for (const [name, text] of Object.entries(texts)) expect(text, name + ' has an unfilled placeholder').not.toContain('{{');
  for (const name of ['llms', 'integration', 'operator']) expect(texts[name], name).toContain('https://github.com/UBA-PSI/wiai-datastore');
  // no sandbox configured on this server: the documents say so instead of showing a made-up scope ID
  expect(texts.llms).toContain('This server has no public sandbox');
  expect(texts.llms).not.toContain(SANDBOX_ID);
  // one read per guide
  expect(md.split('\n').length).toBeLessThanOrEqual(351);
  expect(porting.split('\n').length).toBeLessThanOrEqual(151);
  // the pointers of llms.txt and the checklist exist in the guides
  for (const heading of [/^## 2\. The script tag$/m, /^## 4\. API$/m, /^### Autosave$/m, /^## 6\. Modelling$/m, /^## 7\. Conflicts$/m, /^## 8\. Members and the vault dialog$/m, /^## 10\. wds-verify$/m,
    /^## 11\. What to tell users$/m, /^## 12\. Complete minimal example$/m, /^## 13\. Sandbox and porting$/m]) expect(md, String(heading)).toMatch(heading);
  for (const heading of [/^# Porting an existing app to WIAI Datastore$/m, /^## 1\. Inventory$/m, /^## 3\. Importing an old export file$/m, /^## 4\. Data that is still in the browsers of existing users$/m, /^## 5\. Testing$/m]) expect(porting, String(heading)).toMatch(heading);
  expect(texts.llms).toContain(o + '/docs/porting.md');
  expect(md).toContain(o + '/docs/porting.md');
  // links: every address on the served documents' own origin answers 200 (the pages of this documentation, the export tool, llms.txt, the API root of the library)
  const urls = new Set();
  for (const text of Object.values(texts)) for (const m of text.matchAll(new RegExp(stack.docs.origin.replace(/[.]/g, '\\.') + '/datastore/[A-Za-z0-9_./-]*[A-Za-z0-9_/]', 'g'))) urls.add(m[0]);
  expect([...urls].some((u) => u.endsWith('/docs/porting.md'))).toBe(true);
  for (const u of urls) {
    if (/\/api\/|\/client\/$/.test(u) || /\/api$/.test(u)) continue;     // the API and the library directory are not pages
    const r = await fetch(u);
    expect(r.status, u).toBe(200);
  }
  // relative links of the Markdown files in the repository: README and the example
  for (const file of ['README.md', 'examples/zeit-notizen/README.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const m of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      if (/^(https?:|mailto:)/.test(m[1])) continue;
      expect(existsSync(join(ROOT, dirname(file), m[1])), file + ' links to ' + m[1]).toBe(true);
    }
  }
});

test('hash and version of the documents are the ones of client/dist/hashes.json (the library the server serves)', async ({ stack, md }) => {
  // the server under test serves a bundle with its own escrow pins; the document must name exactly that bundle
  expect(md).toContain('integrity="' + stack.sri + '"');
  const dist = JSON.parse(readFileSync(join(ROOT, 'client', 'dist', 'hashes.json'), 'utf8'));
  const newest = Object.keys(dist).sort().pop();
  expect(readFileSync(join(HERE, 'zeit-notizen', 'index.html'), 'utf8')).toContain('integrity="' + dist[newest].sri + '"');
  // the file at examples/ names the production URL and the published hash of this repository
  expect(readFileSync(join(HERE, 'zeit-notizen', 'index.html'), 'utf8')).toContain('https://wiai.uni-bamberg.de/datastore/client/wds-' + newest + '.js');
  // nothing else in the documentation or the examples carries a stale hash
  for (const file of ['docs/site/integration.md', 'docs/site/porting.md', 'docs/site/llms.txt', 'docs/site/operator.md', 'README.md', 'examples/zeit-notizen/README.md', 'examples/zeit-notizen/index.html']) {
    for (const m of readFileSync(join(ROOT, file), 'utf8').matchAll(/sha384-[A-Za-z0-9+/=]{64}/g)) expect(m[0], file).toBe(dist[newest].sri);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// tests: the API table (integration.md, section 4)

const API = ['unlock', 'status', 'get', 'set', 'remove', 'collection', 'autosave', 'onChange', 'onConflict', 'showHistory', 'openVault', 'lock', 'migrateLocal'];
const GONE = ['setLocale', 'locale', 'onLock', 'onUnlock', 'onStale', 'exportAll', 'getBlob', 'getRecord', 'getMany', 'list', 'history', 'restore', 'usage', 'isUnlocked', 'share'];

test('the store has the names of the API table and none of the removed ones; the collection has the documented methods', async ({ browser, stack, md }) => {
  const url = harness(md, stack, { recipe: '', ret: [], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  const keys = await page.evaluate(() => Object.keys(store).sort());
  for (const name of API) {
    expect(keys, 'the store lacks ' + name).toContain(name);
    expect(md, 'the guide does not name ' + name).toContain('store.' + name);
  }
  for (const name of GONE) expect(keys, 'the store still has ' + name).not.toContain(name);
  const cols = (await page.evaluate(() => Object.keys(store.collection('x/')))).filter((k) => !k.startsWith('_')).sort();   // underscore names are internal
  expect(cols).toEqual(['add', 'autosave', 'get', 'getAll', 'items', 'load', 'remove', 'set']);
  await noProblems(page);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------------------------
// tests: autosave, collections, files

test('integration.md: the autosave block saves the state it is given and reports it; stop() makes changed() a no-op', async ({ browser, stack, md }) => {
  const autosave = blockAfter(md, /^### Autosave$/, 'js');
  const url = harness(md, stack, { recipe: autosave, params: ['state', 'statusEl'], ret: ['saver'], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  const out = await page.evaluate(async () => {
    const statusEl = document.createElement('span');
    const R = await window.__recipe(store, { state: { text: 'draft text' }, statusEl });
    // the block itself ran changed(), flush() and stop(): the draft is in the vault
    R.saver.changed();        // after stop(): nothing happens, nothing throws
    return { status: statusEl.textContent, saved: await store.get('draft') };
  });
  expect(out).toEqual({ status: 'saved', saved: { text: 'draft text' } });
  // a second live handle for one name is a UsageError
  const twice = await page.evaluate(() => { const first = store.autosave('twice', () => ({ a: 1 })); try { store.autosave('twice', () => ({ a: 2 })); return 'no error'; } catch (e) { return e.name; } finally { first.stop(); } });
  expect(twice).toBe('UsageError');
  await noProblems(page);
  await ctx.close();
});

test('collections: the block adds, edits with autosave, lists, notices the other device through onChange on focus, and removes', async ({ browser, stack, md }) => {
  const recipe = blockAfter(md, /^## 6\. Modelling$/, 'js', 0);
  const url = harness(md, stack, { recipe, params: ['render', 'onStatus'], ret: ['notes', 'saver', 'id', 'note', 'all'], scope: stack.scope });
  const ctx = await newContext(browser);
  const a = await open(ctx, url);
  const accessId = await openVault(a, stack);
  await a.evaluate(() => window.__unlock);
  await a.evaluate(async () => {
    window.__renders = []; window.__changes = [];
    window.R = await window.__recipe(store, { render: (items) => window.__renders.push(items.map((i) => i.meta.title).sort()), onStatus: () => {} });
    // the block registered its handler; the test takes it out (one handler per store) and renders the same way
    store.onChange(null);
    store.onChange((ch) => { window.__changes.push(ch); window.__renders.push(R.notes.items().map((i) => i.meta.title).sort()); });
  });
  // the block: load (empty), add, get, autosave handle, set with an id of its own, getAll, remove of that one
  expect(await a.evaluate(() => window.__renders[0])).toEqual([]);
  const id = await a.evaluate(() => R.id);
  expect(id).toMatch(/^[0-9a-z]{10}$/);
  expect(await a.evaluate(() => R.all.map((x) => x.id).sort())).toEqual([id, '2026-ws'].sort());
  expect(await a.evaluate(() => R.notes.items().map((i) => i.id))).toEqual([id]);
  await a.evaluate(async () => { R.note.title = 'Shopping, edited'; R.saver.changed(); await R.saver.flush(); R.saver.stop(); R.saver.changed(); });   // changed() after stop(): nothing happens
  expect(await a.evaluate((i) => R.notes.get(i), id)).toEqual({ title: 'Shopping, edited', text: '' });
  expect(await a.evaluate(() => window.__changes.some((c) => c.remote === false && c.names.some((n) => n.startsWith('notes/'))))).toBe(true);   // own writes fire onChange with remote: false
  expect(await a.evaluate(() => window.__renders.length)).toBeGreaterThan(1);                                                                    // and the handler renders after them

  // a second device: it adds a note; the first one notices on focus (remote: true) and lists it
  const b = await open(ctx, url);
  await unlockLater(b, accessId);
  await b.evaluate(async () => { window.nb = store.collection('notes/', { meta: (n) => ({ title: n.title }) }); await nb.load(); });
  const other = await b.evaluate(async () => (await nb.add({ title: 'From the other device' })).id);
  await a.evaluate(() => { window.__changes = []; window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => a.evaluate(() => window.__changes.filter((c) => c.remote === true).flatMap((c) => c.names)), { timeout: 30000 }).toContain('notes/' + other);
  expect(await a.evaluate(() => R.notes.items().map((i) => i.id).sort())).toEqual([id, other].sort());
  // the other device removes it again: the first one learns of the removal on the next focus
  await b.evaluate((i) => nb.remove(i), other);
  await a.evaluate(() => { window.__changes = []; window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => a.evaluate(() => R.notes.items().length), { timeout: 30000 }).toBe(1);
  await noProblems(a, b);
  await ctx.close();
});

test('files: add (file first, then the item), download link, delete in reverse order', async ({ browser, stack, md }) => {
  const files = blockAfter(md, /^## 6\. Modelling$/, 'js', 1);
  const download = blockAfter(md, /^## 6\. Modelling$/, 'js', 2);
  const url = harness(md, stack, { recipe: files + '\n' + download, ret: ['photos', 'addPhoto', 'deletePhoto', 'downloadFile'], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  await page.evaluate(async () => { window.R = await window.__recipe(store, {}); await R.photos.load(); });
  const itemId = await page.evaluate(() => R.addPhoto(new File([new Uint8Array([1, 2, 3, 4])], 'cat.png', { type: 'image/png' })));
  const item = await page.evaluate(() => R.photos.items()[0]);
  expect(item.id).toBe(itemId);
  expect(item.meta.name).toBe('cat.png');
  expect(item.meta.file).toMatch(/^[0-9a-f]{8}-cat\.png$/);
  const stored = await page.evaluate(async (n) => { const b = await store.get('files/' + n); return { type: b.type, bytes: [...new Uint8Array(await b.arrayBuffer())] }; }, item.meta.file);
  expect(stored).toEqual({ type: 'image/png', bytes: [1, 2, 3, 4] });          // the stored MIME type is kept
  const dl = page.waitForEvent('download');
  await page.evaluate((n) => R.downloadFile(n, 'my cat.png'), item.meta.file);
  expect((await dl).suggestedFilename()).toBe('my cat.png');
  await page.evaluate((it) => R.deletePhoto(it), item);
  expect(await page.evaluate(() => R.photos.items().length)).toBe(0);
  expect(await page.evaluate((n) => store.get('files/' + n), item.meta.file)).toBeUndefined();
  await noProblems(page);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------------------------
// tests: conflicts

test('conflicts in code: one handler, an if on c.name: settings merge, everything else gets the library dialog', async ({ browser, stack, md }) => {
  const recipe = blockAfter(md, /^## 7\. Conflicts$/, 'js');
  const url = harness(md, stack, { recipe, ret: [], scope: stack.scope });
  const ctx = await newContext(browser);
  const a = await open(ctx, url);
  await a.evaluate(async () => { await window.__recipe(store, {}); });
  const accessId = await openVault(a, stack);
  await a.evaluate(() => window.__unlock);
  const b = await open(ctx, url);
  await b.evaluate(async () => { await window.__recipe(store, {}); });
  await unlockLater(b, accessId);

  // settings: both devices changed different settings; the handler merges
  await a.evaluate(() => store.set('settings', { a: 1 }));
  await b.evaluate(async () => { await store.get('settings'); await store.set('settings', { b: 2 }); });
  const merged = await a.evaluate(() => store.set('settings', { a: 1, c: 3 }));
  expect(merged.resolution).toBe('merged');
  expect(merged.value).toEqual({ b: 2, a: 1, c: 3 });
  expect(await b.evaluate(() => store.get('settings'))).toEqual({ b: 2, a: 1, c: 3 });

  // another record: the handler returns nothing, the library's dialog asks the person
  await a.evaluate(() => store.set('notes/n1', { text: 'one' }));
  await b.evaluate(async () => { await store.get('notes/n1'); await store.set('notes/n1', { text: 'two' }); });
  const asked = a.evaluate(() => store.set('notes/n1', { text: 'three' }));
  const dialog = a.locator('[data-wds-view="conflict"]');
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await dialog.locator('[data-wds="conflict-theirs"]').click();
  expect(await asked).toMatchObject({ resolution: 'theirs', value: { text: 'two' } });

  // a record this page has not read is a conflict, too: "get it first" replaces it
  await a.evaluate(() => store.set('notes/n2', { text: 'old' }));
  const c = await open(ctx, url);
  await c.evaluate(async () => { await window.__recipe(store, {}); });
  await unlockLater(c, accessId);
  const unread = c.evaluate(() => store.set('notes/n2', { text: 'blind' }));
  await expect(c.locator('[data-wds-view="conflict"]')).toBeVisible({ timeout: 30000 });
  await c.locator('[data-wds="conflict-mine"]').click();
  expect((await unread).resolution).toBe('mine');
  await c.evaluate(async () => { await store.get('notes/n2'); });
  expect((await c.evaluate(() => store.set('notes/n2', { text: 'read first' }))).resolution).toBe('saved');
  await expect(c.locator('[data-wds-view="conflict"]')).toHaveCount(0);
  await noProblems(a, b, c);
  await ctx.close();
});

test('the library dialog opens above a modal dialog of the app, as section 4 says: a conflict while an own <dialog> is open stays answerable', async ({ browser, stack, md }) => {
  const url = harness(md, stack, { recipe: '', ret: [], scope: stack.scope, extraBody: '<dialog id="mine"><p>my own modal dialog</p><button id="inner">inner</button></dialog>' });
  const ctx = await newContext(browser);
  const a = await open(ctx, url);
  await a.evaluate(async () => { await window.__recipe(store, {}); });
  const accessId = await openVault(a, stack);
  await a.evaluate(() => window.__unlock);
  const b = await open(ctx, url);
  await b.evaluate(async () => { await window.__recipe(store, {}); });
  await unlockLater(b, accessId);
  await a.evaluate(() => store.set('shared', { v: 1 }));
  await b.evaluate(async () => { await store.get('shared'); await store.set('shared', { v: 2 }); });
  await a.evaluate(() => { document.getElementById('mine').showModal(); window.__p = store.set('shared', { v: 3 }); });
  const conflict = dlg(a, 'conflict');
  await expect(conflict).toBeVisible({ timeout: 30000 });
  await conflict.locator('[data-wds="conflict-theirs"]').click();                 // no force: the dialog is on top and not inert
  expect((await a.evaluate(() => window.__p)).resolution).toBe('theirs');
  await expect(a.locator('#inner')).toBeVisible();
  expect(await a.evaluate(() => document.querySelectorAll('dialog:not(.wds-dialog)').length)).toBe(1);   // the selector of the guide finds only the app's own dialog
  await noProblems(a, b);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------------------------
// tests: porting.md

test('porting.md section 3: the import of an old export keeps the ids; a second import neither doubles nor overwrites what was changed since', async ({ browser, stack, md, porting }) => {
  const recipe = blockAfter(porting, /^## 3\. Importing an old export file$/, 'js');
  const url = harness(md, stack, { recipe, ret: ['notes', 'importOldExport'], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  await page.evaluate(async () => { window.R = await window.__recipe(store, {}); });
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  const bad = await page.evaluate(() => R.importOldExport(new File(['{"items": []}'], 'x.json')).then(() => 'accepted', (e) => e.message));
  expect(bad).toContain('not an export of the old version');
  const old = { notes: [{ id: 12, title: 'twelve', text: 'a' }, { id: 'three', title: 'three', text: 'b' }] };
  expect(await page.evaluate((o) => R.importOldExport(new File([JSON.stringify(o)], 'old.json')), old)).toBe(2);
  await page.evaluate(async () => { await R.notes.get('old-12'); await R.notes.set('old-12', { title: 'twelve', text: 'changed after the import' }); });
  expect(await page.evaluate((o) => R.importOldExport(new File([JSON.stringify(o)], 'old.json')), old)).toBe(2);          // again: no conflict, no copies, nothing overwritten
  const kept = await page.evaluate(async () => { await R.notes.load(); return R.notes.items().map((i) => [i.id, i.meta.title]).sort(); });
  expect(kept).toEqual([['old-12', 'twelve'], ['old-three', 'three']]);
  expect(await page.evaluate(() => R.notes.get('old-12'))).toEqual({ title: 'twelve', text: 'changed after the import' });
  expect(await page.evaluate(() => R.notes.get('old-three'))).toEqual({ title: 'three', text: 'b' });
  await expect(page.locator('dialog[data-wds-view="conflict"]')).toHaveCount(0);
  await noProblems(page);
  await ctx.close();
});


// ---------------------------------------------------------------------------------------------------------------------------
// tests: store.migrateLocal in the documented block of porting.md

// The old app in a browser, as the block of the document knows it: IndexedDB "zeitnotizen" with notes (auto-increment keys) and files (an attachment as a data: URL and the key of its
// note), and one localStorage key with a JSON text. Nothing else is named by the block.
const OLD_SEED = String.raw`
  window.seedOld = async function () {
    await new Promise((ok, fail) => {
      const req = indexedDB.open('zeitnotizen', 1);
      req.onupgradeneeded = () => {
        const db = req.result, notes = db.createObjectStore('notes', { autoIncrement: true }), files = db.createObjectStore('files', { autoIncrement: true });
        notes.put({ title: 'Kickoff', text: 'first words' });
        notes.put({ title: 'Plan', text: 'second words' });
        files.put({ noteId: 1, name: 'plan.pdf', dataUrl: 'data:application/pdf;base64,' + btoa('%PDF-1') });
        db.createObjectStore('meta').put('de', 'lang');       // not named by the block: it stays
      };
      req.onsuccess = () => { req.result.close(); ok(); };
      req.onerror = () => fail(req.error);
    });
    localStorage.setItem('zeitnotizen.daten', JSON.stringify({ projects: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }], entries: [] }));
    localStorage.setItem('zeitnotizen.lang', 'de');           // a preference: the block does not name it
  };
  window.oldLeft = async function () {                          // what is left of the old storage
    const out = { local: {}, rows: null };
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k.startsWith('wds:')) out.local[k] = localStorage.getItem(k); }
    const db = await new Promise((resolve) => { const r = indexedDB.open('zeitnotizen'); r.onupgradeneeded = () => { r.transaction.abort(); resolve(null); }; r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null); });
    if (db) {
      out.rows = {};
      for (const s of ['notes', 'files', 'meta']) out.rows[s] = await new Promise((resolve) => { const r = db.transaction(s).objectStore(s).count(); r.onsuccess = () => resolve(r.result); });
      db.close();
    }
    return out;
  };
`;
async function idbAvailable(page) { return page.evaluate(() => { try { return typeof indexedDB !== 'undefined' && !!indexedDB.open('probe-' + Math.random()); } catch (e) { return false; } }); }
const oldUrl = (md, porting, stack, { scope, origin } = {}) => harness(md, stack, { recipe: blockAfter(porting, /^## 4\. Data that is still in the browsers of existing users$/, 'js'), ret: ['result'], scope: scope || stack.scope, origin,
  extraHead: '<script>' + OLD_SEED + '</script>' });
const startOld = (page) => page.evaluate(() => { window.__done = window.__recipe(store, {}).then((r) => (window.R = r), (e) => ({ rejected: e.name + ': ' + e.message })); });
const finishOld = (page) => page.evaluate(() => window.__done);
async function answerQuestion(page, { backup = false } = {}) {
  const q = dlg(page, 'migrate');
  await expect(q).toBeVisible({ timeout: 30000 });
  await expect(q).not.toHaveAttribute('aria-busy', /.*/);
  if (backup) {
    const download = page.waitForEvent('download');
    await q.locator('[data-wds="migrate-backup"]').click();
    expect((await download).suggestedFilename()).toMatch(/\.zip$/);
  }
  await q.locator('[data-wds="migrate-yes"]').click();
}
const vaultOfOld = (page) => page.evaluate(async () => {
  const projects = store.collection('projects/'), notes = store.collection('notes/'), files = store.collection('files/');
  await Promise.all([projects.load(), notes.load(), files.load()]);
  const blob = files.items().length ? await store.get('files/' + files.items()[0].id) : null;
  return {
    projects: (await projects.getAll()).map((p) => p.value.name).sort(),
    notes: (await notes.getAll()).map((n) => ({ id: n.id, title: n.value.title, meta: n.meta })).sort((x, y) => (x.title < y.title ? -1 : 1)),
    files: files.items().map((f) => ({ id: f.id, meta: f.meta })),
    file: blob && { type: blob.type, text: await blob.text() },
  };
});

test('porting.md, the migrateLocal block: the real server copies at the first start; the second start asks and deletes what the block named; a third finds nothing', async ({ browser, stack, md, porting }) => {
  const url = oldUrl(md, porting, stack);
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  if (!(await idbAvailable(page))) test.skip(true, 'this engine has no IndexedDB for file:// pages');
  const accessId = await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  await page.evaluate(() => seedOld());
  await startOld(page);
  await answerQuestion(page, { backup: true });                  // the link "Download a copy of the old data first", then the answer
  const res = await finishOld(page);
  expect(res.result.status).toBe('migrated');
  const st = await vaultOfOld(page);
  expect(st.projects).toEqual(['Alpha', 'Beta']);
  expect(st.notes.map((n) => n.title)).toEqual(['Kickoff', 'Plan']);
  expect(st.notes.map((n) => n.meta.title)).toEqual(['Kickoff', 'Plan']);
  expect(st.files).toHaveLength(1);
  expect(st.files[0].meta.note).toBe(st.notes[0].id);           // ref(key): the reference to the note's new id
  expect(st.files[0].meta.name).toBe('plan.pdf');
  expect(st.file).toEqual({ type: 'application/pdf', text: '%PDF-1' });   // the app converted the data: URL
  expect((await page.evaluate(() => oldLeft())).rows).toEqual({ notes: 2, files: 1, meta: 1 });   // the first start only copies
  // the second start asks whether everything is in the app, and deletes
  const page2 = await open(ctx, url);
  await unlockLater(page2, accessId);
  await startOld(page2);
  const del = dlg(page2, 'migrate-delete');
  await expect(del).toBeVisible({ timeout: 30000 });
  await del.locator('[data-wds="migrate-delete-yes"]').click();
  expect((await finishOld(page2)).result).toMatchObject({ status: 'nothing' });
  const left = await page2.evaluate(() => oldLeft());
  expect(left.rows).toEqual({ notes: 0, files: 0, meta: 1 });   // what was copied is gone; the language row was not named and stays
  expect(Object.keys(left.local)).toEqual(['zeitnotizen.lang']);
  // a third start: nothing to take over, no dialog
  const page3 = await open(ctx, url);
  await unlockLater(page3, accessId);
  await startOld(page3);
  expect((await finishOld(page3)).result).toMatchObject({ status: 'nothing' });
  await expect(page3.locator('dialog[data-wds-view]')).toHaveCount(0);
  await noProblems(page, page2, page3);
  await ctx.close();
});

async function sandboxVault(page) {
  await page.evaluate(() => { window.__unlock = store.unlock(); });
  await expect(dlg(page, 'unlock')).toContainText('Sandbox');
  await createVault(page);
  await page.evaluate(() => window.__unlock);
  expect(await page.evaluate(() => store.status().sandbox)).toBe(true);
}

test('porting.md, the migrateLocal block in the sandbox: the data is copied and the old data is kept', async ({ browser, stack, md, porting }) => {
  const url = oldUrl(md, porting, stack, { scope: SANDBOX_ID, origin: stack.sandbox.origin });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  if (!(await idbAvailable(page))) test.skip(true, 'this engine has no IndexedDB for file:// pages');
  await sandboxVault(page);
  await page.evaluate(() => seedOld());
  await startOld(page);
  await expect(dlg(page, 'migrate')).toContainText('Sandbox');
  await answerQuestion(page);
  const res = await finishOld(page);
  expect(res.result.status).toBe('migrated');
  const left = await page.evaluate(() => oldLeft());
  expect(left.rows).toEqual({ notes: 2, files: 1, meta: 1 });                 // still there: the sandbox never deletes
  expect(Object.keys(left.local).sort()).toEqual(['zeitnotizen.daten', 'zeitnotizen.lang']);
  expect((await vaultOfOld(page)).notes).toHaveLength(2);
  // the documents of a server with a sandbox name it
  const llms = await (await fetch(stack.sandbox.origin + '/datastore/llms.txt')).text();
  expect(llms).toContain(SANDBOX_ID);
  expect(llms).toContain('03:30 Europe/Berlin');
  expect(llms).toContain('512 KB per record');
  expect(llms).not.toContain('{{');
  const guide = await (await fetch(stack.sandbox.origin + '/datastore/docs/integration.md')).text();
  expect(guide).toContain('512 KB per record');
  expect(guide).not.toContain('{{');
  await noProblems(page);
  await ctx.close();
});

test('porting.md, the migrateLocal block: without old data there is no dialog and no request (status nothing); a wrong option is a UsageError', async ({ browser, stack, md, porting }) => {
  const url = oldUrl(md, porting, stack);
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  const res = await page.evaluate(() => window.__recipe(store, {}));
  expect(res.result).toMatchObject({ status: 'nothing' });
  await expect(page.locator('dialog[data-wds-view]')).toHaveCount(0);
  const wrong = await page.evaluate(() => Promise.resolve().then(() => store.migrateLocal({ id: 'Not valid!', map() {} })).then(() => 'accepted', (e) => e.name));
  expect(wrong).toBe('UsageError');
  await noProblems(page);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------------------------
// tests: the json blocks, every code block, and wds-verify on what the documents print

test('the wds-verify.json blocks of the documents and the file of the example app are valid for the tool', async ({ md, porting }) => {
  const printed = JSON.parse(section10Json(md));
  expect(Array.isArray(printed)).toBe(false);
  parseConfig(JSON.stringify(printed));
  parseConfig(blockAfter(porting, /^## 5\. Testing$/, 'json'));
  const seed = JSON.parse(blockAfter(porting, /^## 5\. Testing$/, 'json')).seed;
  expect(seed.steps.some((s) => s.fill && /\{canary\}/.test(s.fill[1]))).toBe(true);
  const file = JSON.parse(readFileSync(join(HERE, 'zeit-notizen', 'wds-verify.json'), 'utf8'));
  parseConfig(JSON.stringify(file));
  expect(file.steps.map((s) => Object.keys(s)[0])).toEqual(expect.arrayContaining(['click', 'fill', 'press', 'upload', 'download', 'wait']));
  expect(file.seed.page).toBe('old/index.html');
  expect(existsSync(join(HERE, 'zeit-notizen', file.seed.page))).toBe(true);
  const old = readFileSync(join(HERE, 'zeit-notizen', 'old', 'index.html'), 'utf8');
  for (const step of file.seed.steps) {
    const sel = step.fill ? step.fill[0] : step.click || (step.upload && step.upload[0]);
    if (sel) expect(old, 'the old page has ' + sel).toContain('id="' + sel.slice(1) + '"');
  }
  expect(file.seed.steps.some((s) => s.upload)).toBe(true);
});

test('every code block of integration.md and porting.md is run or at least parsed, and a new block must be classified here', async ({ md, porting }) => {
  const blocks = (text) => {
    const out = []; let heading = '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^#+ (.*)/); if (h) heading = h[1];
      const f = lines[i].match(/^```(\w*)$/);
      if (!f) continue;
      const body = [];
      for (i++; i < lines.length && !/^```$/.test(lines[i]); i++) body.push(lines[i]);
      out.push({ lang: f[1], heading, code: body.join('\n') });
    }
    return out;
  };
  // [document, heading, index inside that heading] -> how the block is tested
  const registry = {
    'integration|2. The script tag|0': 'run: the example of section 12 carries it (wds-verify static check)',
    'integration|3. Content-Security-Policy|0': 'run: the example of section 12 carries it',
    'integration|4. API|0': 'parsed only',
    'integration|Autosave|0': 'run',
    'integration|6. Modelling|0': 'run (collections)',
    'integration|6. Modelling|1': 'run (files)',
    'integration|6. Modelling|2': 'run (download link)',
    'integration|7. Conflicts|0': 'run',
    'integration|10. wds-verify|0': 'shell: text only',
    'integration|10. wds-verify|1': 'json: valid for the tool, and used with the example of section 12',
    'integration|11. What to tell users|0': 'text: the sentences are compared in test_docs.py',
    'integration|12. Complete minimal example|0': 'run: wds-verify (mock and sandbox)',
    'porting|3. Importing an old export file|0': 'run',
    'porting|4. Data that is still in the browsers of existing users|0': 'run (real server and sandbox)',
    'porting|5. Testing|0': 'json: valid for the tool',
  };
  const Async = Object.getPrototypeOf(async function () {}).constructor;
  const seen = new Set();
  for (const [doc, text] of [['integration', md], ['porting', porting]]) {
    const counts = {};
    for (const b of blocks(text)) {
      const heading = b.heading.replaceAll(String.fromCharCode(96), '');
      const key = doc + '|' + heading + '|' + (counts[heading] = (counts[heading] === undefined ? 0 : counts[heading] + 1));
      expect(registry[key], 'a code block that is not classified: ' + key).toBeTruthy();
      seen.add(key);
      if (b.lang === 'js') expect(() => new Async(b.code), 'the block does not parse: ' + key).not.toThrow();
      if (b.lang === 'json') expect(() => JSON.parse(b.code), 'the block is not JSON: ' + key).not.toThrow();
    }
  }
  for (const key of Object.keys(registry)) expect(seen.has(key), 'classified but gone: ' + key).toBe(true);
});

function verify(file, ...args) {
  return spawnSync('node', [join(ROOT, 'tools', 'wds-verify.mjs'), file, ...args], { encoding: 'utf8', env: { ...process.env, WDS_VERIFY_OFFLINE: '1' }, timeout: 280000 });
}
const publishedSri = () => { const h = JSON.parse(readFileSync(join(ROOT, 'client', 'dist', 'hashes.json'), 'utf8')); return h[Object.keys(h).sort().pop()].sri; };
// what a developer would have in the file: the production address and the published hash (the server of the test serves a bundle with its own escrow pins)
const productionPage = (stack, html) => html.replaceAll(stack.docs.origin + '/datastore', 'https://wiai.uni-bamberg.de/datastore').replaceAll(stack.sri, publishedSri());

test('the example app of section 12 live: the other version of the open note arrives through onChange; text typed since is not overwritten silently', async ({ browser, stack, md }) => {
  test.setTimeout(180000);
  const file = join(stack.pages, 'example-live.html');
  const live = section12(md).replace('WDS.connect({ scope: "myapp-k7m2a9" })', 'WDS.connect({ scope: "' + stack.scope + '", baseUrl: "' + stack.docs.origin + '/datastore/" })');
  expect(live).toContain('notes.autosave(id, () => note, {');
  writeFileSync(file, live.replace('notes.autosave(id, () => note, {', 'notes.autosave(id, () => note, { delayMs: 600000,'));   // saved by flush() only, so that the test decides when
  const ctx = await newContext(browser);
  const a = await open(ctx, 'file://' + file);
  const accessId = await createVault(a, { joinCode: stack.joinCode });
  await a.locator('#new').click();
  await a.locator('#text').fill('first text');
  await a.evaluate(() => current.saver.flush());
  await expect(a.locator('#status')).toHaveText('saved', { timeout: 20000 });
  await expect(a.locator('#list li button').first()).toHaveText('first text');   // the list entry (title) follows the text
  const b = await open(ctx, 'file://' + file);
  await unlockVault(b, accessId);
  await b.locator('#list li button').first().click();
  await expect(b.locator('#text')).toHaveValue('first text');
  await b.locator('#text').fill('text from the other device');
  await b.evaluate(() => current.saver.flush());
  await expect(b.locator('#status')).toHaveText('saved', { timeout: 20000 });
  // a has typed nothing since: the check on focus brings the other text into the editor
  await a.evaluate(() => WDS.internals.testHooks.checkNow());
  await expect(a.locator('#text')).toHaveValue('text from the other device', { timeout: 20000 });
  // a types (not saved yet), b saves again: the check does not touch the editor of a ...
  await a.locator('#text').fill('typed on a');
  await b.locator('#text').fill('second text from b');
  await b.evaluate(() => current.saver.flush());
  await expect(b.locator('#status')).toHaveText('saved', { timeout: 20000 });
  await a.evaluate(() => WDS.internals.testHooks.checkNow());
  await a.waitForTimeout(500);
  await expect(a.locator('#text')).toHaveValue('typed on a');
  // ... and the save of a meets the other version in the library's dialog; "Keep theirs" puts it into the editor
  await a.evaluate(() => { window.p = current.saver.flush(); });
  const conflict = dlg(a, 'conflict');
  await expect(conflict).toBeVisible({ timeout: 30000 });
  await conflict.locator('[data-wds="conflict-theirs"]').click();
  await expect(a.locator('#text')).toHaveValue('second text from b', { timeout: 20000 });
  await noProblems(a, b);
  await ctx.close();
});

test('the example app of section 12 passes wds-verify with the wds-verify.json of section 10 (mock target)', async ({ stack, md }) => {
  test.setTimeout(290000);
  const dir = join(stack.pages, 'verify-example');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), productionPage(stack, section12(md)));
  writeFileSync(join(dir, 'wds-verify.json'), section10Json(md));
  const r = verify(join(dir, 'index.html'), '--target', 'mock');
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain('**Result: passed**');
  expect(r.stdout).toMatch(/Target: \*\*mock\*\*/);
  expect(r.stdout).toMatch(/Data after reload \| pass/);
  expect(r.stdout).not.toMatch(/No <html lang>/);
});

test('the example app of section 12 runs against the sandbox with wds-verify --target sandbox, and --sandbox-copy writes a copy for a person', async ({ stack, md }) => {
  test.setTimeout(290000);
  const dir = join(stack.pages, 'verify-sandbox');
  mkdirSync(dir, { recursive: true });
  // the page as a developer has it (production address); the tool is pointed at the sandbox of this test's server and at the bundle that server serves
  const page = section12(md).replaceAll(stack.docs.origin + '/datastore', 'https://wiai.uni-bamberg.de/datastore');
  writeFileSync(join(dir, 'index.html'), page);
  writeFileSync(join(dir, 'wds-verify.json'), section10Json(md));
  // (WDS_VERIFY_OFFLINE: the scope check would call the example's scope ID "myapp-k7m2a9" unknown, as it is: the documents print a placeholder)
  const env = { ...process.env, WDS_VERIFY_SERVICE: stack.sandbox.service, WDS_VERIFY_LIBRARY: stack.bundleFile, WDS_VERIFY_OFFLINE: '1' };
  const hashes = join(stack.bundleDir, 'hashes.json');
  const r = spawnSync('node', [join(ROOT, 'tools', 'wds-verify.mjs'), join(dir, 'index.html'), '--target', 'sandbox', '--hashes', hashes], { encoding: 'utf8', env, timeout: 280000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toMatch(/Target: \*\*sandbox\*\*/);
  expect(r.stdout).toMatch(/Data after reload \| pass/);
  expect(readFileSync(join(dir, 'index.html'), 'utf8')).not.toContain(SANDBOX_ID);      // the tool ran a copy; the file of the developer is untouched
  // --sandbox-copy: a file with "sandbox" in its name, the app's scope ID replaced; the original is not touched
  const copy = join(dir, 'index-sandbox.html');
  const c = spawnSync('node', [join(ROOT, 'tools', 'wds-verify.mjs'), join(dir, 'index.html'), '--sandbox-copy', copy], { encoding: 'utf8', env, timeout: 60000 });
  expect(c.status, c.stdout + c.stderr).toBe(0);
  expect(readFileSync(copy, 'utf8')).toContain('scope: "' + SANDBOX_ID + '"');
  expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('scope: "myapp-k7m2a9"');
  const bad = spawnSync('node', [join(ROOT, 'tools', 'wds-verify.mjs'), join(dir, 'index.html'), '--sandbox-copy', join(dir, 'copy.html')], { encoding: 'utf8', env, timeout: 60000 });
  expect(bad.status).not.toBe(0);                                              // the name must say "sandbox"
  // and the static check fails a file that contains the sandbox ID
  const s = spawnSync('node', [join(ROOT, 'tools', 'wds-verify.mjs'), copy, '--static-only', '--hashes', hashes], { encoding: 'utf8', env: env, timeout: 60000 });
  expect(s.status).toBe(1);
  expect(s.stdout).toContain('Sandbox scope ID in the app');
});

test('the migrateLocal block of porting.md used in an app: no static finding, an info that says so; the same app with hand-made code is warned about', async ({ stack, md, porting }) => {
  const dir = join(stack.pages, 'verify-static');
  mkdirSync(dir, { recursive: true });
  const base = section12(md);
  const page = (script) => productionPage(stack, base.replace(/<script>\n"use strict";[\s\S]*<\/script>/, '<script>\n"use strict";\nconst store = WDS.connect({ scope: "myapp-k7m2a9" });\n' + script + '\n</script>'));
  const good = 'async function start() {\n  await store.unlock();\n' + blockAfter(porting, /^## 4\. Data that is still in the browsers of existing users$/, 'js') + '\n}\nstart();';
  writeFileSync(join(dir, 'good.html'), page(good));
  const r = verify(join(dir, 'good.html'), '--static-only');
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain('store.migrateLocal');
  expect(r.stdout).not.toContain("Browser storage of the app's own");
  // the hand-made way: reading and deleting the old storage in the app
  const bad = 'async function takeOver() {\n  const req = indexedDB.open("zeitnotizen");\n  req.onsuccess = () => { localStorage.removeItem("zeitnotizen.daten"); };\n}\nstore.unlock();';
  writeFileSync(join(dir, 'bad.html'), page(bad));
  const u = verify(join(dir, 'bad.html'), '--static-only');
  expect(u.stdout).toContain("Browser storage of the app's own");
});

// The example app with its older version as the seed: the tool opens the old page, the new app, answers the library's question, reloads, and looks at the old storage.
test('wds-verify runs the migration of examples/zeit-notizen with its seed: the data appears after the reload and the old data is still there in the sandbox', async ({ stack }) => {
  test.setTimeout(590000);
  const dir = join(stack.pages, 'verify-zeit');
  cpSync(join(HERE, 'zeit-notizen'), dir, { recursive: true });
  // a copy of the example with the hash of the bundle that this server serves (its escrow pins are its own)
  writeFileSync(join(dir, 'index.html'), readFileSync(join(dir, 'index.html'), 'utf8').replaceAll(publishedSri(), stack.sri));
  const env = { ...process.env, WDS_VERIFY_SERVICE: stack.sandbox.service, WDS_VERIFY_LIBRARY: stack.bundleFile, WDS_VERIFY_OFFLINE: '1' };
  const hashes = join(stack.bundleDir, 'hashes.json');
  const r = spawnSync('node', [join(ROOT, 'tools', 'wds-verify.mjs'), join(dir, 'index.html'), '--target', 'sandbox', '--hashes', hashes], { encoding: 'utf8', env, timeout: 280000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toMatch(/Seed: the old app \| pass/);
  expect(r.stdout).toMatch(/Migration: old data visible \| pass/);
  expect(r.stdout).toMatch(/Migration: old data only encrypted \| pass/);
  expect(r.stdout).toMatch(/Migration: old data kept in the sandbox \| pass/);
  expect(r.stdout).toMatch(/Data after reload \| pass/);
});
