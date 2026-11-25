// wds-verify with a browser: wds-verify.json steps, the "nothing was saved" guard, the exportAll exemption, other field types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeApp, verify, miniApp } from './helpers.mjs';

const GO = miniApp({
  body: '<label>Name <input id="a" type="text"></label><button id="go" type="button">Go</button>',
  script: "  $('go').addEventListener('click', function () { store.set('a', { name: $('a').value }); });\n  store.unlock().then(function () { return store.get('a'); }).then(function (v) { if (v) $('a').value = v.name; });",
});

test('an app whose button the heuristics do not recognise: failure with advice, then a pass with steps', { timeout: 120000 }, async () => {
  const none = await verify(writeApp(GO));
  assert.equal(none.code, 1);
  assert.ok(none.titles('fail').includes('Data was saved'));
  assert.match(none.find('saved').detail, /wds-verify\.json/);
  const steps = [{ fill: ['#a', 'my own unique canary text 12345'] }, { click: '#go' }, { wait: 100 }];
  const ok = await verify(writeApp(GO, steps));
  assert.equal(ok.code, 0, JSON.stringify(ok.failures));
  assert.equal(ok.find('saved').level, 'pass');
});

test('the text of a fill step is a canary as well, and a failing step is reported', { timeout: 120000 }, async () => {
  const leaky = GO.replace("store.set('a', { name: $('a').value });", "store.set('a', { name: $('a').value }); localStorage.setItem('copy', $('a').value);");
  const r = await verify(writeApp(leaky, [{ fill: ['#a', 'my own unique canary text 12345'] }, { click: '#go' }, { click: '#does-not-exist' }]));
  assert.equal(r.code, 1);
  assert.match(r.find('leak-localStorage').detail, /(wds-verify\.json fill #a|input "a").*appears \(raw\) in key copy/);
  assert.ok(r.titles('fail').includes('wds-verify.json step 3'));
});

test('a broken wds-verify.json is a usage error', async () => {
  const r = await verify(writeApp(GO, [{ hover: '#a' }]));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /wds-verify\.json step 1/);
});

test('exportAll downloads plaintext by design and is not a leak; other fields (email, number, textarea, contenteditable, date) are filled', { timeout: 120000 }, async () => {
  const body = '<input id="m" type="email" aria-label="mail"><input id="n" type="number" aria-label="amount"><textarea id="t" aria-label="text"></textarea>'
    + '<div id="e" contenteditable="true" aria-label="rich" style="min-height:2em;border:1px solid #888"></div><input id="d" type="date" aria-label="day">'
    + '<button id="save" type="button">Save</button><button id="copy" type="button">Save a copy</button>';
  const script = "  $('save').addEventListener('click', function () { store.set('form', { m: $('m').value, n: $('n').value, t: $('t').value, e: $('e').textContent, d: $('d').value }); });\n"
    + "  $('copy').addEventListener('click', function () { store.exportAll(); });\n"
    + "  store.unlock().then(function () { return store.get('form'); }).then(function (f) { if (f) { $('m').value = f.m; $('n').value = f.n; $('t').value = f.t; $('e').textContent = f.e; $('d').value = f.d; } });";
  const r = await verify(writeApp(miniApp({ body, script })));
  assert.equal(r.code, 0, JSON.stringify(r.failures));
  assert.equal(r.find('leak-download').level, 'pass');
  assert.match(r.find('downloads').detail, /export\.zip \(exportAll, not checked\)/);
  assert.match(r.find('fields').detail, /4 field\(s\)/);
  assert.equal(r.find('leak-request body').level, 'pass');
});

test('a form that submits its fields in the URL leaks through the page URL', { timeout: 120000 }, async () => {
  const body = '<form id="f"><input name="q" type="text" aria-label="query"><button type="submit">Save</button></form>';
  // the documented policy has form-action 'none', which stops such a form; without it the leak is real, and the static check fails too
  const html = miniApp({ body, script: "  store.unlock();" }).replace("; form-action 'none'", '');
  const r = await verify(writeApp(html));
  assert.equal(r.code, 1);
  assert.ok(r.titles('fail').includes('Canary found in page URL'), r.titles('fail').join('|'));
  assert.ok(r.titles('fail').includes('Content Security Policy'));
});

const FILE_BODY = '<input id="f" type="file" aria-label="cover"><span id="shown"></span>';
const fileApp = (extra = '') => miniApp({
  body: FILE_BODY,
  script: "  $('f').addEventListener('change', function () {\n    var f = $('f').files[0]; if (!f) return;\n" + extra
    + "    store.set('covers/one.png', f, { mime: f.type });\n  });\n  store.unlock();",
});

test('upload step: a generated file goes through the file input, its name and bytes are canaries', { timeout: 120000 }, async () => {
  const ok = await verify(writeApp(fileApp(), [{ upload: ['#f'] }]));
  assert.equal(ok.code, 0, JSON.stringify(ok.failures));
  assert.equal(ok.find('saved').level, 'pass');
  assert.equal(ok.find('file-inputs'), undefined);
  assert.match(ok.find('steps').detail, /1 step\(s\) run \(0 fill, 0 click, 1 upload, 0 wait\)/);
  assert.equal(ok.find('leak-request body').level, 'pass');
  // without the step the tool says that it did not use the file input, and that nothing was stored
  const none = await verify(writeApp(fileApp()));
  assert.equal(none.find('file-inputs').level, 'info');
  assert.match(none.find('file-inputs').detail, /upload/);
  // a leak of the file name, and of the bytes in base64
  const names = await verify(writeApp(fileApp("    localStorage.setItem('name', f.name);\n"), [{ upload: ['#f'] }]));
  assert.equal(names.code, 1);
  assert.match(names.find('leak-localStorage').detail, /name of the generated upload file/);
  const bytes = await verify(writeApp(fileApp("    f.arrayBuffer().then(function (b) { localStorage.setItem('copy', btoa(String.fromCharCode.apply(null, new Uint8Array(b)))); });\n"), [{ upload: ['#f'] }]));
  assert.equal(bytes.code, 1);
  assert.match(bytes.find('leak-localStorage').detail, /bytes of the generated upload file/);
});

test('upload step with a file of the developer: found next to wds-verify.json, its name is searched for', { timeout: 120000 }, async () => {
  const dir = writeApp(fileApp("    localStorage.setItem('name', f.name);\n"), [{ upload: ['#f', 'my-secret-cover.png'] }]);
  writeFileSync(join(dir, 'my-secret-cover.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const r = await verify(dir);
  assert.equal(r.code, 1);
  assert.match(r.find('leak-localStorage').detail, /upload file name my-secret-cover\.png/);
  const missing = await verify(writeApp(fileApp(), [{ upload: ['#f', 'nope.png'] }]));
  assert.ok(missing.titles('fail').includes('wds-verify.json step 1'));
  assert.match(missing.find('step-1').detail, /no such file/);
  assert.equal((await verify(writeApp(fileApp(), [{ upload: [] }]))).code, 2);
});

test('the report says what the steps did', { timeout: 120000 }, async () => {
  const steps = [{ fill: ['#a', 'my own unique canary text 12345'] }, { click: '#go' }, { wait: 100 }];
  const r = await verify(writeApp(GO, steps));
  assert.equal(r.code, 0, JSON.stringify(r.failures));
  assert.match(r.find('steps').detail, /3 step\(s\) run \(1 fill, 1 click, 0 upload, 1 wait\)/);
  assert.match(r.find('fields').detail, /by wds-verify\.json steps/);
  assert.match(r.find('fields').detail, /\(\d+ found by the tool, 1 by wds-verify\.json steps\)/);
  // an app that only the steps reach counts the step fills as fields
  const hidden = miniApp({ body: '<div id="box" hidden><input id="a" type="text"></div><button id="open" type="button">Open</button><button id="go" type="button">Go</button>',
    script: "  $('open').addEventListener('click', function () { $('box').hidden = false; });\n  $('go').addEventListener('click', function () { store.set('a', { name: $('a').value }); });\n  store.unlock().then(function () { return store.get('a'); }).then(function (v) { if (v) $('a').value = v.name; });" });
  const h = await verify(writeApp(hidden, { steps: [{ click: '#open' }, { fill: ['#a', 'hidden field canary text 777'] }, { click: '#go' }], afterReload: [{ click: '#open' }] }));
  assert.equal(h.code, 0, JSON.stringify(h.failures));
  assert.match(h.find('fields').detail, /^\d+ field\(s\) filled with canaries \(0 found by the tool, 1 by wds-verify\.json steps\)/);
});

const ITEM_BODY = '<label>Title <input id="t" type="text"></label><label>Author <input id="au" type="text"></label><label>Notes <textarea id="no"></textarea></label><button id="add" type="button">Add</button><button id="save" type="button">Save</button>';

test('one record per item that later steps edit is not "one record for everything"', { timeout: 180000 }, async () => {
  // Add creates books/<id> once; the steps then edit that book and save it again: one record, but the recommended design
  const app = miniApp({ body: ITEM_BODY, script: [
    "  var id = null;",
    "  function item() { return { title: $('t').value, author: $('au').value, notes: $('no').value }; }",
    "  $('add').addEventListener('click', function () { if (!id) id = 'books/' + Math.random().toString(16).slice(2, 10); store.set(id, item()); });",
    "  $('save').addEventListener('click', function () { if (id) store.set(id, item()); });",
    "  store.unlock().then(function () { return store.list('books/'); }).then(function (rows) { return rows.length ? store.get(rows[0].name) : null; })",
    "    .then(function (it) { if (it) { $('t').value = it.title; $('au').value = it.author; $('no').value = it.notes; } });"].join('\n') });
  const steps = [{ fill: ['#t', 'edited title canary 0001'] }, { fill: ['#au', 'edited author canary 0002'] }, { fill: ['#no', 'edited notes canary 0003'] }, { click: '#save' }, { wait: 100 }];
  const r = await verify(writeApp(app, steps));
  assert.equal(r.code, 0, JSON.stringify(r.failures));
  assert.equal(r.find('one-record'), undefined, JSON.stringify(r.warnings));
  // two quick writes to one name (create, then the explicit Save) are not a "save on every key stroke"
  assert.equal(r.find('write-rate').level, 'pass', r.find('write-rate').detail);
});

test('whole app state in one record next to the item records is found', { timeout: 180000 }, async () => {
  const app = miniApp({ body: ITEM_BODY, script: [
    "  var items = [];",
    "  $('add').addEventListener('click', function () {",
    "    var it = { title: $('t').value, author: $('au').value, notes: $('no').value };",
    "    items.push(it);",
    "    store.set('books/' + items.length + Math.random().toString(16).slice(2, 8), it);",
    "    store.set('state', { items: items });",
    "    $('t').value = ''; $('au').value = ''; $('no').value = '';",
    "  });",
    "  store.unlock().then(function () { return store.get('state'); }).then(function (s) { if (s && s.items.length) { var it = s.items[0]; $('t').value = it.title; $('au').value = it.author; $('no').value = it.notes; } });"].join('\n') });
  const r = await verify(writeApp(app));
  assert.equal(r.code, 0, JSON.stringify(r.failures));
  assert.ok(r.titles('warn').includes('One record for everything'), JSON.stringify(r.warnings));
  assert.match(r.find('one-record').detail, /two different items.*"state"/);
});
