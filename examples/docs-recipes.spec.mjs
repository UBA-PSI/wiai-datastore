// Tests of the code recipes of docs/site/integration.md, against the REAL server and the REAL bundle (scripts/test-examples.sh).
// Every recipe is taken from the served document (the first code block after its heading), put into a page that carries the documented
// Content-Security-Policy and script tag, and run from a file:// page. Nothing here re-types a recipe: if the document changes, the test runs the new text.
//  - Collections (several devices, concurrent adds, err.stored after a lost index write), conflicts in code (settings merge, keepTheirs, c.ask()),
//    lock and unlock again (onLock/onUnlock registered once, a pending edit survives the lock), import of an old export,
//  - the one-time migration of old IndexedDB/localStorage data: owner migrates and deletes, the sandbox copies and keeps, a second browser
//    with the same old ids does not collide, an interrupted run continues, a declined run changes nothing, a blocked delete reports,
//    data that does not fit stops before writing, the settings are snapshots that are taken over exactly once (state in the vault), a Blob replaced by one with other bytes is noticed,
//    the marker is per browser, a start with a marker re-reads the copy before it deletes, toNewRecords stops for rows it cannot map,
//  - the example app of section 14 and the wds-verify.json of section 12 pass wds-verify (mock target), the migration recipe passes its static checks,
//  - the documents: no placeholder left, the repository named, links resolve.
// Run with scripts/test-examples.sh (Chromium; WDS_BROWSERS=chromium,firefox,webkit for more).
import { test as base, expect } from '../client/node_modules/@playwright/test/index.mjs';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { startStack, pythonBin, freePort, ROOT, SERVER_DIR } from '../client/test/integration-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PASS = 'purple-elephant-marching-slowly';
const SANDBOX_ID = 'sandbox-000000';

// ---------------------------------------------------------------------------------------------------------------------------
// the stack: the real server with the documentation (public_base set), and a second server with a [sandbox] section for the sandbox cases

async function startSandboxServer(stack) {
  const port = await freePort();
  const cfg = join(stack.tmp, 'sandbox-' + port + '.ini');
  const hash = createHash('sha256').update(stack.operatorToken).digest('base64url');
  writeFileSync(cfg, '[server]\nclient_dir = ' + stack.bundleDir + '\nread_only_threshold = 1.0\nsweep_interval = 0\npublic_base = http://127.0.0.1:' + port + '/datastore\n'
    + '[escrow]\ncurrent_e_pub = ' + stack.escrow.current.e_pub + '\ncurrent_s_pub = ' + stack.escrow.current.s_pub + '\n'
    + 'spare_e_pub = ' + stack.escrow.spare.e_pub + '\nspare_s_pub = ' + stack.escrow.spare.s_pub + '\n[operator]\ntoken_hashes = ' + hash + '\n'
    + '[sandbox]\nscope_id = ' + SANDBOX_ID + '\nwipe_time = 03:30\ntimezone = Europe/Berlin\n');
  let out = '';
  const db = join(stack.tmp, 'sandbox-' + port + '.db');
  const child = spawn(pythonBin(), ['-m', 'wds_server', '--db', db, '--host', '127.0.0.1', '--port', String(port), '--config', cfg], { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const origin = 'http://127.0.0.1:' + port;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error('sandbox server exited:\n' + out);
    try { if ((await fetch(origin + '/datastore/healthz')).ok) break; } catch (e) { /* not yet */ }
    if (i > 300) throw new Error('sandbox server did not start:\n' + out);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { origin, service: origin + '/datastore/', stop: () => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000); }) };
}

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
});
test.setTimeout(240000);

// ---------------------------------------------------------------------------------------------------------------------------
// the document: code blocks by heading

// The n-th fenced block of the given language after the first line that matches heading (a RegExp), up to the next heading of the same or a higher level.
function blockAfter(md, heading, lang, n = 0) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) throw new Error('no heading ' + heading + ' in integration.md');
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
const section14 = (md) => md.slice(md.indexOf('## 14.')).match(/```html\n([\s\S]*?)\n```/)[1];
const section12Json = (md) => md.slice(md.indexOf('## 12.')).match(/```json\n([\s\S]*?)\n```/)[1];

// ---------------------------------------------------------------------------------------------------------------------------
// pages

