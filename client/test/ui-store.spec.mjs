// Browser tests of the store API (wds-ui.js): conflicts, remove(), get, autosave, lock = reload, collections.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { startTestWorld, openApp, dialog, createVaultViaUi, unlockViaUi, lockPage, nodeClient, redeemViaUi } from './ui-helpers.mjs';

let w;
test.beforeEach(async () => { w = await startTestWorld(); live.clear(); });
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
// the check that runs when the page gets the focus (here at once): what another device changed reaches onChange
// (the list entries of the other devices are written in the background: they are flushed first, so that the check sees them)
const live = new Set();
async function sync(page, { flush = true } = {}) {
  if (flush) await Promise.all([...live].map((p) => p.evaluate(() => (window.notes ? notes._flush() : null)).catch(() => null)));
  await page.evaluate(() => WDS.internals.testHooks.checkNow());
}

test('conflicts: one handler decides with "mine", "theirs" or { merged }; undecided, throwing and rejecting handlers hand over to the dialog; a second one is a UsageError', async ({ browser }) => {
  const { page, other } = await setup(browser);
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.evaluate(async () => { for (const n of ['a', 'b', 'c', 'free']) await store.set(n, { v: 1 }); });
  await page.evaluate(() => {
    window.calls = [];
    store.onConflict((c) => {
      calls.push(c.name + ':' + c.mine.deleted);
      if (c.name === 'a') return { merged: { merged: [c.mine.value.v, c.theirs.value.v] } };
      if (c.name === 'b') return 'mine';
      return 'theirs';
    });
  });
  await bump(other, 'a', { v: 2 });
  const r1 = await page.evaluate(() => store.set('a', { v: 3 }));
  expect(r1.resolution).toBe('merged');
  expect(r1.value).toEqual({ merged: [3, 2] });   // set() reports what was stored
  expect((await other.getRecord('a')).value).toEqual({ merged: [3, 2] });
  await bump(other, 'b', { v: 2 });
  expect((await page.evaluate(() => store.set('b', { v: 3 }))).resolution).toBe('mine');
  await bump(other, 'c', { v: 2 });
  const r3 = await page.evaluate(() => store.set('c', { v: 3 }));
  expect([r3.resolution, r3.value]).toEqual(['theirs', { v: 2 }]);
  expect(await page.evaluate(() => calls)).toEqual(['a:false', 'b:false', 'c:false']);
  // a second handler is a UsageError (one per page); null removes the first
  expect(await page.evaluate(() => { try { store.onConflict(() => 'mine'); return 'ok'; } catch (e) { return e.name; } })).toBe('UsageError');
  await page.evaluate(() => { store.onConflict(null); store.onConflict(() => 'mine'); });
  await bump(other, 'c', { v: 4 });
  expect((await page.evaluate(() => store.set('c', { v: 5 }))).resolution).toBe('mine');
  expect(await page.evaluate(() => calls.length)).toBe(3);
  expect(await page.evaluate(() => { try { store.onConflict('notes/', () => {}); return 'ok'; } catch (e) { return e.name; } })).toBe('UsageError');

  // undecided, throwing and rejecting handlers open the built-in dialog
  await page.evaluate(() => {
    window.handlers = { undecided: () => {}, throwing: () => { throw new Error('boom'); }, rejecting: async () => { throw new Error('nope'); }, junk: () => ({ merged: undefined, x: 1 }) && 'whatever' };
  });
  for (const kind of ['undecided', 'throwing', 'rejecting']) {
    await page.evaluate((k) => { store.onConflict(null); store.onConflict(window.handlers[k]); }, kind);
    await bump(other, 'free', { v: kind });
    await page.evaluate(() => { window.setP = store.set('free', { v: 'mine' }); });
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Another device or person saved a newer version' })).toBeVisible();
    await d.getByRole('button', { name: 'Keep mine' }).click();
    expect((await page.evaluate(() => window.setP)).resolution).toBe('mine');
  }
  expect(consoleErrors.some((m) => m.includes('boom'))).toBe(true);
  expect(consoleErrors.some((m) => m.includes('nope'))).toBe(true);
  // a conflict while removing: mine.deleted
  await page.evaluate(() => { store.onConflict(null); store.onConflict((c) => { window.seen = [c.mine.deleted, c.theirs.value]; return 'mine'; }); });
  await bump(other, 'free', { v: 'changed' });
  const rm = await page.evaluate(() => store.remove('free'));
  expect(rm).toEqual({ name: 'free', deleted: true, resolution: 'mine' });
  expect(await page.evaluate(() => window.seen)).toEqual([true, { v: 'changed' }]);
  expect(await page.evaluate(() => store.get('free'))).toBeUndefined();
  // { merged } does not apply to a delete: the dialog decides
  await page.evaluate(() => { store.onConflict(null); store.onConflict(() => ({ merged: 1 })); });
  await bump(other, 'b', { v: 'again' });
  await page.evaluate(() => { window.rmP = store.remove('b'); });
  await dialog(page).getByRole('button', { name: 'Keep the entry' }).click();
  expect((await page.evaluate(() => window.rmP)).resolution).toBe('theirs');
  expect(page.errors).toEqual([]);
});

