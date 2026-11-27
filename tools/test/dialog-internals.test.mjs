// tools/lib/dialog-internals.mjs: the dialogs of the library driven from a Playwright page by their stable attributes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpDir } from './helpers.mjs';
import { startMock, MOCK_JOIN_CODE } from '../lib/wds-mock.mjs';
import {
  createVault, redeemInvite, answerMigration, unlock, confirmSheet, DriveError,
  viewOf, waitForView, dialog, dialogState, formError, describeDialog, fillWhenReady, briefError,
} from '../lib/dialog-internals.mjs';

let mock, browser, scope, appUrl;
// The mock's scopes have a join code (only the sandbox is open): the tool types MOCK_JOIN_CODE.
const createVaultOpen = (page, o = {}) => createVault(page, { joinCode: MOCK_JOIN_CODE, ...o });
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
  const { accessId, passphrase, next } = await createVaultOpen(page);
  assert.equal(next, null);   // the dialog is gone: the app asks nothing more
  assert.match(accessId, /^[0-9A-Z-]{20,}$/);
  assert.ok(passphrase.length >= 20);
  await page.evaluate(() => window.p);
  assert.equal(await page.evaluate(() => store.status().unlocked), true);
  assert.equal(await page.evaluate(() => store.status().role), 'owner');
  await page.evaluate(() => store.set('note', { t: 'kept' }));
  // a new page of another browser context knows nothing: the access ID is typed, a wrong passphrase is an error of the dialog
  const other = await open(await browser.newContext());
  await other.evaluate(() => { window.p = store.unlock(); });
  await assert.rejects(unlock(other, { accessId, passphrase: 'not the passphrase of this vault' , timeout: 20000 }), (e) => e instanceof DriveError && /unlocking failed/.test(e.message));
  assert.deepEqual(await unlock(other, { accessId, passphrase }), { next: null });   // the dialog is still open after the failed try: try again with the right one
  await other.evaluate(() => window.p);
  assert.deepEqual(await other.evaluate(() => store.get('note')), { t: 'kept' });
  await context.close();
});

test('confirm: false leaves the access sheet open for confirmSheet(); waitForView times out with the view it saw', { timeout: 120000 }, async () => {
  const page = await open(await browser.newContext());
  await page.evaluate(() => { window.p = store.unlock(); });
  const { accessId, next } = await createVaultOpen(page, { confirm: false });
  assert.equal(next, 'sheet');
  assert.equal(await viewOf(page), 'sheet');
  assert.equal(await confirmSheet(page), accessId);
  await page.evaluate(() => window.p);
  assert.equal(await viewOf(page), null);
  assert.equal(await dialog(page).isVisible(), false);
  await assert.rejects(waitForView(page, 'unlock', { timeout: 300 }), /timed out after 0 s; it shows nothing/);
});

test('a scope with a join code: createVault needs the code as an option; a missing code is a DriveError, a wrong one is the error of the dialog', { timeout: 120000 }, async () => {
  const code = 'K7M2QX9A-secret';
  const created = await mock.createScope('joinscope', { joinCode: code });
  const open2 = async () => {
    const page = (await (await browser.newContext()).newPage());
    await page.goto(appUrl);
    await page.evaluate(([s, base]) => { window.store = WDS.connect({ scope: s, baseUrl: base }); }, [created.scope, mock.service]);
    await page.evaluate(() => { window.p = store.unlock(); });
    return page;
  };
  const page = await open2();
  await assert.rejects(createVault(page), (e) => e instanceof DriveError && /pass \{ joinCode \}/.test(e.message) && !e.message.includes(code));
  const { accessId } = await createVault(page, { joinCode: code });
  assert.match(accessId, /^[0-9A-Z-]{20,}$/);
  await page.evaluate(() => window.p);
  assert.equal(await page.evaluate(() => store.status().unlocked), true);
  const other = await open2();
  await assert.rejects(createVault(other, { joinCode: 'not-the-code', timeout: 20000 }), (e) => e instanceof DriveError && /creating the vault failed/.test(e.message) && !e.message.includes('not-the-code') && !e.message.includes(code));
});