// The documented head (policy, script tag) of the example of section 14, for the given server origin.
function head(md, stack, origin) {
  const html = section14(md);
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
  await ctx.route('https://api.pwnedpasswords.com/range/*', (route) => route.fulfill({
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
// tests

test('the documents: no placeholder left, the public repository named, links resolve', async ({ stack, md }) => {
  const o = stack.docs.origin + '/datastore';
  const names = ['integration', 'operator', 'users.en', 'users.de'];
  const texts = { llms: await (await fetch(o + '/llms.txt')).text() };
  for (const n of names) texts[n] = await (await fetch(o + '/docs/' + n + '.md')).text();
  texts.export = await (await fetch(o + '/export/')).text();
  for (const [name, text] of Object.entries(texts)) expect(text, name + ' has an unfilled placeholder').not.toContain('{{');
  for (const name of ['llms', 'integration', 'operator']) expect(texts[name], name).toContain('https://github.com/UBA-PSI/wiai-datastore');
  for (const [name, text] of Object.entries(texts)) {
    expect(text, name).not.toMatch(/address of the repository comes from the operator/);
    expect(text, name).not.toMatch(/clone, npm install in client\//);
  }
  // no sandbox configured on this server: the documents say so instead of showing a made-up scope ID
  expect(texts.llms).toContain('This server has no public sandbox');
  expect(texts.llms).not.toContain(SANDBOX_ID);
  // the rules and pointers of llms.txt exist in the guide
  for (const pointer of ['Collections', 'Conflicts in code', 'Lock and unlock again', 'Porting an existing app', 'Without wds-verify', 'Writing wds-verify.json', 'The sandbox', 'wds-verify']) {
    expect(texts.llms + md, pointer).toContain(pointer);
    expect(md, 'heading ' + pointer).toMatch(new RegExp('^#{2,3} (\\d+\\. )?' + pointer.replace('.', '\\.') + '( |$)', 'm'));
  }
  expect(md).toMatch(/^## 12\. wds-verify$/m);
  expect(md).toMatch(/^## 16\. Porting an existing app$/m);
  // links: every address on the served documents' own origin answers 200 (the pages of this documentation, the export tool, llms.txt, the API root of the library)
  const urls = new Set();
  for (const text of Object.values(texts)) for (const m of text.matchAll(new RegExp(stack.docs.origin.replace(/[.]/g, '\\.') + '/datastore/[A-Za-z0-9_./-]*[A-Za-z0-9_/]', 'g'))) urls.add(m[0]);
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
  for (const file of ['docs/site/integration.md', 'docs/site/llms.txt', 'docs/site/operator.md', 'README.md', 'examples/zeit-notizen/README.md', 'examples/zeit-notizen/index.html']) {
    for (const m of readFileSync(join(ROOT, file), 'utf8').matchAll(/sha384-[A-Za-z0-9+/=]{64}/g)) expect(m[0], file).toBe(dist[newest].sri);
  }
});

test('collections: the recipe merges two devices, notices the other one, and survives a lost index write (err.stored)', async ({ browser, stack, md }) => {
  const recipe = blockAfter(md, /^### Collections$/, 'js');
  const url = harness(md, stack, { recipe, params: ['renderList', 'showStatus'], ret: ['notes', 'showList', 'addNote', 'editNote', 'deleteNote', 'allNotes'], scope: stack.scope });
  const setup = (page) => page.evaluate(async () => {
    window.__renders = []; window.__status = [];
    window.R = await window.__recipe(store, { renderList: (items) => window.__renders.push(items.map((i) => i.meta.title).sort()), showStatus: (s) => window.__status.push(s) });
  });
  const ctx = await newContext(browser);
  const a = await open(ctx, url);
  await setup(a);
  const accessId = await openVault(a, stack);
  await a.evaluate(() => window.__unlock);
  await a.evaluate(() => R.showList());
  expect(await a.evaluate(() => window.__renders.at(-1))).toEqual([]);

  // add, edit with autosave, list
  const alpha = await a.evaluate(() => R.addNote({ title: 'Alpha' }));
  expect(alpha).toMatch(/^[0-9a-z]{10}$/);
  await a.evaluate(async (id) => { window.note = { title: 'Alpha, edited' }; window.saver = R.editNote(id, window.note); window.note.title = 'Alpha, edited again'; window.saver.changed(); await window.saver.flush(); }, alpha);
  expect(await a.evaluate(() => window.__status.includes('saved'))).toBe(true);
  expect(await a.evaluate((id) => R.notes.get(id), alpha)).toEqual({ title: 'Alpha, edited again' });

  // a second device (same browser profile, own page): loads the list, both add at the same time without refreshing
  const b = await open(ctx, url);
  await setup(b);
  await unlockLater(b, accessId);
  await b.evaluate(() => R.showList());
  expect(await b.evaluate(() => window.__renders.at(-1)).then((x) => x.length)).toBe(1);
  await Promise.all([a.evaluate(() => R.addNote({ title: 'Charlie' })), b.evaluate(() => R.addNote({ title: 'Bravo' }))]);
  // a's list may not know Bravo yet; refresh() reads the list and keeps Charlie
  await a.evaluate(() => R.notes.refresh());
  const titles = async (page) => (await page.evaluate(() => R.notes.items().map((i) => i.meta.title))).sort();
  const others = async (page) => (await titles(page)).filter((t) => !t.startsWith('Alpha'));   // the title of Alpha was edited: the list entry follows within 10 seconds
  expect(await others(a)).toEqual(['Bravo', 'Charlie']);
  expect(await titles(a)).toHaveLength(3);
  await b.evaluate(() => R.notes.refresh());
  expect(await others(b)).toEqual(['Bravo', 'Charlie']);
  expect(await titles(b)).toHaveLength(3);

  // onChange: the other device adds a note, this one refreshes (as it does on focus) and the recipe renders the new list
  await a.evaluate(() => { window.__renders = []; });
  await b.evaluate(() => R.addNote({ title: 'Foxtrot' }));
  await a.evaluate(() => R.notes.refresh());
  expect(await a.evaluate(() => window.__renders.length)).toBeGreaterThan(0);
  expect((await a.evaluate(() => window.__renders.at(-1))).filter((t) => !t.startsWith('Alpha'))).toEqual(['Bravo', 'Charlie', 'Foxtrot']);

  // getAll and delete: the entry goes, the other device sees it after refresh
  const all = await a.evaluate(() => R.allNotes());
  expect(all.map((x) => x.value.title).sort()).toEqual(['Alpha, edited again', 'Bravo', 'Charlie', 'Foxtrot']);
  expect(await a.evaluate((id) => R.deleteNote(id), alpha)).toBe(true);
  expect(await titles(a)).toEqual(['Bravo', 'Charlie', 'Foxtrot']);
  await b.evaluate(() => R.notes.refresh());
  expect(await titles(b)).toEqual(['Bravo', 'Charlie', 'Foxtrot']);

  // the index write is lost after the note was stored: addNote returns the id (err.stored), nothing is added twice, the next write carries the entry
  let puts = 0;
  a.ignoreAborted = true;
  await ctx.route(/\/api\/v1\/vaults\/[^/]+\/records\/[^/]+$/, (route) => {
    if (route.request().method() === 'PUT' && ++puts === 2) return route.abort('failed');   // 1: the note, 2: the index
    return route.continue();
  });
  const lost = await a.evaluate(() => R.addNote({ title: 'Delta' }));
  expect(lost).toMatch(/^[0-9a-z]{10}$/);
  expect(await titles(a)).toEqual(['Bravo', 'Charlie', 'Delta', 'Foxtrot']);   // the memory view includes the queued entry
  await b.evaluate(() => R.notes.refresh());
  expect(await titles(b)).toEqual(['Bravo', 'Charlie', 'Foxtrot']);             // the server's list does not have it yet
  await ctx.unroute(/\/api\/v1\/vaults\/[^/]+\/records\/[^/]+$/);
  await a.evaluate(() => R.addNote({ title: 'Echo' }));                    // the next index write carries both
  await b.evaluate(() => R.notes.refresh());
  expect(await titles(b)).toEqual(['Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']);
  await noProblems(a, b);
  await ctx.close();
});

test('conflicts in code: settings merge, keepTheirs, a handler without decision opens the dialog, c.ask()', async ({ browser, stack, md }) => {
  const recipe = blockAfter(md, /^### Conflicts in code$/, 'js');
  const url = harness(md, stack, { recipe, ret: [], scope: stack.scope });
  const ctx = await newContext(browser);
  const messages = [];
  const a = await open(ctx, url);
  a.on('console', (m) => messages.push(m.text()));
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
  expect(await b.evaluate(() => store.get('settings', { fresh: true }))).toEqual({ b: 2, a: 1, c: 3 });

  // timer: keepTheirs
  await a.evaluate(() => store.set('timer', { x: 1 }));
  await b.evaluate(async () => { await store.get('timer'); await store.set('timer', { x: 2 }); });
  const theirs = await a.evaluate(() => store.set('timer', { x: 3 }));
  expect(theirs).toMatchObject({ resolution: 'theirs', value: { x: 2 } });

  // notes/: same text -> keepTheirs in code, no dialog
  await a.evaluate(() => store.set('notes/n2', { text: 'same', other: 1 }));
  await b.evaluate(async () => { await store.get('notes/n2'); await store.set('notes/n2', { text: 'same', other: 2 }); });
  const same = await a.evaluate(() => store.set('notes/n2', { text: 'same', other: 3 }));
  expect(same).toMatchObject({ resolution: 'theirs', value: { text: 'same', other: 2 } });
  await expect(a.locator('[data-wds-view="conflict"]')).toHaveCount(0);

  // notes/: deleted on the other side -> the handler decides nothing, the library's dialog asks
  await a.evaluate(() => store.set('notes/n1', { text: 'one' }));
  await b.evaluate(async () => { await store.get('notes/n1'); await store.remove('notes/n1'); });
  const pending = a.evaluate(() => store.set('notes/n1', { text: 'one, edited' }));
  const dialog = a.locator('[data-wds-view="conflict"]');
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await dialog.locator('[data-wds="conflict-mine"]').click();
  expect((await pending).resolution).toBe('mine');
  expect(await b.evaluate(() => store.get('notes/n1', { fresh: true }))).toEqual({ text: 'one, edited' });

  // notes/: different text -> c.ask() shows the dialog now; the person keeps theirs
  await a.evaluate(() => store.set('notes/n3', { text: 'a' }));
  await b.evaluate(async () => { await store.get('notes/n3'); await store.set('notes/n3', { text: 'b' }); });
  const asked = a.evaluate(() => store.set('notes/n3', { text: 'c' }));
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await dialog.locator('[data-wds="conflict-theirs"]').click();
  expect(await asked).toMatchObject({ resolution: 'theirs', value: { text: 'b' } });
  expect(messages.join('\n')).toContain('the person kept theirs');
  await noProblems(a, b);
  await ctx.close();
});

test('lock and unlock again: handlers registered once, the screen is cleared, an unsaved edit is saved before onLock and kept', async ({ browser, stack, md }) => {
  const recipe = blockAfter(md, /^### Lock and unlock again$/, 'js');
  const url = harness(md, stack, { recipe, params: ['clearScreen', 'unlockButton', 'notes', 'render'], ret: [], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  await page.evaluate(async () => {
    window.__renders = []; window.__locks = []; window.__state = { text: 'start' }; window.__stateReads = [];
    const unlockButton = document.getElementById('unlock');
    window.notes = store.collection('notes/', { meta: (n) => ({ title: n.text }) });
    await window.__recipe(store, {
      clearScreen: (reason) => { window.__locks.push(reason); window.__state = null; document.getElementById('list').replaceChildren(); unlockButton.hidden = false; },
      unlockButton, notes: window.notes,
      render: (items) => { window.__renders.push(items.length); unlockButton.hidden = true; },
    });
  });
  const accessId = await createVault(page, { joinCode: stack.joinCode });
  await expect.poll(() => page.evaluate(() => window.__renders.length)).toBe(1);

  // an unsaved edit, then the lock: the library reads the state once and saves it before the handler clears the screen
  await page.evaluate(() => {
    window.__state = { text: 'edited before the lock' };
    window.__saver = notes.autosave('n1', () => { window.__stateReads.push(window.__state === null ? 'after clear' : 'ok'); return window.__state; }, { delayMs: 60000 });
    window.__saver.changed();
  });
  await page.evaluate(() => store.lock());
  expect(await page.evaluate(() => window.__locks)).toEqual(['user']);
  expect(await page.evaluate(() => window.__stateReads)).toEqual(['ok']);          // read once, before onLock cleared it
  await expect(page.locator('#unlock')).toBeVisible();
  expect(await page.evaluate(() => window.__saver.stopReason)).toBe('lock');

  // the person unlocks again in the same page: start runs once more, once
  await page.locator('#unlock').click();
  await unlockVault(page, accessId);
  await expect.poll(() => page.evaluate(() => window.__renders.length)).toBe(2);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__renders.length)).toBe(2);
  expect(await page.evaluate(() => notes.get('n1'))).toEqual({ text: 'edited before the lock' });
  expect(await page.evaluate(() => window.__stateReads)).toEqual(['ok']);          // never read again
  await noProblems(page);
  await ctx.close();
});

test('files: deleting a note removes its attachments first, then the note', async ({ browser, stack, md }) => {
  const recipe = blockAfter(md, /^### Files$/, 'js');
  const url = harness(md, stack, { recipe, params: ['notes', 'files'], ret: ['deleteNoteWithFiles'], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  await page.evaluate(async () => {
    window.notes = store.collection('notes/', { meta: (n) => ({ title: n.title }) });
    window.files = store.collection('files/');
    window.R = await window.__recipe(store, { notes: window.notes, files: window.files });
  });
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  const ids = await page.evaluate(async () => {
    await files.load();
    const a = (await notes.add({ title: 'with files' })).id, b = (await notes.add({ title: 'other' })).id;
    await files.add(new Blob(['one'], { type: 'text/plain' }), { id: 'f1.txt', meta: { name: 'one.txt', note: a } });
    await files.add(new Blob(['two'], { type: 'text/plain' }), { id: 'f2.txt', meta: { name: 'two.txt', note: a } });
    await files.add(new Blob(['three'], { type: 'text/plain' }), { id: 'f3.txt', meta: { name: 'three.txt', note: b } });
    return { a, b };
  });
  // a file comes back with its type through getBlob, as bytes through get
  expect(await page.evaluate(async () => { const b = await store.getBlob('files/f1.txt'); return [b.type, await b.text(), [...(await files.get('f1.txt'))].length]; })).toEqual(['text/plain', 'one', 3]);
  expect(await page.evaluate((id) => R.deleteNoteWithFiles(id), ids.a)).toBe(true);
  expect(await page.evaluate(() => files.items().map((f) => f.id))).toEqual(['f3.txt']);
  expect(await page.evaluate(() => notes.items().map((n) => n.meta.title))).toEqual(['other']);
  expect(await page.evaluate(() => store.get('files/f1.txt', { fresh: true }))).toBeUndefined();
  await noProblems(page);
  await ctx.close();
});

test('porting step 3: the import of an old export reads a file the person chose', async ({ browser, stack, md }) => {
  const recipe = blockAfter(md, /^### Step 3: own export and import$/, 'js');
  const url = harness(md, stack, { recipe, ret: ['notes', 'importOldExport'], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  await page.evaluate(async () => { window.R = await window.__recipe(store, {}); });
  const accessId = await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  const n = await page.evaluate(() => R.importOldExport(new File([JSON.stringify({ notes: [{ id: 1, title: 'one', text: 'x' }, { id: 2, title: 'two', text: 'y' }] })], 'old.json')));
  expect(n).toBe(2);
  const rows = await page.evaluate(() => R.notes.getAll());
  expect(rows.map((r) => r.value.text).sort()).toEqual(['x', 'y']);
  expect(rows.map((r) => r.meta.title).sort()).toEqual(['one', 'two']);
  const bad = await page.evaluate(() => R.importOldExport(new File(['{"items": []}'], 'x.json')).then(() => 'accepted', (e) => e.message));
  expect(bad).toContain('not an export of the old version');
  // the variant that keeps the old ids: references are rewritten, the old order and creation dates stay, a second import overwrites instead of doubling
  const keep = blockAfter(md, /^### Step 3: own export and import$/, 'js', 1);
  const url2 = harness(md, stack, { recipe: blockAfter(md, /^### Step 3: own export and import$/, 'js') + '\n' + keep, ret: ['notes', 'files', 'importOldExportKeepingIds'], scope: stack.scope });
  const page2 = await open(ctx, url2);
  await page2.evaluate(async () => { window.R = await window.__recipe(store, {}); });
  await unlockLater(page2, accessId);
  const old = { notes: [{ id: 12, title: 'twelve', text: 'a', created: 1700000012000 }, { id: 3, title: 'three', text: 'b', created: 1700000003000 }],
    files: [{ id: 7, noteId: 12, name: 'plan.pdf', type: 'application/pdf', base64: Buffer.from([37, 80, 68, 70, 1]).toString('base64') }] };
  expect(await page2.evaluate((o) => R.importOldExportKeepingIds(new File([JSON.stringify(o)], 'old.json')), old)).toBe(3);
  expect(await page2.evaluate((o) => R.importOldExportKeepingIds(new File([JSON.stringify(o)], 'old.json')), old)).toBe(3);          // again: no conflict, no copies
  const kept = await page2.evaluate(async () => { await R.notes.refresh(); await R.files.refresh(); return { notes: R.notes.items().map((i) => [i.id, i.created]), files: R.files.items().map((i) => [i.id, i.meta]) }; });
  expect(kept.notes.filter(([id]) => /^j\d+$/.test(id)).sort()).toEqual([['j12', 1700000012000], ['j3', 1700000003000]]);       // (the two notes of the first import have random ids)
  expect(kept.files).toEqual([['j7.pdf', { name: 'plan.pdf', note: 'j12' }]]);
  expect(await page2.evaluate(() => store.get('files/j7.pdf', { fresh: true }).then((b) => [...b]))).toEqual([37, 80, 68, 70, 1]);
  await noProblems(page2);
  await noProblems(page);
  await ctx.close();
});

// ---- the one-time migration ----

const MIGRATION = (md) => blockAfter(md, /^### Step 4: data that is still in the browsers of existing users$/, 'js');
const SEED = String.raw`
  window.seedOld = async function (opts) {
    opts = opts || {};
    await new Promise((ok, fail) => {
      const req = indexedDB.open('oldapp', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('notes', { keyPath: 'id' }); req.result.createObjectStore('files', { keyPath: 'id' });
        if (opts.meta) req.result.createObjectStore('meta');                                    // a key-value store: out-of-line keys, put(value, key)
      };
      req.onsuccess = () => {
        const db = req.result, tx = db.transaction(['notes', 'files'].concat(db.objectStoreNames.contains('meta') ? ['meta'] : []), 'readwrite');
        if (opts.meta && db.objectStoreNames.contains('meta')) { tx.objectStore('meta').put(opts.timer || { project: 'p1', start: 1700000000000 }, 'timer'); tx.objectStore('meta').put(opts.lang || 'de', 'lang'); }
        tx.objectStore('notes').put({ id: 1, title: opts.title1 || 'Old one', text: 'text of the first old note, with Umlauts: äöü', created: 1700000000000 });
        tx.objectStore('notes').put({ id: 2, title: 'Old two', text: 'text of the second old note', created: 1700000001000 });
        tx.objectStore('files').put({ id: 7, noteId: 1, name: 'plan.pdf', type: 'application/pdf', data: new Uint8Array([37, 80, 68, 70, 1, 2, 3, 250, 251, 252]).buffer });   // bytes as an ArrayBuffer: WebKit cannot store a Blob in IndexedDB on file://
        if (opts.bigBytes) tx.objectStore('files').put({ id: 8, noteId: 2, name: 'huge.bin', type: '', data: new ArrayBuffer(opts.bigBytes) });
        tx.oncomplete = () => { db.close(); ok(); };
        tx.onerror = () => fail(tx.error);
      };
      req.onerror = () => fail(req.error);
    });
    localStorage.setItem('oldapp:prefs', JSON.stringify(opts.prefs || { theme: 'dark' }));
    localStorage.setItem('oldapp:avatar', 'data:image/png;base64,iVBORw0KGgo=');            // a picture kept as a data URL in localStorage
    window.__blobSeeded = false;
    if (opts.blob) await new Promise((ok) => {                                              // a File in the old store (value.blob); WebKit cannot store one on file://: then nothing is seeded
      const r = indexedDB.open('oldapp');
      r.onerror = () => ok();
      r.onsuccess = () => {
        const db = r.result;
        try {
          const tx = db.transaction('files', 'readwrite');
          tx.objectStore('files').put({ id: 9, noteId: 2, name: 'photo.png', type: 'image/png', blob: opts.blob === 'plain' ? new Blob([new Uint8Array([137, 80, 78, 71, 9, 8, 7, 6])], { type: 'image/png' }) : new File([new Uint8Array([137, 80, 78, 71, 9, 8, 7, 6])], 'photo.png', { type: 'image/png', lastModified: 1700000002000 }) });
          tx.oncomplete = () => { db.close(); window.__blobSeeded = true; ok(); };
          tx.onabort = () => { db.close(); ok(); };
        } catch (e) { db.close(); ok(); }
      };
    });
  };
  window.touchOldBlob = (lastModified, plain) => new Promise((ok, fail) => {                // "the old app replaced the file": the same name, size, type and (by default) modification time, one other byte
    const r = indexedDB.open('oldapp');
    const bytes = new Uint8Array([137, 80, 78, 71, 9, 8, 7, 7]);
    r.onsuccess = () => { const db = r.result, tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put({ id: 9, noteId: 2, name: 'photo.png', type: 'image/png', blob: plain ? new Blob([bytes], { type: 'image/png' }) : new File([bytes], 'photo.png', { type: 'image/png', lastModified: lastModified || 1700000002000 }) }); tx.oncomplete = () => { db.close(); ok(); }; tx.onerror = () => fail(tx.error); };
    r.onerror = () => fail(r.error);
  });
  window.changeOldSettings = (o) => new Promise((ok, fail) => {                            // "the old app, used again": its settings change
    if (o.prefs) localStorage.setItem('oldapp:prefs', JSON.stringify(o.prefs));
    const r = indexedDB.open('oldapp');
    r.onsuccess = () => { const db = r.result; if (!o.timer || !db.objectStoreNames.contains('meta')) { db.close(); return ok(); } const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(o.timer, 'timer'); tx.oncomplete = () => { db.close(); ok(); }; tx.onerror = () => fail(tx.error); };
    r.onerror = () => fail(r.error);
  });
  window.addOldRow = () => new Promise((ok, fail) => {                                // "the old app, used again in another tab"
    const req = indexedDB.open('oldapp');
    req.onsuccess = () => { const db = req.result, tx = db.transaction('notes', 'readwrite'); tx.objectStore('notes').put({ id: 3, title: 'Old three', text: 'written after the copy' }); tx.oncomplete = () => { db.close(); ok(); }; tx.onerror = () => fail(tx.error); };
    req.onerror = () => fail(req.error);
  });
  window.__questions = []; window.__downloads = []; window.__answer = true; window.__answerQueue = []; window.__failDownload = false; window.__onDownload = null;
  window.__ui = {                                                                // the app's own dialogs, as the recipe expects them
    confirm: async (q) => { window.__questions.push(q); return window.__answerQueue.length ? window.__answerQueue.shift() : window.__answer; },
    offerDownload: async (blob, name) => { if (window.__failDownload) throw new Error('download dialog failed'); window.__downloads.push({ name, size: blob.size, text: blob.size < 100000 ? await blob.text() : '' }); if (window.__onDownload) await window.__onDownload(name); },
  };
  window.oldState = async function () {                                            // db: the database exists; rows: how many rows it holds (an emptied database stays, it is empty)
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    const db = dbs.some((d) => d.name === 'oldapp');
    let rows = 0;
    if (db) {
      const conn = await new Promise((ok, fail) => { const r = indexedDB.open('oldapp'); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
      for (const name of ['notes', 'files', 'meta']) if (conn.objectStoreNames.contains(name)) rows += await new Promise((ok) => { const r = conn.transaction(name).objectStore(name).count(); r.onsuccess = () => ok(r.result); });
      conn.close();
    }
    return { db, rows, prefs: localStorage.getItem('oldapp:prefs'), avatar: localStorage.getItem('oldapp:avatar'), tag: localStorage.getItem('oldapp:migration-tag') };
  };
`;
function migrationUrl(md, stack, scope, origin, { untagged = false } = {}) {
  let recipe = MIGRATION(md);
  if (untagged) { expect(recipe).toContain('lock: "oldapp-migration", tagged: true };'); recipe = recipe.replace('lock: "oldapp-migration", tagged: true };', 'lock: "oldapp-migration", tagged: false };'); }
  return harness(md, stack, { recipe, ret: ['OLD', 'notes', 'files', 'migrateOldData', 'migratedSettings', 'settingsDone', 'fillGaps', 'openOldDb', 'removeOldData', 'toNewRecords'], scope, origin, extraHead: '<script>' + SEED + '</script>' });
}
// An engine without IndexedDB for file:// pages has no old database to seed (the recipe then looks at localStorage only); these tests need IndexedDB.
async function idbAvailable(page) { return page.evaluate(() => { try { return typeof indexedDB !== 'undefined' && !!indexedDB.open('probe-' + Math.random()); } catch (e) { return false; } }); }
async function migrationPage(ctx, url, testInfo) {
  const page = await open(ctx, url);
  if (testInfo && !(await idbAvailable(page))) {
    expect(await page.evaluate(async () => { const R = await window.__recipe(store, {}); return R.migrateOldData({}); })).toEqual({ status: 'nothing' });   // the recipe copes: nothing to migrate
    testInfo.skip(true, 'this engine has no IndexedDB for file:// pages');
  }
  await page.evaluate(async () => { window.R = await window.__recipe(store, {}); });
  return page;
}
const runMigration = (page) => page.evaluate(() => R.migrateOldData(window.__ui));

test('porting step 4: the owner migrates IndexedDB and localStorage, the old data is emptied, nothing is written twice, a second browser with the same old ids does not collide', async ({ browser, stack, md }) => {
  const url = migrationUrl(md, stack, stack.scope);
  const ctx1 = await newContext(browser), ctx2 = await newContext(browser);
  const one = await migrationPage(ctx1, url, test.info());
  const accessId = await openVault(one, stack);
  await one.evaluate(() => window.__unlock);
  expect(await one.evaluate(() => store.status())).toMatchObject({ role: 'owner', sandbox: false });

  // nothing to migrate yet
  expect(await runMigration(one)).toEqual({ status: 'nothing' });
  expect(await one.evaluate(() => oldState())).toEqual({ db: false, rows: 0, prefs: null, avatar: null, tag: null });      // looking must not create the old database or the tag

  await one.evaluate(() => seedOld());
  // two runs at the same moment (two tabs of the new app): the lock lets one migrate, the other finds nothing left
  const both = await one.evaluate(() => Promise.all([R.migrateOldData(window.__ui), R.migrateOldData(window.__ui)]));
  const res = both.find((r) => r.status === 'migrated');
  expect(res).toMatchObject({ status: 'migrated', deleted: 'deleted', count: 5, tooLarge: [] });   // 2 notes, the pdf, the avatar picture, the settings record
  if (await one.evaluate(() => !!navigator.locks)) expect(both.map((r) => r.status).sort()).toEqual(['migrated', 'nothing']);
  // the question names the vault by the end of its access ID, not in full
  const question = (await one.evaluate(() => window.__questions))[0];
  expect(question).toContain('ends in ' + accessId.slice(-4));
  expect(question).not.toContain(accessId);
  expect(question).toContain('delete them from this browser');
  // the old storage is empty: stores, own keys (an emptied database stays, it holds nothing); the tag stays, it is no user data and names this browser in the vault
  expect(await one.evaluate(() => oldState())).toMatchObject({ rows: 0, prefs: null, avatar: null, tag: expect.stringMatching(/^[0-9a-f]{8}$/) });
  // the person got a copy of the old data before it went
  const dl = (await one.evaluate(() => window.__downloads))[0];
  expect(dl.name).toBe('oldapp-backup.json');
  const backup = JSON.parse(dl.text);
  expect(backup.notes.map((r) => r.value.title)).toEqual(['Old one', 'Old two']);
  expect(backup.local.map((r) => r.key).sort()).toEqual(['oldapp:avatar', 'oldapp:prefs']);
  // the vault holds everything under tagged ids (the key type is part of the id); references were remapped; the file bytes are intact; the creation dates survive; the marker is written
  const items = await one.evaluate(async () => { await R.notes.refresh(); await R.files.refresh(); return { notes: R.notes.items(), files: R.files.items() }; });
  const tag1 = items.notes[0].id.split('-')[0];
  expect(items.notes.map((i) => i.id)).toEqual([tag1 + '-j1', tag1 + '-j2']);
  expect(items.notes.map((i) => i.created)).toEqual([1700000000000, 1700000001000]);
  expect(items.files.map((i) => i.id).sort()).toEqual([tag1 + '-j7.pdf', tag1 + '-soldapp%3Aavatar'].sort());
  expect(items.files.find((i) => i.id.endsWith('.pdf')).meta).toEqual({ name: 'plan.pdf', note: tag1 + '-j1' });
  expect(await one.evaluate((id) => store.get('files/' + id, { fresh: true }).then((b) => [...b]), tag1 + '-j7.pdf')).toEqual([37, 80, 68, 70, 1, 2, 3, 250, 251, 252]);
  expect(await one.evaluate((id) => store.get('files/' + id, { fresh: true }).then((b) => [...b]), tag1 + '-soldapp%3Aavatar')).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(await one.evaluate((t) => store.get('migrated/' + t + '/local', { fresh: true }), tag1)).toEqual({ 'oldapp:prefs': '{"theme":"dark"}' });          // the strings of localStorage
  const marker = await one.evaluate((t) => store.get('migration/' + t, { fresh: true }), tag1);
  expect(marker).toMatchObject({ tag: tag1, counts: { notes: 2, files: 1, local: 2 }, tooLarge: [], settings: 'pending' });
  expect(typeof marker.digest).toBe('string');
  expect(await one.evaluate((id) => R.notes.get(id), tag1 + '-j1')).toEqual({ title: 'Old one', text: 'text of the first old note, with Umlauts: äöü' });
  // running it again finds nothing and writes nothing
  expect(await runMigration(one)).toEqual({ status: 'nothing' });

  // a second browser of the same person: the same old ids 1, 2 and 7 (another tag), the same vault
  const two = await migrationPage(ctx2, url, test.info());
  await unlockLater(two, accessId);
  await two.evaluate(() => seedOld());
  expect(await runMigration(two)).toMatchObject({ status: 'migrated', deleted: 'deleted', count: 5 });
  await one.evaluate(async () => { await R.notes.refresh(); await R.files.refresh(); });
  const after = await one.evaluate(() => ({ notes: R.notes.items().map((i) => i.id), files: R.files.items().map((i) => i.id) }));
  expect(after.notes).toHaveLength(4);
  expect(after.files).toHaveLength(4);
  expect(new Set(after.notes.map((id) => id.split('-')[0])).size).toBe(2);
  // nothing of the first migration was touched
  expect(await one.evaluate((id) => R.notes.get(id), tag1 + '-j2')).toEqual({ title: 'Old two', text: 'text of the second old note' });
  await noProblems(one, two);
  await ctx1.close(); await ctx2.close();
});

test('porting step 4: declined, interrupted, did not fit: the old data is kept, a rerun continues without duplicates', async ({ browser, stack, md }) => {
  const url = migrationUrl(md, stack, stack.scope);
  const ctx = await newContext(browser);
  const page = await migrationPage(ctx, url, test.info());
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);

  // declined: nothing is written, the old data stays (the tag is the one write to the old storage)
  await page.evaluate(() => seedOld());
  await page.evaluate(() => { window.__answer = false; });
  expect(await runMigration(page)).toEqual({ status: 'declined' });
  let state = await page.evaluate(() => oldState());
  expect(state.rows).toBe(3);
  expect(state.prefs).not.toBeNull();
  expect(state.avatar).not.toBeNull();
  expect(await page.evaluate(() => R.notes.load().then((l) => l.length))).toBe(0);

  // interrupted after the copy was verified (the download dialog fails): failed, old data kept, the vault has the copy
  await page.evaluate(() => { window.__answer = true; window.__failDownload = true; });
  const failed = await runMigration(page);
  expect(failed).toMatchObject({ status: 'failed', note: 'the old data was kept' });
  expect(failed.why).toContain('download dialog failed');
  state = await page.evaluate(() => oldState());
  expect(state.rows).toBe(3);
  expect(await page.evaluate(() => R.notes.refresh().then((l) => l.length))).toBe(2);
  const tag = state.tag;

  // rerun: continues, writes nothing twice, finishes and empties the old storage
  await page.evaluate(() => { window.__failDownload = false; });
  let writes = 0;
  await ctx.route(/\/api\/v1\/vaults\/[^/]+\/records\/[^/]+$/, (route) => { if (route.request().method() === 'PUT') writes++; return route.continue(); });
  expect(await runMigration(page)).toMatchObject({ status: 'migrated', deleted: 'deleted' });
  expect(writes).toBe(1);                                                             // only the migration marker
  expect(await page.evaluate(() => oldState())).toMatchObject({ rows: 0, prefs: null, avatar: null });
  expect(await page.evaluate(() => R.notes.refresh().then((l) => l.length))).toBe(2);
  expect(await page.evaluate((t) => store.get('migration/' + t, { fresh: true }), tag)).toMatchObject({ tag });
  await ctx.unroute(/\/api\/v1\/vaults\/[^/]+\/records\/[^/]+$/);

  // does not fit: the vault is (said to be) almost full: nothing is written, nothing deleted (the old app was used again, so the verified copy of the marker does not cover it)
  await page.evaluate(async () => { await seedOld(); await addOldRow(); });
  await ctx.route(/\/api\/v1\/vaults\/[^/]+\/usage$/, async (route) => {
    const r = await route.fetch(), j = await r.json();
    return route.fulfill({ response: r, json: { ...j, bytes: j.limits.vault_bytes - 10 } });
  });
  const full = await runMigration(page);
  await ctx.unroute(/\/api\/v1\/vaults\/[^/]+\/usage$/);
  expect(full.status).toBe('failed');
  expect(full.why).toContain('does not fit');
  expect((await page.evaluate(() => oldState())).rows).toBe(4);
  expect(await page.evaluate(() => R.notes.refresh().then((l) => l.length))).toBe(2);
  await noProblems(page);
  await ctx.close();
});

test('porting step 4: a record too large for the vault becomes a download; the old data goes only after the second confirmation', async ({ browser, stack, md }) => {
  const url = migrationUrl(md, stack, stack.scope);
  const ctx = await newContext(browser);
  const page = await migrationPage(ctx, url, test.info());
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  await page.evaluate(() => seedOld({ bigBytes: 11 * 1024 * 1024 }));
  // the person says yes to the copy and no to deleting what exists only as a download
  await page.evaluate(() => { window.__answerQueue = [true, false]; });
  const partial = await runMigration(page);
  expect(partial).toMatchObject({ status: 'partial', deleted: 'kept' });
  expect(partial.tooLarge).toHaveLength(1);
  expect(partial.tooLarge[0]).toMatch(/^files\/[0-9a-f]{8}-j8\.?/);
  const questions = await page.evaluate(() => window.__questions);
  expect(questions[0]).toContain('too large for the vault');
  expect(questions[1]).toContain('Delete the old data anyway?');
  expect((await page.evaluate(() => window.__downloads)).map((d) => d.name)).toEqual(['oldapp-backup.json', expect.stringMatching(/^oldapp-files-/)]);
  expect((await page.evaluate(() => window.__downloads))[1].size).toBe(11 * 1024 * 1024);
  const kept = await page.evaluate(() => oldState());
  expect(kept.rows).toBe(4);                                                          // nothing deleted
  expect(await page.evaluate(() => R.notes.refresh().then((l) => l.length))).toBe(2);   // the rest was copied
  // the next start asks again; this time the person confirms: the rest was copied before, the old data goes
  await page.evaluate(() => { window.__answerQueue = [true, true]; window.__downloads = []; });
  expect(await runMigration(page)).toMatchObject({ status: 'migrated', deleted: 'deleted' });
  expect(await page.evaluate(() => oldState())).toMatchObject({ rows: 0, prefs: null, avatar: null });
  expect(await page.evaluate(() => R.notes.refresh().then((l) => l.length))).toBe(2);
  await noProblems(page);
  await ctx.close();
});

test('porting step 4: the old app is used again between the copy and the delete: nothing is deleted, the next run copies what is new; an index entry that never landed is repaired', async ({ browser, stack, md }) => {
  const url = migrationUrl(md, stack, stack.scope);
  const ctx = await newContext(browser);
  const page = await migrationPage(ctx, url, test.info());
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  await page.evaluate(() => seedOld());
  // another tab of the old app writes a row while the person looks at the download dialog (after the verified copy, before the delete)
  await page.evaluate(() => { window.__onDownload = async (name) => { if (name === 'oldapp-backup.json') { window.__onDownload = null; await addOldRow(); } }; });
  const first = await runMigration(page);
  expect(first).toMatchObject({ status: 'migrated', deleted: 'changed' });
  let state = await page.evaluate(() => oldState());
  expect(state.rows).toBe(4);                                                         // all rows are still there, including the new one
  expect(state.prefs).not.toBeNull();
  expect(state.tag).not.toBeNull();                                                   // the tag stays: the rerun uses the same ids
  const tag = state.tag;
  expect(await page.evaluate(() => R.notes.refresh().then((l) => l.length))).toBe(2);
  // the next start: the marker does not match the old data any more, so the whole flow runs; only the new row is written
  let writes = 0;
  await ctx.route(/\/api\/v1\/vaults\/[^/]+\/records\/[^/]+$/, (route) => { if (route.request().method() === 'PUT') writes++; return route.continue(); });
  expect(await runMigration(page)).toMatchObject({ status: 'migrated', deleted: 'deleted', count: 6 });
  expect(writes).toBe(3);                                                             // the new note, its list entry, the marker
  await ctx.unroute(/\/api\/v1\/vaults\/[^/]+\/records\/[^/]+$/);
  expect((await page.evaluate(() => oldState())).rows).toBe(0);
  expect(await page.evaluate(() => R.notes.refresh().then((l) => l.length))).toBe(3);

  // an interrupted run that stored items but never wrote their list entries (the tab closed): the next run finds and repairs them
  await page.evaluate(() => seedOld());
  const tag2 = await page.evaluate(() => { localStorage.setItem('oldapp:migration-tag', 'abcd1234'); return 'abcd1234'; });
  await page.evaluate(async (t) => {                                                   // the entities of an earlier run (same content), but no index entries
    await store.set('notes/' + t + '-j1', { title: 'Old one', text: 'text of the first old note, with Umlauts: äöü' });
    await store.set('notes/' + t + '-j2', { title: 'Old two', text: 'text of the second old note' });
  }, tag2);
  await page.evaluate(() => { window.__answer = true; });
  const repaired = await runMigration(page);
  expect(repaired).toMatchObject({ status: 'migrated', deleted: 'deleted' });
  const ids = await page.evaluate(() => R.notes.refresh().then((l) => l.map((i) => i.id)));
  expect(ids).toEqual(expect.arrayContaining(['abcd1234-j1', 'abcd1234-j2']));
  expect(await page.evaluate(() => R.notes.items().find((i) => i.id === 'abcd1234-j1').meta)).toEqual({ title: 'Old one' });   // the repaired entry has its meta
  await noProblems(page);
  await ctx.close();
});

test('porting step 4: Blob and File values and a key-value store in IndexedDB; the old settings are applied once, only where the vault has none', async ({ browser, stack, md }) => {
  const url = migrationUrl(md, stack, stack.scope);
  const ctx = await newContext(browser);
  const page = await migrationPage(ctx, url, test.info());
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  await page.evaluate(() => seedOld({ meta: true, blob: true }));
  const blob = await page.evaluate(() => window.__blobSeeded);
  const res = await runMigration(page);
  // 2 notes, the pdf (bytes), the avatar (data URL), the settings of localStorage, the key-value rows, and the File
  expect(res).toMatchObject({ status: 'migrated', deleted: 'deleted', count: blob ? 7 : 6, tooLarge: [] });
  expect(res.tag).toMatch(/^[0-9a-f]{8}$/);
  expect(await page.evaluate(() => oldState())).toMatchObject({ rows: 0, prefs: null, avatar: null });   // the key-value store is emptied too
  const tag = res.tag;
  // the key-value rows of IndexedDB are one record, next to the one of localStorage
  expect(await page.evaluate((t) => store.get('migrated/' + t + '/meta', { fresh: true }), tag)).toEqual({ lang: 'de', timer: { project: 'p1', start: 1700000000000 } });
  expect(await page.evaluate((t) => store.get('migrated/' + t + '/local', { fresh: true }), tag)).toEqual({ 'oldapp:prefs': '{"theme":"dark"}' });
  const marker = await page.evaluate((t) => store.get('migration/' + t, { fresh: true }), tag);
  expect(marker.counts).toMatchObject({ notes: 2, meta: 2, local: 2, files: blob ? 2 : 1 });
  // the backup file: bytes as { size }, a File as { size, type, name } (a plain JSON.stringify would write {})
  const backup = JSON.parse((await page.evaluate(() => window.__downloads))[0].text);
  expect(backup.files.find((r) => r.key === 7).value.data).toEqual({ size: 10 });
  expect(backup.meta.map((r) => r.key)).toEqual(['lang', 'timer']);
  if (blob) {
    expect(backup.files.find((r) => r.key === 9).value.blob).toEqual({ size: 8, type: 'image/png', name: 'photo.png' });
    const id = tag + '-j9.png';
    const stored = await page.evaluate(async (i) => { const b = await store.getBlob('files/' + i); return [b.type, [...new Uint8Array(await b.arrayBuffer())]]; }, id);
    expect(stored).toEqual(['image/png', [137, 80, 78, 71, 9, 8, 7, 6]]);
    expect(await page.evaluate((i) => R.files.refresh().then((l) => l.find((f) => f.id === i).meta), id)).toEqual({ name: 'photo.png', note: tag + '-j2' });
  }
  // the settings are taken over exactly once, and the state is in the vault: until the app says it saved them they are offered again, whatever a start returned
  const waiting = { tag, local: { 'oldapp:prefs': '{"theme":"dark"}' }, meta: { lang: 'de', timer: { project: 'p1', start: 1700000000000 } } };      // localStorage values stay strings
  expect(await page.evaluate(() => R.migratedSettings())).toEqual(waiting);
  expect(marker.settings).toBe('pending');
  expect(await runMigration(page)).toEqual({ status: 'nothing' });                      // a later start, the page was closed before the app saved the settings
  expect(await page.evaluate(() => R.migratedSettings())).toEqual(waiting);              // nothing is lost
  // a browser that never migrated asks for nothing: no request, no dialog
  const fresh = await migrationPage(await newContext(browser), url, test.info());
  expect(await fresh.evaluate(() => R.migratedSettings())).toBeNull();
  expect(await fresh.locator('[data-wds-view]').count()).toBe(0);
  // ... and only where the vault has no value: a language that is set stays, a missing timer is taken over
  expect(await page.evaluate(() => R.fillGaps({ lang: 'en', timer: null }, { lang: 'de', timer: { project: 'p1' }, theme: 'dark' }))).toEqual({ lang: 'en', timer: { project: 'p1' }, theme: 'dark' });
  expect(await page.evaluate(() => R.fillGaps({}, {}))).toEqual({});
  // the usage shown at the end of the recipe, as the app would write it
  await page.evaluate(async () => {
    await store.set('settings', { lang: 'en' });
    const old = await R.migratedSettings();
    if (old) {
      const prefs = JSON.parse(old.local['oldapp:prefs'] || 'null') || {};
      await store.set('settings', R.fillGaps((await store.get('settings')) || {}, { lang: old.meta.lang, theme: prefs.theme }));
      await R.settingsDone(old);
    }
  });
  expect(await page.evaluate(() => store.get('settings', { fresh: true }))).toEqual({ lang: 'en', theme: 'dark' });
  expect(await page.evaluate(() => R.migratedSettings())).toBeNull();                    // never offered again
  expect(await page.evaluate((t) => store.get('migration/' + t, { fresh: true }), tag)).toMatchObject({ settings: 'applied' });
  await noProblems(page);
  await ctx.close();
});

// A Blob replaced during the run by one with the same size, type, name and modification time: only its bytes differ. The bytes are part of the fingerprint now.
for (const plain of [false, true]) {
  test('porting step 4: ' + (plain ? 'a plain Blob (no name, no modification time)' : 'a File') + ' replaced during the run by one that differs only in its bytes is noticed: nothing is deleted; the next run reports the difference instead of overwriting', async ({ browser, stack, md }) => {
    const url = migrationUrl(md, stack, stack.scope);
    const ctx = await newContext(browser);
    const page = await migrationPage(ctx, url, test.info());
    await openVault(page, stack);
    await page.evaluate(() => window.__unlock);
    await page.evaluate((p) => seedOld({ blob: p ? 'plain' : true }), plain);
    test.skip(!(await page.evaluate(() => window.__blobSeeded)), 'this engine cannot store a Blob in IndexedDB on file:// pages');
    await page.evaluate((p) => { window.__onDownload = async (name) => { if (name === 'oldapp-backup.json') { window.__onDownload = null; await touchOldBlob(undefined, p); } }; }, plain);
    const first = await runMigration(page);
    expect(first).toMatchObject({ status: 'migrated', deleted: 'changed' });
    expect((await page.evaluate(() => oldState())).rows).toBe(4);                      // 2 notes, the pdf, the Blob: all still there
    // the next start: the marker does not match, the whole flow runs; the Blob of the old app (another last byte) differs from the copy in the vault: that run fails and keeps the old data
    const second = await runMigration(page);
    expect(second.status).toBe('failed');
    expect(second.why).toContain('-j9.png');
    expect((await page.evaluate(() => oldState())).rows).toBe(4);
    await noProblems(page);
    await ctx.close();
  });
}

test('porting step 4: the settings are snapshots: changed in the old app meanwhile the rerun still finishes; once taken over they are never offered again, whatever the old app does afterwards', async ({ browser, stack, md }) => {
  const url = migrationUrl(md, stack, stack.scope);
  const ctx = await newContext(browser);
  const page = await migrationPage(ctx, url, test.info());
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  await page.evaluate(() => seedOld({ meta: true }));
  // another tab of the old app changes the timer and a preference between the copy and the delete (the running timer of a meta store changes often)
  await page.evaluate(() => { window.__onDownload = async (name) => { if (name === 'oldapp-backup.json') { window.__onDownload = null; await changeOldSettings({ prefs: { theme: 'light' }, timer: { project: 'p9', start: 1700000009999 } }); } }; });
  const first = await runMigration(page);
  expect(first).toMatchObject({ status: 'migrated', deleted: 'changed' });
  const tag = first.tag;
  expect(await page.evaluate((t) => store.get('migrated/' + t + '/meta', { fresh: true }), tag)).toMatchObject({ timer: { project: 'p1' } });      // the snapshot of the first run
  // the rerun: the settings records of the vault differ from the old app's now: they are overwritten, the run is not "failed"
  const second = await runMigration(page);
  expect(second).toMatchObject({ status: 'migrated', deleted: 'deleted', tag });
  expect(await page.evaluate((t) => store.get('migrated/' + t + '/meta', { fresh: true }), tag)).toEqual({ lang: 'de', timer: { project: 'p9', start: 1700000009999 } });
  expect(await page.evaluate((t) => store.get('migrated/' + t + '/local', { fresh: true }), tag)).toEqual({ 'oldapp:prefs': '{"theme":"light"}' });
  const old = await page.evaluate(() => R.migratedSettings());
  expect(old.meta.timer.project).toBe('p9');
  await page.evaluate(async () => { await store.set('settings', { lang: 'de', timer: null }); await R.settingsDone(await R.migratedSettings()); });   // the person stopped the timer in the new app
  // the old app is used again (a stale tab), a full run follows: the stopped timer stays stopped
  await page.evaluate(() => seedOld({ meta: true, timer: { project: 'p7', start: 1700000007777 }, prefs: { theme: 'blue' } }));
  const third = await runMigration(page);
  expect(third).toMatchObject({ status: 'migrated', deleted: 'deleted', tag });
  expect(third.count).toBe(4);                                                          // 2 notes, the pdf and the avatar: the settings are not copied again
  expect(await page.evaluate(() => R.migratedSettings())).toBeNull();
  expect(await page.evaluate((t) => store.get('migrated/' + t + '/meta', { fresh: true }), tag)).toMatchObject({ timer: { project: 'p9' } });
  expect(await page.evaluate(() => store.get('settings', { fresh: true }))).toEqual({ lang: 'de', timer: null });
  await noProblems(page);
  await ctx.close();
});

test('porting step 4 without the tag in the ids: they stay short; the same data from a second browser is one copy; settings and marker stay per browser, so different settings never collide; data that differs stops that run', async ({ browser, stack, md }) => {
  const url = migrationUrl(md, stack, stack.scope, undefined, { untagged: true });
  const ctx1 = await newContext(browser), ctx2 = await newContext(browser);
  const one = await migrationPage(ctx1, url, test.info());
  const accessId = await openVault(one, stack);
  await one.evaluate(() => window.__unlock);
  await one.evaluate(() => seedOld({ meta: true }));
  const res = await runMigration(one);
  expect(res).toMatchObject({ status: 'migrated', deleted: 'deleted', count: 6 });
  expect(res.tag).toMatch(/^[0-9a-f]{8}$/);                                              // a tag per browser also here: the marker and the settings are named by it
  expect((await one.evaluate(() => oldState())).tag).toBe(res.tag);
  const ids = await one.evaluate(async () => { await R.notes.refresh(); await R.files.refresh(); return { notes: R.notes.items().map((i) => i.id), files: R.files.items().map((i) => i.id).sort() }; });
  expect(ids.notes).toEqual(['j1', 'j2']);                                               // no tag in the item ids
  expect(ids.files).toEqual(['j7.pdf', 'soldapp%3Aavatar']);

  // a second browser holding the same items but other settings (another language, another theme): the items are one copy, the settings are its own
  const two = await migrationPage(ctx2, url, test.info());
  await unlockLater(two, accessId);
  await two.evaluate(() => seedOld({ meta: true, lang: 'fr', prefs: { theme: 'light' } }));
  const res2 = await runMigration(two);
  expect(res2).toMatchObject({ status: 'migrated', deleted: 'deleted', count: 6 });      // not "again": its marker is its own
  expect(res2.tag).not.toBe(res.tag);
  expect((await two.evaluate(() => oldState())).rows).toBe(0);
  await one.evaluate(async () => { await R.notes.refresh(); await R.files.refresh(); });
  expect(await one.evaluate(() => [R.notes.items().length, R.files.items().length])).toEqual([2, 2]);
  expect((await one.evaluate(() => R.migratedSettings())).meta.lang).toBe('de');
  expect((await two.evaluate(() => R.migratedSettings())).meta.lang).toBe('fr');
  expect((await two.evaluate(() => R.migratedSettings())).local).toEqual({ 'oldapp:prefs': '{"theme":"light"}' });

  // the second browser changed one note: the ids meet, the values differ: that run fails, names the item, keeps the old data, overwrites nothing
  await two.evaluate(() => seedOld({ meta: true, title1: 'Old one, edited in the second browser' }));
  const clash = await runMigration(two);
  expect(clash.status).toBe('failed');
  expect(clash.why).toContain('did not come back');
  expect(clash.why).toContain('notes/j1');
  expect(clash.why).toContain('the old data was kept');
  expect((await two.evaluate(() => oldState())).rows).toBe(5);
  expect(await one.evaluate(() => R.notes.get('j1'))).toEqual({ title: 'Old one', text: 'text of the first old note, with Umlauts: äöü' });
  await noProblems(one, two);
  await ctx1.close(); await ctx2.close();
});

test('porting step 4: toNewRecords stops for a row it cannot map instead of copying something wrong; Dates, numeric keys and a Blob as the row value work', async ({ browser, stack, md }) => {
  const url = migrationUrl(md, stack, stack.scope);
  const ctx = await newContext(browser);
  const page = await migrationPage(ctx, url, test.info());
  const rows = (o) => ({ local: [], meta: [], notes: [], files: [], ...o });
  const tryRows = (o) => page.evaluate((x) => { try { return { ok: R.toNewRecords(x, 'abcd1234').map((i) => ({ id: i.id, name: i.name, created: i.created, meta: i.meta, size: i.value instanceof Blob ? i.value.size : null })) }; } catch (e) { return { error: e.message }; } }, o);
  // a field named like nothing the recipe knows: not "undefined" bytes, an error with the key
  expect((await tryRows(rows({ files: [{ key: 5, value: { id: 5, noteId: 1, name: 'a.pdf', pdf: 'x' } }] }))).error).toMatch(/old row 5: neither a Blob nor bytes in \.data \(adapt toNewRecords\)/);
  // a value that holds a Blob, a Map or a Set would be written as {}
  for (const what of ['Blob', 'Map', 'Set']) {
    const r = await page.evaluate((w) => {
      const make = { Blob: () => new Blob(['x']), Map: () => new Map([[1, 2]]), Set: () => new Set([1]) }[w];
      try { R.toNewRecords({ local: [], meta: [], files: [], notes: [{ key: 3, value: { title: 't', text: make() } }] }, 'abcd1234'); return 'accepted'; } catch (e) { return e.message; }
    }, what);
    expect(r, what).toContain('old row 3: the value holds a ' + what);
  }
  const meta = await page.evaluate(() => { try { R.toNewRecords({ local: [], files: [], notes: [], meta: [{ key: 'timer', value: new Set([1]) }] }, 'abcd1234'); return 'accepted'; } catch (e) { return e.message; } });
  expect(meta).toContain('old row "meta"');
  // a Date for created, an auto-increment key, a Blob as the row value (no name, no note)
  const ok = await page.evaluate(() => R.toNewRecords({ local: [{ key: 'oldapp:flag', value: 'true' }], meta: [],
    notes: [{ key: 12, value: { title: 't', text: 'x', created: new Date(1700000000000) } }, { key: 13, value: { title: 'u', text: 'y', created: '2023-11-14T22:13:21Z' } }],
    files: [{ key: 14, value: new Blob(['abc'], { type: 'application/pdf' }) }] }, 'abcd1234').map((i) => ({ id: i.id, name: i.name, created: i.created, meta: i.meta, value: i.value instanceof Blob ? 'blob ' + i.value.size : i.value })));
  expect(ok.find((i) => i.id === 'abcd1234-j12').created).toBe(1700000000000);
  expect(ok.find((i) => i.id === 'abcd1234-j13').created).toBe(Date.parse('2023-11-14T22:13:21Z'));
  expect(ok.find((i) => i.id === 'abcd1234-j14')).toMatchObject({ value: 'blob 3', meta: {} });
  expect(ok.find((i) => i.name === 'migrated/abcd1234/local').value).toEqual({ 'oldapp:flag': 'true' });   // a string stays a string
  await noProblems(page);
  await ctx.close();
});


test('collections: set is an upsert (creates the list entry, keeps its place); created exists in the entry; set of a record the page has not read is a conflict', async ({ browser, stack, md }) => {
  const url = harness(md, stack, { recipe: 'const notes = store.collection("notes/", { meta: (n) => ({ title: n.title }) });', ret: ['notes'], scope: stack.scope });
  const ctx = await newContext(browser);
  const a = await open(ctx, url);
  await a.evaluate(async () => { window.R = await window.__recipe(store, {}); });
  const accessId = await openVault(a, stack);
  await a.evaluate(() => window.__unlock);
  await a.evaluate(() => R.notes.load());
  // set with a new id: the record and the list entry exist; created is "now", only in the entry
  const before = Date.now();
  await a.evaluate(() => R.notes.set('my-id', { title: 'Made by set' }));
  const entry = await a.evaluate(() => R.notes.items().find((i) => i.id === 'my-id'));
  expect(entry.meta).toEqual({ title: 'Made by set' });
  expect(entry.created).toBeGreaterThanOrEqual(before - 5000);
  expect(await a.evaluate(() => store.get('notes/my-id'))).toEqual({ title: 'Made by set' });        // the value has no created
  // add with created: that number; set on an existing id: new meta, the same place
  await a.evaluate(() => R.notes.add({ title: 'Dated' }, { id: 'dated', created: 1700000000000 }));
  expect(await a.evaluate(() => R.notes.items().map((i) => i.id))).toEqual(['dated', 'my-id']);
  await a.evaluate(() => R.notes.set('dated', { title: 'Dated, edited' }));
  expect(await a.evaluate(() => R.notes.items().find((i) => i.id === 'dated'))).toMatchObject({ created: 1700000000000, meta: { title: 'Dated, edited' } });
  await a.evaluate(() => R.notes.flush());
  // another device that has not read my-id: set is a conflict, the handler decides; after a read it is a plain save
  const b = await open(ctx, url);
  await b.evaluate(async () => { window.R = await window.__recipe(store, {}); window.__conflicts = []; });
  await unlockLater(b, accessId);
  await b.evaluate(() => { window.__off = store.onConflict('notes/', (c) => { window.__conflicts.push(c.name); return c.keepTheirs(); }); });
  const theirs = await b.evaluate(() => R.notes.set('my-id', { title: 'Blind overwrite' }));
  expect(theirs.resolution).toBe('theirs');
  expect(await b.evaluate(() => window.__conflicts)).toEqual(['notes/my-id']);
  expect(await b.evaluate(() => store.get('notes/my-id', { fresh: true }))).toEqual({ title: 'Made by set' });
  // the other decision: keepMine overwrites on top (the old value stays in the history)
  await b.evaluate(() => { window.__off(); store.onConflict('notes/', (c) => { window.__conflicts.push(c.name); return c.keepMine(); }); });
  expect((await b.evaluate(() => R.notes.set('dated', { title: 'Dated, replaced' }))).resolution).toBe('mine');
  expect(await b.evaluate(() => window.__conflicts)).toEqual(['notes/my-id', 'notes/dated']);
  expect(await b.evaluate(() => store.get('notes/dated', { fresh: true }))).toEqual({ title: 'Dated, replaced' });
  // after a read the same call is a plain save
  await b.evaluate(() => R.notes.get('my-id'));
  expect((await b.evaluate(() => R.notes.set('my-id', { title: 'Saved after reading' }))).resolution).toBe('saved');
  expect(await b.evaluate(() => window.__conflicts)).toHaveLength(2);
  await noProblems(a, b);
  await ctx.close();
});

test('the table of the library dialogs in the guide matches client/src/wds-ui.js, in both directions', async ({ md }) => {
  const ui = readFileSync(join(ROOT, 'client', 'src', 'wds-ui.js'), 'utf8');
  const start = md.indexOf("### Driving the library's dialogs in your own end-to-end tests");
  expect(start).toBeGreaterThan(0);
  const section = md.slice(start, md.indexOf('\n## 13.', start));
  const BT = '\x60';
  const rows = section.split('\n').filter((l) => l.startsWith('| ' + BT) && !l.startsWith('| ' + BT + 'data-wds-view')).map((l) => l.split(' | ').map((c) => c.replace(/^\| /, '').replace(/ \|$/, '')));
  const views = rows.map((r) => r[0].replaceAll(BT, ''));
  expect(views).toEqual(['loading', 'error', 'unlock', 'create', 'redeem', 'sheet', 'conflict', 'history', 'share', 'revoke', 'progress', 'notice']);
  const names = (cell) => [...cell.matchAll(/\x60([a-z][a-z-]*)\x60/g)].map((m) => m[1]);
  // every view and every control of the table exists in the library
  for (const view of views) expect(ui, 'view ' + view).toMatch(new RegExp("(view: |setView\\(|frame\\()'" + view + "'"));
  const listed = new Set();
  for (const row of rows) for (const name of names(row[2])) {
    listed.add(name);
    expect(ui.includes("'" + name + "'"), 'control ' + name + ' of ' + row[0]).toBe(true);
  }
  // every name that the library's own header comment lists is in the guide (table or the paragraph below it)
  const header = ui.slice(ui.indexOf('Stable attributes:'), ui.indexOf('Dialogs use the class prefix'));
  const documented = new Set(names(section));
  let checked = 0;
  for (const line of header.split('\n').slice(1)) {
    const m = line.match(/^ \*\s+[a-z, ]+:\s*(.*)$/);
    if (!m) continue;
    for (const name of m[1].split(/[,;]\s*/).map((s) => s.trim().replace(/^[a-z ]+:\s*/, '').replace(/[^a-z-].*$/, '')).filter(Boolean)) {
      expect(documented.has(name), 'the guide misses ' + name).toBe(true);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(50);
  expect(section).toContain('tools/lib/drive-library.mjs');
  expect(section).toContain('tools/node_modules/playwright');
});

test('porting step 4: another tab holds the old database open: nothing is blocked, no delete stays pending', async ({ browser, stack, md }) => {
  const url = migrationUrl(md, stack, stack.scope);
  const ctx = await newContext(browser);
  const page = await migrationPage(ctx, url, test.info());
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  await page.evaluate(() => seedOld());
  await page.evaluate(() => new Promise((ok) => { const r = indexedDB.open('oldapp'); r.onsuccess = () => { window.__hold = r.result; ok(); }; }));   // "the old app in another tab"
  const res = await runMigration(page);
  expect(res).toMatchObject({ status: 'migrated', deleted: 'deleted', count: 5 });
  expect(await page.evaluate(() => oldState())).toMatchObject({ rows: 0, prefs: null, avatar: null });
  // the old tab writes after the delete: that row is simply there, with the next start it is copied (nothing a pending delete could swallow)
  await page.evaluate(() => addOldRow());
  expect((await page.evaluate(() => oldState())).rows).toBe(1);
  await page.evaluate(() => window.__hold.close());
  expect(await runMigration(page)).toMatchObject({ status: 'migrated', deleted: 'deleted', count: 1 });
  expect(await page.evaluate(() => R.notes.refresh().then((l) => l.length))).toBe(3);
  await noProblems(page);
  await ctx.close();
});

test('porting step 4 in the sandbox: the data is copied, the old data is kept, a rerun deletes nothing; the sandbox shows what it is', async ({ browser, stack, md }) => {
  const url = migrationUrl(md, stack, SANDBOX_ID, stack.sandbox.origin);
  const ctx = await newContext(browser);
  const page = await migrationPage(ctx, url, test.info());
  await page.evaluate(() => { window.__unlock = store.unlock(); });
  // the library says Sandbox: banner, title, the create button, no recovery contact
  await expect(dlg(page, 'unlock')).toContainText('Sandbox');
  await expect(dlg(page, 'unlock').locator('[data-wds="sandbox-banner"]')).toBeVisible();
  await dlg(page, 'unlock').locator('[data-wds="to-create"]').click();
  await expect(dlg(page, 'create').locator('[data-wds="join-code"]')).toHaveCount(0);
  await expect(dlg(page, 'create').locator('[data-wds="recovery-contact"]')).toHaveCount(0);
  await expect(dlg(page, 'create').locator('[data-wds="create-submit"]')).toContainText('sandbox');
  const c = dlg(page, 'create');
  await c.locator('[data-wds="passphrase"]').fill(PASS);
  await c.locator('[data-wds="passphrase-repeat"]').fill(PASS);
  await c.locator('[data-wds="create-submit"]').click();
  await expect(dlg(page, 'sheet')).toBeVisible({ timeout: 60000 });
  await expect(dlg(page, 'sheet').locator('[data-wds="recovery-code"]')).toHaveCount(0);
  await dlg(page, 'sheet').locator('[data-wds="sheet-confirm"]').check();
  await dlg(page, 'sheet').locator('[data-wds="sheet-continue"]').click();
  await page.evaluate(() => window.__unlock);
  await expect(page.locator('[data-wds="sandbox-bar"]')).toBeVisible();
  expect(await page.evaluate(() => store.status().sandbox)).toBe(true);

  await page.evaluate(() => seedOld());
  const res = await runMigration(page);
  expect(res).toMatchObject({ status: 'migrated', deleted: 'kept', count: 5 });
  expect((await page.evaluate(() => window.__questions))[0]).toContain('sandbox: the old data stays');
  const state = await page.evaluate(() => oldState());
  expect(state.rows).toBe(3);                                         // the old data is still there
  expect(state.prefs).not.toBeNull();
  expect(state.avatar).not.toBeNull();
  expect(state.tag).not.toBeNull();
  expect(await page.evaluate(() => R.notes.refresh().then((l) => l.length))).toBe(2);
  // a rerun recognises the marker: nothing is written, nothing is deleted
  expect(await runMigration(page)).toMatchObject({ status: 'migrated', deleted: 'kept', again: true });
  expect((await page.evaluate(() => oldState())).rows).toBe(3);
  // the shortcut does not trust the marker: a record of the copy that is gone from the vault since sends the run through the whole flow again (it asks, and copies it back)
  await page.evaluate((t) => R.files.remove(t + '-j7.pdf'), res.tag);
  const asked = (await page.evaluate(() => window.__questions)).length;
  const refilled = await runMigration(page);
  expect(refilled).toMatchObject({ status: 'migrated', deleted: 'kept' });
  expect(refilled.again).toBeUndefined();
  expect((await page.evaluate(() => window.__questions)).length).toBe(asked + 1);
  expect(await page.evaluate((t) => store.get('files/' + t + '-j7.pdf', { fresh: true }).then((b) => [...b]), res.tag)).toEqual([37, 80, 68, 70, 1, 2, 3, 250, 251, 252]);
  // a record above the (small) limit of the sandbox: it is offered as a download, the rest is copied, nothing is deleted
  await page.evaluate(() => seedOld({ bigBytes: 600 * 1024 }));
  const big = await runMigration(page);
  expect(big).toMatchObject({ status: 'migrated', deleted: 'kept' });
  expect(big.tooLarge).toHaveLength(1);
  expect((await page.evaluate(() => window.__questions)).at(-2)).toContain('too large for the vault');
  expect((await page.evaluate(() => oldState())).rows).toBe(4);
  // the documents of a server with a sandbox name it
  const llms = await (await fetch(stack.sandbox.origin + '/datastore/llms.txt')).text();
  expect(llms).toContain(SANDBOX_ID);
  expect(llms).toContain('03:30 Europe/Berlin');
  expect(llms).toContain('512 KB per record');
  expect(llms).not.toContain('{{');
  const op = await (await fetch(stack.sandbox.origin + '/datastore/docs/operator.md')).text();
  expect(op).toContain('**' + SANDBOX_ID + '**');
  await noProblems(page);
  await ctx.close();
});

test('porting step 4 in the sandbox with window.__WDS_MIGRATION_TEST__ (what wds-verify --migration-delete sets): the question says the data is deleted, and it is', async ({ browser, stack, md }) => {
  const url = migrationUrl(md, stack, SANDBOX_ID, stack.sandbox.origin);
  const ctx = await newContext(browser);
  await ctx.addInitScript(() => { window.__WDS_MIGRATION_TEST__ = true; Object.defineProperty(navigator, 'webdriver', { get: () => true, configurable: true }); });      // what wds-verify --migration-delete does (an automated browser)
  const page = await migrationPage(ctx, url, test.info());
  await page.evaluate(() => { window.__unlock = store.unlock(); });
  await dlg(page, 'unlock').locator('[data-wds="to-create"]').click();
  const c = dlg(page, 'create');
  await c.locator('[data-wds="passphrase"]').fill(PASS);
  await c.locator('[data-wds="passphrase-repeat"]').fill(PASS);
  await c.locator('[data-wds="create-submit"]').click();
  await expect(dlg(page, 'sheet')).toBeVisible({ timeout: 60000 });
  await dlg(page, 'sheet').locator('[data-wds="sheet-confirm"]').check();
  await dlg(page, 'sheet').locator('[data-wds="sheet-continue"]').click();
  await page.evaluate(() => window.__unlock);
  expect(await page.evaluate(() => store.status().sandbox)).toBe(true);
  // a person's browser is not automated (navigator.webdriver is false): the global alone changes nothing, the recipe keeps the old data
  await page.evaluate(() => Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }));
  expect(await page.evaluate(() => R.removeOldData({ local: [] }, { sandbox: true }))).toBe('kept');
  await page.evaluate(() => Object.defineProperty(navigator, 'webdriver', { get: () => true, configurable: true }));
  await page.evaluate(() => seedOld());
  expect(await runMigration(page)).toMatchObject({ status: 'migrated', deleted: 'deleted', count: 5 });
  expect((await page.evaluate(() => window.__questions))[0]).toContain('delete them from this browser');
  expect((await page.evaluate(() => oldState())).rows).toBe(0);
  await noProblems(page);
  await ctx.close();
});

// ---- wds-verify on what the documents print ----

const OLD_APP = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Old notes (local only)</title></head>\n<body>\n<input id=\"title\" aria-label=\"Title\"> <textarea id=\"text\" aria-label=\"Text\"></textarea> <button id=\"save\">Save</button>\n<script>\n\"use strict\";\n// the old, local-only version of the app: one IndexedDB database \"oldapp\", the store \"notes\" (the recipe's OLD names)\ndocument.getElementById(\"save\").onclick = () => {\n  const req = indexedDB.open(\"oldapp\", 1);\n  req.onupgradeneeded = () => { for (const name of [\"notes\", \"files\"]) req.result.createObjectStore(name, { keyPath: \"id\" }); req.result.createObjectStore(\"meta\"); };\n  req.onsuccess = () => {\n    const db = req.result, tx = db.transaction(\"notes\", \"readwrite\");\n    tx.objectStore(\"notes\").put({ id: Date.now(), title: document.getElementById(\"title\").value, text: document.getElementById(\"text\").value, created: Date.now() });\n    tx.oncomplete = () => db.close();\n  };\n};\n</script>\n</body></html>\n";
const NEWAPP_BODY = "<body>\n<h1>Notes</h1>\n<div id=\"ask\" hidden><p id=\"question\"></p><button id=\"migrate-yes\">Copy and delete</button> <button id=\"migrate-no\">Not now</button></div>\n<ul id=\"list\"></ul>\n<span id=\"status\" role=\"status\"></span>\n";
const NEWAPP_SCRIPT = "<script>\n\"use strict\";\nconst store = WDS.connect({ scope: \"myapp-k7m2a9\" });\n__RECIPE__\nconst $ = (id) => document.getElementById(id);\nconst ui = {\n  confirm: (question) => new Promise((ok) => {\n    $(\"question\").textContent = question; $(\"ask\").hidden = false;\n    $(\"migrate-yes\").onclick = () => { $(\"ask\").hidden = true; ok(true); };\n    $(\"migrate-no\").onclick = () => { $(\"ask\").hidden = true; ok(false); };\n  }),\n  offerDownload: async (blob, name) => { const a = document.createElement(\"a\"); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); },   // a backup of the old data\n};\nasync function show() {\n  const items = await notes.refresh();\n  const rows = [];\n  for (const it of items) { const note = await store.get(\"notes/\" + it.id); rows.push(((note && note.title) || \"\") + \": \" + ((note && note.text) || \"\")); }\n  $(\"list\").replaceChildren(...rows.map((r) => { const li = document.createElement(\"li\"); li.textContent = r; return li; }));\n}\nasync function start() {\n  const result = await migrateOldData(ui);\n  $(\"status\").textContent = result.status === \"migrated\" ? \"Migrated (\" + result.deleted + \")\" : \"\";\n  await show();\n}\nstore.onUnlock(start);\nstore.unlock();\n</script>\n</body>\n</html>\n";

function verify(file, ...args) {
  return spawnSync('node', [join(ROOT, 'tools', 'wds-verify.mjs'), file, ...args], { encoding: 'utf8', env: { ...process.env, WDS_VERIFY_OFFLINE: '1' }, timeout: 280000 });
}
const publishedSri = () => { const h = JSON.parse(readFileSync(join(ROOT, 'client', 'dist', 'hashes.json'), 'utf8')); return h[Object.keys(h).sort().pop()].sri; };
// what a developer would have in the file: the production address and the published hash (the server of the test serves a bundle with its own escrow pins)
const productionPage = (stack, html) => html.replaceAll(stack.docs.origin + '/datastore', 'https://wiai.uni-bamberg.de/datastore').replaceAll(stack.sri, publishedSri());

test('the example app of section 14 passes wds-verify with the wds-verify.json of section 12 (mock target)', async ({ stack, md }) => {
  test.setTimeout(290000);
  const dir = join(stack.pages, 'verify-example');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), productionPage(stack, section14(md)));
  writeFileSync(join(dir, 'wds-verify.json'), section12Json(md));
  JSON.parse(section12Json(md));
  const r = verify(join(dir, 'index.html'));
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain('**Result: passed**');
  expect(r.stdout).toMatch(/Target: \*\*mock\*\*/);
  expect(r.stdout).toMatch(/Data after reload \| pass/);
});

test('the example app of section 14 runs against the sandbox with wds-verify --target sandbox, and --sandbox-copy writes a copy for a person', async ({ stack, md }) => {
  test.setTimeout(290000);
  const dir = join(stack.pages, 'verify-sandbox');
  mkdirSync(dir, { recursive: true });
  // the page as a developer has it (production address); the tool is pointed at the sandbox of this test's server and at the bundle that server serves
  const page = section14(md).replaceAll(stack.docs.origin + '/datastore', 'https://wiai.uni-bamberg.de/datastore');
  writeFileSync(join(dir, 'index.html'), page);
  writeFileSync(join(dir, 'wds-verify.json'), section12Json(md));
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

test('wds-verify tests the migration of the recipe: a "seed" block with the old app, mock target deletes, sandbox keeps, --migration-delete deletes there too', async ({ stack, md }) => {
  test.setTimeout(290000);
  const dir = join(stack.pages, 'verify-seed');
  mkdirSync(join(dir, 'old'), { recursive: true });
  const base = section14(md);
  const head = base.slice(0, base.indexOf('<body>'));
  const libTag = base.slice(base.indexOf('</textarea>') + '</textarea>'.length, base.indexOf('<script>\n"use strict";')).trim();
  const app = head + NEWAPP_BODY + libTag + '\n' + NEWAPP_SCRIPT.replace('__RECIPE__', () => MIGRATION(md));
  writeFileSync(join(dir, 'index.html'), productionPage(stack, app));
  writeFileSync(join(dir, 'old', 'index.html'), OLD_APP);
  writeFileSync(join(dir, 'wds-verify.json'), JSON.stringify({
    seed: { page: 'old/index.html', steps: [{ fill: ['#title', 'old title {canary}'] }, { fill: ['#text', 'old text {canary}'] }, { click: '#save' }, { wait: 800 }] },
    steps: [{ click: '#migrate-yes' }, { wait: 4000 }],
  }));
  // mock target: the migration runs as in production, the old data is gone, nothing unencrypted left the page
  const r = verify(join(dir, 'index.html'));
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toMatch(/Target: \*\*mock\*\*/);
  expect(r.stdout).toMatch(/Seed: the old app \| pass/);
  expect(r.stdout).toMatch(/Migration: old data visible \| pass/);
  expect(r.stdout).toMatch(/Migration: old data only encrypted \| pass/);
  expect(r.stdout).toMatch(/Migration: old data deleted \| pass/);
  // sandbox target: the recipe keeps the old data; with --migration-delete (the global the recipe honours) it deletes
  const env = { ...process.env, WDS_VERIFY_SERVICE: stack.sandbox.service, WDS_VERIFY_LIBRARY: stack.bundleFile, WDS_VERIFY_OFFLINE: '1' };
  const hashes = join(stack.bundleDir, 'hashes.json');
  const page = app.replaceAll(stack.docs.origin + '/datastore', 'https://wiai.uni-bamberg.de/datastore');
  writeFileSync(join(dir, 'index.html'), page);
  const sandbox = (...extra) => spawnSync('node', [join(ROOT, 'tools', 'wds-verify.mjs'), join(dir, 'index.html'), '--target', 'sandbox', '--hashes', hashes, ...extra], { encoding: 'utf8', env, timeout: 280000 });
  const kept = sandbox();
  expect(kept.status, kept.stdout + kept.stderr).toBe(0);
  expect(kept.stdout).toMatch(/Migration: old data kept in the sandbox \| pass/);
  expect(kept.stdout).toMatch(/Migration: old data visible \| pass/);
  const deleted = sandbox('--migration-delete');
  expect(deleted.status, deleted.stdout + deleted.stderr).toBe(0);
  expect(deleted.stdout).toMatch(/Migration: old data deleted \| pass/);
});

test('the migration recipe has no static finding: deleting is guarded by the sandbox, no localStorage.clear()', async ({ stack, md }) => {
  const dir = join(stack.pages, 'verify-migration');
  mkdirSync(dir, { recursive: true });
  const base = section14(md);
  const app = base.replace(/<script>\n"use strict";[\s\S]*<\/script>/, '<script>\n"use strict";\nconst store = WDS.connect({ scope: "myapp-k7m2a9" });\n' + MIGRATION(md) + '\n</script>');
  expect(app).toContain('localStorage.removeItem');
  writeFileSync(join(dir, 'index.html'), productionPage(stack, app));
  const r = verify(join(dir, 'index.html'), '--static-only');
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).not.toContain('Deleting local data');
  expect(r.stdout).not.toContain('localStorage.clear()');
  // the same code without the guard is reported (the check works on this text)
  const unguarded = app.replace('if (keepInSandbox(st)) return "kept";', '');
  expect(unguarded).not.toBe(app);
  writeFileSync(join(dir, 'unguarded.html'), productionPage(stack, unguarded));
  const u = verify(join(dir, 'unguarded.html'), '--static-only');
  expect(u.stdout).toContain('Deleting local data');
});

test('wds-verify.json of the example app is the one printed in section 12, and it is valid', async ({ md }) => {
  const printed = JSON.parse(blockAfter(md, /^### Writing wds-verify\.json$/, 'json', 1));
  const file = JSON.parse(readFileSync(join(HERE, 'zeit-notizen', 'wds-verify.json'), 'utf8'));
  expect(printed).toEqual(file);
  expect(Array.isArray(file)).toBe(false);
  expect(file.steps.length).toBeGreaterThanOrEqual(20);
  expect(file.steps.length).toBeLessThanOrEqual(30);
  expect(file.steps.map((s) => Object.keys(s)[0])).toEqual(expect.arrayContaining(['click', 'fill', 'press', 'upload', 'download', 'wait']));
});