test('remove(): four results; it stops the autosave handle of that name', async ({ browser }) => {
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
    window.states = []; window.state = { t: 1 };
    window.h = store.autosave('doc', () => window.state, { delayMs: 300, onStatus: (s, info) => states.push(s + (info && info.resolution ? ':' + info.resolution : '')) });
    h.changed(); await h.flush();
  });
  expect(await page.evaluate(() => states)).toEqual(['dirty', 'saving', 'saved']);
  // "theirs": the other side's newer version is kept; the handle is stopped
  await bump(other, 'doc', { t: 'theirs' });
  await page.evaluate(() => { window.rmP = store.remove('doc'); });
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'This entry was changed in the meantime' })).toBeVisible();
  await d.getByRole('button', { name: 'Keep the entry' }).click();
  expect(await page.evaluate(() => window.rmP)).toEqual({ name: 'doc', deleted: false, resolution: 'theirs', value: { t: 'theirs' } });
  const before = puts();
  await page.evaluate(() => { window.state = { t: 2 }; h.changed(); });   // a no-op: the handle is stopped
  await sleep(700);
  expect(puts()).toBe(before);
  expect(await page.evaluate(() => states.slice(-1)[0])).toBe('saved');
  // a new handle for the name is possible after remove()
  await page.evaluate(() => { window.h = store.autosave('doc', () => window.state, { delayMs: 100 }); h.changed(); return h.flush(); });
  expect(await page.evaluate(() => store.get('doc'))).toEqual({ t: 2 });
});

test('get: a Blob for files and the JSON value otherwise, asks the server every time; collection.getAll reads at most 6 records at a time', async ({ browser }) => {
  const { page, vault, other } = await setup(browser);
  const r = await page.evaluate(async () => {
    await store.set('j', { i: 1 }); await store.set('f', new Uint8Array([1, 2, 3]), { mime: 'application/x-test' }); await store.set('g', new Blob(['hi'], { type: 'text/plain' }));
    const f = await store.get('f'), g = await store.get('g');
    return { j: await store.get('j'), f: [f instanceof Blob, f.type, [...new Uint8Array(await f.arrayBuffer())]], g: [g.type, await g.text()], none: await store.get('none'), bad: await store.get('.wds/x').then(() => 'ok', (e) => e.name) };
  });
  expect(r).toEqual({ j: { i: 1 }, f: [true, 'application/x-test', [1, 2, 3]], g: ['text/plain', 'hi'], none: undefined, bad: 'UsageError' });
  // every get asks the server: what another device saved a moment ago is there
  await other.get('j'); await other.put('j', { i: 'new' });
  expect(await page.evaluate(() => store.get('j'))).toEqual({ i: 'new' });
  await other.put('q', { i: 1 }); await other.list('q');
  await other.put('q', { i: 2 });
  expect(await page.evaluate(() => store.get('q'))).toEqual({ i: 2 });
  // collection.getAll: at most 6 requests in flight
  await page.evaluate(async () => { window.items = store.collection('m/'); await items.load(); for (let i = 0; i < 12; i++) await items.set('m' + i, { i }); });
  const p2 = await device(browser, vault);
  w.world.server.delayMs = 60;
  w.world.server.resetInflight();
  const vals = await p2.evaluate(async () => { const c = store.collection('m/'); return (await c.getAll()).map((x) => x.value.i); });
  expect(vals).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);   // in the order of the list
  expect(w.world.server.maxInflight).toBeLessThanOrEqual(6);
  expect(w.world.server.maxInflight).toBeGreaterThan(1);
  w.world.server.delayMs = 0;
  // an error other than "missing" rejects
  await p2.route('**/datastore/api/**', (route) => route.abort('internetdisconnected'));
  expect(await p2.evaluate(() => store.get('m/m1').then(() => 'ok', (e) => e.name))).toBe('OfflineError');
});

