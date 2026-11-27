// wds-verify: the migration test (the "seed" of wds-verify.json), the union of the views after the reload, the placeholder {canary}, and the sandbox
// wording. The old app is a tiny local-only notes page (IndexedDB "oldapp" + one localStorage key); the new app copies it into the vault.
// The new app here migrates BY HAND (own prompt, own deletion, answered by steps): the tests check what the tool sees, whatever the app does, including the
// bad ways (no copy, a plaintext copy, a deletion in the sandbox, a forgotten store). The good way, store.migrateLocal with the library's own dialogs, is in
// verify-dynamic-roundf.test.mjs; a hand-made migration also gets the static finding 'hand-storage' (verify-static.test.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeApp, verify, run, miniApp, readApp, variant, tmpDir } from './helpers.mjs';
import { startMock } from '../lib/wds-mock.mjs';
import { parseConfig } from '../lib/config.mjs';

const OLD_APP = `<!doctype html><html><head><meta charset="utf-8"><title>Old notes</title></head><body>
<label>Title <input id="title" type="text"></label><button id="save" type="button">Save</button>
<script>
var req = indexedDB.open('oldapp', 1);
req.onupgradeneeded = function () { req.result.createObjectStore('notes', { keyPath: 'id' }); };
var ready = new Promise(function (ok) { req.onsuccess = function () { ok(req.result); }; });
document.getElementById('save').onclick = function () {
  ready.then(function (db) {
    var tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').put({ id: 'n' + Date.now() + Math.floor(Math.random() * 1000), title: document.getElementById('title').value });
    localStorage.setItem('oldapp:prefs', JSON.stringify({ theme: 'dark' }));
  });
};
</script></body></html>`;

// The new app: after unlocking it looks for old notes, asks (the prompt is answered by a step of wds-verify.json), copies them into the vault
// and deletes the old data unless the vault is the sandbox (what store.migrateLocal does for an app, written by hand).
const NEW_BODY = '<ul id="list"></ul><p id="result"></p><div id="ask" hidden>Copy the old notes? <button id="yes" type="button">Copy</button></div>'
  + '<label>New note <input id="n" type="text"></label><button id="add" type="button">Add</button>';
const MIGRATE = `
  function idb(req) { return new Promise(function (ok, fail) { req.onsuccess = function () { ok(req.result); }; req.onerror = function () { fail(req.error); }; }); }
  function openOld() { return new Promise(function (ok) { var req = indexedDB.open('oldapp'); req.onupgradeneeded = function () { req.transaction.abort(); }; req.onsuccess = function () { ok(req.result); }; req.onerror = function () { ok(null); }; }); }
  async function readOld() {
    var db = await openOld(), rows = [];
    if (db && db.objectStoreNames.contains('notes')) rows = await idb(db.transaction('notes').objectStore('notes').getAll());
    if (db) db.close();
    return rows;
  }
  async function clearOld(sandbox) {
    if (sandbox) return;
    var db = await openOld();
    if (db) { var tx = db.transaction('notes', 'readwrite'); tx.objectStore('notes').clear(); await new Promise(function (ok) { tx.oncomplete = ok; }); db.close(); }
    localStorage.removeItem('oldapp:prefs');
  }
  var notes = store.collection('notes/');
  async function render() {
    var all = await notes.getAll();
    $('list').textContent = all.map(function (x) { return x.value.title; }).join(' | ');
  }
  async function migrate() {
    var rows = await readOld(), todo = [];
    for (var i = 0; i < rows.length; i++) if (await store.get('notes/' + rows[i].id) === undefined) todo.push(rows[i]);
    if (!todo.length) return;
    await new Promise(function (ok) { $('ask').hidden = false; $('yes').onclick = function () { $('ask').hidden = true; ok(); }; });
    for (var j = 0; j < todo.length; j++) await notes.set(todo[j].id, { title: todo[j].title });
    var keep = store.status().sandbox;
    $('result').textContent = keep ? 'the old data was kept' : 'the old data was deleted';
    await clearOld(keep);
    await render();
  }
  $('add').addEventListener('click', function () { notes.add({ title: $('n').value }).then(render); });
  store.unlock().then(render).then(migrate);`;
const newApp = (extra = '') => miniApp({ body: NEW_BODY, script: MIGRATE.replace('  store.unlock()', extra + '\n  store.unlock()') });

const SEED = { page: 'old.html', steps: [{ fill: ['#title', 'old note {canary}'] }, { click: '#save' }] };
function writeMigApp(html, config, old = OLD_APP) {
  const dir = writeApp(html, config);
  if (old) writeFileSync(join(dir, 'old.html'), old);
  return dir;
}

