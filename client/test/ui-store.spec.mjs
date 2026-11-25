// Browser tests of the store API (wds-ui.js): conflict handlers, remove(), getMany, autosave, lock snapshots, collections.
import { test, expect } from '@playwright/test';
import { startTestWorld, openApp, dialog, createVaultViaUi, unlockViaUi, nodeClient, redeemViaUi, core, I } from './ui-helpers.mjs';

let w;
test.beforeEach(async () => { w = await startTestWorld(); });
test.afterEach(async () => { await w.close(); });

const idOf = (v) => v.accessId.replace(/-/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const puts = () => w.world.server.requests.filter((r) => r.method === 'PUT' && /\/records\//.test(r.path)).length;

async function setup(browser, cfg) {
  const page = await openApp(await browser.newContext(), w, cfg ? { cfg } : undefined);
  const vault = await createVaultViaUi(page);
  const other = nodeClient(w);
  await other.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  return { page, vault, other };
}
async function device(browser, vault, cfg) {
  const p = await openApp(await browser.newContext(), w, cfg ? { cfg } : undefined);
  await unlockViaUi(p, vault.accessId, vault.passphrase);
  return p;
}
// somebody else saves a newer version of name, so that the next write of the page conflicts
async function bump(other, name, value) { await other.get(name); await other.put(name, value); }

test('conflict handlers: exact name, then prefix, then global; handlers that decide nothing, throw or reject hand over to the dialog; c.ask()', async ({ browser }) => {
  const { page, other } = await setup(browser);
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.evaluate(async () => { for (const n of ['notes/a', 'notes/b', 'cfg', 'free']) await store.set(n, { v: 1 }); });
  await page.evaluate(() => {
    window.calls = [];
    store.onConflict((c) => { calls.push('global:' + c.name + ':' + c.op); c.keepTheirs(); });
    window.offPrefix = store.onConflict('notes/', (c) => { calls.push('prefix:' + c.name); c.keepMine(); });
    window.offExact = store.onConflict('notes/a', (c) => { calls.push('exact:' + c.name); c.merge((m, t) => ({ merged: [m.v, t.v] })); });
  });
  await bump(other, 'notes/a', { v: 2 });
  const r1 = await page.evaluate(() => store.set('notes/a', { v: 3 }));
  expect(r1.resolution).toBe('merged');
  expect(r1.value).toEqual({ merged: [3, 2] });   // set() reports what was stored
  expect((await other.getRecord('notes/a')).value).toEqual({ merged: [3, 2] });
  await bump(other, 'notes/b', { v: 2 });
  expect((await page.evaluate(() => store.set('notes/b', { v: 3 }))).resolution).toBe('mine');
  await bump(other, 'cfg', { v: 2 });
  const r3 = await page.evaluate(() => store.set('cfg', { v: 3 }));
  expect([r3.resolution, r3.value]).toEqual(['theirs', { v: 2 }]);
  expect(await page.evaluate(() => calls)).toEqual(['exact:notes/a', 'prefix:notes/b', 'global:cfg:set']);
  // unsubscribing the exact handler moves the name to the prefix handler
  await page.evaluate(() => window.offExact());
  await bump(other, 'notes/a', { v: 4 });
  expect((await page.evaluate(() => store.set('notes/a', { v: 5 }))).resolution).toBe('mine');
  // overlapping prefixes are refused; the same prefix again replaces; unrelated ones are fine
  const errs = await page.evaluate(() => {
    const out = [];
    for (const p of ['notes/x/', 'not', 'notes/']) { try { store.onConflict(p === 'not' ? 'notes' : p, () => {}); out.push('ok:' + p); } catch (e) { out.push(e.name + ':' + p); } }
    try { store.onConflict('other/', () => {}); out.push('ok:other/'); } catch (e) { out.push(e.name); }
    try { store.onConflict('.wds/x', () => {}); } catch (e) { out.push(e.name); }
    return out;
  });
  expect(errs).toEqual(['UsageError:notes/x/', 'ok:not', 'ok:notes/', 'ok:other/', 'UsageError']);

  // undecided, throwing and rejecting handlers open the built-in dialog
  await page.evaluate(() => { store.onConflict(null); store.onConflict('notes/', null); });
  await page.evaluate(() => {
    window.handlers = { undecided: () => {}, throwing: () => { throw new Error('boom'); }, rejecting: async () => { throw new Error('nope'); } };
  });
  for (const kind of ['undecided', 'throwing', 'rejecting']) {
    await page.evaluate((k) => { store.onConflict('free', window.handlers[k]); }, kind);
    await bump(other, 'free', { v: kind });
    await page.evaluate(() => { window.setP = store.set('free', { v: 'mine' }); });
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Another device or person saved a newer version' })).toBeVisible();
    await d.getByRole('button', { name: 'Keep mine' }).click();
    expect((await page.evaluate(() => window.setP)).resolution).toBe('mine');
  }
  expect(consoleErrors.some((m) => m.includes('boom'))).toBe(true);
  expect(consoleErrors.some((m) => m.includes('nope'))).toBe(true);
  // c.ask() shows the dialog from inside the handler
  await page.evaluate(() => { store.onConflict('free', async (c) => { window.asked = await c.ask(); }); });
  await bump(other, 'free', { v: 'ask' });
  await page.evaluate(() => { window.setP = store.set('free', { v: 'mine again' }); });
  await dialog(page).getByRole('button', { name: 'Keep theirs' }).click();
  const r = await page.evaluate(() => window.setP);
  expect([r.resolution, r.value]).toEqual(['theirs', { v: 'ask' }]);
  expect(await page.evaluate(() => window.asked)).toBe('theirs');
  // a conflict while removing: op and mine.deleted
  await page.evaluate(() => { store.onConflict('free', (c) => { window.seen = [c.op, c.mine.deleted, c.theirs.value]; c.keepMine(); }); });
  await bump(other, 'free', { v: 'changed' });
  const rm = await page.evaluate(() => store.remove('free'));
  expect(rm).toEqual({ name: 'free', deleted: true, resolution: 'mine' });
  expect(await page.evaluate(() => window.seen)).toEqual(['remove', true, { v: 'changed' }]);
  expect(await page.evaluate(() => store.get('free'))).toBeUndefined();
  expect(page.errors).toEqual([]);
});

test('remove(): four results; autosave handles pause during the request and stop, resume or report the kept version', async ({ browser }) => {
  const { page, other } = await setup(browser);
  const r = await page.evaluate(async () => {
    await store.set('r1', { v: 1 });
    return { deleted: await store.remove('r1'), absent: await store.remove('r1'), never: await store.remove('never-there') };
  });
  expect(r.deleted).toEqual({ name: 'r1', deleted: true, resolution: 'deleted' });
  expect(r.absent).toEqual({ name: 'r1', deleted: false, resolution: 'absent' });
  expect(r.never.resolution).toBe('absent');

  await page.evaluate(async () => {
    await store.set('doc', { t: 0 });
    window.states = []; window.replaced = []; window.errs = []; window.state = { t: 1 };
    window.h = store.autosave('doc', () => window.state, { delayMs: 300, onStatus: (s) => states.push(s), onReplaced: (v) => replaced.push(v), onError: (e) => errs.push(e.message) });
    h.changed(); await h.flush();
  });
  expect(await page.evaluate(() => h.status)).toBe('saved');
  // "theirs": the other side's newer version is kept; the handle is paused while the dialog is open
  await bump(other, 'doc', { t: 'theirs' });
  await page.evaluate(() => { window.rmP = store.remove('doc'); });
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'This entry was changed in the meantime' })).toBeVisible();
  const before = puts();
  await page.evaluate(() => { window.state = { t: 2 }; h.changed(); });
  await sleep(900);
  expect(puts()).toBe(before);   // nothing was saved while the remove request was open
  await d.getByRole('button', { name: 'Keep the entry' }).click();
  const res = await page.evaluate(() => window.rmP);
  expect(res).toEqual({ name: 'doc', deleted: false, resolution: 'theirs', value: { t: 'theirs' } });
  expect(await page.evaluate(() => replaced)).toEqual([{ t: 'theirs' }]);
  expect(await page.evaluate(() => states.includes('replaced'))).toBe(true);
  expect(await page.evaluate(() => h.stopReason)).toBeNull();
  // resumed: the edit made meanwhile is saved now
  await expect.poll(() => page.evaluate(() => h.status)).toBe('saved');
  expect(await page.evaluate(() => store.get('doc'))).toEqual({ t: 2 });
  // "deleted": the handle stops, and every changed() after that reports it
  const rm = await page.evaluate(() => store.remove('doc'));
  expect(rm.resolution).toBe('deleted');
  const after = await page.evaluate(() => { h.changed(); h.changed(); return { reason: h.stopReason, status: h.status, errs: errs.slice(), err: h.error && h.error.message }; });
  expect(after.reason).toBe('removed');
  expect(after.status).toBe('stopped');
  expect(after.errs).toHaveLength(2);
  expect(after.errs[0]).toContain('autosave handle stopped (removed)');
  expect(after.err).toContain('stopped (removed)');
  // a failed request: the handle is resumed unchanged and still saves
  await page.evaluate(async () => {
    await store.set('doc2', { t: 0 });
    window.state2 = { t: 5 };
    window.h2 = store.autosave('doc2', () => window.state2, { delayMs: 400 });
    h2.changed();
  });
  await page.route('**/datastore/api/**', (route) => route.abort('internetdisconnected'));
  const failed = await page.evaluate(() => store.remove('doc2').then(() => 'removed', (e) => e.name));
  expect(failed).toBe('OfflineError');
  await page.unroute('**/datastore/api/**');
  expect(await page.evaluate(() => h2.stopReason)).toBeNull();
  await expect.poll(() => page.evaluate(() => h2.status), { timeout: 20000 }).toBe('saved');
  expect(await page.evaluate(() => store.get('doc2'))).toEqual({ t: 5 });
});