test('autosave: one live handle per name, stop() ends it, undefined state, flush never rejects, onStatus(status, info)', async ({ browser }) => {
  const { page, other } = await setup(browser);
  const r = await page.evaluate(async () => {
    window.state = { n: 1 };
    const log = [];
    const h1 = store.autosave('draft', () => window.state, { delayMs: 60000, onStatus: (s) => log.push('h1:' + s) });
    h1.changed();
    const dup = (() => { try { store.autosave('draft', () => window.state); return 'ok'; } catch (e) { return e.name; } })();
    const status = await h1.flush();
    h1.stop();
    h1.changed(); h1.changed();   // a no-op after stop
    const h2 = store.autosave('draft', () => ({ n: 2 }), { delayMs: 60000, onStatus: (s) => log.push('h2:' + s) });
    h2.changed(); await h2.flush(); h2.stop();
    return { dup, status, log, stored: await store.get('draft') };
  });
  expect(r.dup).toBe('UsageError');
  expect(r.status).toBe('saved');
  expect(r.log).toEqual(['h1:dirty', 'h1:saving', 'h1:saved', 'h2:dirty', 'h2:saving', 'h2:saved']);
  expect(r.stored).toEqual({ n: 2 });
  // getState returning undefined: no write, status back to the previous non-dirty one
  const before = puts();
  const u = await page.evaluate(async () => {
    window.nothing = true;
    const seen = [];
    const h = store.autosave('maybe', () => (window.nothing ? undefined : { x: 1 }), { delayMs: 50, onStatus: (s) => seen.push(s) });
    h.changed(); await h.flush();
    return seen;
  });
  expect(u).toEqual(['dirty', 'idle']);
  expect(puts()).toBe(before);
  // a lost conflict is reported by onChange({ remote: true }), the one way to learn that the open entry is another text now; onStatus says saved
  await page.evaluate(async () => {
    await store.set('shared', { v: 0 });
    window.infos = []; window.changes = [];
    window.hs = store.autosave('shared', () => ({ v: 'mine' }), { delayMs: 60000, onStatus: (s, info) => { if (s === 'saved') infos.push(info); } });
    store.onConflict(() => 'theirs');
    store.onChange((c) => { if (c.remote) changes.push(c.names); });
  });
  await bump(other, 'shared', { v: 'theirs' });
  await page.evaluate(async () => { hs.changed(); await hs.flush(); });
  expect(await page.evaluate(() => infos)).toEqual([undefined]);
  expect(await page.evaluate(() => changes)).toEqual([['shared']]);
  // the editor still holds the old text: its next save meets the other version again (it is not overwritten silently)
  await page.evaluate(() => { store.onConflict(null); hs.changed(); window.hsP = hs.flush(); });
  await expect(page.locator('[data-wds-view=conflict]')).toBeVisible();
  await page.locator('[data-wds=conflict-theirs]').click();
  expect(await page.evaluate(() => hsP)).toBe('saved');
  await page.evaluate(() => hs.stop());
  // flush() never rejects, also when saving fails; the status carries the error
  await page.route('**/datastore/api/**', (route) => route.abort('internetdisconnected'));
  const f = await page.evaluate(async () => {
    const errs = [];
    const h = store.autosave('failing', () => ({ x: 1 }), { delayMs: 60000, onStatus: (s, info) => { if (s === 'error') errs.push(info.error.name); } });
    h.changed();
    return { status: await h.flush(), errs };
  });
  expect(f).toEqual({ status: 'error', errs: ['OfflineError'] });
});

test('lock = save what is pending, then reload; offline, a dialog offers the backup first and then "Lock anyway"', async ({ browser }) => {
  const { page, vault } = await setup(browser);
  await page.evaluate(() => {
    window.state = { text: 'precious words' };
    window.h = store.autosave('draft', () => window.state, { delayMs: 60000 });
    h.changed();
  });
  await lockPage(page);   // online: the pending value is saved first
  expect(await page.evaluate(() => store.status().unlocked)).toBe(false);
  await unlockViaUi(page, vault.accessId, vault.passphrase);
  expect(await page.evaluate(() => store.get('draft'))).toEqual({ text: 'precious words' });
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-wds-role'))).toBe('owner');

  // offline: the save fails, the person is asked
  await page.evaluate(() => {
    window.state = { text: 'unsaved words' };
    window.h = store.autosave('draft', () => window.state, { delayMs: 60000 });
    h.changed();
    window.beforeUnloadPrevented = false;
    window.addEventListener('beforeunload', (ev) => { window.beforeUnloadPrevented = ev.defaultPrevented; });
  });
  await page.route('**/datastore/api/**', (route) => route.abort('internetdisconnected'));
  await page.evaluate(() => { void store.lock(); });
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'Not everything is saved' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.hasAttribute('data-wds-role'))).toBe(false);
  const dl = page.waitForEvent('download');
  await d.getByRole('button', { name: 'Download unsaved values (backup)' }).click();
  expect(JSON.parse(readFileSync(await (await dl).path(), 'utf8'))).toEqual({ text: 'unsaved words' });
  await expect(d).toBeVisible();   // the backup does not decide anything
  const loaded = page.waitForEvent('load');
  await d.getByRole('button', { name: 'Lock anyway' }).click();
  await loaded;
  expect(await page.evaluate(() => store.status().unlocked)).toBe(false);
  await page.unroute('**/datastore/api/**');
  await unlockViaUi(page, vault.accessId, vault.passphrase);
  expect(await page.evaluate(() => store.get('draft'))).toEqual({ text: 'precious words' });   // the unsaved edit is gone; it was handed out as a backup
});