test('config: the seed block is validated, {canary} is allowed in fill texts', () => {
  const ok = parseConfig(JSON.stringify({ seed: SEED, steps: [{ click: '#yes' }] }));
  assert.deepEqual(ok.seed, SEED);
  assert.equal(parseConfig('{}').seed, null);
  for (const bad of ['{"seed":"old.html"}', '{"seed":[]}', '{"seed":{"steps":[{"fill":["#a","b"]}]}}', '{"seed":{"page":"old.html"}}', '{"seed":{"page":"old.html","steps":[{"click":"#a"}]}}',
    '{"seed":{"page":"old.html","steps":[{"fill":["#a","long text"]}],"more":1}}', '{"seed":{"page":"old.html","steps":[{"hover":"#a"}]}}'])
    assert.throws(() => parseConfig(bad), /wds-verify\.json/, bad);
  assert.throws(() => parseConfig('{"seed":{"page":"old.html","steps":[{"click":"#a"}]}}'), /at least one fill or upload step/);
  assert.throws(() => parseConfig('{"seed":{"page":"old.html","steps":[{"nope":1}]}}'), /seed\.steps step 1 is not one of/);
});

test('seed: a missing old page is a usage error', async () => {
  const dir = writeApp(newApp(), { seed: { page: 'nope.html', steps: SEED.steps } });
  const r = await run('wds-verify.mjs', [dir, '--static-only']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /seed\.page.*nope\.html.*not a file/);
});

test('migration (mock): the old values are typed into the old app, the prompt is answered by a step, the values show up in the app, only encrypted, and the old data is gone', { timeout: 240000 }, async () => {
  const r = await verify(writeMigApp(newApp(), { seed: SEED, steps: [{ click: '#yes' }] }));
  assert.equal(r.code, 0, JSON.stringify(r.failures) + r.stderr);
  assert.equal(r.find('seed').level, 'pass');
  assert.match(r.find('seed').detail, /old\.html stored 1 of 1 typed value/);
  assert.equal(r.find('migration-visible').level, 'pass');
  assert.match(r.find('migration-visible').detail, /All 1 value/);
  assert.equal(r.find('migration-encrypted').level, 'pass');
  assert.equal(r.find('migration-old-data').level, 'pass');
  assert.match(r.find('migration-old-data').title, /deleted/);
  // the old data is in the old app's storage by design: no leak finding for it; the values of the app itself are still searched for
  for (const id of ['leak-localStorage', 'leak-IndexedDB', 'leak-request body', 'leak-server database (mock)', 'leak-download']) assert.equal(r.find(id).level, 'pass', id);
  assert.equal(r.find('reload').level, 'pass');
  assert.equal(r.find('saved').level, 'pass');
  // the app migrates by hand: the static check says what to use instead
  assert.equal(r.find('hand-storage').level, 'warn');
  assert.match(r.find('hand-storage').detail, /store\.migrateLocal \(porting\.md\)/);
});

test('migration: an app that never copies the old data fails (not visible), and the old data is still there', { timeout: 240000 }, async () => {
  const lazy = variant(newApp(), '  store.unlock().then(render).then(migrate);', '  store.unlock().then(render);');
  const r = await verify(writeMigApp(lazy, { seed: SEED }));
  assert.equal(r.code, 1);
  assert.ok(r.titles('fail').includes('Migration: old data visible'), r.titles('fail').join('|'));
  assert.match(r.find('migration-visible').detail, /None of the 1 value/);
  assert.equal(r.find('migration-old-data').level, 'warn');
  assert.equal(r.find('seed').level, 'pass');
});