test('getMany: order, missing records, concurrency cap, fresh reads', async ({ browser }) => {
  const { page, other } = await setup(browser);
  await page.evaluate(async () => { for (let i = 0; i < 12; i++) await store.set('m/' + i, { i }); });
  const r = await page.evaluate(async () => ({
    vals: await store.getMany(['m/3', 'm/none', 'm/0']),
    empty: await store.getMany([]),
    bad: await Promise.all([0, 17, 1.5].map((c) => store.getMany(['m/1'], { concurrency: c }).then(() => 'ok', (e) => e.name))),
    badName: await store.getMany(['.wds/x']).then(() => 'ok', (e) => e.name),
  }));
  expect(r.vals).toEqual([{ i: 3 }, undefined, { i: 0 }]);
  expect(r.empty).toEqual([]);
  expect(r.bad).toEqual(['UsageError', 'UsageError', 'UsageError']);
  expect(r.badName).toBe('UsageError');
  // the number of requests in flight never exceeds the cap (a fresh page: nothing is cached)
  const p2 = await device(browser, (await (async () => ({ accessId: (await page.evaluate(() => store.status().accessId)), passphrase: 'purple-elephant-marching-slowly' }))()));
  const names = Array.from({ length: 12 }, (_, i) => 'm/' + i);
  w.world.server.delayMs = 60;
  for (const [conc, expectMax] of [[3, 3], [1, 1]]) {
    w.world.server.resetInflight();
    const vals = await p2.evaluate((a) => store.getMany(a.names, { concurrency: a.conc }), { names, conc });
    expect(vals.map((v) => v.i)).toEqual(names.map((_, i) => i));
    expect(w.world.server.maxInflight).toBeLessThanOrEqual(expectMax);
    expect(w.world.server.maxInflight).toBeGreaterThanOrEqual(1);
  }
  w.world.server.resetInflight();
  await p2.evaluate((n) => store.getMany(n), names);
  expect(w.world.server.maxInflight).toBeLessThanOrEqual(6);
  expect(w.world.server.maxInflight).toBeGreaterThan(1);
  w.world.server.delayMs = 0;
  // fresh: list() keeps the records it downloaded for a moment; fresh ignores that copy
  await other.put('q/1', { i: 1 });
  await other.put('q/2', { i: 2 });
  await p2.evaluate(async () => { await store.list('q/'); });
  await other.put('q/1', { i: 'new' });
  expect(await p2.evaluate(() => store.get('q/1'))).toEqual({ i: 1 });   // the copy list() kept
  await other.put('q/2', { i: 'new' });
  await p2.evaluate(async () => { await store.list('q/'); });   // list() sees q/2 changed and downloads it again
  expect(await p2.evaluate(() => store.getMany(['q/2'], { fresh: true }))).toEqual([{ i: 'new' }]);
  await p2.evaluate(async () => { await store.list('q/'); });
  expect(await p2.evaluate(() => store.get('q/2', { fresh: true }))).toEqual({ i: 'new' });
  // an error other than "missing" rejects
  await p2.route('**/datastore/api/**', (route) => route.abort('internetdisconnected'));
  expect(await p2.evaluate(() => store.getMany(['m/1', 'm/2']).then(() => 'ok', (e) => e.name))).toBe('OfflineError');
});