// ---------------------------------------------------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------------------------------------------------
const NOTES = () => { window.notes = store.collection('notes/', { meta: (v) => ({ t: v.t }) }); return window.notes.load().then((l) => l.length); };
const idsOf = (page) => page.evaluate(() => notes.items().map((i) => i.id).sort());

async function twoDevices(browser) {
  const a = await openApp(await browser.newContext(), w);
  const vault = await createVaultViaUi(a);
  const b = await device(browser, vault);
  await a.evaluate(NOTES); await b.evaluate(NOTES);
  live.add(a); live.add(b);
  return { a, b, vault };
}

test('collection: no lost update when two devices add and remove (op replay on the latest index); items come in insertion order', async ({ browser }) => {
  const { a, b, vault } = await twoDevices(browser);
  await b.evaluate(() => notes.set('x', { t: 'x' }));
  await a.evaluate(() => notes.set('y', { t: 'y' }));   // a had not seen x
  await a.evaluate(() => notes.set('z', { t: 'z' }));   // x is kept
  expect(await idsOf(a)).toEqual(['x', 'y', 'z']);
  await b.evaluate(() => notes.remove('x'));   // b's list was stale
  await a.evaluate(() => notes.set('w', { t: 'w' }));
  await sync(a); await sync(b);
  expect(await idsOf(a)).toEqual(['w', 'y', 'z']);
  expect(await idsOf(b)).toEqual(['w', 'y', 'z']);
  const c = await device(browser, vault);
  expect(await c.evaluate(() => store.collection('notes/').load().then((l) => l.map((i) => i.id)))).toEqual(['y', 'z', 'w']);   // the order the entries were added in
  // meta travels with the index: a list renders without loading the items
  expect(await c.evaluate(() => { const col = store.collection('notes/'); return col.load().then(() => col.items().find((i) => i.id === 'y').meta); })).toEqual({ t: 'y' });
});

test('collection: an item deleted on one device and kept (edited) on another stays visible on both', async ({ browser }) => {
  const { a, b } = await twoDevices(browser);
  await a.evaluate(() => notes.set('x', { t: 'same' }));
  await sync(b);
  expect(await idsOf(b)).toEqual(['x']);
  await b.evaluate(() => { store.onConflict(() => 'mine'); });
  await a.evaluate(() => notes.remove('x'));
  // b edits without a meta change: the entity conflicts with the deletion, b keeps its version, the item comes back
  const res = await b.evaluate(() => notes.set('x', { t: 'same', extra: 1 }));
  expect(res.resolution).toBe('mine');
  await sync(a); await sync(b);
  expect(await idsOf(a)).toEqual(['x']);
  expect(await idsOf(b)).toEqual(['x']);
  expect(await a.evaluate(() => notes.get('x'))).toEqual({ t: 'same', extra: 1 });
});

test('collection: a failed index write does not fail add/set: the item is stored, the list entry waits in the queue and goes out with the next write, on "online", on focus, before lock', async ({ browser }) => {
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
  const res = await a.evaluate(() => notes.set('k1', { t: 'kept' }).then((r) => r.version, (e) => e.name));
  expect(res).toBe(1);   // the item record is stored: the call resolves
  await expect(dialog(a).getByRole('heading', { name: 'Not saved' })).toBeVisible();   // the failed index write was offline with unsaved changes: one dialog
  await dialog(a).getByRole('button', { name: 'Close' }).first().click();
  expect(await a.evaluate(() => store.get('notes/k1'))).toEqual({ t: 'kept' });
  await sync(b, { flush: false });
  expect(await idsOf(b)).toEqual([]);
  expect(await idsOf(a)).toEqual(['k1']);   // this device's list already shows it: the change waits in the queue
  // the next write carries the waiting change
  await a.unroute('**/datastore/api/**');
  await a.evaluate(() => notes.set('k3', { t: 'later' }));
  await sync(b);
  expect(await idsOf(b)).toEqual(['k1', 'k3']);
  // "online" retries by itself
  await failSecondPut(a);
  await a.evaluate(() => notes.set('k4', { t: 'offline' }));
  await a.unroute('**/datastore/api/**');
  await a.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => { await sync(b); return idsOf(b); }, { timeout: 15000 }).toEqual(['k1', 'k3', 'k4']);
  // a record under the prefix that no index lists: the export brings it back into the list (orphan repair)
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  await owner.put('notes/k2', { t: 'gone' });
  const d = await device(browser, vault);
  await d.evaluate(NOTES);
  expect(await idsOf(d)).toEqual(['k1', 'k3', 'k4']);
  await d.evaluate(() => { void store.openVault(); });
  const dl = d.waitForEvent('download');
  await dialog(d).getByRole('button', { name: 'Export everything (ZIP, unencrypted)' }).click();
  await dl;
  await expect(dialog(d).getByText(/Export finished: \d+ records\./)).toBeVisible();
  await expect.poll(() => idsOf(d)).toEqual(['k1', 'k2', 'k3', 'k4']);
  await expect.poll(async () => { await sync(b); return idsOf(b); }, { timeout: 15000 }).toEqual(['k1', 'k2', 'k3', 'k4']);
});

