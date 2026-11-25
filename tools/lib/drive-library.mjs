// Drive the dialogs of the WIAI Datastore library from a Playwright page, by their stable attributes (client/README.md, "Stable
// attributes": data-wds-view on the dialog, data-wds on every control). The attributes do not change with the language, so the same
// script works in every locale. wds-verify uses these functions; so can the Playwright tests of your own app, imported from a clone:
//
//   import { createVault, unlock, confirmSheet } from '<clone>/tools/lib/drive-library.mjs';
//   await page.goto(pathToFileURL('app.html').href);
//   const { accessId, passphrase } = await createVault(page);    // the app calls store.unlock(); this answers the dialogs
//   await page.reload();
//   await unlock(page, { accessId, passphrase });
//
// Every function that takes `page` finds the dialog itself (the last element with data-wds-view). The functions that take `d` (a
// Playwright locator of one dialog) are the single steps the high-level ones are made of; wds-verify calls them one by one because
// it also has to react to other dialogs in between. Failures throw DriveError with the text the library showed.
import { randomBytes } from 'node:crypto';

export class DriveError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = (d, name) => d.locator('[data-wds="' + name + '"]');

// The topmost dialog of the library (a locator; it may not be visible).
export function dialog(page) { return page.locator('[data-wds-view]').last(); }

// data-wds-view of the dialog that is on screen: 'loading', 'error', 'unlock', 'create', 'redeem', 'sheet', 'conflict', 'history',
// 'share', 'revoke', 'progress' or 'notice'; null when no dialog is visible.
export async function viewOf(page) {
  const d = dialog(page);
  if (!(await d.isVisible().catch(() => false))) return null;
  return (await d.getAttribute('data-wds-view', { timeout: 2000 }).catch(() => null)) || null;
}

// Wait until the dialog shows one of the views (a name or a list of names); resolves the view. views = null waits for no dialog at all.
export async function waitForView(page, views, { timeout = 30000 } = {}) {
  const want = views === null ? [null] : [].concat(views);
  const t0 = Date.now();
  let seen;
  for (;;) {
    seen = await viewOf(page);
    if (want.includes(seen)) return seen;
    if (Date.now() - t0 > timeout) throw new DriveError('waiting for the library dialog ' + (views === null ? 'to close' : 'view ' + want.join(' or ')) + ' timed out after ' + Math.round(timeout / 1000) + ' s; it shows ' + (seen ? 'view "' + seen + '"' : 'nothing'));
    await sleep(100);
  }
}

// The error the dialog shows (the text of form-error, or a note that a field was marked invalid); '' when there is none.
export async function formError(d) {
  const text = ((await ctl(d, 'form-error').first().innerText().catch(() => '')) || '').trim();
  if (text) return text;
  return (await d.locator('[aria-invalid="true"]').count().catch(() => 0)) ? 'a field was marked invalid' : '';
}

// ---- single steps (d: the dialog locator) ----
// "Create a new vault" in the unlock dialog.
export async function chooseCreate(d) { await ctl(d, 'to-create').click({ timeout: 5000 }); }
// Fill the create form and press the button. A scope with the enrollment "join code" shows a join-code field: the code comes from the
// option joinCode or, by default, from the environment variable WDS_JOIN_CODE (the one place for it: set in the shell that runs the test,
// never written into a file; it is never printed, and no error message contains it). Without a code the call throws a DriveError.
export async function submitCreate(d, { passphrase, joinCode } = {}) {
  if (await ctl(d, 'join-code').first().isVisible().catch(() => false)) {
    const code = joinCode !== undefined ? joinCode : process.env.WDS_JOIN_CODE;
    if (!code) throw new DriveError('this scope asks for a join code; set the environment variable WDS_JOIN_CODE in the shell that runs the test (ask the person for the code; never write it into a file)');
    await ctl(d, 'join-code').fill(code, { timeout: 5000 });
  }
  await ctl(d, 'passphrase').fill(passphrase, { timeout: 5000 });
  await ctl(d, 'passphrase-repeat').fill(passphrase, { timeout: 5000 });
  await ctl(d, 'create-submit').click({ timeout: 5000 });
}
// Fill the unlock form and press the button. The access ID is filled only when it is given and the field is empty (the library
// remembers the access ID of the last vault on this device).
export async function submitUnlock(d, { accessId, passphrase }) {
  const id = ctl(d, 'access-id-input');
  if (accessId && !(await id.inputValue().catch(() => '')).trim()) await id.fill(accessId, { timeout: 5000 }).catch(() => {});
  await ctl(d, 'passphrase').fill(passphrase, { timeout: 5000 });
  await ctl(d, 'unlock-submit').click({ timeout: 5000 });
}