test('autosave: one live handle per name, undefined state, flush never rejects, statuses', async ({ browser }) => {
  const { page } = await setup(browser);
  const r = await page.evaluate(async () => {
    window.state = { n: 1 };
    const log = [];
    const h1 = store.autosave('draft', () => window.state, { delayMs: 60000, onStatus: (s) => log.push('h1:' + s) });
    h1.changed();
    const h2 = store.autosave('draft', () => window.state, { delayMs: 60000, onStatus: (s) => log.push('h2:' + s) });
    // the old handle was flushed (its pending save completes) and then stopped
    await new Promise((res) => { const i = setInterval(() => { if (h1.stopReason) { clearInterval(i); res(); } }, 20); });
    return { reason: h1.stopReason, h1: h1.status, h2: h2.status, log, stored: await store.get('draft'), name: h2.name };
  });
  expect(r.reason).toBe('superseded');
  expect(r.h1).toBe('stopped');
  expect(r.h2).toBe('idle');
  expect(r.stored).toEqual({ n: 1 });
  expect(r.name).toBe('draft');
  expect(r.log).toContain('h1:saved');
  // getState returning undefined: no write, status back to the previous non-dirty one
  const before = puts();
  const u = await page.evaluate(async () => {
    window.nothing = true;
    const seen = [];
    const h = store.autosave('maybe', () => (window.nothing ? undefined : { x: 1 }), { delayMs: 50, onStatus: (s) => seen.push(s) });
    h.changed(); await h.flush();
    return { status: h.status, seen };
  });
  expect(u.status).toBe('idle');
  expect(u.seen).toEqual(['dirty', 'idle']);
  expect(puts()).toBe(before);
  // flush() never rejects, also when saving fails; error and onError carry the reason
  await page.route('**/datastore/api/**', (route) => route.abort('internetdisconnected'));
  const f = await page.evaluate(async () => {
    const errs = [];
    const h = store.autosave('failing', () => ({ x: 1 }), { delayMs: 60000, onError: (e) => errs.push(e.name) });
    h.changed();
    const status = await h.flush();
    return { status, errs, error: h.error && h.error.name };
  });
  expect(f).toEqual({ status: 'error', errs: ['OfflineError'], error: 'OfflineError' });
});

