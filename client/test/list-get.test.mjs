// list() downloads every record once; the get() that follows it must not download the same record a second time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupVault, newClient } from './helpers.mjs';

const recordGets = (world) => world.server.requests.filter((r) => r.method === 'GET' && /\/records\/[^/?]+$/.test(r.path)).length;

async function secondDevice(ctx) {
  const c = newClient(ctx.world);
  await c.unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase });
  return c;
}

test('get() after list() is served from the list download, once', async () => {
  const ctx = await setupVault();
  await ctx.founder.put('books/a', { title: 'A' });
  await ctx.founder.put('books/b', { title: 'B' });
  await ctx.founder.put('covers/a.jpg', new Uint8Array(5000).fill(7), { mime: 'image/jpeg' });
  const c = await secondDevice(ctx);
  ctx.world.server.requests.length = 0;
  const rows = await c.list('books/');
  assert.deepEqual(rows.map((r) => r.name), ['books/a', 'books/b']);
  assert.equal(recordGets(ctx.world), 3, 'the prefix does not limit the download: all three records came');
  assert.deepEqual(await c.get('books/a'), { title: 'A' });
  const cover = await c.getRecord('covers/a.jpg');
  assert.equal(cover.mime, 'image/jpeg');
  assert.equal(cover.value.length, 5000);
  assert.equal(recordGets(ctx.world), 3, 'both reads came from the list download');
  // used once: the next read asks the server
  assert.deepEqual(await c.get('books/a'), { title: 'A' });
  assert.equal(recordGets(ctx.world), 4);
  // a second list() only downloads what changed
  await ctx.founder.put('books/b', { title: 'B2' });
  ctx.world.server.requests.length = 0;
  await c.list();
  assert.equal(recordGets(ctx.world), 1);
  assert.deepEqual(await c.get('books/b'), { title: 'B2' });
  assert.equal(recordGets(ctx.world), 1);
});

test('a write or delete by this client drops the listed copy; an old copy is not served', async () => {
  const ctx = await setupVault();
  await ctx.founder.put('x', { v: 1 });
  await ctx.founder.put('y', { v: 1 });
  const c = await secondDevice(ctx);
  await c.list();
  await c.put('x', { v: 2 });
  assert.deepEqual(await c.get('x'), { v: 2 });
  await c.delete('y');
  assert.equal(await c.get('y'), undefined);
  // too old: fetched again
  await ctx.founder.put('z', { v: 1 });
  await c.list();
  let t = Date.now();
  c.now = () => t + 31000;
  ctx.world.server.requests.length = 0;
  await ctx.founder.put('z', { v: 2 });
  assert.deepEqual(await c.get('z'), { v: 2 });
  assert.equal(recordGets(ctx.world), 1);
});

test('large values are not kept in memory', async () => {
  const ctx = await setupVault();
  await ctx.founder.put('big', new Uint8Array(1100000).fill(1));
  await ctx.founder.put('small', { a: 1 });
  const c = await secondDevice(ctx);
  await c.list();
  assert.equal(c.s.listed.size, 1);
  ctx.world.server.requests.length = 0;
  await c.getRecord('big');
  assert.equal(recordGets(ctx.world), 1);
});
