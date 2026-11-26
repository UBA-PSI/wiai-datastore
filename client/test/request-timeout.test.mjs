// A request that does not answer must end: after the timeout the call fails with an OfflineError (code "timeout"), so that a dialog that waits for the
// answer can show its error view instead of loading for ever. The timer must not keep a Node process alive and must be cleared when the answer comes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { core, setupVault, newClient } from './helpers.mjs';

const client = (fetch, extra = {}) => new core.Client(Object.assign({ scope: 'timeout-test-abc123', service: 'http://127.0.0.1:9/datastore/', fetch, storage: core.memoryStorage(), timeout: 60 }, extra));
const never = () => new Promise(() => {});

test('a request that never answers fails with an OfflineError (timeout) after the timeout', async () => {
  const t0 = Date.now();
  await assert.rejects(client(never).getScopeInfo(), (e) => e instanceof core.OfflineError && e.code === 'timeout' && /no answer within/.test(e.message));
  assert.ok(Date.now() - t0 >= 50 && Date.now() - t0 < 2000);
});

test('an answer whose body never arrives fails the same way', async () => {
  const stuck = async () => ({ ok: true, status: 200, headers: new Map(), json: never, arrayBuffer: never });
  await assert.rejects(client(stuck).getScopeInfo(), (e) => e instanceof core.OfflineError && e.code === 'timeout');
  const stuckError = async () => ({ ok: false, status: 500, headers: new Map(), json: never });
  await assert.rejects(client(stuckError).getScopeInfo(), (e) => e instanceof core.RequestError && e.status === 500);   // an error body that never arrives does not hide the status
});

test('a fast answer clears the timer, and timeout 0 means no limit', async () => {
  let aborted = 0;
  const ok = async (url, init) => { if (init && init.signal) init.signal.addEventListener('abort', () => aborted++); return { ok: true, status: 200, headers: new Map(), json: async () => ({ scope: 'timeout-test-abc123', kdf: core.internals.DEFAULT_KDF }) }; };
  const info = await client(ok).getScopeInfo();
  assert.equal(info.scope, 'timeout-test-abc123');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(aborted, 0);
  const slow = async () => { await new Promise((r) => setTimeout(r, 150)); return { ok: true, status: 200, headers: new Map(), json: async () => ({ scope: 'timeout-test-abc123', kdf: core.internals.DEFAULT_KDF }) }; };
  assert.equal((await client(slow, { timeout: 0 }).getScopeInfo()).scope, 'timeout-test-abc123');
});

test('an upload gets one more second per 10 KB, and creating or redeeming gets three times the time', async () => {
  const slow = async () => { await new Promise((r) => setTimeout(r, 300)); return { ok: true, status: 200, headers: new Map() }; };
  const c = client(slow, { timeout: 100 });
  await assert.rejects(c._req('GET', '/x'), (e) => e instanceof core.OfflineError && e.code === 'timeout');
  await assert.rejects(c._req('PUT', '/x', { body: new Uint8Array(9000) }), (e) => e.code === 'timeout');   // 9 KB: still within the first 10 KB
  assert.equal((await c._req('PUT', '/x', { body: new Uint8Array(30000) })).ok, true);                     // 30 KB: 100 ms + 3 s
  assert.equal((await c._req('GET', '/x', { timeout: c._patientMs() })).ok, true);                         // three times 100 ms
  assert.equal(client(slow, { timeout: 0 })._patientMs(), 0);
});

test('Client.defaultTimeout is the default of the option', async () => {
  const keep = core.Client.defaultTimeout;
  try {
    core.Client.defaultTimeout = 40;
    await assert.rejects(new core.Client({ scope: 'timeout-test-abc123', service: 'http://127.0.0.1:9/datastore/', fetch: never, storage: core.memoryStorage() }).getScopeInfo(), (e) => e.code === 'timeout');
  } finally { core.Client.defaultTimeout = keep; }
});

test('a write whose answer is lost after the server stored it counts as saved; when the record cannot be looked at, the failure is reported', async () => {
  const { founder } = await setupVault();
  const real = founder.fetch;
  founder.timeoutMs = 80;
  let mode = 'drop-answer';
  founder.fetch = async (url, init) => {
    if (mode === 'drop-answer' && init && init.method === 'PUT') { await real(url, init); return never(); }   // stored, answer lost
    if (mode === 'down') { if (init && init.method === 'PUT') await real(url, init); throw new TypeError('fetch failed'); }   // stored, then the network is gone
    return real(url, init);
  };
  const r = await founder.put('note', { n: 1 });
  assert.equal(r.version, 1);
  assert.deepEqual(await founder.get('note'), { n: 1 });
  assert.equal((await founder.put('note', { n: 2 })).version, 2);   // the client's version counter moved on: no 412 against its own write
  mode = 'down';
  await assert.rejects(founder.put('note', { n: 3 }), (e) => e instanceof core.OfflineError);   // no way to tell: the caller keeps the value pending
});

test('status() while an unlock is running says "locked" (an app may poll isUnlocked() at any time)', async () => {
  const ctx = await setupVault();
  const slow = async (url, init) => { await new Promise((r) => setTimeout(r, 15)); return ctx.world.server.fetch(url, init); };
  const c = newClient(ctx.world, { fetch: slow });
  const p = c.unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase, maintain: false });
  let polls = 0, sawLocked = 0;
  for (let done = false; !done;) {
    const s = c.status();   // must not throw, whatever the unlock has done so far
    polls++; if (!s.unlocked) sawLocked++;
    done = await Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 2))]);
  }
  assert.ok(polls > 3 && sawLocked > 0, polls + ' polls, ' + sawLocked + ' locked');
  assert.equal(c.status().unlocked, true);
});