test('lock keeps unsaved autosave state (read once, before onLock clears the screen) and writes it after the next unlock of the same vault', async ({ browser }) => {
  const { page, vault } = await setup(browser);
  await page.evaluate(() => {
    window.getCalls = 0; window.unlocks = []; window.locks = [];
    const out = document.getElementById('out');
    window.start = () => {
      window.starts = (window.starts || 0) + 1;
      window.h = store.autosave('draft', () => { window.getCalls++; return { text: out.textContent }; }, { delayMs: 60000 });
    };
    store.onLock((reason) => { window.locks.push(reason); out.textContent = ''; });
    store.onUnlock((st) => window.unlocks.push(st.vaultId));
    store.onUnlock(window.start); store.onUnlock(window.start);   // the same function twice registers once
    window.start();
    out.textContent = 'precious words'; h.changed();
  });
  await page.route('**/datastore/api/**', (route) => route.abort('internetdisconnected'));
  await page.evaluate(() => store.lock());
  expect(await page.evaluate(() => ({ calls: getCalls, locks, out: document.getElementById('out').textContent, reason: h.stopReason }))).toEqual({ calls: 1, locks: ['user'], out: '', reason: 'lock' });
  await page.unroute('**/datastore/api/**');
  await unlockViaUi(page, vault.accessId, vault.passphrase);
  // the snapshot was written before onUnlock handlers ran, and getState() was not called again for it
  expect(await page.evaluate(() => store.get('draft'))).toEqual({ text: 'precious words' });
  const after = await page.evaluate(() => ({ calls: getCalls, starts, unlocks: unlocks.length, live: h.stopReason }));
  expect(after).toEqual({ calls: 1, starts: 2, unlocks: 1, live: null });   // start() ran once on the unlock; the first handle had stopped, the new one is live
  const stored = await page.evaluate(() => store.get('draft'));
  expect(stored.text).toBe('precious words');
  // start() twice: the older handle is superseded, a save produces exactly one write
  await page.evaluate(() => { window.start(); window.h.changed(); });
  const n0 = puts();
  await page.evaluate(() => window.h.flush());
  expect(puts() - n0).toBe(1);
});

test('lock snapshots of one vault are dropped, with a notice, when another vault is unlocked', async ({ browser }) => {
  const { page } = await setup(browser);
  await page.evaluate(() => {
    window.h = store.autosave('draft', () => ({ text: 'lost?' }), { delayMs: 60000 });
    window.h.changed();
  });
  await page.route('**/datastore/api/**', (route) => route.abort('internetdisconnected'));
  await page.evaluate(() => store.lock());
  await page.unroute('**/datastore/api/**');
  // a second vault in the same app (new vault created on the lock screen)
  await createVaultViaUi(page, 'second-vault-passphrase-with-words');
  await expect(page.getByText('Unsaved changes of the previously open vault could not be saved.')).toBeVisible();
  expect(await page.evaluate(() => store.get('draft'))).toBeUndefined();
});

// ---------------------------------------------------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------------------------------------------------
const NOTES = () => { window.notes = store.collection('notes/', { meta: (v) => ({ t: v.t }) }); return window.notes.load().then((l) => l.length); };
const ids = (items) => items.map((i) => i.id).sort();
const idsOf = (page) => page.evaluate(() => notes.items().map((i) => i.id).sort());

async function twoDevices(browser) {
  const a = await openApp(await browser.newContext(), w);
  const vault = await createVaultViaUi(a);
  const b = await device(browser, vault);
  await a.evaluate(NOTES); await b.evaluate(NOTES);
  return { a, b, vault };
}

test('collection: no lost update when two devices add and remove (op replay on the latest index)', async ({ browser }) => {
  const { a, b, vault } = await twoDevices(browser);
  await b.evaluate(() => notes.add({ t: 'x' }, { id: 'x' }));
  await a.evaluate(() => notes.add({ t: 'y' }, { id: 'y' }));   // a had not seen x
  await a.evaluate(() => notes.add({ t: 'z' }, { id: 'z' }));   // x is kept
  expect(await idsOf(a)).toEqual(['x', 'y', 'z']);
  await b.evaluate(() => notes.remove('x'));   // b's list was stale
  await a.evaluate(() => notes.add({ t: 'w' }, { id: 'w' }));
  await a.evaluate(() => notes.refresh()); await b.evaluate(() => notes.refresh());
  expect(await idsOf(a)).toEqual(['w', 'y', 'z']);
  expect(await idsOf(b)).toEqual(['w', 'y', 'z']);
  const c = await device(browser, vault);
  expect(await c.evaluate(() => store.collection('notes/').load().then((l) => l.map((i) => i.id).sort()))).toEqual(['w', 'y', 'z']);
  // meta travels with the index: a list renders without loading the items
  expect(await c.evaluate(() => store.collection('notes/').items().find((i) => i.id === 'y').meta)).toEqual({ t: 'y' });
  expect(await c.evaluate(() => store.list('notes/').then((r) => r.map((x) => x.name).sort()))).toEqual(['notes/w', 'notes/y', 'notes/z']);
});

test('collection: the same result when the clock of one device is a day ahead', async ({ browser }) => {
  const { a, b } = await twoDevices(browser);
  await b.evaluate(() => { const real = Date.now.bind(Date); Date.now = () => real() + 86400000; });
  await b.evaluate(() => notes.add({ t: 'x' }, { id: 'x' }));
  await a.evaluate(() => notes.add({ t: 'y' }, { id: 'y' }));
  await a.evaluate(() => notes.add({ t: 'z' }, { id: 'z' }));
  await b.evaluate(() => notes.remove('x'));
  await a.evaluate(() => notes.add({ t: 'w' }, { id: 'w' }));
  await a.evaluate(() => notes.refresh()); await b.evaluate(() => notes.refresh());
  expect(await idsOf(a)).toEqual(['w', 'y', 'z']);
  expect(await idsOf(b)).toEqual(['w', 'y', 'z']);
});

