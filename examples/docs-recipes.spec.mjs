// Tests of the code blocks of docs/site/integration.md and docs/site/porting.md, against the REAL server and the REAL bundle (scripts/test-examples.sh).
// Every block is taken from the served document (by its heading), put into a page that carries the documented Content-Security-Policy and script tag,
// and run from a file:// page. Nothing here re-types a block: if the document changes, the test runs the new text.
//  - integration.md: collections (several devices, concurrent adds, err.stored after a lost index write), conflicts in code (settings merge, keepTheirs, c.ask()),
//    lock and unlock again (onLock/onUnlock registered once, a pending edit survives the lock), autosave, files (delete with attachments, save with a new or replaced attachment, the file in a new tab inside the click),
//    set and created, the table of the library's dialogs against client/src/wds-ui.js, the example app of section 14 and the wds-verify.json of section 12 under wds-verify,
//  - porting.md: the import of an old export, the options of store.migrateLocal, the Cookbook block (Example 1) against a seeded old database, the type of a file (mime), the box of the library's notices (real server: migrated and deleted, the sandbox
//    keeps, the test global deletes), the zeit-notizen block (identical to the one in examples/zeit-notizen/index.html), the start function, the checklist for apps with forms and
//    modal dialogs, the seed block of section 12 (identical to the one of the example), the migration under wds-verify (mock deletes, sandbox keeps, --migration-delete deletes),
//    static findings of the blocks,
//  - every code block of both documents is accounted for (run, or syntax-checked), so that a new block cannot slip in untested,
//  - the documents: no placeholder left, the repository named, links resolve.
// The safety properties of the migration itself (interrupted runs, changed rows, too large, differing entries, two tabs, ...) are tested by client/test/migrate.spec.mjs.
// Run with scripts/test-examples.sh (Chromium; WDS_BROWSERS=chromium,firefox,webkit for more).
import { test as base, expect } from '../client/node_modules/@playwright/test/index.mjs';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startStack, startSandboxServer, SANDBOX_ID, ROOT } from '../client/test/integration-env.mjs';

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
// tests: the documents