test('collection: writes are coalesced; when the index write keeps conflicting, the items stay stored and the entries stay queued', async ({ browser }) => {
  const { a, b, vault } = await twoDevices(browser);
  w.world.server.delayMs = 80;
  const before = puts();
  const r = await a.evaluate(async () => {
    const ids = ['p', 'q', 'r', 's', 't'];
    return Promise.all(ids.map((id) => notes.set(id, { t: id }))).then((all) => all.map((x, i) => (x.version ? ids[i] : null)));
  });
  w.world.server.delayMs = 0;
  expect(r).toEqual(['p', 'q', 'r', 's', 't']);
  await expect.poll(() => puts() - before - 5).toBeGreaterThan(0);
  await expect.poll(() => puts() - before - 5).toBeLessThanOrEqual(2);   // one write for the first, one follow-up for the rest
  await sync(b);
  expect(await idsOf(b)).toEqual(['p', 'q', 'r', 's', 't']);
  // every round conflicts: 10 rounds with a pause between them, then the write fails; the item is stored and its entry stays queued
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const indexRid = await owner._rid('notes.index');
  w.world.server.failPreconditions = (rid) => rid === indexRid;
  const t0 = Date.now(), n0 = w.world.server.requests.filter((x) => x.method === 'PUT' && x.path.endsWith(indexRid)).length;
  const res = await a.evaluate(() => notes.set('late', { t: 'late' }).then((x) => x.version, (e) => e.name));
  expect(res).toBe(1);
  await expect.poll(() => w.world.server.requests.filter((x) => x.method === 'PUT' && x.path.endsWith(indexRid)).length - n0, { timeout: 20000 }).toBe(10);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(9 * 50);   // jitter of 50 to 500 ms between rounds
  await expect(dialog(a).getByRole('heading', { name: 'Not saved' })).toHaveCount(0);   // a conflict is not an offline episode
  w.world.server.failPreconditions = null;
  // the entry is still queued and goes out with the next write
  await a.evaluate(() => notes.set('next', { t: 'next' }));
  await sync(b);
  expect(await idsOf(b)).toEqual(['late', 'next', 'p', 'q', 'r', 's', 't']);
});

test('collection: records that are gone are skipped and removed from the list lazily', async ({ browser }) => {
  const { a, vault } = await twoDevices(browser);
  const other = nodeClient(w);
  await other.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  await a.evaluate(async () => { await notes.set('one', { t: 'one' }); await notes.set('two', { t: 'two' }); });
  await other.get('notes/two'); await other.delete('notes/two');   // the record is gone, the index still lists it
  const before = puts();
  const got = await a.evaluate(async () => ({ one: await notes.get('one'), two: await notes.get('two'), all: (await notes.getAll()).map((x) => x.id) }));
  expect(got).toEqual({ one: { t: 'one' }, two: undefined, all: ['one'] });
  expect(puts()).toBe(before);   // reading writes nothing
  expect(await idsOf(a)).toEqual(['one']);   // the memory already drops it
  await a.evaluate(() => notes.set('three', { t: 'three' }));   // the next write carries the removal
  const fresh = await device(browser, vault);
  expect(await fresh.evaluate(() => store.collection('notes/').load().then((l) => l.map((i) => i.id).sort()))).toEqual(['one', 'three']);
});

