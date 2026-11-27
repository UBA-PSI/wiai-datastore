// Stress test of the library's dialogs: reload and unlock many times against the real server while the network is slow, jittery, fails
// and stalls (requests are delayed, aborted, answered with 500, or never answered). Whatever happens, there is never more than one library
// dialog, a page that is locked and waits for the unlock always shows one, a dialog never waits for ever (a request that does not answer ends
// in the "error" view with a retry, or in the form's error), and a view that cannot be built ends in the "error" view as well. Chromium, Firefox and WebKit
// (playwright.integration.config.mjs). WDS_STRESS_ROUNDS=50 makes a longer run; WDS_STRESS_SEED=<n> repeats the faults of an earlier run.
import { test as base, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startStack } from './integration-env.mjs';
import { createVault, unlock, DriveError, viewOf, dialog, dialogState, waitForView } from '../../tools/lib/dialog-internals.mjs';

const test = base.extend({
  stack: [async ({}, use) => {
    const stack = await startStack();
    try { await use(stack); } finally { await stack.stop(); }
  }, { scope: 'worker' }],
});
test.describe.configure({ mode: 'serial' });
test.setTimeout(600000);

const ROUNDS = Number(process.env.WDS_STRESS_ROUNDS || 16);
const PASSPHRASE = 'purple elephants marching slowly stress';

// A seeded generator, so that a failing run can be repeated.
function rng(seed) { let x = (seed >>> 0) || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

function appUrl(stack) {
  const dir = join(stack.tmp, 'pages');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'stress.html');
  // As a real app does: connect and unlock at load.
  writeFileSync(file, '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>wds stress</title><script src="file://' + stack.bundleFile + '"></script></head>'
    + '<body><main><h1>Stress test app</h1></main><script>'
    + 'WDSCore.Client.defaultTimeout = 2000;'   // a short request timeout, so that a request that is never answered ends within the test
    + 'window.store = WDS.connect({ scope: ' + JSON.stringify(stack.scope) + ', baseUrl: ' + JSON.stringify(stack.service) + ' });'
    + 'window.__unlocking = true;'
    + 'window.unlockP = store.unlock().then(function () { window.__unlocking = false; return "unlocked"; }, function (e) { window.__unlocking = false; return "rejected " + e.code; });'
    + '</script></body></html>');
  return 'file://' + file;
}

// Before the page's scripts: a watcher that records, every 25 ms, the most library dialogs at once, how long a locked page that waits for its unlock has
// shown no dialog, how long a dialog has been "loading", and the longest gap between two ticks (a main thread that was blocked). The page is
// reloaded often, so the numbers are collected before every reload (harvest) and kept as maxima.
const INIT = '(' + function () {
  window.__dlg = { dupMax: 0, noDialogSince: 0, noDialogMax: 0, loadingSince: 0, loadingMax: 0, gapMax: 0, last: Date.now() };
  setInterval(function () {
    const L = window.__dlg, now = Date.now();
    L.gapMax = Math.max(L.gapMax, now - L.last); L.last = now;
    const dialogs = document.querySelectorAll('dialog.wds-dialog');
    let loading = false;
    dialogs.forEach(function (d) { if (d.getAttribute('data-wds-view') === 'loading') loading = true; });
    L.dupMax = Math.max(L.dupMax, dialogs.length);
    const locked = window.__unlocking === true && !(window.store && window.store.status().unlocked);
    if (locked && !dialogs.length) { if (!L.noDialogSince) L.noDialogSince = now; L.noDialogMax = Math.max(L.noDialogMax, now - L.noDialogSince); } else L.noDialogSince = 0;
    if (loading) { if (!L.loadingSince) L.loadingSince = now; L.loadingMax = Math.max(L.loadingMax, now - L.loadingSince); } else L.loadingSince = 0;
  }, 25);
} + ')()';