test('collection: an item deleted on one device and kept (edited) on another stays visible on both', async ({ browser }) => {
  const { a, b } = await twoDevices(browser);
  await a.evaluate(() => notes.add({ t: 'same' }, { id: 'x' }));
  await b.evaluate(() => notes.refresh());
  expect(await idsOf(b)).toEqual(['x']);
  await b.evaluate(() => { store.onConflict('notes/', (c) => c.keepMine()); });
  await a.evaluate(() => notes.remove('x'));
  // b edits without a meta change: the entity conflicts with the deletion, b keeps its version, the item comes back
  const res = await b.evaluate(() => notes.set('x', { t: 'same', extra: 1 }));
  expect(res.resolution).toBe('mine');
  await a.evaluate(() => notes.refresh()); await b.evaluate(() => notes.refresh());
  expect(await idsOf(a)).toEqual(['x']);
  expect(await idsOf(b)).toEqual(['x']);
  expect(await a.evaluate(() => notes.get('x'))).toEqual({ t: 'same', extra: 1 });
});

test('collection: a failed index write keeps the item and rejects with stored/id/record; the queued change goes out with the next write or on "online"; rebuild() repairs orphans', async ({ browser }) => {
  const { a, b, vault } = await twoDevices(browser);
  const failSecondPut = async (page) => {
    let n = 0;
    await page.route('**/datastore/api/**', (route) => {
      const r = route.request();
      if (r.method() === 'PUT' && /\/records\//.test(r.url())) { n++; if (n === 2) return route.abort('internetdisconnected'); }
      return route.continue();
    });
  };
  await failSecondPut(a);
  const err = await a.evaluate(() => notes.add({ t: 'lost?' }, { id: 'k1' }).then(() => null, (e) => ({ name: e.name, stored: e.stored, id: e.id, record: e.record })));
  expect(err).toEqual({ name: 'OfflineError', stored: true, id: 'k1', record: 'notes/k1' });
  // the item exists, the index on the server does not list it yet
  expect(await a.evaluate(() => store.get('notes/k1'))).toEqual({ t: 'lost?' });
  await b.evaluate(() => notes.refresh());
  expect(await idsOf(b)).toEqual([]);
  expect(await idsOf(a)).toEqual(['k1']);   // this device's list already shows it: the change waits in the queue
  // the next add carries the waiting change: no second add of k1 is needed
  await a.unroute('**/datastore/api/**');
  await a.evaluate(() => notes.add({ t: 'later' }, { id: 'k3' }));
  await b.evaluate(() => notes.refresh());
  expect(await idsOf(b)).toEqual(['k1', 'k3']);
  // "online" retries by itself
  await failSecondPut(a);
  await a.evaluate(() => notes.add({ t: 'offline' }, { id: 'k4' }).catch(() => null));
  await a.unroute('**/datastore/api/**');
  await a.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => { await b.evaluate(() => notes.refresh()); return idsOf(b); }, { timeout: 15000 }).toEqual(['k1', 'k3', 'k4']);
  // a record under the prefix that no index lists (its page went away before the index write): rebuild() brings it back
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  await owner.put('notes/k2', { t: 'gone' });
  const d = await device(browser, vault);
  await d.evaluate(NOTES);
  expect(await idsOf(d)).toEqual(['k1', 'k3', 'k4']);
  const rebuilt = await d.evaluate(() => notes.rebuild().then((l) => l.map((i) => i.id + ':' + i.meta.t).sort()));
  expect(rebuilt).toEqual(['k1:lost?', 'k2:gone', 'k3:later', 'k4:offline']);
  await b.evaluate(() => notes.refresh());
  expect(await idsOf(b)).toEqual(['k1', 'k2', 'k3', 'k4']);
});

test('collection: writes are coalesced, and after 10 conflicting rounds the call fails with the item stored', async ({ browser }) => {
  const { a, b, vault } = await twoDevices(browser);
  w.world.server.delayMs = 80;
  const before = puts();
  const r = await a.evaluate(async () => {
    const calls = ['p', 'q', 'r', 's', 't'].map((id) => notes.add({ t: id }, { id }));
    return Promise.all(calls).then((all) => all.map((x) => x.id));
  });
  w.world.server.delayMs = 0;
  expect(r).toEqual(['p', 'q', 'r', 's', 't']);
  const indexPuts = puts() - before - 5;
  expect(indexPuts).toBeLessThanOrEqual(2);   // one write for the first, one follow-up for the rest
  await b.evaluate(() => notes.refresh());
  expect(await idsOf(b)).toEqual(['p', 'q', 'r', 's', 't']);
  // every round conflicts: 10 rounds with a pause between them, then ConflictError with stored
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const indexRid = await owner._rid('notes.index');
  w.world.server.failPreconditions = (rid) => rid === indexRid;
  const t0 = Date.now(), n0 = w.world.server.requests.filter((x) => x.method === 'PUT' && x.path.endsWith(indexRid)).length;
  const err = await a.evaluate(() => notes.add({ t: 'late' }, { id: 'late' }).then(() => null, (e) => ({ name: e.name, stored: e.stored, id: e.id, record: e.record })));
  w.world.server.failPreconditions = null;
  expect(err).toEqual({ name: 'ConflictError', stored: true, id: 'late', record: 'notes/late' });
  expect(w.world.server.requests.filter((x) => x.method === 'PUT' && x.path.endsWith(indexRid)).length - n0).toBe(10);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(9 * 50);   // jitter of 50 to 500 ms between rounds
  // the operation is still queued and goes out with the next write
  await a.evaluate(() => notes.add({ t: 'next' }, { id: 'next' }));
  await b.evaluate(() => notes.refresh());
  expect(await idsOf(b)).toEqual(['late', 'next', 'p', 'q', 'r', 's', 't']);
});