test('fillWhenReady waits for a field that appears late and is disabled for a while, and tries again when the page replaces the field', { timeout: 60000 }, async () => {
  const page = await (await browser.newContext()).newPage();
  await page.setContent('<div id="host"></div>');
  await page.evaluate(() => {
    const host = document.getElementById('host');
    // the field appears after 400 ms, disabled; it is enabled after 900 ms; the whole form is replaced once at 1300 ms (the dialog is rebuilt)
    setTimeout(() => { host.innerHTML = '<input id="a" disabled>'; }, 400);
    setTimeout(() => { document.getElementById('a').disabled = false; }, 900);
    setTimeout(() => { host.innerHTML = '<input id="a">'; }, 1300);
  });
  await fillWhenReady(page.locator('#a'), 'secret-text', { timeout: 10000 });
  await page.waitForTimeout(1500);
  // the field that was replaced after the fill is empty again; a caller that needs the text checks it (the check inside fillWhenReady catches a replacement before it returns)
  assert.ok(['secret-text', ''].includes(await page.inputValue('#a')));
  // a field that never becomes editable is an error that says so, within the time given
  await page.setContent('<input id="b" disabled>');
  const t0 = Date.now();
  await assert.rejects(fillWhenReady(page.locator('#b'), 'x', { timeout: 1500, attempts: 2 }), /not editable|Timeout/);
  assert.ok(Date.now() - t0 < 8000);
  // a field that formats what is typed: 'nonempty' accepts it, 'exact' does not
  await page.setContent('<input id="c" oninput="this.value = this.value.toUpperCase()">');
  await fillWhenReady(page.locator('#c'), 'abc', { check: 'nonempty' });
  assert.equal(await page.inputValue('#c'), 'ABC');
  await assert.rejects(fillWhenReady(page.locator('#c'), 'abc', { timeout: 1500, attempts: 2 }), /does not hold the text/);
  // briefError: up to 8 lines and 800 characters, no colour codes
  const long = new Error(['locator.fill: Timeout 5000ms exceeded.', 'Call log:', ...Array.from({ length: 20 }, (_, i) => '  - step ' + i + ' \x1b[2mdim\x1b[22m')].join('\n'));
  const brief = briefError(long);
  assert.equal(brief.split('\n').length, 8);
  assert.ok(!brief.includes('\x1b') && brief.includes('Call log:') && brief.includes('step 5'));
  assert.ok(briefError(new Error('x'.repeat(2000))).length <= 800);
});

test('readiness: a dialog without a view, or with aria-busy, is "not ready"; viewOf tells it from "no dialog"', { timeout: 60000 }, async () => {
  const page = await (await browser.newContext()).newPage();
  await page.setContent('<div id="d" data-wds-view="" style="width:100px;height:40px">x</div>');
  assert.equal(await viewOf(page), '');
  assert.deepEqual(await dialogState(dialog(page)), { view: '', busy: false, ready: false });
  await page.evaluate(() => { document.getElementById('d').setAttribute('data-wds-view', 'unlock'); document.getElementById('d').setAttribute('aria-busy', 'true'); });
  assert.deepEqual(await dialogState(dialog(page)), { view: 'unlock', busy: true, ready: false });
  assert.equal(await viewOf(page), 'unlock');
  await page.evaluate(() => { document.getElementById('d').removeAttribute('aria-busy'); });
  assert.deepEqual(await dialogState(dialog(page)), { view: 'unlock', busy: false, ready: true });
  await page.evaluate(() => { document.getElementById('d').remove(); });
  assert.equal(await viewOf(page), null);
  assert.equal(await dialogState(dialog(page)), null);
  // waitForView waits through the "not ready" state
  await page.setContent('<div id="d" data-wds-view="" style="width:100px;height:40px">x</div>');
  await page.evaluate(() => setTimeout(() => document.getElementById('d').setAttribute('data-wds-view', 'create'), 400));
  assert.equal(await waitForView(page, 'create', { timeout: 5000 }), 'create');
});

// A stand-in for the unlock dialog: the submit button runs "onsubmit" (a script) in the page.
const UNLOCK_HTML = (onsubmit) => '<div id="d" data-wds-view="unlock" style="width:200px;height:100px"><input data-wds="access-id-input" value="ABC"><input data-wds="passphrase" type="password"><div data-wds="form-error"></div><button data-wds="unlock-submit" onclick="' + onsubmit + '">go</button></div>';