const KEYS = ['dupMax', 'noDialogMax', 'loadingMax', 'gapMax'];
async function harvest(page, agg) {
  const w = await page.evaluate(() => window.__dlg).catch(() => null);
  if (w) for (const k of KEYS) agg[k] = Math.max(agg[k], w[k]);
}
const fresh = () => ({ dupMax: 0, noDialogMax: 0, loadingMax: 0, gapMax: 0 });

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: 'en-US' });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e) + (page.errors.length < 2 ? ' ' + String(e.stack).split('\n').slice(0, 4).join(' | ') : '')));
  return page;
}

const dump = (page) => page.evaluate(() => Array.from(document.querySelectorAll('dialog')).map((d) => ({ cls: d.className, view: d.getAttribute('data-wds-view'), busy: d.getAttribute('aria-busy'), open: d.open, text: d.innerText.replace(/\s+/g, ' ').slice(0, 160) }))).catch((e) => String(e));

test('reload and unlock with a slow, failing and stalling network: a dialog always has a view, never waits for ever, and a failed load shows the error view with a retry', async ({ browser, stack }) => {
  const seed = Number(process.env.WDS_STRESS_SEED || (Date.now() % 100000));
  const rand = rng(seed);
  console.log('dialog stress: seed ' + seed + ', ' + ROUNDS + ' rounds (WDS_STRESS_SEED=' + seed + ' repeats the faults)');
  const page = await newPage(browser);
  await page.goto(appUrl(stack));
  const made = await createVault(page, { passphrase: PASSPHRASE, joinCode: stack.joinCode });
  expect(await page.evaluate(() => window.unlockP)).toBe('unlocked');

  // One mode per round, so that every kind of fault is hit: slow answers, failed and 500 answers, requests that are never answered.
  let mode = 'clean';
  let injected = 0;
  await page.route('**/datastore/api/**', async (route) => {
    const r = rand();
    if (mode === 'clean') return route.continue().catch(() => {});
    if (mode === 'jitter') { await new Promise((res) => setTimeout(res, Math.floor(rand() * 1500))); return route.continue().catch(() => {}); }
    if (mode === 'stall' && r < 0.6) { injected++; return; }                // never answered: the library's own timeout ends the wait
    if (r < 0.35) { injected++; return route.abort('failed').catch(() => {}); }
    if (r < 0.5) { injected++; return route.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"internal"}' }).catch(() => {}); }
    await new Promise((res) => setTimeout(res, Math.floor(rand() * 600)));
    return route.continue().catch(() => {});
  });

  const modes = ['jitter', 'flaky', 'stall', 'clean'];
  const stats = { retries: 0, errorViews: 0, midReload: 0, formErrors: 0 };
  const agg = fresh();
  for (let i = 0; i < ROUNDS; i++) {
    mode = modes[i % modes.length];
    const started = mode;
    // reload; sometimes again while the first load's requests are in flight
    await harvest(page, agg);
    await page.reload();
    if (rand() < 0.3) { await page.waitForTimeout(Math.floor(rand() * 400)); stats.midReload++; await harvest(page, agg); await page.reload(); }
    const t0 = Date.now();
    let done = false;
    while (!done) {
      if (Date.now() - t0 > 90000) throw new Error('round ' + i + ' (' + started + '): the page is not unlocked after 90 s; dialogs: ' + JSON.stringify(await dump(page)));
      if (mode === 'stall' && Date.now() - t0 > 7000) mode = 'clean';   // the network is back: a retry works
      const v = await viewOf(page);
      if (v === 'error') {
        stats.errorViews++;
        await page.locator('[data-wds-view="error"] [data-wds="retry"]').click({ timeout: 5000 });
        stats.retries++;
      } else if (v === 'unlock') {
        try { await unlock(page, { accessId: made.accessId, passphrase: PASSPHRASE, timeout: 40000 }); done = true; }
        catch (e) {
          if (!(e instanceof DriveError) || !/unlocking failed/.test(e.message)) throw new Error('round ' + i + ' (' + started + '): ' + e.message);
          stats.formErrors++;   // the network failed during the unlock: the form shows the error, the person submits again
          if (mode !== 'clean' && rand() < 0.5) mode = 'clean';
        }
      } else if (v === null && (await page.evaluate(() => window.unlockP)) === 'unlocked' && !(await page.locator('[data-wds-view]').count())) done = true;
      else await page.waitForTimeout(100);
    }
    await harvest(page, agg);
    expect(agg.dupMax, 'round ' + i + ' (' + started + '): ' + agg.dupMax + ' library dialogs at once').toBeLessThanOrEqual(1);
    expect(agg.noDialogMax, 'round ' + i + ' (' + started + '): the page was locked and waiting for its unlock, and showed no dialog for ' + agg.noDialogMax + ' ms').toBeLessThan(3000);
    expect(agg.loadingMax, 'round ' + i + ' (' + started + '): a library dialog was "loading" for ' + agg.loadingMax + ' ms').toBeLessThan(12000);
    expect(agg.gapMax, 'round ' + i + ' (' + started + '): the main thread of the page was blocked for ' + agg.gapMax + ' ms').toBeLessThan(15000);
    expect(await page.evaluate(() => window.store.status().unlocked), 'round ' + i).toBe(true);
  }
  console.log('dialog stress: ' + JSON.stringify(stats) + ', requests disturbed ' + injected + ', watcher maxima ' + JSON.stringify(agg));
  expect(page.errors).toEqual([]);
});