test('collection: records that are gone are skipped and removed lazily; records the index does not know are found by list()', async ({ browser }) => {
  const { a, vault } = await twoDevices(browser);
  const other = nodeClient(w);
  await other.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  await a.evaluate(async () => { await notes.add({ t: 'one' }, { id: 'one' }); await notes.add({ t: 'two' }, { id: 'two' }); });
  await other.get('notes/two'); await other.delete('notes/two');   // the record is gone, the index still lists it
  const before = puts();
  const got = await a.evaluate(async () => ({ one: await notes.get('one'), two: await notes.get('two'), all: (await notes.getAll()).map((x) => x.id) }));
  expect(got).toEqual({ one: { t: 'one' }, two: undefined, all: ['one'] });
  expect(puts()).toBe(before);   // reading writes nothing
  expect(await idsOf(a)).toEqual(['one']);   // the memory already drops it
  // an orphan: a record under the prefix that the index does not list
  await other.put('notes/orph', { t: 'orphan' });
  const before2 = puts();
  const listed = await a.evaluate(async () => { const changes = []; notes.onChange((c) => changes.push(c.added)); await store.list('notes/'); return { ids: notes.items().map((i) => i.id).sort(), changes }; });
  expect(listed.ids).toEqual(['one', 'orph']);
  expect(listed.changes).toEqual([['orph']]);
  expect(puts()).toBe(before2);   // still no write
  await a.evaluate(() => notes.add({ t: 'three' }, { id: 'three' }));   // the next write carries both lazy changes
  const fresh = await device(browser, vault);
  expect(await fresh.evaluate(() => store.collection('notes/').load().then((l) => l.map((i) => i.id).sort()))).toEqual(['one', 'orph', 'three']);
});

test('collection: a read member never writes the index; meta limit, names, options, items() before load and after lock', async ({ browser }) => {
  const { a, vault } = await twoDevices(browser);
  await a.evaluate(() => notes.add({ t: 'seen' }, { id: 'seen' }));
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const inv = await owner.createInvite({ role: 'read' });
  const m = await openApp(await browser.newContext(), w);
  await redeemViaUi(m, inv.code.display, 'member passphrase with words');
  const putsBefore = puts();
  const seen = await m.evaluate(async () => {
    const c = store.collection('notes/', { meta: (v) => ({ t: v.t }) });
    await c.load();
    return { items: c.items().map((i) => i.id), all: (await c.getAll()).map((x) => x.value.t), add: await c.add({ t: 'no' }, { id: 'no' }).then(() => 'ok', (e) => e.name) };
  });
  expect(seen).toEqual({ items: ['seen'], all: ['seen'], add: 'AuthError' });
  expect(puts()).toBe(putsBefore);
  // meta over 512 bytes is a UsageError and nothing is written
  const r = await a.evaluate(async () => {
    const out = {};
    out.big = await notes.add({ t: 'x'.repeat(600) }, { id: 'big' }).then(() => 'ok', (e) => e.name);
    out.bigStored = (await store.list('notes/')).some((x) => x.name === 'notes/big');
    out.badId = await Promise.all(['a/b', '', 'x'.repeat(201)].map((id) => notes.add({ t: 1 }, { id }).then(() => 'ok', (e) => e.name)));
    out.dotted = (await notes.add({ t: 'pdf' }, { id: 'abc.pdf' })).id;
    out.generated = (await notes.add({ t: 'g' })).id;
    out.names = [notes.prefix, notes.indexName];
    for (const p of ['notes', '.wds/x/']) { try { store.collection(p); out['p:' + p] = 'ok'; } catch (e) { out['p:' + p] = e.name; } }
    // one object per prefix; the options of the latest call win
    const f1 = () => ({ which: 1 }), f2 = () => ({ which: 2 });
    const c1 = store.collection('opt/', { meta: f1 }), c2 = store.collection('opt/', { meta: f2 });
    out.same = c1 === c2;
    await c2.add({ q: 1 }, { id: 'o1' });
    out.meta = c2.items()[0].meta;
    out.custom = store.collection('custom/', { index: 'my-index' }).indexName;
    out.inside = (() => { try { store.collection('inside/', { index: 'inside/idx' }); return 'ok'; } catch (e) { return e.name; } })();
    return out;
  });
  expect(r.big).toBe('UsageError');
  expect(r.bigStored).toBe(false);
  expect(r.badId).toEqual(['UsageError', 'UsageError', 'UsageError']);
  expect(r.dotted).toBe('abc.pdf');
  expect(r.generated).toMatch(/^[0-9a-z]{10}$/);
  expect(r.names).toEqual(['notes/', 'notes.index']);
  expect(r['p:notes']).toBe('UsageError');
  expect(r['p:.wds/x/']).toBe('UsageError');
  expect(r.same).toBe(true);
  expect(r.meta).toEqual({ which: 2 });
  expect(r.custom).toBe('my-index');
  expect(r.inside).toBe('UsageError');
  // items() needs a load first, and again after a lock
  const lockCheck = await a.evaluate(async () => {
    const c = store.collection('fresh/');
    const before = (() => { try { c.items(); return 'ok'; } catch (e) { return e.name + ':' + /load/.test(e.message); } })();
    const hasBefore = (() => { try { c.has('x'); return 'ok'; } catch (e) { return e.name; } })();
    await notes.load(); notes.items();
    await store.lock();
    const afterLock = (() => { try { notes.items(); return 'ok'; } catch (e) { return e.name; } })();
    return { before, hasBefore, afterLock };
  });
  expect(lockCheck).toEqual({ before: 'UsageError:true', hasBefore: 'UsageError', afterLock: 'UsageError' });
});

