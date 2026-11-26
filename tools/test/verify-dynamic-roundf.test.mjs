// wds-verify, round F: the readiness of the library's dialogs (a dialog without a view, busy, or with a field that is disabled for a while is waited for, never
// "unexpected"), the library's migration dialogs (migrate, migrate-large) answered by the tool, an app with a modal dialog of its own, the name of a value that was
// neither shown nor written, the reset of a restored search field, and store.migrateLocal end to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { writeApp, verify, run, miniApp, variant, freshHtml, tmpDir, ROOT } from './helpers.mjs';
import { startMock } from '../lib/wds-mock.mjs';

// What the library under test can do (LIB works in parallel: a test that needs a part that is not there yet is skipped, and says why).
const uiSrc = readFileSync(join(ROOT, 'client', 'src', 'wds-ui.js'), 'utf8');
const LIB_TOP_LAYER = /el\('dialog'/.test(uiSrc);
const LIB_MIGRATE = /migrateLocal\s*[:=(]/.test(uiSrc) && /migrate-yes/.test(uiSrc);
const needs = (ok, why) => (ok ? {} : { skip: why });

const noNotes = (r) => assert.equal(r.find('driver'), undefined, r.find('driver') && r.find('driver').detail);

// ---- readiness: the library builds its dialog in steps; the tool waits ----
const FLICKER = [
  "$('go').onclick = function () { store.set('note', { a: $('a').value }); };",
  "store.unlock().then(function () { return store.get('note'); }).then(function (v) { if (v) $('a').value = v.a; });",
  '// every unlock dialog goes through the states of a dialog that is being built: no view, a field that is disabled, busy',
  "new MutationObserver(function () {",
  "  var d = document.querySelector('[data-wds-view=\"unlock\"]:not([data-flicked])');",
  "  if (!d) return;",
  "  d.setAttribute('data-flicked', '1');",
  "  var p = d.querySelector('[data-wds=\"passphrase\"]');",
  "  d.setAttribute('data-wds-view', ''); d.setAttribute('aria-busy', 'true'); if (p) p.disabled = true;",
  "  setTimeout(function () { d.setAttribute('data-wds-view', 'unlock'); }, 600);",
  "  setTimeout(function () { d.removeAttribute('aria-busy'); if (p) p.disabled = false; }, 1200);",
  "}).observe(document.documentElement, { childList: true, subtree: true });",
].join('\n');

test('a dialog that is built in steps (no view, aria-busy, a disabled field) is waited for: no "unexpected dialog", no note, the reload passes', { timeout: 240000 }, async () => {
  const app = miniApp({ body: '<label>Note <input id="a" type="text"></label><button id="go" type="button" data-wds-verify="save">Keep</button>', script: FLICKER });
  const r = await verify(writeApp(app));
  assert.equal(r.code, 0, JSON.stringify(r.failures) + r.stderr);
  noNotes(r);
  assert.equal(r.find('reload').level, 'pass', r.find('reload').detail);
  assert.equal(r.find('vault').level, 'pass');
  assert.deepEqual(r.warnings.map((w) => w.id), []);
});

// ---- the library's migration dialogs, played by the page itself (the tool must not depend on the library's migrateLocal for this) ----
const OLD_APP = '<!doctype html><html><head><meta charset="utf-8"><title>Old notes</title></head><body>\n'
  + '<label>Title <input id="title" type="text"></label><button id="save" type="button">Save</button>\n<script>\n'
  + "var req = indexedDB.open('oldapp', 1);\n"
  + "req.onupgradeneeded = function () { req.result.createObjectStore('notes', { keyPath: 'id' }); };\n"
  + "var ready = new Promise(function (ok) { req.onsuccess = function () { ok(req.result); }; });\n"
  + "document.getElementById('save').onclick = function () { ready.then(function (db) { var tx = db.transaction('notes', 'readwrite'); tx.objectStore('notes').put({ id: 'n' + Date.now() + Math.floor(Math.random() * 1000), title: document.getElementById('title').value }); localStorage.setItem('oldapp:prefs', JSON.stringify({ theme: 'dark' })); }); };\n"
  + '</script></body></html>';
const SEED = { page: 'old.html', steps: [{ fill: ['#title', 'old note {canary}'] }, { click: '#save' }] };
function writeMig(html, config, old = OLD_APP) {
  const dir = writeApp(html, config);
  writeFileSync(join(dir, 'old.html'), old);
  return dir;
}

// A page that plays the migration dialogs of the library: the markup and the names of client/README.md (view migrate with migrate-backup, migrate-yes;
// view migrate-large with migrate-large-download and migrate-delete, which stays disabled until every file was downloaded), made by the page.
// large: two entries "are too large" and have to be downloaded one by one before the old data may go.
const FAKE = `
  function openOld() { return new Promise(function (ok) { var req = indexedDB.open('oldapp'); req.onupgradeneeded = function () { req.transaction.abort(); }; req.onsuccess = function () { ok(req.result); }; req.onerror = function () { ok(null); }; }); }
  function all(db, name) { return new Promise(function (ok) { var q = db.transaction(name).objectStore(name).getAll(); q.onsuccess = function () { ok(q.result); }; }); }
  function download(name, text, type) { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function dialog(view, html) { var d = document.createElement('div'); d.className = 'wds-root'; d.setAttribute('data-wds-view', view); d.innerHTML = html; document.body.appendChild(d); return d; }
  function wait(el, name) { return new Promise(function (ok) { el.querySelector('[data-wds=' + name + ']').onclick = ok; }); }
  var LARGE = __LARGE__;
  async function migrate() {
    var db = await openOld(); if (!db || !db.objectStoreNames.contains('notes')) return;
    var rows = await all(db, 'notes'); if (!rows.length) return;
    var d = dialog('migrate', '<p>Take over the data?</p><button data-wds="migrate-backup">Backup</button><button data-wds="migrate-yes">Take over</button><button data-wds="migrate-no">Not now</button>');
    d.setAttribute('aria-busy', 'true'); await new Promise(function (ok) { setTimeout(ok, 500); }); d.removeAttribute('aria-busy');
    d.querySelector('[data-wds=migrate-backup]').onclick = function () { download('oldapp-old-data-2031-01-01.json', JSON.stringify(rows), 'application/json'); };
    await wait(d, 'migrate-yes'); d.remove();
    for (var i = 0; i < rows.length; i++) await store.set('notes/' + rows[i].id, { title: rows[i].title });
    if (LARGE) {
      var big = dialog('migrate-large', '<button data-wds="migrate-large-download">One</button><button data-wds="migrate-large-download">Two</button><button data-wds="migrate-delete" disabled>Delete anyway</button>');
      var left = 2, del = big.querySelector('[data-wds=migrate-delete]');
      big.querySelectorAll('[data-wds=migrate-large-download]').forEach(function (b, i) { b.onclick = function () { download('large-' + i + '.bin', rows[0].title, 'application/octet-stream'); if (--left === 0) del.disabled = false; }; });
      await new Promise(function (ok) { del.onclick = function () { if (!del.disabled) ok(); }; }); big.remove();
    }
    var tx = db.transaction('notes', 'readwrite'); tx.objectStore('notes').clear(); await new Promise(function (ok) { tx.oncomplete = ok; }); db.close();
    localStorage.removeItem('oldapp:prefs');
    $('result').textContent = 'migrated';
    await render();
  }
  async function render() { var out = [], l = await store.list('notes/'); for (var i = 0; i < l.length; i++) out.push((await store.get(l[i].name)).title); $('list').textContent = out.join(' | '); }
  store.unlock().then(render).then(migrate);`;
const fakeMigration = (large) => miniApp({ body: '<ul id="list"></ul><p id="result"></p>', script: FAKE.replace('__LARGE__', large ? 'true' : 'false') });

test('the tool answers the migration dialog of the library: it waits for the busy state, downloads the backup (not a leak), presses "Take over"; the old data is deleted', { timeout: 240000 }, async () => {
  const r = await verify(writeMig(fakeMigration(false), { seed: SEED }));
  assert.equal(r.code, 0, JSON.stringify(r.failures) + r.stderr);
  noNotes(r);
  assert.equal(r.find('migration-visible').level, 'pass', r.find('migration-visible').detail);
  assert.equal(r.find('migration-old-data').level, 'pass', r.find('migration-old-data').detail);
  assert.equal(r.find('leak-download').level, 'pass');
  const d = r.find('migration-dialog');
  assert.equal(d.level, 'info');
  assert.match(d.detail, /downloaded the backup \(oldapp-old-data-2031-01-01\.json\) and pressed "Take over"/);
  assert.match(r.find('downloads').detail, /oldapp-old-data-2031-01-01\.json \(offered by the library's migration dialog\)/);
});

test('the tool answers migrate-large: every file is downloaded one by one, then "delete anyway"; the downloads hold the old data and are no leak', { timeout: 240000 }, async () => {
  const r = await verify(writeMig(fakeMigration(true), { seed: SEED }));
  assert.equal(r.code, 0, JSON.stringify(r.failures) + r.stderr);
  noNotes(r);
  assert.equal(r.find('migration-old-data').level, 'pass', r.find('migration-old-data').detail);
  assert.equal(r.find('leak-download').level, 'pass', r.find('leak-download').detail);
  assert.match(r.find('migration-dialog').detail, /2 entries were too large for the vault: the tool downloaded them and deleted the old data anyway/);
  assert.match(r.find('downloads').detail, /large-0\.bin \(offered by the library's migration dialog\).*large-1\.bin \(offered by the library's migration dialog\)/);
  // the same data as an ordinary download that the app starts on its own is a leak
  const leaky = variant(fakeMigration(false), "$('result').textContent = 'migrated';", "download('copy.txt', rows[0].title, 'text/plain'); $('result').textContent = 'migrated';");
  const l = await verify(writeMig(leaky, { seed: SEED }));
  assert.ok(l.titles('fail').includes('Canary found in download'), l.titles('fail').join('|'));
});

// ---- an app with a modal dialog of its own ----
const MODAL_BODY = '<dialog id="welcome"><p>Welcome</p><button id="welcome-ok" type="button">Close</button></dialog><label>Note <input id="a" type="text"></label><button id="go" type="button" data-wds-verify="save">Keep</button>';
const MODAL_SCRIPT = [
  "var w = $('welcome'); $('welcome-ok').onclick = function () { w.close(); };",
  "$('go').onclick = function () { store.set('note', { a: $('a').value }); };",
  'w.showModal();',
  "store.unlock().then(function () { return store.get('note'); }).then(function (v) { if (v) $('a').value = v.a; });",
].join('\n');

test('an app with a modal dialog of its own that is open at every start: the library dialogs come up above it, a step closes it; without the step the report says why nothing was typed', { timeout: 300000, ...needs(LIB_TOP_LAYER, 'the library does not use top-layer dialogs yet') }, async () => {
  const app = miniApp({ body: MODAL_BODY, script: MODAL_SCRIPT });
  const ok = await verify(writeApp(app, { steps: [{ click: '#welcome-ok' }], afterReload: [{ click: '#welcome-ok' }] }));
  assert.equal(ok.code, 0, JSON.stringify(ok.failures) + ok.stderr);
  noNotes(ok);
  assert.equal(ok.find('vault').level, 'pass');
  assert.equal(ok.find('reload').level, 'pass', ok.find('reload').detail);
  assert.equal(ok.find('app-modals').level, 'info');
  assert.deepEqual(ok.warnings.map((w) => w.id), []);
  // without steps the page behind the modal is inert: nothing can be typed, and the report names the cause
  const none = await verify(writeApp(app));
  assert.equal(none.find('vault').level, 'pass');
  assert.equal(none.find('fields').level, 'warn');
  assert.match(none.find('fields').detail, /field\(s\) sat behind a modal dialog of the app.*add a first step that closes it/);
});

// ---- the value that was neither shown nor written is named ----
test('"neither shown nor written" names the field and its value', { timeout: 240000 }, async () => {
  const app = miniApp({
    body: '<label>Title <input id="title" type="text"></label><label>DOI <input id="eDoi" type="text"></label><button id="go" type="button" data-wds-verify="save">Keep</button><p id="shown"></p>',
    script: "$('go').onclick = function () { store.set('entry', { title: $('title').value }); $('shown').textContent = $('title').value; };\n"
      + "store.unlock().then(function () { return store.get('entry'); }).then(function (v) { if (v) $('shown').textContent = v.title; });",
  });
  const r = await verify(writeApp(app));
  assert.equal(r.code, 0, JSON.stringify(r.failures) + r.stderr);
  assert.equal(r.find('reload').level, 'pass', r.find('reload').detail);
  assert.match(r.find('reload').detail, /1 other typed value was neither shown as text nor written to the store before the reload and is not counted: #eDoi \("WDSCANARY [0-9a-f]+z\d\d äöü&="\)\./);
  // a step-typed value is named by its selector
  const steps = await verify(writeApp(app, { steps: [{ fill: ['#eDoi', 'doi 10.1000/{canary}'] }] }));
  assert.match(steps.find('reload').detail, /2 other typed values were neither shown.*#eDoi \("WDSCANARY [0-9a-f]+z\d\d äöü&="\), #eDoi \("doi 10\.1000\/WDSCANARY-[0-9a-f]+z\d\d"\)\./);
});

// ---- a restored search field ----
const SEARCH_APP = () => miniApp({
  body: '<label>Search <input id="fSearch" type="search"></label><label>Title <input id="title" type="text"></label><button id="go" type="button" data-wds-verify="save">Keep</button><ul id="list"></ul>',
  script: [
    "var items = [], filter = '';",
    "function render() { $('list').textContent = ''; items.filter(function (i) { return !filter || i.title.indexOf(filter) >= 0; }).forEach(function (i) { var li = document.createElement('li'); li.textContent = i.title; $('list').appendChild(li); }); }",
    "$('fSearch').onchange = function () { filter = $('fSearch').value; store.set('settings', { filter: filter }); render(); };",
    "$('go').onclick = function () { items.push({ title: $('title').value }); store.set('items', { items: items }); render(); };",
    "store.unlock().then(function () { return Promise.all([store.get('settings'), store.get('items')]); }).then(function (r) { filter = (r[0] && r[0].filter) || ''; $('fSearch').value = filter; items = (r[1] && r[1].items) || []; render(); });",
  ].join('\n'),
});

test('an app that restores its search field: the tool clears the field (a search field only) when values are hidden by it, and says so', { timeout: 300000 }, async () => {
  const r = await verify(writeApp(SEARCH_APP()));
  assert.equal(r.code, 0, JSON.stringify(r.failures) + r.stderr);
  assert.equal(r.find('reload').level, 'pass', r.find('reload').detail);
  const s = r.find('search-reset');
  assert.equal(s.level, 'info');
  assert.match(s.detail, /the field #fSearch held a value typed before the reload.*reset a restored search field #fSearch.*\{"fill": \["#fSearch", ""\]\}/);
  // the same app with the reset as an afterReload step (an empty text is allowed in a fill step): the tool has nothing to clear
  const stepped = await verify(writeApp(SEARCH_APP(), { afterReload: [{ fill: ['#fSearch', ''] }] }));
  assert.equal(stepped.code, 0, JSON.stringify(stepped.failures) + stepped.stderr);
  assert.equal(stepped.find('search-reset'), undefined);
  assert.equal(stepped.find('afterReload-step-1'), undefined);
  // a field that is no search field is left alone: the values stay hidden and the check says so as before
  const plain = SEARCH_APP().replace(/fSearch/g, 'fOther').replace('type="search"', 'type="text"');
  const p = await verify(writeApp(plain));
  assert.equal(p.find('search-reset'), undefined);
  assert.notEqual(p.find('reload').level, 'fail');
});

// ---- the same app five times in a row: no flaky note ----
test('examples/zeit-notizen five times in a row: no note, no warning (the unlock dialog after the reload is waited for)', { timeout: 900000 }, async () => {
  // a copy of the example with the integrity hash of the library as it is built now (the example carries the hash of the last release build)
  const dir = tmpDir('wds-zeit-');
  cpSync(join(ROOT, 'examples', 'zeit-notizen'), dir, { recursive: true });
  for (let i = 1; i <= 5; i++) {
    writeFileSync(join(dir, 'index.html'), freshHtml(readFileSync(join(ROOT, 'examples', 'zeit-notizen', 'index.html'), 'utf8')));   // again every time: the hash follows a rebuild
    const r = await run('wds-verify.mjs', [dir, '--json', '--target', 'mock']);
    const j = JSON.parse(r.stdout);
    const bad = j.findings.filter((f) => f.level === 'fail' || f.level === 'warn');
    assert.equal(r.code, 0, 'run ' + i + ': ' + JSON.stringify(bad));
    assert.deepEqual(bad.map((f) => f.id + ': ' + f.detail.slice(0, 300)), [], 'run ' + i);
  }
});

// ---- store.migrateLocal end to end (needs the library's migrateLocal) ----
const NEW_BODY = '<ul id="list"></ul><p id="result"></p><label>New note <input id="n" type="text"></label><button id="add" type="button">Add</button>';
const MIGRATE_LOCAL = `
  var notes = store.collection('notes/');
  var MIGRATION = {
    id: 'oldnotes',
    indexedDB: { name: 'oldapp', stores: ['notes'] },
    localStorage: { keys: ['oldapp:prefs'] },
    map: function (old, h) {
      var prefs = old.json('oldapp:prefs') || {};
      return {
        items: old.rows('notes').map(function (r) { return { col: notes, id: h.id(r.key), value: { title: r.value.title }, from: r }; }),
        settings: { record: 'settings', value: { theme: prefs.theme }, from: 'oldapp:prefs' },
      };
    },
  };
  async function render() { var vals = await notes.getAll(); $('list').textContent = vals.map(function (v) { return v.value.title; }).join(' | '); }
  $('add').addEventListener('click', function () { notes.add({ title: $('n').value }).then(render); });
  store.unlock().then(function () { return store.migrateLocal(MIGRATION); }).then(function (res) { $('result').textContent = res.status + (res.deleted ? ' ' + res.deleted : ''); return notes.load(); }).then(render);`;
const migrateApp = () => miniApp({ body: NEW_BODY, script: MIGRATE_LOCAL });

test('store.migrateLocal (mock): the tool answers the library, the values are in the vault after the reload, the old data is gone, no warning', { timeout: 300000, ...needs(LIB_MIGRATE, 'the library has no store.migrateLocal yet') }, async () => {
  const r = await verify(writeMig(migrateApp(), { seed: SEED }));
  assert.equal(r.code, 0, JSON.stringify(r.failures) + r.stderr);
  noNotes(r);
  assert.equal(r.find('migrate-local').level, 'info');
  assert.equal(r.find('migration-visible').level, 'pass', r.find('migration-visible').detail);
  assert.equal(r.find('migration-encrypted').level, 'pass');
  assert.equal(r.find('migration-old-data').level, 'pass', r.find('migration-old-data').detail);
  assert.equal(r.find('migration-dialog').level, 'info');
  assert.match(r.find('migration-dialog').detail, /downloaded the backup/);
  assert.equal(r.find('leak-download').level, 'pass');
  assert.deepEqual(r.warnings.map((w) => w.id), []);
  assert.equal(r.find('hand-migration'), undefined);
  assert.equal(r.find('local-delete'), undefined);
  // an app that never calls it: not visible, old data still there, and the report names the call
  const lazy = variant(migrateApp(), 'return store.migrateLocal(MIGRATION);', 'return null;');
  const l = await verify(writeMig(lazy, { seed: SEED }));
  assert.equal(l.code, 1);
  assert.ok(l.titles('fail').includes('Migration: old data visible'), l.titles('fail').join('|'));
  assert.match(l.find('migration-visible').detail, /does the app call await store\.migrateLocal/);
});

// The real library, the real migrate-large view: one entry is larger than the record limit of the mock scope. The tool downloads it (the
// library's own download button), presses "delete anyway", and the old data is gone; the other entry is in the vault.
const OLD_APP_BIG = OLD_APP.replace("tx.objectStore('notes').put({ id: 'n' + Date.now() + Math.floor(Math.random() * 1000), title: document.getElementById('title').value });",
  "var os = tx.objectStore('notes'); os.put({ id: 'n' + Date.now() + Math.floor(Math.random() * 1000), title: document.getElementById('title').value }); os.put({ id: 'big', title: 'big file', file: new Blob([new Uint8Array(11 * 1024 * 1024)], { type: 'application/octet-stream' }) });");
const MIGRATE_BIG = MIGRATE_LOCAL.replace("items: old.rows('notes').map(function (r) { return { col: notes, id: h.id(r.key), value: { title: r.value.title }, from: r }; }),",
  "items: old.rows('notes').map(function (r) { return { col: notes, id: h.id(r.key), value: r.value.file || { title: r.value.title }, from: r }; }),")
  .replace("$('list').textContent = vals.map(function (v) { return v.value.title; }).join(' | ');", "$('list').textContent = vals.map(function (v) { return v.value && v.value.title; }).filter(Boolean).join(' | ');");

test('the real migrate-large view of the library: the tool downloads the large entry, presses "delete anyway", and the old data is gone (mock)', { timeout: 300000, ...needs(LIB_MIGRATE, 'the library has no store.migrateLocal yet') }, async () => {
  assert.ok(OLD_APP_BIG !== OLD_APP && MIGRATE_BIG !== MIGRATE_LOCAL, 'the test variants were not applied');
  const r = await verify(writeMig(miniApp({ body: NEW_BODY, script: MIGRATE_BIG }), { seed: SEED }, OLD_APP_BIG));
  assert.equal(r.code, 0, JSON.stringify(r.failures) + r.stderr);
  assert.equal(r.find('migration-visible').level, 'pass', r.find('migration-visible').detail);
  assert.equal(r.find('migration-old-data').level, 'pass', r.find('migration-old-data').detail);
  assert.match(r.find('migration-dialog').detail, /1 entry was too large for the vault.*deleted the old data anyway/, r.find('migration-dialog').detail);
  assert.equal(r.find('leak-download').level, 'pass');
  assert.deepEqual(r.warnings.map((w) => w.id), []);
});

// Rows that map leaves out are deleted with the old data: the question asks for a confirmation, the tool ticks it and the report warns.
test('store.migrateLocal: h.skip rows need the confirmation of the question; the tool ticks the box and warns (mock)', { timeout: 300000, ...needs(LIB_MIGRATE, 'the library has no store.migrateLocal yet') }, async () => {
  const skipping = variant(migrateApp(), "settings: { record: 'settings', value: { theme: prefs.theme }, from: 'oldapp:prefs' },", "settings: (h.skip('oldapp:prefs', 'a cache'), undefined),");
  assert.ok(skipping !== migrateApp());
  const r = await verify(writeMig(skipping, { seed: SEED }));
  assert.equal(r.code, 0, JSON.stringify(r.failures) + r.stderr);
  assert.equal(r.find('migration-skipped-rows').level, 'warn');
  assert.match(r.find('migration-skipped-rows').detail, /deleted together with the old data/);
  assert.equal(r.find('migration-visible').level, 'pass', r.find('migration-visible').detail);
  assert.equal(r.find('migration-old-data').level, 'pass', r.find('migration-old-data').detail);
});

// A notice of the library (bottom right, above dialogs) can cover a button of the app: the tool says so, dismisses it and clicks again.
test('a click that a library notice covers: the tool dismisses the notice, clicks again and says what happened', { timeout: 240000 }, async () => {
  const script = "$('go').onclick = function () { store.set('note', { a: $('a').value }); };\n"
    + "store.unlock().then(function () { var t = document.createElement('div'); t.className = 'wds-toasts wds-root'; t.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483000'; t.innerHTML = '<div class=\"wds-toast\" style=\"width:100%;height:100%\"><button type=\"button\" data-wds=\"toast-dismiss\" style=\"width:100%;height:100%\">Dismiss</button></div>'; t.querySelector('button').onclick = function () { t.remove(); }; document.body.appendChild(t); });";
  const app = miniApp({ body: '<label>Note <input id="a" type="text"></label><button id="go" type="button">Keep</button>', script });
  const r = await verify(writeApp(app, { steps: [{ fill: ['#a', 'a note with a long {canary}'] }, { click: '#go' }] }));
  assert.equal(r.titles('fail').filter((t) => /step/.test(t)).length, 0, JSON.stringify(r.failures) + r.stderr);
  assert.match((r.find('driver') || { detail: '' }).detail, /a notice of the library covered #go/);
});

let mock;
before(async () => { if (LIB_MIGRATE) mock = await startMock({ bundle: true, sandbox: true }); });
after(async () => { if (mock) await mock.stop(); });
async function sbVerify(dir, args = []) {
  const r = await run('wds-verify.mjs', [dir, '--json', '--target', 'sandbox', ...args], { env: { WDS_VERIFY_SERVICE: mock.origin + '/datastore', WDS_VERIFY_LIBRARY: mock.bundle.file } });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (e) { /* no report */ }
  return { ...r, parsed, find: (id) => (parsed ? parsed.findings.find((f) => f.id === id) : undefined), titles: (level) => (parsed ? parsed.findings.filter((f) => f.level === level).map((f) => f.title) : []) };
}

test('store.migrateLocal (sandbox): the old data is kept; with --migration-delete (the global, set by the tool in its own browser) it is deleted', { timeout: 300000, ...needs(LIB_MIGRATE, 'the library has no store.migrateLocal yet') }, async () => {
  const kept = await sbVerify(writeMig(migrateApp(), { seed: SEED }));
  assert.equal(kept.code, 0, JSON.stringify(kept.parsed && kept.parsed.findings.filter((f) => f.level === 'fail')) + kept.stderr);
  assert.equal(kept.find('migration-old-data').level, 'pass');
  assert.match(kept.find('migration-old-data').title, /kept in the sandbox/);
  const del = await sbVerify(writeMig(migrateApp(), { seed: SEED }), ['--migration-delete']);
  assert.equal(del.code, 0, JSON.stringify(del.parsed && del.parsed.findings.filter((f) => f.level === 'fail')) + del.stderr);
  assert.match(del.find('migration-old-data').title, /deleted/);
  assert.equal(del.find('migration-visible').level, 'pass');
});