test('a page that is busy (Argon2id blocks the main thread) is "not known", never "no dialog": viewOf says "" and unlock() waits for the answer', { timeout: 60000 }, async () => {
  const page = await (await browser.newContext()).newPage();
  // wrong passphrase: the page is blocked for 3 s, then shows the error; the old reading of "no answer" as "no dialog" reported success
  await page.setContent(UNLOCK_HTML("setTimeout(function () { var t = Date.now(); while (Date.now() - t < 3000); document.querySelector('[data-wds=form-error]').textContent = 'Wrong passphrase.'; }, 50)"));
  await assert.rejects(unlock(page, { accessId: 'ABC', passphrase: 'x', timeout: 20000 }), /unlocking failed: Wrong passphrase/);
  // the dialog goes away after the block: success, not an error
  await page.setContent(UNLOCK_HTML("setTimeout(function () { var t = Date.now(); while (Date.now() - t < 3000); document.getElementById('d').remove(); }, 50)"));
  await unlock(page, { accessId: 'ABC', passphrase: 'x', timeout: 20000 });
  // during a block of the page, describeDialog says "unresponsive" and viewOf says "not ready" ('')
  await page.setContent(UNLOCK_HTML(''));
  await page.evaluate(() => { setTimeout(() => { const t = Date.now(); while (Date.now() - t < 3500); }, 50); });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(await describeDialog(page, { timeout: 500 }), { unresponsive: true });
  assert.equal(await viewOf(page), '');
  assert.equal(await viewOf(page), 'unlock');
});

test('formError of a dialog that closed a moment ago returns "" at once (a locator that matches nothing must not wait 30 s)', { timeout: 60000 }, async () => {
  const page = await (await browser.newContext()).newPage();
  await page.setContent(UNLOCK_HTML(''));
  const d = dialog(page);
  assert.equal(await formError(d), '');
  await page.evaluate(() => document.getElementById('d').remove());
  const t0 = Date.now();
  assert.equal(await formError(d), '');
  assert.ok(Date.now() - t0 < 4000, 'took ' + (Date.now() - t0) + ' ms');
  // a dialog that closes right after the submit: unlock() returns at once
  await page.setContent(UNLOCK_HTML("document.getElementById('d').remove()"));
  const t1 = Date.now();
  await unlock(page, { accessId: 'ABC', passphrase: 'x', timeout: 20000 });
  assert.ok(Date.now() - t1 < 5000, 'took ' + (Date.now() - t1) + ' ms');
});

test('redeemInvite: an invite code of the owner opens a vault for a member in another browser; a wrong code is a DriveError', { timeout: 180000 }, async () => {
  const owner = await open(await browser.newContext());
  await owner.evaluate(() => { window.p = store.unlock(); });
  await createVaultOpen(owner);
  await owner.evaluate(() => window.p);
  await owner.evaluate(() => { window.sp = store.openVault(); });
  await waitForView(owner, 'share');
  await owner.locator('[data-wds="invite-create"]').click();
  await owner.locator('[data-wds="invite-code"]').waitFor({ timeout: 20000 });
  const code = ((await owner.locator('[data-wds="invite-code"]').innerText()) || '').trim();
  assert.ok(code.length >= 12, code);
  await owner.locator('[data-wds="close"]').first().click();
  await owner.evaluate(() => store.set('shared-note', { t: 'for the member' }));
  const member = await open(await browser.newContext());
  await member.evaluate(() => { window.p = store.unlock(); });
  await assert.rejects(redeemInvite(member, { code: 'AAAA-BBBB-CCCC-DDDD-EEEE', timeout: 20000 }), (e) => e instanceof DriveError && /redeeming the invite failed/.test(e.message));
  const { accessId, passphrase } = await redeemInvite(member, { code });
  assert.ok(accessId && passphrase.length >= 20);
  await member.evaluate(() => window.p);
  assert.equal(await member.evaluate(() => store.status().unlocked), true);
  assert.deepEqual(await member.evaluate(() => store.get('shared-note')), { t: 'for the member' });
});