// The access sheet after creating a vault: read the access ID, tick "I have saved it", continue. Resolves the access ID shown.
export async function confirmSheet(page, { timeout = 10000 } = {}) {
  const d = dialog(page);
  const accessId = ((await ctl(d, 'access-id').first().innerText().catch(() => '')) || '').trim();
  try {
    await ctl(d, 'sheet-confirm').check({ timeout: 5000 });
    await ctl(d, 'sheet-continue').click({ timeout: 5000 });
  } catch (e) {
    const said = (await formError(d)) || ((await d.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new DriveError('the access sheet could not be confirmed: ' + String(e.message).split('\n')[0] + (said ? '; the dialog says: "' + said + '"' : ''));
  }
  await d.waitFor({ state: 'hidden', timeout }).catch(() => {});
  return accessId;
}

// ---- whole flows ----
// A passphrase that passes the library's rules.
export function newPassphrase() { return 'wdsv-' + randomBytes(5).toString('hex') + '-' + randomBytes(5).toString('hex') + '-' + randomBytes(5).toString('hex'); }

// The app has called store.unlock() and its dialog is open: create a vault (unlock dialog -> create -> access sheet -> confirmed).
// Resolves { accessId, passphrase }. Do not await store.unlock() before this call: it resolves only after the dialogs are answered.
// opts: passphrase (default: a generated one), joinCode (for a scope that needs one; default: the environment variable WDS_JOIN_CODE), confirm (default true; false leaves the access
// sheet open for confirmSheet(page)), timeout (ms per step).
export async function createVault(page, { passphrase = newPassphrase(), joinCode, confirm = true, timeout = 60000 } = {}) {
  let view = await waitForView(page, ['unlock', 'create'], { timeout });
  if (view === 'unlock') { await chooseCreate(dialog(page)); }
  await waitForView(page, 'create', { timeout });
  const d = dialog(page);
  await submitCreate(d, { passphrase, joinCode });
  const t0 = Date.now();
  for (;;) {
    view = await viewOf(page);
    if (view === 'sheet') break;
    const err = await formError(d);
    if (err) throw new DriveError('creating the vault failed: ' + err);
    if (view === null) throw new DriveError('creating the vault failed: the dialog closed without an access sheet');
    if (Date.now() - t0 > timeout) throw new DriveError('creating the vault timed out after ' + Math.round(timeout / 1000) + ' s');
    await sleep(150);
  }
  const accessId = confirm ? await confirmSheet(page) : ((await ctl(dialog(page), 'access-id').first().innerText().catch(() => '')) || '').trim();
  return { accessId, passphrase };
}

// The app has called store.unlock() and the unlock dialog is open: unlock an existing vault. Resolves when the dialog is gone;
// throws DriveError with the dialog's error (wrong passphrase, ...). opts: accessId (needed unless the library remembers it), passphrase.
export async function unlock(page, { accessId, passphrase, timeout = 30000 }) {
  await waitForView(page, 'unlock', { timeout });
  const d = dialog(page);
  await submitUnlock(d, { accessId, passphrase });
  const t0 = Date.now();
  for (;;) {
    const view = await viewOf(page);
    if (view === null) return;
    if (view === 'notice' || view === 'sheet') return;   // the library has more to say (a notice, a new access sheet): the caller answers it
    const err = await formError(d);
    if (err) throw new DriveError('unlocking failed: ' + err);
    if (Date.now() - t0 > timeout) throw new DriveError('unlocking timed out after ' + Math.round(timeout / 1000) + ' s; the dialog shows view "' + view + '"');
    await sleep(150);
  }
}