test('collection: autosave keeps the index meta current, written at most every 10 s, and on lock', async ({ browser }) => {
  const { a, b } = await twoDevices(browser);
  await a.evaluate(() => notes.add({ t: 'v1' }, { id: 'doc' }));
  const n0 = puts();
  await a.evaluate(async () => {
    window.state = { t: 'v2' };
    window.h = notes.autosave('doc', () => window.state, { delayMs: 100 });
    h.changed(); await h.flush();
    window.state = { t: 'v3' }; h.changed(); await h.flush();
  });
  expect(puts() - n0).toBe(2);   // two entity writes; the index waits: its last write was moments ago
  const mid = puts();
  await sleep(1500);
  expect(puts()).toBe(mid);   // the next meta change waits for the 10 s window
  await a.evaluate(() => store.lock());   // flushed on lock
  await b.evaluate(() => notes.refresh());
  expect(await b.evaluate(() => notes.items().find((i) => i.id === 'doc').meta)).toEqual({ t: 'v3' });
});

test('collection: a newer index on another device is merged on focus, onChange fires, no "newer versions" notice', async ({ browser }) => {
  const { a, b } = await twoDevices(browser);
  await a.evaluate(() => { window.changes = []; notes.onChange((c) => changes.push({ added: c.added, removed: c.removed, changed: c.changed, n: c.items.length })); });
  await b.evaluate(() => notes.add({ t: 'from b' }, { id: 'nb' }));
  await a.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => a.evaluate(() => changes.length)).toBe(1);
  expect(await a.evaluate(() => changes[0])).toEqual({ added: ['nb'], removed: [], changed: [], n: 1 });
  expect(await idsOf(a)).toEqual(['nb']);
  await expect(a.getByText(/Newer versions/)).toHaveCount(0);
  // the same function registered twice fires once
  await a.evaluate(() => { window.dup = 0; const f = () => { window.dup++; }; notes.onChange(f); notes.onChange(f); });
  await b.evaluate(() => notes.add({ t: 'again' }, { id: 'nb2' }));
  await a.evaluate(() => notes.refresh());
  expect(await a.evaluate(() => window.dup)).toBe(1);
});