test('confirmSheet: a sheet that cannot be confirmed is a DriveError with the text of the dialog, not a timeout of the disabled button', { timeout: 120000 }, async () => {
  const page = await open(await browser.newContext());
  await page.evaluate(() => { window.p = store.unlock(); });
  await createVaultOpen(page, { confirm: false });
  // the app (or a bug) makes the checkbox impossible to tick
  await page.evaluate(() => { const c = document.querySelector('[data-wds="sheet-confirm"]'); c.disabled = true; });
  await assert.rejects(confirmSheet(page), (e) => e instanceof DriveError && /the access sheet could not be confirmed/.test(e.message) && /the dialog says/.test(e.message));
});

// An app that calls migrateLocal after the unlock: unlock() and createVaultOpen() end on the question (next: 'migrate') instead of waiting for a dialog that is gone.
const startMigration = (page, n) => page.evaluate((n) => { localStorage.setItem('old.key', '{"a":1}'); window.p = store.unlock().then(() => store.migrateLocal({ id: 'drive', localStorage: ['old.key'], map: () => ({ name: 'moved-' + n, value: { t: n } }) })); }, n);
test('createVault and unlock resolve with next "migrate" when the app calls migrateLocal after the unlock; answerMigration then answers the question', { timeout: 180000 }, async () => {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await open(context);
  await startMigration(page, 1);
  const made = await createVaultOpen(page);
  assert.equal(made.next, 'migrate');
  assert.equal((await answerMigration(page)).backup !== null, true);
  assert.deepEqual(await page.evaluate(() => window.p), { status: 'migrated' });
  assert.deepEqual(await page.evaluate(() => store.get('moved-1')), { t: 1 });
  const other = await open(await browser.newContext({ acceptDownloads: true }));
  await startMigration(other, 2);
  assert.deepEqual(await unlock(other, { accessId: made.accessId, passphrase: made.passphrase }), { next: 'migrate' });
  await answerMigration(other, { backup: false });
  assert.equal((await other.evaluate(() => window.p)).status, 'migrated');
  await context.close();
});

test('answerMigration: the backup is downloaded, "Take over" pressed; the failure dialog is a DriveError', { timeout: 60000 }, async () => {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(appUrl);
  await page.evaluate(() => {
    const dl = (name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['x'])); a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
    const dialog = (view, html) => { const d = document.createElement('div'); d.className = 'wds-root'; d.setAttribute('data-wds-view', view); d.innerHTML = html; document.body.appendChild(d); return d; };
    window.log = [];
    const q = dialog('migrate', '<button data-wds="migrate-backup">b</button><button data-wds="migrate-yes">y</button>');
    q.querySelector('[data-wds=migrate-backup]').onclick = () => { window.log.push('backup'); dl('old-data.zip'); };
    q.querySelector('[data-wds=migrate-yes]').onclick = () => { window.log.push('yes'); q.remove(); };
  });
  const files = [];
  assert.deepEqual(await answerMigration(page, { downloads: files }), { backup: 'old-data.zip' });
  assert.deepEqual(files, ['old-data.zip']);
  assert.deepEqual(await page.evaluate(() => window.log), ['backup', 'yes']);
  // without the backup
  await page.evaluate(() => {
    const d = document.createElement('div'); d.className = 'wds-root'; d.setAttribute('data-wds-view', 'migrate');
    d.innerHTML = '<button data-wds="migrate-backup">b</button><button data-wds="migrate-yes">y</button>'; document.body.appendChild(d);
    d.querySelector('[data-wds=migrate-yes]').onclick = () => { window.log.push('yes2'); d.remove(); };
  });
  assert.deepEqual(await answerMigration(page, { backup: false }), { backup: null });
  assert.equal((await page.evaluate(() => window.log)).slice(-1)[0], 'yes2');
  // the library's failure dialog
  await page.evaluate(() => { const d = document.createElement('div'); d.className = 'wds-root'; d.setAttribute('data-wds-view', 'migrate-failed'); d.textContent = 'Taking over the old data failed.'; document.body.appendChild(d); });
  await assert.rejects(answerMigration(page, { backup: false, timeout: 5000 }), (e) => e instanceof DriveError && /the migration failed: Taking over the old data failed/.test(e.message));
  await context.close();
});
