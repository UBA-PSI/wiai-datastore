// Pure parts: collection op replay, remembered access ID, fresh reads in the core, checkRemote with watched names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { core, setupVault, newClient } from './helpers.mjs';

const require = createRequire(import.meta.url);
const WDS = require('../src/wds-ui.js');
const apply = WDS.internals.applyCollectionOps;

test('collection apply(): upsert keeps the place of an existing entry, remove deletes, operations run in order, the input is not changed', () => {
  const base = { a: { m: { t: 'a' } }, b: { m: {} } };
  const copy = JSON.stringify(base);
  const cases = [
    ['no ops', [], base],
    ['upsert new goes to the end', [{ t: 'upsert', id: 'n', m: { t: 'n' } }], { ...base, n: { m: { t: 'n' } } }],
    ['upsert existing replaces meta', [{ t: 'upsert', id: 'a', m: { t: 'a2' } }], { a: { m: { t: 'a2' } }, b: base.b }],
    ['remove', [{ t: 'remove', id: 'a' }], { b: base.b }],
    ['remove unknown id', [{ t: 'remove', id: 'zz' }], base],
    ['remove then upsert: comes back at the end', [{ t: 'remove', id: 'a' }, { t: 'upsert', id: 'a', m: { t: 'x' } }], { b: base.b, a: { m: { t: 'x' } } }],
    ['upsert then remove', [{ t: 'upsert', id: 'q', m: {} }, { t: 'remove', id: 'q' }], base],
    ['upsert without meta', [{ t: 'upsert', id: 'e' }], { ...base, e: { m: {} } }],
  ];
  for (const [name, ops, want] of cases) assert.deepEqual(apply(base, ops), want, name);
  assert.deepEqual(Object.keys(apply(base, [{ t: 'upsert', id: 'n', m: {} }, { t: 'upsert', id: 'a', m: { t: 'a2' } }])), ['a', 'b', 'n'], 'the order of the keys is the order of the list');
  assert.equal(JSON.stringify(base), copy);
});

test('remembered access ID is stored as {id, t}; other contents are ignored', async () => {
  const { world, founder, created } = await setupVault();
  const key = 'wds:' + world.scope + ':access_id';
  const raw = JSON.parse(world.storage.getItem(key));
  assert.equal(raw.id, created.accessId);
  assert.equal(typeof raw.t, 'number');
  assert.deepEqual(founder.rememberedAccess(), { id: created.accessId, t: raw.t });
  assert.equal(founder.rememberedAccessId(), created.accessId);
  for (const bad of [created.accessId, '{"id":"x","t":1}', '{"id":"' + created.accessId + '"}', 'null', '[1]', '{']) {
    world.storage.setItem(key, bad);
    assert.equal(founder.rememberedAccess(), null, bad);
    assert.equal(founder.rememberedAccessId(), null, bad);
  }
  founder.forgetAccessId();
  assert.equal(world.storage.getItem(key), null);
});

test('get/getRecord with fresh skip the copy that list() keeps', async () => {
  const { world, founder, created, passphrase } = await setupVault();
  await founder.put('x/1', { v: 1 });
  const other = newClient(world);
  await other.unlock({ accessId: created.accessId, passphrase });
  await other.list('x/');   // downloads x/1 and keeps it for a moment
  const gets = () => world.server.requests.filter((r) => r.method === 'GET' && /\/records\/[A-Za-z0-9_-]{43}$/.test(r.path)).length;
  let n = gets();
  assert.deepEqual(await other.get('x/1'), { v: 1 });
  assert.equal(gets() - n, 0, 'served from the list copy');
  await other.list('x/');
  n = gets();
  assert.deepEqual(await other.get('x/1', { fresh: true }), { v: 1 });
  assert.equal(gets() - n, 1, 'fresh reads from the server');
  assert.deepEqual((await other.getRecord('x/1', { fresh: true })).value, { v: 1 });
});

test('checkRemote({names}) reports a record that this session never saw, once it exists', async () => {
  const { world, founder, created, passphrase } = await setupVault();
  const other = newClient(world);
  await other.unlock({ accessId: created.accessId, passphrase });
  assert.equal(await other.get('notes.index'), undefined);
  assert.deepEqual(await other.checkRemote(), []);
  assert.deepEqual(await other.checkRemote({ names: ['notes.index'] }), []);
  await founder.put('notes.index', { n: 1 });
  assert.deepEqual(await other.checkRemote(), []);
  const rows = await other.checkRemote({ names: ['notes.index'] });
  assert.deepEqual(rows, [{ name: 'notes.index', version: 1, known: 0, deleted: false }]);
});

test('collection apply(): an upsert with an older record version never replaces a newer entry; versions are kept', () => {
  const base = { a: { v: 3, m: { t: 'A2' } } };
  assert.deepEqual(apply(base, [{ t: 'upsert', id: 'a', v: 2, m: { t: 'B1' } }]), base, 'older version ignored');
  assert.deepEqual(apply(base, [{ t: 'upsert', id: 'a', v: 4, m: { t: 'B2' } }]), { a: { v: 4, m: { t: 'B2' } } });
  assert.deepEqual(apply(base, [{ t: 'upsert', id: 'a', v: 3, m: { t: 'same version' } }]), { a: { v: 3, m: { t: 'same version' } } });
  assert.deepEqual(apply(base, [{ t: 'upsert', id: 'a', m: { t: 'unknown version' } }]), { a: { v: 3, m: { t: 'unknown version' } } }, 'no version: applies, keeps the known one');
  assert.deepEqual(apply({}, [{ t: 'upsert', id: 'n', v: 1, m: {} }, { t: 'remove', id: 'n' }, { t: 'upsert', id: 'n', v: 1, m: { t: 'again' } }]), { n: { v: 1, m: { t: 'again' } } });
});

test('rememberAccessId keeps the first time for the same ID; another ID starts over', async () => {
  const { world, founder, created } = await setupVault();
  const key = 'wds:' + world.scope + ':access_id';
  const t0 = JSON.parse(world.storage.getItem(key)).t;
  world.storage.setItem(key, JSON.stringify({ id: created.accessId, t: 1000 }));
  founder.rememberAccessId(created.accessId);
  assert.equal(JSON.parse(world.storage.getItem(key)).t, 1000, 'same ID: first time kept');
  founder.rememberAccessId('A'.repeat(20));
  assert.ok(JSON.parse(world.storage.getItem(key)).t >= t0, 'other ID: new time');
});

test('put() with an explicit undefined base is a UsageError (it would fall back to what the client knows)', async () => {
  const { founder } = await setupVault();
  await assert.rejects(() => founder.put('x', { v: 1 }, { base: undefined }), (e) => e.name === 'UsageError');
  assert.equal((await founder.put('x', { v: 1 }, { base: null })).version, 1);
  assert.equal((await founder.put('x', { v: 2 }, { base: 1 })).version, 2);
  assert.equal((await founder.put('x', { v: 3 })).version, 3);
});