test('collection: a read member never writes the index; meta limit, names, options, items() before load', async ({ browser }) => {
  const { a, vault } = await twoDevices(browser);
  await a.evaluate(() => notes.set('seen', { t: 'seen' }));
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const inv = await owner.createInvite({ role: 'read' });
  const m = await openApp(await browser.newContext(), w);
  await redeemViaUi(m, inv.code.display, 'member passphrase with words');
  const putsBefore = puts();
  const seen = await m.evaluate(async () => {
    const c = store.collection('notes/', { meta: (v) => ({ t: v.t }) });
    await c.load();
    return { items: c.items().map((i) => i.id), all: (await c.getAll()).map((x) => x.value.t), add: await c.set('no', { t: 'no' }).then(() => 'ok', (e) => e.name), role: document.documentElement.getAttribute('data-wds-role') };
  });
  expect(seen).toEqual({ items: ['seen'], all: ['seen'], add: 'AuthError', role: 'read' });
  expect(puts()).toBe(putsBefore);
  // meta over 512 bytes is a UsageError and nothing is written
  const r = await a.evaluate(async () => {
    const out = {};
    out.big = await notes.set('big', { t: 'x'.repeat(600) }).then(() => 'ok', (e) => e.name);
    out.bigStored = await store.get('notes/big');
    out.badId = await Promise.all(['a/b', '', 'x'.repeat(201)].map((id) => notes.set(id, { t: 1 }).then(() => 'ok', (e) => e.name)));
    await notes.set('abc.pdf', { t: 'pdf' });
    out.dotted = notes.items().some((i) => i.id === 'abc.pdf');
    out.generated = (await notes.add({ t: 'g' })).id;
    for (const p of ['notes', '.wds/x/']) { try { store.collection(p); out['p:' + p] = 'ok'; } catch (e) { out['p:' + p] = e.name; } }
    out.badMeta = (() => { try { store.collection('bad/', { meta: 5 }); return 'ok'; } catch (e) { return e.name; } })();
    out.keys = Object.keys(notes).filter((k) => k[0] !== '_').sort();
    return out;
  });
  expect(r.big).toBe('UsageError');
  expect(r.bigStored).toBeUndefined();
  expect(r.badId).toEqual(['UsageError', 'UsageError', 'UsageError']);
  expect(r.dotted).toBe(true);
  expect(r.generated).toMatch(/^[0-9a-z]{10}$/);
  expect(r['p:notes']).toBe('UsageError');
  expect(r['p:.wds/x/']).toBe('UsageError');
  expect(r.badMeta).toBe('UsageError');
  expect(r.keys).toEqual(['add', 'autosave', 'get', 'getAll', 'items', 'load', 'remove', 'set']);
  // items() needs a load first
  const before = await a.evaluate(() => { const c = store.collection('fresh/'); try { c.items(); return 'ok'; } catch (e) { return e.name + ':' + /load/.test(e.message); } });
  expect(before).toBe('UsageError:true');
});

test('collection: autosave keeps the index meta current, written at most every 10 s, and before the lock', async ({ browser }) => {
  const { a, b } = await twoDevices(browser);
  await a.evaluate(() => notes.set('doc', { t: 'v1' }));
  await a.evaluate(() => notes._flush());
  const n0 = puts();
  await a.evaluate(async () => {
    window.state = { t: 'v2' };
    window.h = notes.autosave('doc', () => window.state, { delayMs: 100 });
    h.changed(); await h.flush();
    window.state = { t: 'v3' }; h.changed(); await h.flush();
  });
  expect(puts() - n0).toBe(2);   // two entity writes; the index waits: its last write was moments ago
  expect(await a.evaluate(() => notes.items()[0].meta)).toEqual({ t: 'v3' });   // this device's list is current at once
  const mid = puts();
  await sleep(1500);
  expect(puts()).toBe(mid);   // the next meta change waits for the 10 s window
  await lockPage(a);   // flushed before the reload
  await sync(b);
  expect(await b.evaluate(() => notes.items().find((i) => i.id === 'doc').meta)).toEqual({ t: 'v3' });
});