test('the documents: no placeholder left, the public repository named, links resolve', async ({ stack, md, porting }) => {
  const o = stack.docs.origin + '/datastore';
  const names = ['integration', 'porting', 'operator', 'users.en', 'users.de'];
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
  // the rules and pointers of llms.txt exist in the guides
  for (const pointer of ['Collections', 'Conflicts in code', 'Lock and unlock again', 'Porting an existing app', 'Without wds-verify', 'Writing wds-verify.json', 'The sandbox', 'wds-verify']) {
    expect(texts.llms + md, pointer).toContain(pointer);
    expect(md, 'heading ' + pointer).toMatch(new RegExp('^#{2,3} (\\d+\\. )?' + pointer.replace('.', '\\.') + '( |$)', 'm'));
  }
  expect(md).toMatch(/^## 12\. wds-verify$/m);
  expect(md).toMatch(/^## 16\. Porting an existing app$/m);
  // porting.md: its own sections, linked from llms.txt and integration.md, and no hand recipe left anywhere
  for (const heading of [/^# Porting an existing app to WIAI Datastore$/m, /^## 1\. Inventory$/m, /^## 4\. Data that is still in the browsers of existing users$/m, /^### Example 1: /m, /^### Example 2: /m,
    /^### The join code for tests \(a real scope\)$/m, /^## 6\. Test the port$/m, /^## 7\. Checklist for apps with forms and modal dialogs$/m]) expect(porting, String(heading)).toMatch(heading);
  expect(texts.llms).toContain(o + '/docs/porting.md');
  expect(md).toContain(o + '/docs/porting.md');
  for (const [name, text] of Object.entries(texts)) for (const gone of ['openOldDb', 'keepInSandbox', 'migratedSettings', 'settingsDone', 'toNewRecords', 'migrateOldData', 'WDS_JOIN_CODE=', 'MiB']) expect(text, name + ' still names ' + gone).not.toContain(gone);
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
  expect(await page.evaluate(() => window.__saver.status)).toBe('stopped');

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
    await files.set('f1.txt', new Blob(['one'], { type: 'text/plain' }), { meta: { name: 'one.txt', note: a } });
    await files.set('f2.txt', new Blob(['two'], { type: 'text/plain' }), { meta: { name: 'two.txt', note: a } });
    await files.set('f3.txt', new Blob(['three'], { type: 'text/plain' }), { meta: { name: 'three.txt', note: b } });
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
test('files: saving a note with a new or replaced attachment writes file, note, then removes the old file; a lost or failed note write takes the new file away again', async ({ browser, stack, md }) => {
  const recipe = blockAfter(md, /^### Files$/, 'js', 1);
  expect(recipe).toContain('async function saveNoteWithFile(');
  const url = harness(md, stack, { recipe, params: ['notes', 'files'], ret: ['saveNoteWithFile'], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  const setup = (p) => p.evaluate(async () => {
    window.notes = store.collection('notes/', { meta: (n) => ({ title: n.title }) });
    window.files = store.collection('files/');
    window.R = await window.__recipe(store, { notes: window.notes, files: window.files });
    window.save = (id, note, text) => R.saveNoteWithFile(id, note, text === null ? null : new File([text], text + '.txt', { type: 'text/plain' }));
    window.fileIds = async () => { await files.refresh(); return files.items().map((f) => f.id).sort(); };
  });
  await setup(page);
  const accessId = await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  await page.evaluate(() => files.load());

  // a new note with a file: the file is there, the note names it, the file's meta names the note
  const first = await page.evaluate(() => save('n1', { title: 'one' }, 'first'));
  expect(first.resolution).toBe('saved');
  const f1 = (await page.evaluate(() => notes.get('n1'))).fileId;
  expect(await page.evaluate(() => fileIds())).toEqual([f1]);
  expect(await page.evaluate(() => files.items()[0].meta)).toEqual({ note: 'n1', name: 'first.txt' });
  expect(await page.evaluate(async (id) => (await store.getBlob('files/' + id)).text(), f1)).toBe('first');

  // replaced: the new file is written, the note names it, the old file is gone
  await page.evaluate((id) => save('n1', { title: 'one', fileId: id }, 'second'), f1);
  const f2 = (await page.evaluate(() => notes.get('n1'))).fileId;
  expect(f2).not.toBe(f1);
  expect(await page.evaluate(() => fileIds())).toEqual([f2]);
  expect(await page.evaluate((id) => store.get('files/' + id, { fresh: true }), f1)).toBeUndefined();

  // no new file: the file stays, only the note changes
  await page.evaluate((id) => save('n1', { title: 'one, renamed', fileId: id }, null), f2);
  expect(await page.evaluate(() => fileIds())).toEqual([f2]);
  expect(await page.evaluate(() => notes.get('n1'))).toEqual({ title: 'one, renamed', fileId: f2 });

  // the note write fails for a reason that leaves the note unwritten (quota, no right to write): the error reaches the caller, the new file is taken away again, the old one stays
  await page.evaluate(() => { window.__realSet = notes.set.bind(notes); notes.set = async () => { throw new WDS.errors.QuotaError('too large'); }; });
  const failed = await page.evaluate((id) => save('n1', { title: 'never saved', fileId: id }, 'third').then(() => 'resolved', (e) => e.name), f2);
  expect(failed).toBe('QuotaError');
  expect(await page.evaluate(() => fileIds())).toEqual([f2]);
  // an OfflineError may mean that the write reached the server and only its answer was lost: the note may name the new file, so the file stays (an orphan costs space only)
  await page.evaluate(() => { notes.set = async () => { throw new WDS.errors.OfflineError('offline'); }; });
  const offline = await page.evaluate((id) => save('n1', { title: 'maybe saved', fileId: id }, 'third-b').then(() => 'resolved', (e) => e.name), f2);
  expect(offline).toBe('OfflineError');
  const kept = (await page.evaluate(() => fileIds())).filter((id) => id !== f2);
  expect(kept).toHaveLength(1);
  await page.evaluate((id) => files.remove(id), kept[0]);
  await page.evaluate(() => { notes.set = window.__realSet; });

  // the note write loses with "theirs": the other device's note is stored, so the new file is unreferenced and goes; the file the other note names stays
  const b = await open(ctx, url);
  await setup(b);
  await unlockLater(b, accessId);
  await b.evaluate(() => files.load());
  await b.evaluate(async () => { await notes.get('n1'); await notes.set('n1', { title: 'written on the other device', fileId: (await notes.get('n1')).fileId }); });
  await page.evaluate(() => { store.onConflict('notes/', (c) => c.keepTheirs()); });
  const lost = await page.evaluate((id) => save('n1', { title: 'mine', fileId: id }, 'fourth'), f2);
  expect(lost.resolution).toBe('theirs');
  expect(lost.value).toEqual({ title: 'written on the other device', fileId: f2 });
  expect(await page.evaluate(() => fileIds())).toEqual([f2]);
  expect(await page.evaluate(() => store.get('notes/n1', { fresh: true }))).toEqual({ title: 'written on the other device', fileId: f2 });

  // the note is stored and only its list entry is lost (err.stored): the note names the new file, so the file stays
  const pattern = /\/api\/v1\/vaults\/[^/]+\/records\/[^/]+$/;
  let puts = 0;
  page.ignoreAborted = true;
  await ctx.route(pattern, (route) => {
    if (route.request().method() === 'PUT' && ++puts === 4) return route.abort('failed');   // 1: the file, 2: its list entry, 3: the note, 4: the note's list entry
    return route.continue();
  });
  const indexLost = await page.evaluate((id) => save('n1', { title: 'five', fileId: id }, 'fifth').then(() => 'resolved', (e) => ({ stored: e.stored === true })), f2);
  await ctx.unroute(pattern);
  expect(indexLost).toEqual({ stored: true });
  const five = await page.evaluate(() => store.get('notes/n1', { fresh: true }));
  expect(five.title).toBe('five');
  expect(five.fileId).not.toBe(f2);
  expect(await page.evaluate(async (id) => (await store.getBlob('files/' + id)).text(), five.fileId)).toBe('fifth');   // the note's file is there

  // the answer of the note write is lost after the server stored it: the library looks at the record and counts it as saved; the old file goes, the new one stays
  puts = 0;
  await ctx.route(pattern, async (route) => {
    if (route.request().method() === 'PUT' && ++puts === 3) { await route.fetch(); return route.abort('failed'); }   // the server has the note, the page never hears of it
    return route.continue();
  });
  const dropped = await page.evaluate((id) => save('n1', { title: 'six', fileId: id }, 'sixth').then((r) => r.resolution, (e) => e.name), five.fileId);
  await ctx.unroute(pattern);
  expect(dropped).toBe('saved');
  const six = await page.evaluate(() => store.get('notes/n1', { fresh: true }));
  expect(six.title).toBe('six');
  expect(await page.evaluate(async (id) => (await store.getBlob('files/' + id)).text(), six.fileId)).toBe('sixth');
  expect(await page.evaluate((id) => store.get('files/' + id, { fresh: true }), five.fileId)).toBeUndefined();   // step 3 removed the old file
  await noProblems(page, b);
  await ctx.close();
});

test('porting.md section 3: the import of an old export keeps the ids, rewrites the references and overwrites on a second import', async ({ browser, stack, md, porting }) => {
  const recipe = blockAfter(porting, /^## 3\. Own export and import$/, 'js');
  const url = harness(md, stack, { recipe, ret: ['notes', 'files', 'importOldExportKeepingIds'], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  await page.evaluate(async () => { window.R = await window.__recipe(store, {}); });
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  const bad = await page.evaluate(() => R.importOldExportKeepingIds(new File(['{"items": []}'], 'x.json')).then(() => 'accepted', (e) => e.message));
  expect(bad).toContain('not an export of the old version');
  // the ids of the old export are kept: references are rewritten, the old order and creation dates stay, a second import overwrites instead of doubling
  const old = { notes: [{ id: 12, title: 'twelve', text: 'a', created: 1700000012000 }, { id: 3, title: 'three', text: 'b', created: 1700000003000 }],
    files: [{ id: 7, noteId: 12, name: 'plan.pdf', type: 'application/pdf', base64: Buffer.from([37, 80, 68, 70, 1]).toString('base64') }] };
  expect(await page.evaluate((o) => R.importOldExportKeepingIds(new File([JSON.stringify(o)], 'old.json')), old)).toBe(3);
  expect(await page.evaluate((o) => R.importOldExportKeepingIds(new File([JSON.stringify(o)], 'old.json')), old)).toBe(3);          // again: no conflict, no copies
  const kept = await page.evaluate(async () => { await R.notes.refresh(); await R.files.refresh(); return { notes: R.notes.items().map((i) => [i.id, i.created]).sort(), files: R.files.items().map((i) => [i.id, i.meta]) }; });
  expect(kept.notes).toEqual([['j12', 1700000012000], ['j3', 1700000003000]]);
  expect(kept.files).toEqual([['j7.pdf', { name: 'plan.pdf', note: 'j12' }]]);
  expect(await page.evaluate(() => store.get('files/j7.pdf', { fresh: true }).then((b) => [...b]))).toEqual([37, 80, 68, 70, 1]);
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
  await a.evaluate(() => R.notes.set('dated', { title: 'Dated' }, { created: 1700000000000 }));
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
  expect(views).toEqual(['loading', 'error', 'unlock', 'create', 'redeem', 'sheet', 'conflict', 'history', 'share', 'revoke', 'progress', 'notice', 'migrate', 'migrate-large']);
  const names = (cell) => [...cell.matchAll(/\x60([a-z][a-z-]*)\x60/g)].map((m) => m[1]);
  // every view and every control of the table exists in the library
  for (const view of views) expect(ui, 'view ' + view).toMatch(new RegExp("(view: |setView\\(|frame\\(|migrateView\\(run, )'" + view + "'"));
  const listed = new Set();
  for (const row of rows) for (const name of names(row[2])) {
    listed.add(name);
    expect(ui.includes("'" + name + "'"), 'control ' + name + ' of ' + row[0]).toBe(true);
  }
  expect(listed.size).toBeGreaterThan(50);
  expect(section).toContain('until the roster is refreshed');
  expect(section).toContain('tools/lib/drive-library.mjs');
  expect(section).toContain('tools/node_modules/playwright');
});

// ---------------------------------------------------------------------------------------------------------------------------
// tests: store.migrateLocal in the documented blocks of porting.md

const COOK = (porting) => blockAfter(porting, /^### Example 1: /, 'js');
const ZEIT = (porting) => blockAfter(porting, /^### Example 2: /, 'js');

// The old Cookbook in a browser: IndexedDB "cookbook" with recipes (out-of-line string keys; { title, portions, steps, photos: [{ image, caption }], saved }) and images (a File per key), and the localStorage key with the preferences.
const COOK_SEED = String.raw`
  window.seedCook = async function (opts) {
    opts = opts || {};
    await new Promise((ok, fail) => {
      const req = indexedDB.open('cookbook', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const recipes = db.createObjectStore('recipes'), images = db.createObjectStore('images');
        recipes.put({ title: 'Apple pie', portions: 8, steps: ['Peel the apples', 'Bake for 45 minutes'], photos: [{ image: 'img-1', caption: 'Fresh from the oven' }, { image: 'img-2', caption: 'The first slice' }], saved: '2024-03-01T10:00:00.000Z' }, 'apple-pie');
        recipes.put({ title: 'Tarte Tatin', portions: 6, steps: ['Caramelise'], photos: [{ image: 'img-gone', caption: 'A photo that was lost' }], saved: '2024-03-02T10:00:00.000Z' }, 'Tarte Tatin');   // its image row is gone
        recipes.put({ title: 'Plain rice', portions: 2, steps: ['Boil'], saved: '2024-03-03T10:00:00.000Z' }, 'rice');                                                                       // no photos at all
        const one = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 250, 251, 252]), two = new Uint8Array([255, 216, 255, 224, 9, 8, 7]);
        const put = (key, name, bytes) => images.put(opts.blobs ? new File([bytes], name, { type: 'image/jpeg' }) : { name, type: 'image/jpeg', data: bytes.buffer }, key);   // WebKit cannot keep a File in IndexedDB on file://
        put('img-1', 'apple-pie.jpg', one); put('img-2', 'slice.jpg', two);
      };
      req.onsuccess = () => { req.result.close(); ok(); };
      req.onerror = () => fail(req.error);
    });
    localStorage.setItem('cookbook.prefs', JSON.stringify({ units: 'imperial', view: 'grid', search: 'pie' }));
    localStorage.setItem('other.app.key', 'keep me');
  };
  window.oldCook = async function () {        // what is left of the old storage
    const out = { local: {}, rows: null };
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k.startsWith('wds:')) out.local[k] = localStorage.getItem(k); }
    const db = await new Promise((resolve) => { const r = indexedDB.open('cookbook'); r.onupgradeneeded = () => { r.transaction.abort(); resolve(null); }; r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null); });
    if (db) {
      out.rows = {};
      for (const s of ['recipes', 'images']) out.rows[s] = await new Promise((resolve) => { const r = db.transaction(s).objectStore(s).count(); r.onsuccess = () => resolve(r.result); });
      db.close();
    }
    return out;
  };
  window.tagOf = () => localStorage.getItem('wds:migrate:cookbook:tag');
`;

async function canKeepBlobs(page) {         // an engine that cannot keep a Blob or File in IndexedDB for file:// pages: the seed uses bytes (h.blob takes value.data and value.type)
  return page.evaluate(() => new Promise((res) => {
    try {
      const r = indexedDB.open('probe-' + Math.random());
      r.onupgradeneeded = () => { r.result.createObjectStore('s').put(new Blob(['x']), 'k'); };
      r.onsuccess = () => { r.result.close(); res(true); };
      r.onerror = () => res(false);
    } catch (e) { res(false); }
  }));
}
async function idbAvailable(page) { return page.evaluate(() => { try { return typeof indexedDB !== 'undefined' && !!indexedDB.open('probe-' + Math.random()); } catch (e) { return false; } }); }

function cookUrl(md, porting, stack, { scope, origin, recipe } = {}) {
  return harness(md, stack, { recipe: recipe || COOK(porting), ret: ['result', 'recipes', 'images'], scope: scope || stack.scope, origin, extraHead: '<script>' + COOK_SEED + '</script>' });
}
// Starts the block of the document (it calls store.migrateLocal at once) and returns; the dialogs are answered by the test.
const startCook = (page) => page.evaluate(() => { window.__done = window.__recipe(store, {}).then((r) => (window.R = r), (e) => ({ rejected: e.name + ': ' + e.message })); });
const finishCook = (page) => page.evaluate(() => window.__done);
async function answerYes(page, { backup = false } = {}) {
  const q = dlg(page, 'migrate');
  await expect(q).toBeVisible({ timeout: 30000 });
  await expect(q).not.toHaveAttribute('aria-busy', /.*/);
  if (backup) {
    const download = page.waitForEvent('download');
    await q.locator('[data-wds="migrate-backup"]').click();
    expect((await download).suggestedFilename()).toMatch(/^cookbook-old-data-\d{4}-\d{2}-\d{2}\.zip$/);
  }
  await q.locator('[data-wds="migrate-yes"]').click();
}
const vaultOfCook = (page) => page.evaluate(async () => {
  const tag = tagOf(), recipes = R.recipes, images = R.images;          // the collections that the block of the document made
  await recipes.refresh(); await images.refresh();
  const all = await recipes.getAll(), files = [];
  for (const e of images.items()) { const b = await store.getBlob('images/' + e.id); files.push({ id: e.id, meta: e.meta, type: b.type, bytes: [...new Uint8Array(await b.arrayBuffer())] }); }
  files.sort((x, y) => (x.id < y.id ? -1 : 1));
  return { tag, recipes: all.map((r) => ({ id: r.id, meta: r.meta, value: r.value, created: recipes.items().find((i) => i.id === r.id).created })), files, records: (await store.list()).map((r) => r.name) };
});
const IMAGE_1 = [255, 216, 255, 224, 1, 2, 3, 250, 251, 252], IMAGE_2 = [255, 216, 255, 224, 9, 8, 7];

test('porting.md example 1 (string keys, a list of photos, a reference to the image, a dead reference, images): the real server migrates and deletes; the person asked once; a second start finds nothing', async ({ browser, stack, md, porting }) => {
  const url = cookUrl(md, porting, stack);
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  if (!(await idbAvailable(page))) test.skip(true, 'this engine has no IndexedDB for file:// pages');
  const accessId = await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  await page.evaluate((blobs) => seedCook({ blobs }), await canKeepBlobs(page));
  await startCook(page);
  await answerYes(page, { backup: true });
  const res = await finishCook(page);
  expect(res.result).toEqual({ status: 'migrated', deleted: 'deleted' });
  // the notice of the library: a box at the bottom right of the window (26rem wide, 1rem from the right and bottom edge, 5 to 8rem high; in a narrow window .5rem from the edges)
  const toast = page.locator('[data-wds-toast=migration]');
  await expect(toast).toBeVisible();
  const box = await toast.boundingBox(), view = page.viewportSize();
  expect(Math.round(view.width - (box.x + box.width))).toBe(16);
  expect(Math.round(view.height - (box.y + box.height))).toBe(16);
  expect(Math.round(box.width)).toBe(416);
  expect(box.height).toBeGreaterThanOrEqual(5 * 16);
  expect(box.height).toBeLessThanOrEqual(8 * 16);
  // in a window narrower than 36rem: the window width minus 1rem, .5rem from the left, right and bottom edge
  await page.setViewportSize({ width: 400, height: 700 });
  const narrow = await toast.boundingBox();
  expect(Math.round(narrow.x)).toBe(8);
  expect(Math.round(400 - (narrow.x + narrow.width))).toBe(8);
  expect(Math.round(700 - (narrow.y + narrow.height))).toBe(8);
  expect(Math.round(narrow.width)).toBe(384);
  await page.setViewportSize(view);
  const st = await vaultOfCook(page);
  expect(st.recipes).toHaveLength(3);
  const byTitle = Object.fromEntries(st.recipes.map((r) => [r.value.title, r]));
  expect(byTitle['Apple pie'].id).toBe(st.tag + '-sapple-pie');          // a string key: "s" and the URL-encoded text
  expect(byTitle['Tarte Tatin'].id).toBe(st.tag + '-sTarte%20Tatin');
  expect(byTitle['Apple pie'].value).toEqual({ title: 'Apple pie',
    photos: [{ image: st.tag + '-simg-1.jpg', caption: 'Fresh from the oven' }, { image: st.tag + '-simg-2.jpg', caption: 'The first slice' }] });   // the references compute the ids of their images as the image side does
  expect(byTitle['Tarte Tatin'].value.photos).toEqual([{ image: null, caption: 'A photo that was lost' }]);   // a dead reference keeps what the person wrote
  expect(byTitle['Plain rice'].value.photos).toEqual([]);
  expect(byTitle['Apple pie'].meta).toEqual({ title: 'Apple pie' });
  expect(byTitle['Apple pie'].created).toBe(Date.parse('2024-03-01T10:00:00.000Z'));
  expect(st.recipes.slice().sort((x, y) => x.created - y.created).map((r) => r.value.title)).toEqual(['Apple pie', 'Tarte Tatin', 'Plain rice']);
  expect(st.files).toEqual([
    { id: st.tag + '-simg-1.jpg', meta: { name: 'apple-pie.jpg' }, type: 'image/jpeg', bytes: IMAGE_1 },   // byte for byte; the type of the File is kept without a mime in the block
    { id: st.tag + '-simg-2.jpg', meta: { name: 'slice.jpg' }, type: 'image/jpeg', bytes: IMAGE_2 }]);
  expect(st.records).not.toContain('.wds/migration/cookbook/' + st.tag);   // the marker is hidden
  const old = await page.evaluate(() => oldCook());
  expect(old.rows).toEqual({ recipes: 0, images: 0 });
  expect(Object.keys(old.local).sort()).toEqual(['cookbook.prefs', 'other.app.key']);   // the block names no localStorage key: a personal preference and another app's key are never touched
  // a second start: nothing to take over, no dialog, no question
  const page2 = await open(ctx, url);
  await page2.evaluate(() => { window.R = null; });
  await unlockLater(page2, accessId);
  await startCook(page2);
  expect((await finishCook(page2)).result).toEqual({ status: 'nothing' });
  await expect(page2.locator('dialog[data-wds-view]')).toHaveCount(0);
  await noProblems(page, page2);
  await ctx.close();
});

// What type a file gets in the vault: the table row "items" of porting.md says that the type of the Blob or File is kept, and that mime overrides it.
const MIME_SEED = String.raw`
  window.seedMimes = async function (opts) {
    opts = opts || {};
    await new Promise((ok, fail) => {
      const req = indexedDB.open('mimes', 1);
      req.onupgradeneeded = () => {
        const rows = req.result.createObjectStore('rows'), bytes = (n) => new Uint8Array([n, n + 1, n + 2]);
        rows.put({ data: bytes(1).buffer, type: 'image/png' }, 'typed');            // h.blob: a Blob of the type of the row
        rows.put({ data: bytes(2).buffer }, 'untyped');                             // no type anywhere
        rows.put({ data: bytes(3).buffer, type: 'text/plain' }, 'override');        // the entry says mime: image/webp
        rows.put({ data: bytes(4).buffer, type: 'image/gif' }, 'raw');              // the entry passes the bytes themselves, not h.blob(...)
        rows.put({ data: 'data:image/svg+xml;base64,' + btoa('<svg/>') }, 'dataurl');   // h.blob: the type of the data: URL
        if (opts.blobs) rows.put(new File([bytes(5)], 'plan.pdf', { type: 'application/pdf' }), 'file');   // a File: its own type
      };
      req.onsuccess = () => { req.result.close(); ok(); };
      req.onerror = () => fail(req.error);
    });
  };
`;
const MIME_RECIPE = String.raw`
const blobs = store.collection("blobs/");
const result = await store.migrateLocal({
  id: "mimes",
  indexedDB: { name: "mimes", stores: ["rows"] },
  map(old, h) {
    return { items: old.rows("rows").map((row) => ({ col: blobs, id: h.id(row.key), from: row,
      value: row.key === "raw" ? new Uint8Array(row.value.data) : h.blob(row.value),
      ...(row.key === "override" ? { mime: "image/webp" } : {}) })) };
  },
});
`;

test('porting.md, the items table: without mime the type of the Blob or File is stored, an untyped Blob or raw bytes get none (getBlob: application/octet-stream), mime overrides', async ({ browser, stack, md, porting }) => {
  const table = porting.split('\n').find((l) => l.startsWith('| ' + String.fromCharCode(96) + 'items' + String.fromCharCode(96) + ' |'));
  expect(table).toContain('Without ' + String.fromCharCode(96) + 'mime' + String.fromCharCode(96) + ', the ' + String.fromCharCode(96) + 'type' + String.fromCharCode(96) + ' of the Blob or File is stored');
  expect(table).toContain('application/octet-stream');
  const url = harness(md, stack, { recipe: MIME_RECIPE, ret: ['result', 'blobs'], scope: stack.scope, extraHead: '<script>' + MIME_SEED + '</script>' });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  if (!(await idbAvailable(page))) test.skip(true, 'this engine has no IndexedDB for file:// pages');
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  const withFile = await canKeepBlobs(page);
  await page.evaluate((blobs) => seedMimes({ blobs }), withFile);
  await page.evaluate(() => { window.__done = window.__recipe(store, {}).then((r) => (window.R = r), (e) => ({ rejected: e.name + ': ' + e.message })); });
  await answerYes(page);
  const res = await page.evaluate(() => window.__done);
  expect(res.result).toEqual({ status: 'migrated', deleted: 'deleted' });
  const types = await page.evaluate(async () => {
    const out = {}, tag = localStorage.getItem('wds:migrate:mimes:tag');
    for (const key of ['typed', 'untyped', 'override', 'raw', 'dataurl', 'file']) {
      const rec = await store.getRecord('blobs/' + tag + '-s' + key, { fresh: true });
      out[key] = rec ? { mime: rec.mime || null, blobType: (await store.getBlob('blobs/' + tag + '-s' + key)).type } : null;
    }
    out.count = (await store.list('blobs/')).length;
    return out;
  });
  expect(types.count).toBe(withFile ? 6 : 5);
  expect(types.typed).toEqual({ mime: 'image/png', blobType: 'image/png' });
  expect(types.untyped).toEqual({ mime: null, blobType: 'application/octet-stream' });
  expect(types.override).toEqual({ mime: 'image/webp', blobType: 'image/webp' });
  expect(types.raw).toEqual({ mime: null, blobType: 'application/octet-stream' });     // the bytes themselves: no type, whatever the row says
  expect(types.dataurl).toEqual({ mime: 'image/svg+xml', blobType: 'image/svg+xml' });
  if (withFile) expect(types.file).toEqual({ mime: 'application/pdf', blobType: 'application/pdf' });
  await noProblems(page);
  await ctx.close();
});

async function sandboxVault(page) {
  await page.evaluate(() => { window.__unlock = store.unlock(); });
  await expect(dlg(page, 'unlock')).toContainText('Sandbox');
  await createVault(page);
  await page.evaluate(() => window.__unlock);
  await expect(page.locator('[data-wds="sandbox-bar"]')).toBeVisible();
  expect(await page.evaluate(() => store.status().sandbox)).toBe(true);
}

test('porting.md example 1 in the sandbox: the data is copied and the old data is kept (the question says so); a rerun asks nothing and deletes nothing', async ({ browser, stack, md, porting }) => {
  const url = cookUrl(md, porting, stack, { scope: SANDBOX_ID, origin: stack.sandbox.origin });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  if (!(await idbAvailable(page))) test.skip(true, 'this engine has no IndexedDB for file:// pages');
  await sandboxVault(page);
  await page.evaluate((blobs) => seedCook({ blobs }), await canKeepBlobs(page));
  await startCook(page);
  await expect(dlg(page, 'migrate')).toContainText('Sandbox');
  await answerYes(page);
  const res = await finishCook(page);
  expect(res.result).toEqual({ status: 'migrated', deleted: 'kept' });
  const old = await page.evaluate(() => oldCook());
  expect(old.rows).toEqual({ recipes: 3, images: 2 });                   // still there
  expect(Object.keys(old.local).sort()).toEqual(['cookbook.prefs', 'other.app.key']);
  expect((await vaultOfCook(page)).recipes).toHaveLength(3);
  // what the person does in the new app stays: an edit and a deletion survive the next start, and nothing is asked again
  await page.evaluate(async () => { const all = R.recipes.items(); await R.recipes.remove(all[0].id); });
  await startCook(page);
  const again = await finishCook(page);
  expect(again.result).toMatchObject({ status: 'migrated', deleted: 'kept' });
  await expect(page.locator('dialog[data-wds-view="migrate"]')).toHaveCount(0);
  expect((await vaultOfCook(page)).recipes).toHaveLength(2);
  // the documents of a server with a sandbox name it
  const llms = await (await fetch(stack.sandbox.origin + '/datastore/llms.txt')).text();
  expect(llms).toContain(SANDBOX_ID);
  expect(llms).toContain('03:30 Europe/Berlin');
  expect(llms).toContain('512 KB per record');
  expect(llms).not.toContain('{{');
  const op = await (await fetch(stack.sandbox.origin + '/datastore/docs/operator.md')).text();
  expect(op).toContain('**' + SANDBOX_ID + '**');
  const portingSandbox = await (await fetch(stack.sandbox.origin + '/datastore/docs/porting.md')).text();
  expect(portingSandbox).toContain('512 KB per record');
  expect(portingSandbox).not.toContain('{{');
  await noProblems(page);
  await ctx.close();
});

test('porting.md, the test global: an automated test that sets window.__WDS_MIGRATION_TEST__ sees the deletion in the sandbox', async ({ browser, stack, md, porting }) => {
  const url = cookUrl(md, porting, stack, { scope: SANDBOX_ID, origin: stack.sandbox.origin });
  const ctx = await newContext(browser);
  // what the block of porting.md says to do, in the developer's own automated browser
  const block = blockAfter(porting, /^### The deletion path in the sandbox: the test global$/, 'js');
  expect(block).toContain('context.addInitScript');
  await ctx.addInitScript(() => { window.__WDS_MIGRATION_TEST__ = true; });
  const warnings = [];
  const page = await open(ctx, url);
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
  if (!(await idbAvailable(page))) test.skip(true, 'this engine has no IndexedDB for file:// pages');
  await sandboxVault(page);
  await page.evaluate((blobs) => seedCook({ blobs }), await canKeepBlobs(page));
  await startCook(page);
  await answerYes(page);                                                         // (the question is the sandbox's and still says that the old data stays; the result says what happened)
  expect((await finishCook(page)).result).toEqual({ status: 'migrated', deleted: 'deleted' });
  expect((await page.evaluate(() => oldCook())).rows).toEqual({ recipes: 0, images: 0 });
  expect(warnings.filter((w) => /__WDS_MIGRATION_TEST__/.test(w))).toHaveLength(1);
  await noProblems(page);
  await ctx.close();
});

test('porting.md, the call: the options of the block are valid, and without old data there is no dialog and no request (status nothing)', async ({ browser, stack, md, porting }) => {
  const recipe = blockAfter(porting, /^### The call$/, 'js');
  const url = harness(md, stack, { recipe, ret: ['result'], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  let requests = 0;
  page.on('request', (r) => { if (/\/api\//.test(r.url())) requests++; });
  const before = requests;
  const res = await page.evaluate(() => window.__recipe(store, {}));
  expect(res.result).toEqual({ status: 'nothing' });
  await expect(page.locator('dialog[data-wds-view]')).toHaveCount(0);
  expect(requests - before).toBeLessThanOrEqual(1);                       // at most the scope document that tells whether this is a sandbox
  await noProblems(page);
  await ctx.close();
});

test('porting.md, what your app does with the result: the start function asks once per page and loads afterwards', async ({ browser, stack, md, porting }) => {
  const recipe = blockAfter(porting, /^### What your app does with the result$/, 'js');
  const url = harness(md, stack, { recipe, params: ['takeOverOldData', 'renderList', 'recipes'], ret: ['start'], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  const warned = [];
  page.on('console', (m) => { if (m.type() === 'warning') warned.push(m.text()); });
  const calls = await page.evaluate(async () => {
    const log = [];
    const R = await window.__recipe(store, {
      takeOverOldData: async () => { log.push('migrate'); return { status: 'failed', why: 'a reason for the developer' }; },
      renderList: (items) => log.push('render ' + items.join(',')),
      recipes: { load: async () => { log.push('load'); return ['a', 'b']; } },
    });
    await R.start(); await R.start();
    return log;
  });
  expect(calls).toEqual(['migrate', 'load', 'render a,b', 'load', 'render a,b']);
  expect(warned.join('\n')).toContain('a reason for the developer');
  await ctx.close();
});

test('porting.md example 2 is the code of examples/zeit-notizen/index.html, and the app uses it', async ({ porting }) => {
  const app = readFileSync(join(HERE, 'zeit-notizen', 'index.html'), 'utf8');
  const m = app.match(/\n( *)\/\/ migrateLocal: begin\n([\s\S]*?)\n *\/\/ migrateLocal: end\n/);
  expect(m, 'the markers in index.html').not.toBeNull();
  const fromApp = m[2].split('\n').map((l) => l.slice(m[1].length)).join('\n');
  expect(fromApp).toBe(ZEIT(porting));
  expect(app).toContain('await takeOverOldData()');
  expect(app).not.toMatch(/indexedDB\.open|localStorage\.removeItem/);                                 // the app itself never opens or empties the old storage
  expect(app).toContain('var LANG_KEY = "zeitnotizen.lang"');                                         // its one personal preference stays in localStorage under its own key
  expect(fromApp).not.toContain('zeitnotizen.lang');                                                  // and is never named in migrateLocal
  for (const name of ['projectsCol', 'timeCol', 'notesCol', 'filesCol']) expect(app).toContain('var ' + name + ' = store.collection');
});

test('the seed block of section 12 is the one of examples/zeit-notizen/wds-verify.json, and the old app has the elements it names', async ({ md }) => {
  const file = JSON.parse(readFileSync(join(HERE, 'zeit-notizen', 'wds-verify.json'), 'utf8'));
  const printed = JSON.parse(blockAfter(md, /^### Writing wds-verify\.json$/, 'json', 1));
  expect(printed.seed).toEqual(file.seed);
  const old = readFileSync(join(HERE, 'zeit-notizen', 'old', 'index.html'), 'utf8');
  for (const step of file.seed.steps) {
    const sel = step.fill ? step.fill[0] : step.click || (step.upload && step.upload[0]);
    if (sel) expect(old, 'the old page has ' + sel).toContain('id="' + sel.slice(1) + '"');
  }
  expect(file.seed.steps.some((s) => s.upload)).toBe(true);
  expect(file.seed.steps.some((s) => s.fill && /\{canary\}/.test(s.fill[1]))).toBe(true);
});


// ---------------------------------------------------------------------------------------------------------------------------
// tests: the other code blocks (checklist, popup, autosave, role)

const POPUP_HEADING = /^### Files$/;
test('the popup block of integration.md (Files) opens the window inside the click and falls back to a download link', async ({ browser, stack, md }) => {
  const fromGuide = blockAfter(md, POPUP_HEADING, 'js', 2);
  const url = harness(md, stack, { recipe: fromGuide, params: ['openButton', 'id', 'name', 'offerDownloadLink', 'showError'], ret: [], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  await page.evaluate(async () => {
    window.__links = []; window.__errors = [];
    window.openButton = document.createElement('button'); window.openButton.id = 'open-file'; window.openButton.textContent = 'Open'; document.body.append(window.openButton);
    await window.__recipe(store, { openButton: window.openButton, id: 'doc1', name: 'doc1.txt', offerDownloadLink: (url, name) => window.__links.push([url.slice(0, 5), name]), showError: (e) => window.__errors.push(e.message) });
  });
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  await page.evaluate(() => store.set('pdfs/doc1', new Blob(['hello popup'], { type: 'text/plain' })));
  // the click opens the (empty) window at once, the file arrives in it
  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.locator('#open-file').click()]);
  await expect.poll(() => popup.url(), { timeout: 20000 }).toMatch(/^blob:/);
  expect(await popup.locator('body').innerText()).toContain('hello popup');
  expect(await page.evaluate(() => [window.__links, window.__errors])).toEqual([[], []]);
  await popup.close();
  // a blocker that refuses the empty window: the download link is offered instead
  await page.evaluate(() => { window.__realOpen = window.open; window.open = () => null; });
  await page.locator('#open-file').click();
  await expect.poll(() => page.evaluate(() => window.__links.length)).toBe(1);
  expect(await page.evaluate(() => window.__links[0])).toEqual(['blob:', 'doc1.txt']);
  // a file that is gone: the window is closed again and the error shown
  await page.evaluate(() => { window.open = window.__realOpen; return store.remove('pdfs/doc1'); });
  const [popup2] = await Promise.all([ctx.waitForEvent('page'), page.locator('#open-file').click()]);
  await expect.poll(() => page.evaluate(() => window.__errors.length)).toBe(1);
  await expect.poll(() => popup2.isClosed()).toBe(true);
  expect(await page.evaluate(() => window.__errors[0])).toContain('does not exist any more');
  await noProblems(page);
  await ctx.close();
});

test('headless Chromium has no PDF viewer: a popup filled with a PDF blob stays at about:blank and the file is a download, a text blob is shown (integration.md, section 12)', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'the sentence in the guide is about Chromium');
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  await page.setContent('<p>page</p>');
  const fill = async (type, body) => {
    const [popup] = await Promise.all([ctx.waitForEvent('page'), page.evaluate(([type, body]) => { const w = window.open('', '_blank'); w.location.href = URL.createObjectURL(new Blob([body], { type })); }, [type, body])]);
    const seen = { download: null };
    popup.on('download', (d) => { seen.download = d.suggestedFilename(); });
    await popup.waitForTimeout(1500);
    const out = { url: popup.url(), download: seen.download, text: type === 'text/plain' ? await popup.locator('body').innerText() : null };
    await popup.close();
    return out;
  };
  const pdf = await fill('application/pdf', '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  expect(pdf.url).toBe('about:blank');
  expect(pdf.download).toMatch(/\.pdf$/);
  const text = await fill('text/plain', 'hello popup');
  expect(text.url).toMatch(/^blob:/);
  expect(text.download).toBeNull();
  expect(text.text).toContain('hello popup');
  const guide = readFileSync(join(ROOT, 'docs', 'site', 'integration.md'), 'utf8');
  expect(guide).toContain('**Headless Chromium has no PDF viewer.**');
  await ctx.close();
});

test('porting.md checklist for apps with forms: the typed values stay after a failed save, the button is disabled while saving and enabled again, the submit does not navigate', async ({ browser, stack, md, porting }) => {
  const recipe = blockAfter(porting, /^## 7\. Checklist for apps with forms and modal dialogs$/, 'js', 0);
  const url = harness(md, stack, { recipe, params: ['recipes', 'form', 'saveButton', 'readForm', 'showSaved', 'showError', 'closeForm', 'id'], ret: [], scope: stack.scope,
    extraBody: '<form id="f"><input id="title" value="typed text"><button id="save" type="submit">Save</button></form>' });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  await page.evaluate(async () => {
    window.__log = []; window.__gate = null;
    window.recipes = store.collection('recipes/', { meta: (r) => ({ title: r.title }) });
    window.__realSet = window.recipes.set.bind(window.recipes);
    window.recipes.set = async (id, v) => { window.__log.push('set ' + v.title); if (window.__gate) await window.__gate; if (window.__fail) throw Object.assign(new Error('offline'), { name: 'OfflineError' }); return window.__realSet(id, v); };
    await window.__recipe(store, {
      recipes: window.recipes, form: document.getElementById('f'), saveButton: document.getElementById('save'), id: 'item-1.pdf',
      readForm: () => ({ title: document.getElementById('title').value }),
      showSaved: (v) => window.__log.push('saved ' + v.title), showError: (e) => window.__log.push('error ' + e.message), closeForm: () => window.__log.push('closed'),
    });
  });
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  // while the save is in flight the button is disabled; the submit does not navigate
  await page.evaluate(() => { window.__gate = new Promise((r) => { window.__openGate = r; }); });
  await page.locator('#save').click();
  await expect(page.locator('#save')).toBeDisabled();
  await page.evaluate(() => window.__openGate());
  await expect(page.locator('#save')).toBeEnabled();
  expect(await page.evaluate(() => window.__log)).toEqual(['set typed text', 'closed', 'saved typed text']);
  expect(page.url()).toBe(url);
  // a failed save keeps the form: nothing is closed, the error is shown, the button is enabled again
  await page.evaluate(() => { window.__log.length = 0; window.__gate = null; window.__fail = true; });
  await page.locator('#save').click();
  await expect.poll(() => page.evaluate(() => window.__log.length)).toBe(2);
  expect(await page.evaluate(() => window.__log)).toEqual(['set typed text', 'error offline']);
  await expect(page.locator('#save')).toBeEnabled();
  expect(await page.locator('#title').inputValue()).toBe('typed text');
  await noProblems(page);
  await ctx.close();
});

test('the library dialog opens above a modal dialog of the app, as the checklist says: a conflict while an own <dialog> is open stays answerable', async ({ browser, stack, md }) => {
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
  await noProblems(a, b);
  await ctx.close();
});

test('integration.md: the autosave block saves the state it is given, and the role block hides nothing for the owner', async ({ browser, stack, md }) => {
  const autosave = blockAfter(md, /^### Autosave$/, 'js');
  const role = blockAfter(md, /^## 8\. Members and sharing$/, 'js');
  const url = harness(md, stack, { recipe: autosave + '\n' + role, params: ['state', 'statusEl', 'textarea', 'saveButton'], ret: ['saver'], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  const out = await page.evaluate(async () => {
    const statusEl = document.createElement('span'), textarea = document.createElement('textarea'), saveButton = document.createElement('button');
    const R = await window.__recipe(store, { state: { text: 'draft text' }, statusEl, textarea, saveButton });
    // the block itself ran changed(), flush() and stop(): the draft is in the vault, the handle is stopped by the person's own call
    return { status: R.saver.status, readOnly: textarea.readOnly, hidden: saveButton.hidden, saved: await store.get('draft', { fresh: true }) };
  });
  expect(out).toEqual({ status: 'stopped', readOnly: false, hidden: false, saved: { text: 'draft text' } });
  await noProblems(page);
  await ctx.close();
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
  // [document, heading prefix, index inside that heading] -> how the block is tested
  const RUN = 'run (a test above or in the example app)', PARSE = 'parsed only';
  const registry = {
    'integration|2. The script tag|0': 'run: the example of section 14 carries it (wds-verify static check)',
    'integration|3. Content-Security-Policy|0': 'run: the example of section 14 carries it',
    'integration|4. API reference|0': PARSE,
    'integration|Autosave|0': RUN,
    'integration|Lock and unlock again|0': RUN,
    'integration|Collections|0': RUN,
    'integration|Files|0': RUN,
    'integration|Files|1': RUN,
    'integration|Files|2': RUN,
    'integration|Conflicts in code|0': RUN,
    'integration|8. Members and sharing|0': RUN,
    'integration|12. wds-verify|0': 'shell: text only',
    'integration|12. wds-verify|1': 'shell: text only',
    'integration|Writing wds-verify.json|0': 'json: parsed below',
    'integration|Writing wds-verify.json|1': 'json: equal to the file of the example app',
    'integration|13. What to tell users|0': 'text: the sentences are compared in test_docs.py',
    'integration|14. Complete minimal example|0': 'run: wds-verify (mock and sandbox)',
    'porting|3. Own export and import|0': RUN,
    'porting|The call|0': RUN,
    'porting|Example 1: a reference from one entry to another (photos in a recipe)|0': RUN,
    'porting|Example 2: a localStorage JSON, notes, files and a key-value store|0': 'identical to the app, which app.spec.mjs runs against a seeded old browser',
    'porting|What your app does with the result|0': RUN,
    'porting|The deletion path in the sandbox: the test global|0': PARSE,
    'porting|The join code for tests (a real scope)|0': 'shell: text only',
    'porting|7. Checklist for apps with forms and modal dialogs|0': RUN,
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

// ---------------------------------------------------------------------------------------------------------------------------
// tests: wds-verify on what the documents print

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

test('the Cookbook block of porting.md uses the library for the old data: no static finding, an info that says so; the same app with hand-made code is warned about', async ({ stack, md, porting }) => {
  const dir = join(stack.pages, 'verify-static');
  mkdirSync(dir, { recursive: true });
  const base = section14(md);
  const page = (script) => productionPage(stack, base.replace(/<script>\n"use strict";[\s\S]*<\/script>/, '<script>\n"use strict";\nconst store = WDS.connect({ scope: "myapp-k7m2a9" });\n' + script + '\n</script>'));
  const good = 'async function takeOverOldData() {\n' + COOK(porting) + '\n  return result;\n}\nstore.onUnlock(async () => { await takeOverOldData(); });\nstore.unlock();';
  writeFileSync(join(dir, 'good.html'), page(good));
  const r = verify(join(dir, 'good.html'), '--static-only');
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain('store.migrateLocal');
  expect(r.stdout).not.toContain('taken over by hand');
  expect(r.stdout).not.toContain('Deleting local data');
  expect(r.stdout).not.toContain('localStorage.clear()');
  // the hand-made way: reading and deleting the old storage in the app
  const bad = 'async function takeOver() {\n  const req = indexedDB.open("cookbook");\n  req.onsuccess = () => { localStorage.removeItem("cookbook.prefs"); };\n}\nstore.unlock();';
  writeFileSync(join(dir, 'bad.html'), page(bad));
  const u = verify(join(dir, 'bad.html'), '--static-only');
  expect(u.stdout).toContain('taken over by hand');
});

// The example app with its older version as the seed: the tool opens the old page, the new app, answers the library's migration dialogs, reloads, and looks at the old storage.
test('wds-verify runs the migration of examples/zeit-notizen with its seed: mock target deletes the old data, sandbox keeps it, --migration-delete deletes it there too', async ({ stack }) => {
  test.setTimeout(590000);
  const app = join(HERE, 'zeit-notizen', 'index.html');
  const r = verify(app);
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toMatch(/Target: \*\*mock\*\*/);
  expect(r.stdout).toMatch(/Seed: the old app \| pass/);
  expect(r.stdout).toMatch(/Migration: old data visible \| pass/);
  expect(r.stdout).toMatch(/Migration: old data only encrypted \| pass/);
  expect(r.stdout).toMatch(/Migration: old data deleted \| pass/);
  expect(r.stdout).toMatch(/Data after reload \| pass/);
  // the sandbox: a copy of the example with the hash of the bundle that this server serves (its escrow pins are its own)
  const dir = join(stack.pages, 'verify-zeit');
  cpSync(join(HERE, 'zeit-notizen'), dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), readFileSync(join(dir, 'index.html'), 'utf8').replaceAll(publishedSri(), stack.sri));
  const env = { ...process.env, WDS_VERIFY_SERVICE: stack.sandbox.service, WDS_VERIFY_LIBRARY: stack.bundleFile, WDS_VERIFY_OFFLINE: '1' };
  const hashes = join(stack.bundleDir, 'hashes.json');
  const sandbox = (...extra) => spawnSync('node', [join(ROOT, 'tools', 'wds-verify.mjs'), join(dir, 'index.html'), '--target', 'sandbox', '--hashes', hashes, ...extra], { encoding: 'utf8', env, timeout: 280000 });
  const kept = sandbox();
  expect(kept.status, kept.stdout + kept.stderr).toBe(0);
  expect(kept.stdout).toMatch(/Migration: old data kept in the sandbox \| pass/);
  expect(kept.stdout).toMatch(/Migration: old data visible \| pass/);
  const deleted = sandbox('--migration-delete');
  expect(deleted.status, deleted.stdout + deleted.stderr).toBe(0);
  expect(deleted.stdout).toMatch(/Migration: old data deleted \| pass/);
});

test('wds-verify.json of the example app is the one printed in section 12 (with its seed block), and it is valid', async ({ md }) => {
  const printed = JSON.parse(blockAfter(md, /^### Writing wds-verify\.json$/, 'json', 1));
  const file = JSON.parse(readFileSync(join(HERE, 'zeit-notizen', 'wds-verify.json'), 'utf8'));
  expect(printed).toEqual(file);
  expect(Array.isArray(file)).toBe(false);
  expect(file.steps.length).toBeGreaterThanOrEqual(20);
  expect(file.steps.length).toBeLessThanOrEqual(30);
  expect(file.steps.map((s) => Object.keys(s)[0])).toEqual(expect.arrayContaining(['click', 'fill', 'press', 'upload', 'download', 'wait']));
  expect(file.seed.page).toBe('old/index.html');
  expect(existsSync(join(HERE, 'zeit-notizen', file.seed.page))).toBe(true);
});
