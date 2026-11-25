// wds-verify with a browser: every sink and every encoding is caught; chatty writes and one-record apps are flagged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readApp, writeApp, verify, variant, miniApp } from './helpers.mjs';

test('canaries leaking into every kind of place are found, whatever the encoding', { timeout: 120000 }, async () => {
  const good = readApp('good');
  const leak = `
    var t = $('owner').value;
    sessionStorage.setItem('s', t);
    localStorage.setItem('b', btoa(unescape(encodeURIComponent(t))));
    localStorage.setItem('h', Array.from(new TextEncoder().encode(t)).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''));
    console.log('saving', t);
    history.replaceState(null, '', '#' + encodeURIComponent(t));
    var u16 = new Uint8Array(t.length * 2); for (var i = 0; i < t.length; i++) { u16[2 * i] = t.charCodeAt(i) & 255; u16[2 * i + 1] = t.charCodeAt(i) >> 8; }
    var open = indexedDB.open('leak', 1);
    open.onupgradeneeded = function () { open.result.createObjectStore('s'); };
    open.onsuccess = function () { open.result.transaction('s', 'readwrite').objectStore('s').put(u16, 'k'); };
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t])); a.download = 'copy.txt'; document.body.appendChild(a); a.click();
`;
  const html = variant(good, "    store.set('profile', { owner: $('owner').value });", "    store.set('profile', { owner: $('owner').value });" + leak);
  const r = await verify(writeApp(html));
  assert.equal(r.code, 1, r.stderr);
  const titles = r.titles('fail');
  for (const sink of ['sessionStorage', 'localStorage', 'console output', 'page URL', 'IndexedDB', 'download']) assert.ok(titles.includes('Canary found in ' + sink), sink + ' in ' + titles.join('|'));
  assert.match(r.find('leak-localStorage').detail, /\(base64\)|\(hex\)/);
  assert.match(r.find('leak-page URL').detail, /url-encoded/);
  assert.match(r.find('leak-IndexedDB').detail, /UTF-16LE/);
  assert.match(r.find('leak-download').detail, /copy\.txt/);
  // the library's own traffic and storage stay clean
  for (const clean of ['request body', 'request header', 'request URL', 'server database (mock)']) assert.ok(!titles.includes('Canary found in ' + clean), clean);
});

test('a save on every key stroke is flagged (and fails with --strict)', { timeout: 120000 }, async () => {
  const good = readApp('good');
  const html = variant(good, "  $('note').addEventListener('input', function () { noteSave.changed(); });",
    "  $('note').addEventListener('input', function () { noteSave.changed(); });\n  $('owner').addEventListener('input', function () { store.set('profile', { owner: $('owner').value }); });");
  const dir = writeApp(html);
  const r = await verify(dir);
  assert.equal(r.code, 0, JSON.stringify(r.failures));
  assert.ok(r.titles('warn').includes('Write frequency'));
  assert.match(r.find('write-rate').detail, /"profile" written \d+ times within a second/);
  assert.match(r.find('write-rate').detail, /autosave/);
  const strict = await verify(dir, ['--strict']);
  assert.equal(strict.code, 1);
});

test('one record that holds everything is flagged, three records are not', { timeout: 120000 }, async () => {
  const body = '<label>A <input id="a" type="text"></label><label>B <textarea id="b"></textarea></label><label>C <input id="c" type="text"></label><button id="save" type="button">Save</button>';
  const mono = miniApp({ body, script: "  $('save').addEventListener('click', function () { store.set('everything', { a: $('a').value, b: $('b').value, c: $('c').value }); });\n  store.unlock().then(function () { return store.get('everything'); }).then(function (v) { if (v) { $('a').value = v.a; $('b').value = v.b; $('c').value = v.c; } });" });
  const r = await verify(writeApp(mono));
  assert.equal(r.code, 0, JSON.stringify(r.failures));
  assert.ok(r.titles('warn').includes('One record for everything'), r.titles('warn').join('|'));
  assert.match(r.find('one-record').detail, /3 of 3 fields.*"everything"/);
  const split = miniApp({ body, script: "  $('save').addEventListener('click', function () { store.set('a', $('a').value); store.set('b', $('b').value); store.set('c', $('c').value); });\n  store.unlock().then(function () { return Promise.all([store.get('a'), store.get('b'), store.get('c')]); }).then(function (v) { $('a').value = v[0] || ''; $('b').value = v[1] || ''; $('c').value = v[2] || ''; });" });
  const r2 = await verify(writeApp(split));
  assert.equal(r2.code, 0, JSON.stringify(r2.failures));
  assert.equal(r2.find('one-record'), undefined);
  assert.equal(r2.find('write-rate').level, 'pass');
});