test('collection: calls queued behind a failing index write fail too (stored), and nothing stays pending', async ({ browser }) => {
  const { a, vault } = await twoDevices(browser);
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const indexRid = await owner._rid('notes.index');
  await a.route('**/datastore/api/**', async (route) => {
    const r = route.request();
    if (r.method() === 'PUT' && r.url().endsWith(indexRid)) { await sleep(500); return route.abort('internetdisconnected'); }
    return route.continue();
  });
  const res = await a.evaluate(() => Promise.all(['m1', 'm2', 'm3', 'm4'].map((id) => notes.add({ t: id }, { id }).then(() => 'ok', (e) => ({ name: e.name, stored: e.stored, id: e.id })))));
  expect(res.map((r) => r.stored)).toEqual([true, true, true, true]);
  expect(res.map((r) => r.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  await a.unroute('**/datastore/api/**');
  // the changes stayed queued: the next write carries them
  await a.evaluate(() => notes.add({ t: 'm5' }, { id: 'm5' }));
  const b = await device(browser, vault);
  await b.evaluate(NOTES);
  expect(await idsOf(b)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
});

test('collection: an index that did not exist at load time is never overwritten blindly (list() of another prefix does not change the base)', async ({ browser }) => {
  const { a, b } = await twoDevices(browser);   // both loaded a missing index
  await a.evaluate(() => notes.add({ t: 'from a' }, { id: 'a1' }));
  await b.evaluate(() => store.list('files/'));   // the core now knows the index version, the collection does not
  await b.evaluate(() => notes.add({ t: 'from b' }, { id: 'b1' }));
  await b.evaluate(() => notes.refresh()); await a.evaluate(() => notes.refresh());
  expect(await idsOf(a)).toEqual(['a1', 'b1']);
  expect(await idsOf(b)).toEqual(['a1', 'b1']);
  expect(await b.evaluate(() => notes.items().find((i) => i.id === 'a1').meta)).toEqual({ t: 'from a' });
});

test('collection: a delayed op with an older entity version does not overwrite the newer title of another device', async ({ browser }) => {
  const { a, b, vault } = await twoDevices(browser);
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const indexRid = await owner._rid('notes.index');
  await a.evaluate(() => notes.add({ t: 'v1' }, { id: 'n' }));
  await b.evaluate(() => notes.refresh());
  await b.evaluate(() => store.get('notes/n'));   // b knows version 1 of the note
  let release; const gate = new Promise((r) => { release = r; });
  await b.route('**/datastore/api/**', async (route) => {
    const r = route.request();
    if (r.method() === 'PUT' && r.url().endsWith(indexRid)) await gate;
    return route.continue();
  });
  const pending = b.evaluate(() => notes.set('n', { t: 'B1' }).then(() => 'done'));   // entity v2 is stored, its index op waits
  await expect.poll(() => a.evaluate(() => store.get('notes/n', { fresh: true })), { timeout: 10000 }).toEqual({ t: 'B1' });
  await a.evaluate(() => notes.set('n', { t: 'A2' }));   // v3, index entry written
  release();
  await pending;
  await a.evaluate(() => notes.refresh()); await b.evaluate(() => notes.refresh());
  expect(await a.evaluate(() => notes.items().map((i) => i.meta.t))).toEqual(['A2']);
  expect(await b.evaluate(() => notes.items().map((i) => i.meta.t))).toEqual(['A2']);
  expect(await a.evaluate(() => store.get('notes/n', { fresh: true }))).toEqual({ t: 'A2' });
});

test('collection: a refresh whose read was overtaken by a write does not drop the new item', async ({ browser }) => {
  const { a, vault } = await twoDevices(browser);
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const indexRid = await owner._rid('notes.index');
  await a.evaluate(() => notes.add({ t: 'one' }, { id: 'one' }));
  await a.route('**/datastore/api/**', async (route) => {
    const r = route.request();
    if (r.method() === 'GET' && r.url().includes(indexRid)) { const resp = await route.fetch(); await sleep(800); return route.fulfill({ response: resp }); }
    return route.continue();
  });
  const refreshing = a.evaluate(() => notes.refresh().then(() => 'ok'));
  await sleep(200);
  await a.evaluate(() => notes.add({ t: 'two' }, { id: 'two' }));   // written while the (older) read is still on its way
  await refreshing;
  await a.unroute('**/datastore/api/**');
  expect(await idsOf(a)).toEqual(['one', 'two']);
});

test('lock keeps the pre-lock state even when onLock clears the very object getState returned', async ({ browser }) => {
  const { page, vault } = await setup(browser);
  await page.evaluate(() => {
    window.state = { text: 'precious words', items: [1, 2, 3] };
    window.h = store.autosave('draft', () => window.state, { delayMs: 60000 });
    store.onLock(() => { window.state.text = ''; window.state.items.length = 0; });
    window.h.changed();
  });
  await page.route('**/datastore/api/**', (route) => route.abort('internetdisconnected'));
  await page.evaluate(() => store.lock());
  expect(await page.evaluate(() => window.state)).toEqual({ text: '', items: [] });
  await page.unroute('**/datastore/api/**');
  await unlockViaUi(page, vault.accessId, vault.passphrase);
  expect(await page.evaluate(() => store.get('draft'))).toEqual({ text: 'precious words', items: [1, 2, 3] });
});

test('collection: add({ created }) orders the list; flush() resolves when queued index changes are on the server and rejects while they cannot be written', async ({ browser }) => {
  const { a, b, vault } = await twoDevices(browser);
  await a.evaluate(() => notes.add({ t: 'late' }, { id: 'late', created: 2000 }));
  await a.evaluate(() => notes.add({ t: 'early' }, { id: 'early', created: 1000 }));
  expect(await a.evaluate(() => notes.items().map((i) => i.id + ':' + i.created))).toEqual(['early:1000', 'late:2000']);
  expect(await a.evaluate(() => notes.add({ t: 'x' }, { created: 'yesterday' }).then(() => 'ok', (e) => e.name))).toBe('UsageError');
  await a.evaluate(() => notes.flush());   // nothing waiting: resolves at once
  // an index write fails: the change is queued, flush() fails too and keeps it; when the network is back flush() writes it
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const indexRid = await owner._rid('notes.index');
  await a.route('**/datastore/api/**', (route) => (route.request().method() === 'PUT' && route.request().url().endsWith(indexRid) ? route.abort('internetdisconnected') : route.continue()));
  const err = await a.evaluate(() => notes.add({ t: 'q' }, { id: 'q' }).then(() => null, (e) => ({ stored: e.stored, id: e.id })));
  expect(err).toEqual({ stored: true, id: 'q' });
  expect(await a.evaluate(() => notes.flush().then(() => 'ok', (e) => ({ name: e.name, stored: e.stored })))).toEqual({ name: 'OfflineError', stored: undefined });
  await a.unroute('**/datastore/api/**');
  await a.evaluate(() => notes.flush());
  await b.evaluate(() => notes.refresh());
  expect(await idsOf(b)).toEqual(['early', 'late', 'q']);
});