test('migration: an app that copies the old values to a plaintext key is a leak; an old app that stores nothing fails the seed', { timeout: 240000 }, async () => {
  const leaky = variant(newApp(), "for (var j = 0; j < todo.length; j++) await notes.set(", "for (var j = 0; j < todo.length; j++) localStorage.setItem('copy-' + j, todo[j].title);\n    for (var j = 0; j < todo.length; j++) await notes.set(");
  const r = await verify(writeMigApp(leaky, { seed: SEED, steps: [{ click: '#yes' }] }));
  assert.equal(r.code, 1);
  assert.ok(r.titles('fail').includes('Canary found in localStorage'), r.titles('fail').join('|'));
  assert.match(r.find('leak-localStorage').detail, /seed fill #title appears \(raw\) in key copy-0/);
  // the old app does not store anything
  const none = await verify(writeMigApp(newApp(), { seed: SEED, steps: [{ click: '#yes' }] }, '<!doctype html><title>old</title><input id="title"><button id="save">Save</button>'));
  assert.equal(none.code, 1);
  assert.ok(none.titles('fail').includes('Seed: the old app'), none.titles('fail').join('|'));
  assert.match(none.find('seed').detail, /holds none of the 1 typed value/);
});

test('migration: a seed step that fails is reported with its number, and the app run goes on', { timeout: 240000 }, async () => {
  const r = await verify(writeMigApp(newApp(), { seed: { page: 'old.html', steps: [...SEED.steps, { click: '#does-not-exist' }] }, steps: [{ click: '#yes' }] }));
  assert.ok(r.titles('fail').includes('wds-verify.json seed step 3'), r.titles('fail').join('|'));
  assert.equal(r.find('migration-visible').level, 'pass');
});

test('without a seed, an app that mentions a migration is told that it was not tested', { timeout: 240000 }, async () => {
  const r = await verify(writeMigApp(newApp(), { steps: [] }));
  assert.match(r.parsed.notTested.join('\n'), /migration of old local data was not tested/);
});

test('migration: a prompt that names the old titles but never copies or deletes does not pass (the old data is still there); a download of the old data is a leak, also as JSON (only the library\'s backup is expected)', { timeout: 300000 }, async () => {
  const prompting = variant(variant(variant(newApp(), "for (var j = 0; j < todo.length; j++) await notes.set(todo[j].id, { title: todo[j].title });", ''), 'await clearOld(keep);', ''),
    "await new Promise(function (ok) { $('ask').hidden = false;", "await new Promise(function (ok) { $('ask').firstChild.textContent = 'Copy ' + todo.map(function (t) { return t.title; }).join(', ') + '? '; $('ask').hidden = false;");
  const r = await verify(writeMigApp(prompting, { seed: SEED, steps: [{ click: '#yes' }] }));
  assert.equal(r.code, 1, JSON.stringify(r.failures));
  assert.equal(r.find('migration-old-data').level, 'fail', r.find('migration-old-data').detail);
  assert.match(r.find('migration-old-data').detail, /IndexedDB store oldapp\/notes \(1 row\)/);
  // a background download of the old titles as text: the old data left the app unencrypted
  const download = (name, body, type) => variant(newApp(), '    var keep = store.status().sandbox', "    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([" + body + "], { type: '" + type + "' })); a.download = '" + name + "'; document.body.appendChild(a); a.click();\n    var keep = store.status().sandbox");
  const text = await verify(writeMigApp(download('copy.txt', "todo.map(function (t) { return t.title; }).join('\\n')", 'text/plain'), { seed: SEED, steps: [{ click: '#yes' }] }));
  assert.equal(text.code, 1, JSON.stringify(text.failures));
  assert.ok(text.titles('fail').includes('Canary found in download'), text.titles('fail').join('|'));
  const json = await verify(writeMigApp(download('oldapp-backup.json', 'JSON.stringify(todo)', 'application/json'), { seed: SEED, steps: [{ click: '#yes' }] }));
  assert.equal(json.code, 1, JSON.stringify(json.failures));
  assert.equal(json.find('leak-download').level, 'fail');
  assert.match(json.find('leak-download').detail, /An app never downloads data in the background/);
});

test('migration: everything the old app stored must be gone, not only the places that hold a typed value; seed.keep names what stays', { timeout: 300000 }, async () => {
  const forgets = variant(newApp(), "localStorage.removeItem('oldapp:prefs');", '');
  const r = await verify(writeMigApp(forgets, { seed: SEED, steps: [{ click: '#yes' }] }));
  assert.equal(r.code, 1, JSON.stringify(r.failures));
  assert.equal(r.find('migration-visible').level, 'pass');
  assert.equal(r.find('migration-old-data').level, 'fail');
  assert.match(r.find('migration-old-data').detail, /localStorage key "oldapp:prefs"/);
  const kept = await verify(writeMigApp(forgets, { seed: { ...SEED, keep: ['oldapp:prefs'] }, steps: [{ click: '#yes' }] }));
  assert.equal(kept.code, 0, JSON.stringify(kept.failures));
  assert.equal(kept.find('migration-old-data').level, 'pass');
  assert.throws(() => parseConfig('{"seed":{"page":"old.html","steps":[{"fill":["#a","long text"]}],"keep":"oldapp:prefs"}}'), /seed\.keep/);
  assert.deepEqual(parseConfig(JSON.stringify({ seed: { ...SEED, keep: ['a', 'b/c'] } })).seed.keep, ['a', 'b/c']);
});

// ---- the sandbox: the old data is kept ----
let mock;
before(async () => { mock = await startMock({ bundle: true, sandbox: true }); });
after(async () => { if (mock) await mock.stop(); });
const envFor = (m) => ({ WDS_VERIFY_SERVICE: m.origin + '/datastore', WDS_VERIFY_LIBRARY: m.bundle.file });
async function sbVerify(dir, args = []) {
  const r = await run('wds-verify.mjs', [dir, '--json', '--target', 'sandbox', ...args], { env: envFor(mock) });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (e) { /* no report */ }
  return { ...r, parsed, find: (id) => (parsed ? parsed.findings.find((f) => f.id === id) : undefined), titles: (level) => (parsed ? parsed.findings.filter((f) => f.level === level).map((f) => f.title) : []) };
}

test('migration (sandbox): the old data is kept, and an app that deletes it there fails; no "mock" in the findings', { timeout: 300000 }, async () => {
  const config = { seed: SEED, steps: [{ click: '#yes' }] };
  const kept = await sbVerify(writeMigApp(newApp(), config));
  assert.equal(kept.code, 0, JSON.stringify(kept.parsed && kept.parsed.findings.filter((f) => f.level === 'fail')) + kept.stderr);
  assert.equal(kept.find('migration-visible').level, 'pass');
  assert.equal(kept.find('migration-old-data').level, 'pass');
  assert.match(kept.find('migration-old-data').title, /kept in the sandbox/);
  assert.doesNotMatch(JSON.stringify(kept.parsed.findings.map((f) => f.title + ' ' + f.detail)).replace(/--target mock/g, ''), /\bmock\b/i, 'a sandbox run never says "mock"');
  assert.match(kept.find('saved').detail, /reached the service/);
  // an app that deletes in the sandbox (it ignores store.status().sandbox) fails
  const careless = variant(newApp(), 'var keep = store.status().sandbox;', 'var keep = false;');
  const bad = await sbVerify(writeMigApp(careless, config));
  assert.equal(bad.code, 1);
  assert.ok(bad.titles('fail').includes('Migration: old data kept in the sandbox'), bad.titles('fail').join('|'));
});

// ---- the reload check takes the union of the views ----
const TABS_BODY = '<button id="tab-a" type="button">Tab A</button><button id="tab-b" type="button">Tab B</button><div id="pa"><label>First <input id="a" type="text"></label></div><div id="pb" hidden><label>Second <input id="b" type="text"></label></div><button id="go" type="button" data-wds-verify="save">Keep</button>';
const TABS_SCRIPT = [
  "  function show(w) { $('pa').hidden = w !== 'a'; $('pb').hidden = w !== 'b'; }",
  "  $('tab-a').onclick = function () { show('a'); }; $('tab-b').onclick = function () { show('b'); };",
  "  $('go').onclick = function () { store.set('both', { a: $('a').value, b: $('b').value }); };",
  "  store.unlock().then(function () { return store.get('both'); }).then(function (v) { if (v) { $('a').value = v.a; $('b').value = v.b; } });",
].join('\n');

test('data after reload: a value in each of two tabs passes with one afterReload step per tab (the tool looks after every step); one tab alone warns', { timeout: 240000 }, async () => {
  const app = miniApp({ body: TABS_BODY, script: TABS_SCRIPT });
  const steps = [{ click: '#tab-b' }, { fill: ['#b', 'a value in the second tab {canary}'] }, { click: '#go' }];
  // the first field is filled by the tool (visible); the second by a step; after the reload only one tab shows at a time
  const both = await verify(writeApp(app, { steps, afterReload: [{ click: '#tab-a' }, { click: '#tab-b' }] }));
  assert.equal(both.code, 0, JSON.stringify(both.failures) + both.stderr);
  assert.equal(both.find('reload').level, 'pass', both.find('reload').detail);
  assert.match(both.find('reload').detail, /every afterReload step/);
  const one = await verify(writeApp(app, { steps, afterReload: [{ click: '#tab-a' }] }));
  assert.equal(one.find('reload').level, 'warn', one.find('reload').detail);
  assert.match(one.find('reload').detail, /afterReload steps that open the missing views/);
});

test('"Library version released" is information, in the sandbox as well as in the mock', { timeout: 240000 }, async () => {
  const r = await verify(writeApp(readApp('good')));
  assert.deepEqual(r.warnings.map((w) => w.id), []);
  const f = r.find('library-frozen');
  if (f) { assert.equal(f.level, 'info'); assert.match(f.detail, /about the library, not about your app/); }
});
