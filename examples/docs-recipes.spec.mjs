// Tests of the code blocks of docs/site/integration.md and docs/site/porting.md, against the REAL server and the REAL bundle (scripts/test-examples.sh).
// Every block is taken from the served document (by its heading), put into a page that carries the documented Content-Security-Policy and script tag,
// and run from a file:// page. Nothing here re-types a block: if the document changes, the test runs the new text.
//  - integration.md: collections (several devices, concurrent adds, err.stored after a lost index write), conflicts in code (settings merge, keepTheirs, c.ask()),
//    lock and unlock again (onLock/onUnlock registered once, a pending edit survives the lock), autosave, files (delete with attachments, the file in a new tab inside the click),
//    set and created, the table of the library's dialogs against client/src/wds-ui.js, the example app of section 14 and the wds-verify.json of section 12 under wds-verify,
//  - porting.md: the import of an old export, the options of store.migrateLocal, the Literaturliste block against a seeded old database (real server: migrated and deleted, the sandbox
//    keeps, the test global deletes), the zeit-notizen block (identical to the one in examples/zeit-notizen/index.html), the start function, the checklist for apps with forms and
//    modal dialogs, the popup block, the seed block (identical to the one of the example), the migration under wds-verify (mock deletes, sandbox keeps, --migration-delete deletes),
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
test('porting.md section 3: the import of an old export reads a file the person chose', async ({ browser, stack, md, porting }) => {
  const recipe = blockAfter(porting, /^## 3\. Own export and import$/, 'js');
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
  const keep = blockAfter(porting, /^## 3\. Own export and import$/, 'js', 1);
  const url2 = harness(md, stack, { recipe: blockAfter(porting, /^## 3\. Own export and import$/, 'js') + '\n' + keep, ret: ['notes', 'files', 'importOldExportKeepingIds'], scope: stack.scope });
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
  expect(views).toEqual(['loading', 'error', 'unlock', 'create', 'redeem', 'sheet', 'conflict', 'history', 'share', 'revoke', 'progress', 'notice', 'migrate', 'migrate-discard', 'migrate-differs', 'migrate-large']);
  const names = (cell) => [...cell.matchAll(/\x60([a-z][a-z-]*)\x60/g)].map((m) => m[1]);
  // every view and every control of the table exists in the library
  for (const view of views) expect(ui, 'view ' + view).toMatch(new RegExp("(view: |setView\\(|frame\\(|migrateView\\(run, )'" + view + "'"));
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
    for (const name of m[1].split(/[,;]\s*/).map((s) => s.trim().replace(/^[a-z ]+:\s*/, '').replace(/[^a-z-].*$/, '')).filter((n) => n && !['toast', 'only'].includes(n))) {      // (the words of the prose in the toast line are no control names)
      expect(documented.has(name), 'the guide misses ' + name).toBe(true);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(50);
  expect(section).toContain('tools/lib/drive-library.mjs');
  expect(section).toContain('tools/node_modules/playwright');
});

// ---------------------------------------------------------------------------------------------------------------------------
// tests: store.migrateLocal in the documented blocks of porting.md

const LIT = (porting) => blockAfter(porting, /^### Example 1: /, 'js');
const ZEIT = (porting) => blockAfter(porting, /^### Example 2: /, 'js');

// The old Literaturliste in a browser: IndexedDB "literatur" with refs { id autoIncrement keyPath, title, ..., pdfId, pdfName, created } and pdfs { id, name, blob }, and the localStorage key with the settings.
const LIT_SEED = String.raw`
  window.seedLit = async function (opts) {
    opts = opts || {};
    await new Promise((ok, fail) => {
      const req = indexedDB.open('literatur', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const refs = db.createObjectStore('refs', { keyPath: 'id', autoIncrement: true });
        const pdfs = db.createObjectStore('pdfs', { keyPath: 'id', autoIncrement: true });
        refs.add({ title: 'Alpha', authors: 'A. Author', year: 2001, pdfId: 1, pdfName: 'eins.pdf', created: '2024-03-01T10:00:00.000Z' });
        refs.add({ title: 'Beta', authors: 'B. Author', year: 2002, pdfId: 99, pdfName: 'weg.pdf', created: '2024-03-02T10:00:00.000Z' });      // its pdf is gone
        refs.add({ title: 'Gamma', authors: 'C. Author', year: 2003, created: '2024-03-03T10:00:00.000Z' });                                       // no pdf at all
        const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 1, 2, 3, 250, 251, 252]);
        pdfs.add(opts.blobs ? { name: 'eins.pdf', blob: new Blob([bytes], { type: 'application/pdf' }) } : { name: 'eins.pdf', type: 'application/pdf', data: bytes.buffer });   // WebKit cannot keep a Blob in IndexedDB on file://
      };
      req.onsuccess = () => { req.result.close(); ok(); };
      req.onerror = () => fail(req.error);
    });
    localStorage.setItem('literaturliste.einstellungen', JSON.stringify({ theme: 'dark', sort: 'year', statsOpen: true, filter: '' }));
    localStorage.setItem('other.app.key', 'keep me');
  };
  window.oldLit = async function () {        // what is left of the old storage
    const out = { local: {}, rows: null };
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k.startsWith('wds:')) out.local[k] = localStorage.getItem(k); }
    const db = await new Promise((resolve) => { const r = indexedDB.open('literatur'); r.onupgradeneeded = () => { r.transaction.abort(); resolve(null); }; r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null); });
    if (db) {
      out.rows = {};
      for (const s of ['refs', 'pdfs']) out.rows[s] = await new Promise((resolve) => { const r = db.transaction(s).objectStore(s).count(); r.onsuccess = () => resolve(r.result); });
      db.close();
    }
    return out;
  };
  window.tagOf = () => localStorage.getItem('wds:migrate:literatur:tag');
`;

async function canKeepBlobs(page) {         // an engine that cannot keep a Blob in IndexedDB for file:// pages: the seed uses bytes (h.blob takes value.data)
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

function litUrl(md, porting, stack, { scope, origin, recipe } = {}) {
  return harness(md, stack, { recipe: recipe || LIT(porting), ret: ['result', 'refs', 'pdfs'], scope: scope || stack.scope, origin, extraHead: '<script>' + LIT_SEED + '</script>' });
}
// Starts the block of the document (it calls store.migrateLocal at once) and returns; the dialogs are answered by the test.
const startLit = (page) => page.evaluate(() => { window.__done = window.__recipe(store, {}).then((r) => (window.R = r), (e) => ({ rejected: e.name + ': ' + e.message })); });
const finishLit = (page) => page.evaluate(() => window.__done);
async function answerYes(page, { backup = false } = {}) {
  const q = dlg(page, 'migrate');
  await expect(q).toBeVisible({ timeout: 30000 });
  await expect(q).not.toHaveAttribute('aria-busy', /.*/);
  if (backup) {
    const download = page.waitForEvent('download');
    await q.locator('[data-wds="migrate-backup"]').click();
    expect((await download).suggestedFilename()).toMatch(/^literatur-old-data-\d{4}-\d{2}-\d{2}\.zip$/);
  }
  await q.locator('[data-wds="migrate-yes"]').click();
}
const vaultOfLit = (page) => page.evaluate(async () => {
  const tag = tagOf(), refs = R.refs, pdfs = R.pdfs;                  // the collections that the block of the document made
  await refs.refresh(); await pdfs.refresh();
  const all = await refs.getAll(), files = [];
  for (const e of pdfs.items()) { const b = await store.getBlob('pdfs/' + e.id); files.push({ id: e.id, meta: e.meta, type: b.type, bytes: [...new Uint8Array(await b.arrayBuffer())] }); }
  return { tag, refs: all.map((r) => ({ id: r.id, meta: r.meta, value: r.value, created: refs.items().find((i) => i.id === r.id).created })), files, settings: await store.get('settings', { fresh: true }), records: (await store.list()).map((r) => r.name) };
});
const PDF_BYTES = [37, 80, 68, 70, 45, 49, 46, 52, 10, 1, 2, 3, 250, 251, 252];

test('porting.md example 1 (references both ways, a dead reference, a Blob, settings): the real server migrates and deletes; the person asked once; a second start finds nothing', async ({ browser, stack, md, porting }) => {
  const url = litUrl(md, porting, stack);
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  if (!(await idbAvailable(page))) test.skip(true, 'this engine has no IndexedDB for file:// pages');
  const accessId = await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  // the person has started the new app already: a setting of its own that the old settings must not overwrite
  await page.evaluate(async () => { await store.set('settings', { theme: 'light' }); });
  await page.evaluate((blobs) => seedLit({ blobs }), await canKeepBlobs(page));
  await startLit(page);
  await answerYes(page, { backup: true });
  const res = await finishLit(page);
  expect(res.result).toEqual({ status: 'migrated', deleted: 'deleted', copied: 4, total: 4, sandbox: false });
  const st = await vaultOfLit(page);
  expect(st.refs).toHaveLength(3);
  const byTitle = Object.fromEntries(st.refs.map((r) => [r.value.title, r]));
  expect(byTitle.Alpha.id).toBe(st.tag + '-j1');
  expect(byTitle.Alpha.value.pdfId).toBe(st.tag + '-j1.pdf');           // the reference computes the id of its pdf as the pdf side does
  expect(byTitle.Alpha.value.pdfName).toBe('eins.pdf');
  expect(byTitle.Alpha.value.id).toBeUndefined();                       // the old counter is the key now
  expect(byTitle.Beta.value.pdfId).toBeNull();                          // a reference to a pdf that is gone
  expect(byTitle.Beta.value.pdfName).toBeNull();
  expect(byTitle.Gamma.value.pdfId).toBeNull();
  expect(byTitle.Alpha.meta).toEqual({ title: 'Alpha' });
  expect(byTitle.Alpha.created).toBe(Date.parse('2024-03-01T10:00:00.000Z'));
  expect(st.refs.slice().sort((a, b) => a.created - b.created).map((r) => r.value.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
  expect(st.files).toEqual([{ id: st.tag + '-j1.pdf', meta: { name: 'eins.pdf', ref: st.tag + '-j1' }, type: 'application/pdf', bytes: PDF_BYTES }]);   // the other direction, byte for byte
  expect(st.settings).toEqual({ theme: 'light', sort: 'year', statsOpen: true, filter: '' });      // the old settings fill only what the vault lacks
  expect(st.records).not.toContain('.wds/migration/literatur/' + st.tag);                          // the marker is hidden
  const old = await page.evaluate(() => oldLit());
  expect(old.rows).toEqual({ refs: 0, pdfs: 0 });
  expect(old.local).toEqual({ 'other.app.key': 'keep me' });            // only the configured keys are gone
  await expect(page.locator('[data-wds-toast=migration]')).toBeVisible();
  // a second start: nothing to take over, no dialog, no question
  const page2 = await open(ctx, url);
  await page2.evaluate(() => { window.R = null; });
  await unlockLater(page2, accessId);
  await startLit(page2);
  expect((await finishLit(page2)).result).toEqual({ status: 'nothing', sandbox: false });
  await expect(page2.locator('dialog[data-wds-view]')).toHaveCount(0);
  await noProblems(page, page2);
  await ctx.close();
});

test('porting.md example 1 with tagged: false: the ids are the ones that the import of section 3 builds (j1, j1.pdf)', async ({ browser, stack, md, porting }) => {
  const recipe = LIT(porting);
  expect(recipe).toContain('id: "literatur",');
  const url = litUrl(md, porting, stack, { recipe: recipe.replace('id: "literatur",', 'id: "literatur", tagged: false,') });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  if (!(await idbAvailable(page))) test.skip(true, 'this engine has no IndexedDB for file:// pages');
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  await page.evaluate((blobs) => seedLit({ blobs }), await canKeepBlobs(page));
  await startLit(page);
  await answerYes(page);
  expect((await finishLit(page)).result).toMatchObject({ status: 'migrated', deleted: 'deleted', copied: 4 });
  const st = await vaultOfLit(page);
  const newId = (oldId) => (typeof oldId === 'string' ? 's' : 'j') + encodeURIComponent(typeof oldId === 'string' ? oldId : JSON.stringify(oldId));     // the function of the import in section 3
  expect(st.refs.map((r) => r.id).sort()).toEqual([newId(1), newId(2), newId(3)]);
  expect(st.files.map((f) => f.id)).toEqual([newId(1) + '.pdf']);
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
  const url = litUrl(md, porting, stack, { scope: SANDBOX_ID, origin: stack.sandbox.origin });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  if (!(await idbAvailable(page))) test.skip(true, 'this engine has no IndexedDB for file:// pages');
  await sandboxVault(page);
  await page.evaluate((blobs) => seedLit({ blobs }), await canKeepBlobs(page));
  await startLit(page);
  await expect(dlg(page, 'migrate')).toContainText('Sandbox');
  await answerYes(page);
  const res = await finishLit(page);
  expect(res.result).toEqual({ status: 'migrated', deleted: 'kept', copied: 4, total: 4, sandbox: true });
  const old = await page.evaluate(() => oldLit());
  expect(old.rows).toEqual({ refs: 3, pdfs: 1 });                        // still there
  expect(Object.keys(old.local).sort()).toEqual(['literaturliste.einstellungen', 'other.app.key']);
  expect((await vaultOfLit(page)).refs).toHaveLength(3);
  // what the person does in the new app stays: an edit and a deletion survive the next start, and nothing is asked again
  await page.evaluate(async () => { const all = R.refs.items(); await R.refs.remove(all[0].id); });
  await startLit(page);
  const again = await finishLit(page);
  expect(again.result).toMatchObject({ status: 'migrated', again: true, deleted: 'kept' });
  await expect(page.locator('dialog[data-wds-view="migrate"]')).toHaveCount(0);
  expect((await vaultOfLit(page)).refs).toHaveLength(2);
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
  const url = litUrl(md, porting, stack, { scope: SANDBOX_ID, origin: stack.sandbox.origin });
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
  await page.evaluate((blobs) => seedLit({ blobs }), await canKeepBlobs(page));
  await startLit(page);
  await answerYes(page);                                                         // (the question is the sandbox's and still says that the old data stays; the result says what happened)
  expect((await finishLit(page)).result).toMatchObject({ status: 'migrated', deleted: 'deleted', copied: 4, sandbox: true });
  expect((await page.evaluate(() => oldLit())).rows).toEqual({ refs: 0, pdfs: 0 });
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
  expect(res.result).toEqual({ status: 'nothing', sandbox: false });
  await expect(page.locator('dialog[data-wds-view]')).toHaveCount(0);
  expect(requests - before).toBeLessThanOrEqual(1);                       // at most the scope document that tells whether this is a sandbox
  await noProblems(page);
  await ctx.close();
});

test('porting.md, what your app does with the result: the start function asks once per page and loads afterwards', async ({ browser, stack, md, porting }) => {
  const recipe = blockAfter(porting, /^### What your app does with the result$/, 'js');
  const url = harness(md, stack, { recipe, params: ['takeOverOldData', 'renderList', 'refs'], ret: ['start'], scope: stack.scope });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  const warned = [];
  page.on('console', (m) => { if (m.type() === 'warning') warned.push(m.text()); });
  const calls = await page.evaluate(async () => {
    const log = [];
    const R = await window.__recipe(store, {
      takeOverOldData: async () => { log.push('migrate'); return { status: 'failed', why: 'a reason for the developer' }; },
      renderList: (items) => log.push('render ' + items.join(',')),
      refs: { load: async () => { log.push('load'); return ['a', 'b']; } },
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
  expect(app).not.toMatch(/indexedDB\.open|localStorage\.(getItem|removeItem|setItem)/);              // the app itself never touches the old storage
  for (const name of ['projectsCol', 'timeCol', 'notesCol', 'filesCol']) expect(app).toContain('var ' + name + ' = store.collection');
});

test('the seed block of porting.md and of section 12 is the one of examples/zeit-notizen/wds-verify.json, and the old app has the elements it names', async ({ md, porting }) => {
  const file = JSON.parse(readFileSync(join(HERE, 'zeit-notizen', 'wds-verify.json'), 'utf8'));
  const fromPorting = JSON.parse(blockAfter(porting, /^### The migration test in wds-verify /, 'json'));
  expect(fromPorting.seed).toEqual(file.seed);
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
test('the popup block of integration.md (Files) and porting.md (checklist) is one and the same, opens the window inside the click and falls back to a download link', async ({ browser, stack, md, porting }) => {
  const fromGuide = blockAfter(md, POPUP_HEADING, 'js', 1);
  const fromPorting = blockAfter(porting, /^## 7\. Checklist for apps with forms and modal dialogs$/, 'js', 1);
  expect(fromGuide).toBe(fromPorting);
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

test('porting.md checklist for apps with forms: own dialogs are closed on lock, the typed values stay after a failed save, the button is disabled while saving and enabled again', async ({ browser, stack, md, porting }) => {
  const recipe = blockAfter(porting, /^## 7\. Checklist for apps with forms and modal dialogs$/, 'js', 0);
  const url = harness(md, stack, { recipe, params: ['refs', 'form', 'saveButton', 'readForm', 'showSaved', 'showError', 'closeForm', 'clearScreen', 'id'], ret: [], scope: stack.scope,
    extraBody: '<dialog id="mine"><p>my own modal dialog</p></dialog><form id="f"><input id="title" value="typed text"><button id="save" type="submit">Save</button></form>' });
  const ctx = await newContext(browser);
  const page = await open(ctx, url);
  await page.evaluate(async () => {
    window.__log = []; window.__gate = null;
    window.refs = store.collection('refs/', { meta: (r) => ({ title: r.title }) });
    window.__realSet = window.refs.set.bind(window.refs);
    window.refs.set = async (id, v) => { window.__log.push('set ' + v.title); if (window.__gate) await window.__gate; if (window.__fail) throw Object.assign(new Error('offline'), { name: 'OfflineError' }); return window.__realSet(id, v); };
    await window.__recipe(store, {
      refs: window.refs, form: document.getElementById('f'), saveButton: document.getElementById('save'), id: 'item-1.pdf',
      readForm: () => ({ title: document.getElementById('title').value }),
      showSaved: (v) => window.__log.push('saved ' + v.title), showError: (e) => window.__log.push('error ' + e.message), closeForm: () => window.__log.push('closed'),
      clearScreen: () => window.__log.push('cleared'),
    });
  });
  await openVault(page, stack);
  await page.evaluate(() => window.__unlock);
  // (3) while the save is in flight the button is disabled; (4) the submit does not navigate
  await page.evaluate(() => { window.__gate = new Promise((r) => { window.__openGate = r; }); });
  await page.locator('#save').click();
  await expect(page.locator('#save')).toBeDisabled();
  await page.evaluate(() => window.__openGate());
  await expect(page.locator('#save')).toBeEnabled();
  expect(await page.evaluate(() => window.__log)).toEqual(['set typed text', 'closed', 'saved typed text']);
  expect(page.url()).toBe(url);
  // (2) a failed save keeps the form: nothing is closed, the error is shown, the button is enabled again
  await page.evaluate(() => { window.__log.length = 0; window.__gate = null; window.__fail = true; });
  await page.locator('#save').click();
  await expect.poll(() => page.evaluate(() => window.__log.length)).toBe(2);
  expect(await page.evaluate(() => window.__log)).toEqual(['set typed text', 'error offline']);
  await expect(page.locator('#save')).toBeEnabled();
  expect(await page.locator('#title').inputValue()).toBe('typed text');
  // (1) an own modal dialog is closed by the onLock handler, which the library calls on every lock
  await page.evaluate(() => { window.__log.length = 0; document.getElementById('mine').showModal(); });
  expect(await page.evaluate(() => document.querySelectorAll('dialog:not(.wds-dialog)[open]').length)).toBe(1);
  await page.evaluate(() => store.lock());
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('dialog:not(.wds-dialog)[open]').length)).toBe(0);
  expect(await page.evaluate(() => window.__log)).toContain('cleared');
  // (6) an id with "." and a percent sign goes into a selector through CSS.escape
  expect(await page.evaluate(() => { const el = document.createElement('li'); el.id = 'item-a%2Fb.pdf'; document.body.append(el); return document.querySelector('#item-' + CSS.escape('a%2Fb.pdf')) === el; })).toBe(true);
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
    return { stopReason: R.saver.stopReason, readOnly: textarea.readOnly, hidden: saveButton.hidden, saved: await store.get('draft', { fresh: true }) };
  });
  expect(out).toEqual({ stopReason: 'stop', readOnly: false, hidden: false, saved: { text: 'draft text' } });
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
    'integration|Conflicts in code|0': RUN,
    'integration|8. Members and sharing|0': RUN,
    'integration|12. wds-verify|0': 'shell: text only',
    'integration|12. wds-verify|1': 'shell: text only',
    'integration|Writing wds-verify.json|0': 'json: parsed below',
    'integration|Writing wds-verify.json|1': 'json: equal to the file of the example app',
    'integration|13. What to tell users|0': 'text: the sentences are compared in test_docs.py',
    'integration|14. Complete minimal example|0': 'run: wds-verify (mock and sandbox)',
    'porting|3. Own export and import|0': RUN,
    'porting|3. Own export and import|1': RUN,
    'porting|The call|0': RUN,
    'porting|Example 1: references in both directions, files, settings in localStorage|0': RUN,
    'porting|Example 2: a localStorage JSON, notes, files and a key-value store|0': 'identical to the app, which app.spec.mjs runs against a seeded old browser',
    'porting|What your app does with the result|0': RUN,
    'porting|The migration test in wds-verify (the seed block)|0': 'json: equal to the example, run by wds-verify below',
    'porting|The deletion path in the sandbox: the test global|0': PARSE,
    'porting|The join code for tests (a real scope)|0': 'shell: text only',
    'porting|7. Checklist for apps with forms and modal dialogs|0': RUN,
    'porting|7. Checklist for apps with forms and modal dialogs|1': RUN,
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

test('the Literaturliste block of porting.md uses the library for the old data: no static finding, an info that says so; the same app with hand-made code is warned about', async ({ stack, md, porting }) => {
  const dir = join(stack.pages, 'verify-static');
  mkdirSync(dir, { recursive: true });
  const base = section14(md);
  const page = (script) => productionPage(stack, base.replace(/<script>\n"use strict";[\s\S]*<\/script>/, '<script>\n"use strict";\nconst store = WDS.connect({ scope: "myapp-k7m2a9" });\n' + script + '\n</script>'));
  const good = 'async function takeOverOldData() {\n' + LIT(porting) + '\n  return result;\n}\nstore.onUnlock(async () => { await takeOverOldData(); });\nstore.unlock();';
  writeFileSync(join(dir, 'good.html'), page(good));
  const r = verify(join(dir, 'good.html'), '--static-only');
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain('store.migrateLocal');
  expect(r.stdout).not.toContain('taken over by hand');
  expect(r.stdout).not.toContain('Deleting local data');
  expect(r.stdout).not.toContain('localStorage.clear()');
  // the hand-made way: reading and deleting the old storage in the app
  const bad = 'async function takeOver() {\n  const req = indexedDB.open("literatur");\n  req.onsuccess = () => { localStorage.removeItem("literaturliste.einstellungen"); };\n}\nstore.unlock();';
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