test('onChange: own writes (remote: false) and, on focus, what another device changed in a list (remote: true, item names), without a notice', async ({ browser }) => {
  const { a, b } = await twoDevices(browser);
  await a.evaluate(() => { window.changes = []; store.onChange((c) => changes.push(c)); });
  await a.evaluate(() => notes.set('mine', { t: 'm' }));
  await a.evaluate(() => store.set('plain', { v: 1 }));
  await a.evaluate(async () => { const h = notes.autosave('mine', () => ({ t: 'm2' }), { delayMs: 50 }); h.changed(); await h.flush(); h.stop(); });
  await a.evaluate(() => notes.remove('mine'));
  expect(await a.evaluate(() => changes)).toEqual([
    { names: ['notes/mine'], remote: false }, { names: ['plain'], remote: false }, { names: ['notes/mine'], remote: false }, { names: ['notes/mine'], remote: false },
  ]);
  await a.evaluate(() => { changes.length = 0; });
  await b.evaluate(() => notes.set('nb', { t: 'from b' }));
  await sync(a);
  await expect.poll(() => a.evaluate(() => changes)).toEqual([{ names: ['notes/nb'], remote: true }]);
  expect(await idsOf(a)).toEqual(['nb']);
  await expect(a.locator('[data-wds-notice]')).toHaveCount(0);
  // a change of meta only, and a removal
  await a.evaluate(() => { changes.length = 0; });
  await b.evaluate(() => notes.set('nb', { t: 'changed' }));
  await b.evaluate(() => notes.remove('nb'));
  await sync(a);
  await expect.poll(() => a.evaluate(() => changes)).toEqual([{ names: ['notes/nb'], remote: true }]);
  expect(await idsOf(a)).toEqual([]);
  // a handler that was removed is not called
  await a.evaluate(() => { store.onChange(null); changes.length = 0; });
  await b.evaluate(() => notes.set('nb3', { t: 'x' }));
  await sync(a); await sleep(300);
  expect(await a.evaluate(() => changes)).toEqual([]);
  expect(await idsOf(a)).toEqual(['nb3']);
});

test('collection: an index that did not exist at load time is never overwritten blindly', async ({ browser }) => {
  const { a, b } = await twoDevices(browser);   // both loaded a missing index
  await a.evaluate(() => notes.set('a1', { t: 'from a' }));
  await b.evaluate(() => store.get('notes.index'));   // the core now knows the index version, the collection does not
  await b.evaluate(() => notes.set('b1', { t: 'from b' }));
  await sync(b); await sync(a);
  expect(await idsOf(a)).toEqual(['a1', 'b1']);
  expect(await idsOf(b)).toEqual(['a1', 'b1']);
  expect(await b.evaluate(() => notes.items().find((i) => i.id === 'a1').meta)).toEqual({ t: 'from a' });
});

test('collection: a delayed op with an older entity version does not overwrite the newer title of another device', async ({ browser }) => {
  const { a, b, vault } = await twoDevices(browser);
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const indexRid = await owner._rid('notes.index');
  await a.evaluate(() => notes.set('n', { t: 'v1' }));
  await sync(b);
  await b.evaluate(() => store.get('notes/n'));   // b knows version 1 of the note
  let release; const gate = new Promise((r) => { release = r; });
  await b.route('**/datastore/api/**', async (route) => {
    const r = route.request();
    if (r.method() === 'PUT' && r.url().endsWith(indexRid)) await gate;
    return route.continue();
  });
  await b.evaluate(() => { window.pendingSet = notes.set('n', { t: 'B1' }).then(() => 'done'); });   // entity v2 is stored, its index op waits
  await expect.poll(() => a.evaluate(() => store.get('notes/n')), { timeout: 10000 }).toEqual({ t: 'B1' });
  await a.evaluate(() => notes.set('n', { t: 'A2' }));   // v3, index entry written
  release();
  await b.evaluate(() => window.pendingSet);
  await expect.poll(async () => { await sync(a); await sync(b); return [await a.evaluate(() => notes.items().map((i) => i.meta.t)), await b.evaluate(() => notes.items().map((i) => i.meta.t))]; }, { timeout: 15000 }).toEqual([['A2'], ['A2']]);
  expect(await a.evaluate(() => store.get('notes/n'))).toEqual({ t: 'A2' });
});

test('collection: a check whose read was overtaken by a write does not drop the new item', async ({ browser }) => {
  const { a, b, vault } = await twoDevices(browser);
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const indexRid = await owner._rid('notes.index');
  await a.evaluate(() => notes.set('one', { t: 'one' }));
  await b.evaluate(() => notes.set('other', { t: 'other' }));   // the index on the server is newer than a's copy: the check reads it
  await a.route('**/datastore/api/**', async (route) => {
    const r = route.request();
    if (r.method() === 'GET' && r.url().includes(indexRid)) { const resp = await route.fetch(); await sleep(800); return route.fulfill({ response: resp }); }
    return route.continue();
  });
  const checking = sync(a);
  await sleep(300);
  await a.evaluate(() => notes.set('two', { t: 'two' }));   // written while the (older) read is still on its way
  await checking;
  await a.unroute('**/datastore/api/**');
  expect(await idsOf(a)).toEqual(['one', 'other', 'two']);
});

