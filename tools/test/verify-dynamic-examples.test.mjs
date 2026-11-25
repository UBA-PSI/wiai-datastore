// wds-verify with a browser: the good example passes, the bad one fails for the right reasons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readApp, writeApp, verify, variant } from './helpers.mjs';

test('the good example app passes, and the run proves that data was saved', { timeout: 120000 }, async () => {
  const r = await verify(writeApp(readApp('good')));
  assert.equal(r.code, 0, JSON.stringify(r.failures) + r.stderr);
  assert.equal(r.parsed.failed, false);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.warnings.map((w) => w.id), []);   // "library version released" is info: it is about the library, not the app
  for (const id of ['library-loaded', 'vault', 'saved', 'write-rate', 'leak-request body', 'leak-localStorage', 'leak-IndexedDB', 'leak-console output', 'leak-server database (mock)']) assert.equal(r.find(id).level, 'pass', id);
  assert.match(r.find('saved').detail, /record write/);
  assert.match(r.find('fields').detail, /"Save"/);
});

test('the bad example app fails: plaintext in localStorage, a plaintext request to another host, direct access to the datastore', { timeout: 120000 }, async () => {
  const r = await verify(writeApp(readApp('bad')));
  assert.equal(r.code, 1, r.stderr);
  const titles = r.titles('fail');
  assert.ok(titles.includes('Canary found in localStorage'), titles.join('|'));
  assert.ok(titles.includes('Canary found in request body'), titles.join('|'));
  assert.ok(titles.includes('No direct access to the datastore'), titles.join('|'));
  assert.match(r.find('leak-localStorage').detail, /textarea "note" appears \(raw\) in key draft/);
  assert.match(r.find('leak-request body').detail, /stats\.example\.org\/collect/);
  assert.match(r.find('app-direct').detail, /Code of the app \(not the library\)/);
  assert.equal(r.find('app-network').level, 'warn');
  // what the library itself does is not blamed: no request header or URL leak, no leak into the mock's database
  assert.equal(r.find('leak-server database (mock)').level, 'pass');
  assert.equal(r.find('leak-request URL').level, 'pass');
});

test('a page without the library tag fails statically and the dynamic part says why it did not run', { timeout: 60000 }, async () => {
  const good = readApp('good');
  const r = await verify(writeApp(good.replace(/<script src=[\s\S]*?<\/script>/, '')));
  assert.equal(r.code, 1);
  assert.ok(r.titles('fail').includes('Library script tag'));
  assert.ok(r.titles('fail').includes('Dynamic checks'));
});

test('a page whose CSP blocks the library: the library does not load, and the report shows the console', { timeout: 60000 }, async () => {
  const good = readApp('good');
  const r = await verify(writeApp(variant(good, 'https://wiai.uni-bamberg.de/datastore/client/;', "'self';")));
  assert.equal(r.code, 1);
  assert.ok(r.titles('fail').includes('Content Security Policy') || r.titles('fail').includes('Library loads'));
  assert.ok(r.titles('fail').includes('Library loads'));
  assert.match(r.find('library-loaded').detail, /Content Security Policy|Refused/i);
});