test('reload, then the drive unlock() at once, as a test of an app does it: always unlocked, the page never hangs', async ({ browser, stack }) => {
  const page = await newPage(browser);
  await page.goto(appUrl(stack));
  const made = await createVault(page, { passphrase: PASSPHRASE, joinCode: stack.joinCode });
  const agg = fresh();
  for (let i = 0; i < Math.max(6, Math.round(ROUNDS / 2)); i++) {
    await harvest(page, agg);
    await page.reload();
    const t0 = Date.now();
    await unlock(page, { accessId: made.accessId, passphrase: PASSPHRASE });   // no polling of our own: the helper has to cope with whatever the dialog does
    expect(Date.now() - t0, 'unlock ' + i + ' took ' + (Date.now() - t0) + ' ms').toBeLessThan(25000);
    expect(await page.evaluate(() => window.unlockP), 'round ' + i).toBe('unlocked');
    expect(await page.evaluate(() => window.store.status().unlocked), 'round ' + i).toBe(true);
  }
  await harvest(page, agg);
  expect(agg.dupMax).toBeLessThanOrEqual(1);
  expect(agg.noDialogMax).toBeLessThan(3000);
  expect(page.errors).toEqual([]);
});

test('a view that cannot be built ends in the error view with a retry, not in a dialog that loads for ever', async ({ browser, stack }) => {
  const page = await newPage(browser);
  // The build of the unlock form throws (a fieldset cannot be created) as long as the flag is set.
  await page.addInitScript(() => {
    const orig = document.createElement.bind(document);
    document.createElement = function (tag) { if (window.__breakFieldset && String(tag).toLowerCase() === 'fieldset') throw new Error('boom: cannot build the form'); return orig.apply(document, arguments); };
    window.__breakFieldset = true;
  });
  await page.goto(appUrl(stack));
  await waitForView(page, 'error', { timeout: 20000 });
  const st = await dialogState(dialog(page));
  expect(st).toEqual({ view: 'error', busy: false, ready: true });
  // a fixed sentence for the person; the exception text is for the console only
  await expect(page.locator('[data-wds-view="error"] [data-wds="form-error"]')).toContainText(/could not be built/i);
  await expect(page.locator('[data-wds-view="error"] [data-wds="form-error"]')).not.toContainText(/boom/);
  // the same failure again after a retry: the error view again, with a retry
  await page.locator('[data-wds-view="error"] [data-wds="retry"]').click();
  await expect(page.locator('[data-wds-view="error"] [data-wds="retry"]')).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => { window.__breakFieldset = false; });
  await page.locator('[data-wds-view="error"] [data-wds="retry"]').click();
  await waitForView(page, 'unlock', { timeout: 20000 });
  expect(await page.evaluate(() => document.querySelectorAll('dialog.wds-dialog').length)).toBe(1);
});
