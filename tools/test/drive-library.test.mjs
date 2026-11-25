// tools/lib/drive-library.mjs: the dialogs of the library driven from a Playwright page by their stable attributes, as a developer's own test would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpDir } from './helpers.mjs';
import { startMock } from '../lib/wds-mock.mjs';
import { createVault, unlock, confirmSheet, viewOf, waitForView, dialog, DriveError } from '../lib/drive-library.mjs';

let mock, browser, scope, appUrl;
before(async () => {
  const pw = (await import('playwright')).default;
  mock = await startMock({ bundle: true });
  scope = 'drive-demo-k7m2a9';
  mock.createScopeWithId(scope);
  const dir = tmpDir('wds-drive-');
  const file = join(dir, 'app.html');
  writeFileSync(file, '<!doctype html><html><head><meta charset="utf-8"><script src="' + pathToFileURL(mock.bundle.file).href + '"></script></head><body><p id="out"></p></body></html>');
  appUrl = pathToFileURL(file).href;
  browser = await pw.chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (mock) await mock.stop(); });

const open = async (context) => {
  const page = await context.newPage();
  await page.goto(appUrl);
  await page.evaluate(([s, base]) => { window.store = WDS.connect({ scope: s, baseUrl: base }); }, [scope, mock.service]);
  return page;
};

test('createVault, unlock and confirmSheet drive the library dialogs', { timeout: 120000 }, async () => {
  const context = await browser.newContext({ locale: 'de-DE' });   // the attributes do not depend on the language
  const page = await open(context);
  assert.equal(await viewOf(page), null);
  await page.evaluate(() => { window.p = store.unlock(); });
  const { accessId, passphrase } = await createVault(page);
  assert.match(accessId, /^[0-9A-Z-]{20,}$/);
  assert.ok(passphrase.length >= 20);
  await page.evaluate(() => window.p);
  assert.equal(await page.evaluate(() => store.status().unlocked), true);
  assert.equal(await page.evaluate(() => store.status().accessId.replace(/-/g, '')), accessId.replace(/-/g, ''));
  await page.evaluate(() => store.set('note', { t: 'kept' }));
  // a new page of another browser context knows nothing: the access ID is typed, a wrong passphrase is an error of the dialog
  const other = await open(await browser.newContext());
  await other.evaluate(() => { window.p = store.unlock(); });
  await assert.rejects(unlock(other, { accessId, passphrase: 'not the passphrase of this vault' , timeout: 20000 }), (e) => e instanceof DriveError && /unlocking failed/.test(e.message));
  await unlock(other, { accessId, passphrase }).catch(() => {});   // the dialog is still open after the failed try: try again with the right one
  await other.evaluate(() => window.p);
  assert.deepEqual(await other.evaluate(() => store.get('note')), { t: 'kept' });
  await context.close();
});

test('confirm: false leaves the access sheet open for confirmSheet(); waitForView times out with the view it saw', { timeout: 120000 }, async () => {
  const page = await open(await browser.newContext());
  await page.evaluate(() => { window.p = store.unlock(); });
  const { accessId } = await createVault(page, { confirm: false });
  assert.equal(await viewOf(page), 'sheet');
  assert.equal(await confirmSheet(page), accessId);
  await page.evaluate(() => window.p);
  assert.equal(await viewOf(page), null);
  assert.equal(await dialog(page).isVisible(), false);
  await assert.rejects(waitForView(page, 'unlock', { timeout: 300 }), /timed out after 0 s; it shows nothing/);
});

test('a scope with a join code: the code comes from WDS_JOIN_CODE, a missing one is a DriveError that names the variable and never the code; nothing prints it', { timeout: 120000 }, async () => {
  const code = 'K7M2QX9A-secret';
  const created = await mock.createScope('joinscope', { enrollment: 'join_code', joinCode: code });
  const open2 = async () => {
    const page = (await (await browser.newContext()).newPage());
    await page.goto(appUrl);
    await page.evaluate(([s, base]) => { window.store = WDS.connect({ scope: s, baseUrl: base }); }, [created.scope, mock.service]);
    await page.evaluate(() => { window.p = store.unlock(); });
    return page;
  };
  const saved = process.env.WDS_JOIN_CODE;
  try {
    delete process.env.WDS_JOIN_CODE;
    const page = await open2();
    await assert.rejects(createVault(page), (e) => e instanceof DriveError && /WDS_JOIN_CODE/.test(e.message) && !e.message.includes(code));
    // the create dialog is still open: the code of the environment is used
    process.env.WDS_JOIN_CODE = code;
    const { accessId } = await createVault(page);
    assert.match(accessId, /^[0-9A-Z-]{20,}$/);
    await page.evaluate(() => window.p);
    assert.equal(await page.evaluate(() => store.status().unlocked), true);
    // a wrong code is the error of the dialog
    process.env.WDS_JOIN_CODE = 'not-the-code';
    const other = await open2();
    await assert.rejects(createVault(other, { timeout: 20000 }), (e) => e instanceof DriveError && /creating the vault failed/.test(e.message) && !e.message.includes('not-the-code'));
  } finally { if (saved === undefined) delete process.env.WDS_JOIN_CODE; else process.env.WDS_JOIN_CODE = saved; }
});

test('confirmSheet: a sheet that cannot be confirmed is a DriveError with the text of the dialog, not a timeout of the disabled button', { timeout: 120000 }, async () => {
  const page = await open(await browser.newContext());
  await page.evaluate(() => { window.p = store.unlock(); });
  await createVault(page, { confirm: false });
  // the app (or a bug) makes the checkbox impossible to tick
  await page.evaluate(() => { const c = document.querySelector('[data-wds="sheet-confirm"]'); c.disabled = true; });
  await assert.rejects(confirmSheet(page), (e) => e instanceof DriveError && /the access sheet could not be confirmed/.test(e.message) && /the dialog says/.test(e.message));
});