test('collection.set is an upsert: a new id gets its list entry, an existing entry keeps its place, and a record this page has not read is a conflict, not a silent overwrite', async ({ browser }) => {
  const { a, b } = await twoDevices(browser);
  await a.evaluate(() => notes.set('n1', { t: 'one' }));
  await a.evaluate(() => notes.set('n2', { t: 'two' }));
  expect(await a.evaluate(() => notes.items().map((i) => [i.id, i.meta.t]))).toEqual([['n1', 'one'], ['n2', 'two']]);
  // the list entry is on the server: another device sees both after a check, without reading the items
  await sync(b);
  expect(await idsOf(b)).toEqual(['n1', 'n2']);
  // set on an existing entry: meta follows, the place stays
  await a.evaluate(() => notes.set('n1', { t: 'one!' }));
  expect(await a.evaluate(() => notes.items().map((i) => [i.id, i.meta.t]))).toEqual([['n1', 'one!'], ['n2', 'two']]);
  // b lists n1 but has never read it: its set() meets the stored version, and the conflict rules decide (here: the handler keeps b's value)
  await b.evaluate(() => { window.calls = []; store.onConflict((c) => { calls.push(c.name + ':' + c.mine.deleted); return 'mine'; }); });
  const r1 = await b.evaluate(() => notes.set('n1', { t: 'from b' }));
  expect(r1.resolution).toBe('mine');
  expect(await b.evaluate(() => calls)).toEqual(['notes/n1:false']);
  await sync(a);
  expect(await a.evaluate(() => notes.items().filter((i) => i.id === 'n1').map((i) => i.meta.t))).toEqual(['from b']);
  expect(await a.evaluate(() => notes.get('n1'))).toEqual({ t: 'from b' });
  // keeping the stored version instead: the value is not overwritten and the list shows its meta
  await b.evaluate(() => { store.onConflict(null); store.onConflict(() => 'theirs'); });
  await a.evaluate(() => notes.set('n2', { t: 'two, edited by a' }));
  const r2 = await b.evaluate(() => notes.set('n2', { t: 'from b' }));
  expect([r2.resolution, r2.value]).toEqual(['theirs', { t: 'two, edited by a' }]);
  expect(await b.evaluate(() => notes.items().filter((i) => i.id === 'n2').map((i) => i.meta.t))).toEqual(['two, edited by a']);
});

test('autosave: a re-read of the record while the editor holds unsaved text does not move the base; a re-read in the clean state does', async ({ browser }) => {
  const { page, other } = await setup(browser);
  await page.evaluate(async () => { await store.set('note', { t: 'v1' }); window.text = await store.get('note'); window.h = store.autosave('note', () => window.text, { delayMs: 60000 }); });
  // another member saves; the app (an onChange handler, a total over all records) reads the record again while the person has typed
  await bump(other, 'note', { t: 'theirs' });
  await page.evaluate(async () => { window.text = { t: 'v1 and more typing' }; h.changed(); await store.get('note'); window.p = h.flush(); });
  await expect(dialog(page).getByRole('heading', { name: 'Another device or person saved a newer version' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Keep theirs' }).click();
  expect(await page.evaluate(() => p)).toBe('saved');
  expect((await other.getRecord('note')).value).toEqual({ t: 'theirs' });
  // in the clean state a re-read is what the page shows: the next edit builds on it
  await bump(other, 'note', { t: 'theirs 2' });
  await page.evaluate(async () => { window.text = await store.get('note'); window.text = { t: 'theirs 2, edited' }; h.changed(); await h.flush(); });
  expect(await page.evaluate(() => store.get('note'))).toEqual({ t: 'theirs 2, edited' });
});

test('a failed security check is a dialog with OK, once per page; the page goes on', async ({ browser }) => {
  const { page } = await setup(browser);
  await page.evaluate(() => store.set('safe', { t: 1 }));
  await page.route(/\/records\//, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = Buffer.from(await res.body());
    body[body.length - 1] ^= 1;
    await route.fulfill({ response: res, body });
  });
  const err = () => page.evaluate(() => store.get('safe').then(() => null, (e) => e.name));
  expect(await err()).toBe('IntegrityError');
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'A security check failed' })).toBeVisible();
  await expect(d).toContainText('Do not enter new data');
  await d.getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('dialog.wds-dialog')).toHaveCount(0);
  expect(await err()).toBe('IntegrityError');
  await sleep(300);
  await expect(page.locator('dialog.wds-dialog')).toHaveCount(0);   // not shown a second time
});

test('lock empties the page before the reload: no typed text can be put back into the fields', async ({ browser }) => {
  const { page } = await setup(browser);
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'secret'; document.body.appendChild(i); i.value = 'plain text of the vault'; });
  await page.evaluate(() => { addEventListener('pagehide', () => sessionStorage.setItem('at-unload', document.body.children.length + ':' + (document.getElementById('secret') ? 'field' : 'no field'))); });
  const reloaded = page.waitForEvent('load');
  await page.evaluate(() => { store.lock(); });
  await reloaded;
  expect(await page.evaluate(() => sessionStorage.getItem('at-unload'))).toBe('0:no field');
});
