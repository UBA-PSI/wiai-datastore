// Drive the dialogs of the WIAI Datastore library from a Playwright page, by their stable attributes (data-wds-view on the dialog, data-wds on
// every control; they do not change with the language). wds-verify uses these functions; so can the Playwright tests of your own app, imported
// from a clone: import { createVault, unlock } from '<clone>/tools/lib/drive-library.mjs'. Exports (details: tools/README.md):
//   createVault(page, { passphrase?, joinCode?, confirm?, timeout? })  -> { accessId, passphrase, next }   the unlock dialog is open: create a vault
//   unlock(page, { accessId?, passphrase, timeout? })                  -> { next }                           the unlock dialog is open: unlock the vault
//   redeemInvite(page, { code, passphrase?, confirm?, timeout? })      -> { accessId, passphrase }          join with an invite code
//   confirmSheet(page)                                                 -> the access ID                      the access sheet is open: confirm it
//   answerMigration(page, { backup?, timeout?, downloads? })           -> { backup, large }                  answer the questions of store.migrateLocal
//   deleteVault(page, { accessId, passphrase, scope?, baseUrl?, store? })                                   delete the test vault at the end
//   readJoinCode({ file? })  the join code from the file of the person who owns the scope (never printed);  DriveError  what every function throws
// next: the view the dialog ended on: null when it is gone, else 'notice', 'sheet', 'migrate', 'progress', ... (an app that calls migrateLocal after
// the unlock continues with answerMigration). Do not await store.unlock() before the call: it settles only after the dialogs are answered.
import {
  DriveError, readJoinCode, dialog, viewOf, waitForView, formError, dialogSummary, chooseCreate, submitCreate, submitUnlock, submitRedeem, newPassphrase, ctl, sleep, since,
} from './dialog-internals.mjs';

export { DriveError, readJoinCode };

// The views a submit has not left yet: any other view (or none: the dialog is gone) is where the dialog ended up.
const NOT_DONE = ['unlock', 'loading', '', 'error'];
// After the submit: the view the dialog moved on to (null: it is gone). A look that finds no dialog is repeated once after a moment: a dialog
// that opens right after this one (the question of migrateLocal) must not be missed. Throws DriveError with the dialog's error text.
async function waitForNext(page, d, what, timeout) {
  const t0 = Date.now();
  for (;;) {
    const view = await viewOf(page);   // null only when the page answered and has no dialog; '' while the page is busy (Argon2id) or reloading
    if (!NOT_DONE.includes(view)) {
      if (view !== null) return view;
      await sleep(400);
      return viewOf(page);
    }
    const err = view === '' ? '' : await formError(d);
    if (err) {
      const now = await viewOf(page);   // the error was read from a dialog that may have moved on
      if (!NOT_DONE.includes(now)) return now;
      throw new DriveError(what + ' failed: ' + err);
    }
    if (Date.now() - t0 > timeout) {
      const last = await viewOf(page);
      if (!NOT_DONE.includes(last)) return last;
      throw new DriveError(what + ' timed out after ' + since(t0) + ' s; the dialog shows ' + (last ? 'view "' + last + '"' : 'no view (or the page did not answer)') + '; ' + await dialogSummary(page));
    }
    await sleep(150);
  }
}

// The access sheet after creating a vault: read the access ID, tick "I have saved it", continue. Resolves the access ID shown.
export async function confirmSheet(page, { timeout = 10000 } = {}) {
  const d = dialog(page);
  const accessId = ((await ctl(d, 'access-id').first().innerText({ timeout: 3000 }).catch(() => '')) || '').trim();
  try {
    await ctl(d, 'sheet-confirm').check({ timeout: 5000 });
    await ctl(d, 'sheet-continue').click({ timeout: 5000 });
  } catch (e) {
    const said = (await formError(d)) || ((await d.innerText({ timeout: 2000 }).catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new DriveError('the access sheet could not be confirmed: ' + String(e.message).split('\n')[0] + (said ? '; the dialog says: "' + said + '"' : ''));
  }
  await d.waitFor({ state: 'hidden', timeout }).catch(() => {});
  return accessId;
}

// The question of store.migrateLocal (view migrate): download the backup (migrate-backup, when "backup" is true), then "Take over" (migrate-yes).
// When some entries are too large for the vault the library shows view migrate-large: the files are downloaded (migrate-large-download, one
// ZIP) and the old data is deleted anyway (migrate-delete). Resolves { backup: <file name> | null, large: <file name> | null,
// skipped?: true when the question listed rows that map leaves out }. downloads: an optional array that receives the file names.
export async function answerMigration(page, { backup = true, timeout = 60000, downloads } = {}) {
  const t0 = Date.now();
  const out = { backup: null, large: null };
  const download = async (button) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), button.click({ timeout: 5000, noWaitAfter: true })]);
    if (downloads) downloads.push(dl.suggestedFilename());
    return dl.suggestedFilename();
  };
  for (;;) {
    const v = await viewOf(page);
    const d = dialog(page);
    if (v === 'migrate') {
      if (backup && !out.backup) out.backup = await download(ctl(d, 'migrate-backup'));
      if (await ctl(d, 'migrate-skip-ack').count()) {   // rows that map leaves out are deleted with the old data: the box (or the backup) confirms it
        out.skipped = true;
        if (!(await ctl(d, 'migrate-yes').isEnabled({ timeout: 3000 }))) await ctl(d, 'migrate-skip-ack').check({ timeout: 5000 });
      }
      await ctl(d, 'migrate-yes').click({ timeout: 5000 });
      await sleep(200);
    } else if (v === 'migrate-large') {
      out.large = await download(ctl(d, 'migrate-large-download'));
      await ctl(d, 'migrate-delete').click({ timeout: 10000 });
      await sleep(200);
    } else if (v === null && (out.backup || out.large || Date.now() - t0 > 2000)) return out;
    if (Date.now() - t0 > timeout) throw new DriveError('answering the migration dialogs timed out after ' + since(t0) + ' s; the dialog shows ' + (v ? 'view "' + v + '"' : 'nothing') + '; ' + await dialogSummary(page));
    await sleep(150);
  }
}

// Wait for the access sheet after a submit; throws DriveError with the dialog's error (form-error) or when it closes without a sheet.
async function waitForSheet(page, d, what, timeout) {
  const t0 = Date.now();
  for (;;) {
    const view = await viewOf(page);   // '' (not ready, or the page did not answer) is never "closed"
    if (view === 'sheet') return;
    const err = view === '' ? '' : await formError(d);
    if (err) {
      if ((await viewOf(page)) === 'sheet') return;   // the error was read from a dialog that has moved on
      throw new DriveError(what + ' failed: ' + err);
    }
    if (view === null) throw new DriveError(what + ' failed: the dialog closed without an access sheet');
    if (Date.now() - t0 > timeout) {
      if ((await viewOf(page)) === 'sheet') return;
      throw new DriveError(what + ' timed out after ' + since(t0) + ' s; ' + await dialogSummary(page));
    }
    await sleep(150);
  }
}
const sheetAccessId = async (page) => ((await ctl(dialog(page), 'access-id').first().innerText({ timeout: 3000 }).catch(() => '')) || '').trim();

// The app has called store.unlock() and its dialog is open: create a vault (unlock dialog -> create -> access sheet -> confirmed).
// opts: passphrase (default: a generated one), joinCode (for a scope that needs one; default: the join code file, see readJoinCode), confirm (default true;
// false leaves the access sheet open for confirmSheet(page) and next is 'sheet'), timeout (ms per step).
export async function createVault(page, { passphrase = newPassphrase(), joinCode, confirm = true, timeout = 60000 } = {}) {
  const view = await waitForView(page, ['unlock', 'create'], { timeout });
  if (view === 'unlock') { await chooseCreate(dialog(page)); }
  await waitForView(page, 'create', { timeout });
  const d = dialog(page);
  await submitCreate(d, { passphrase, joinCode });
  await waitForSheet(page, d, 'creating the vault', timeout);
  if (!confirm) return { accessId: await sheetAccessId(page), passphrase, next: 'sheet' };
  const accessId = await confirmSheet(page);
  return { accessId, passphrase, next: await waitForNext(page, d, 'creating the vault', timeout) };
}

// The app has called store.unlock() and its dialog is open: join a vault with an invite code (unlock dialog -> "I have an invite" -> redeem form
// -> access sheet -> confirmed). opts: code (the invite code, required), passphrase (default: generated; the member's own passphrase), confirm (default true), timeout.
export async function redeemInvite(page, { code, passphrase = newPassphrase(), confirm = true, timeout = 60000 } = {}) {
  if (!code) throw new DriveError('redeemInvite needs the invite code');
  await waitForView(page, ['unlock', 'redeem'], { timeout });
  await submitRedeem(dialog(page), { code, passphrase });
  await waitForSheet(page, dialog(page), 'redeeming the invite', timeout);
  const accessId = confirm ? await confirmSheet(page) : await sheetAccessId(page);
  return { accessId, passphrase };
}

// The app has called store.unlock() and the unlock dialog is open: unlock an existing vault. Resolves { next } when the dialog is gone or has
// moved on; throws DriveError with the dialog's error (wrong passphrase, ...). opts: accessId (needed unless the library remembers it), passphrase.
export async function unlock(page, { accessId, passphrase, timeout = 30000 }) {
  await waitForView(page, 'unlock', { timeout });
  const d = dialog(page);
  await submitUnlock(d, { accessId, passphrase });
  return { next: await waitForNext(page, d, 'unlocking', timeout) };
}

// Delete the vault that the test created (the test vault of a scope: nobody else needs it). The library's store has no call for this, so the helper opens a second client of the page's library
// (WDSCore.Client, a global of the library bundle) with the access ID and the passphrase that createVault returned, and deletes the vault (owner only).
// opts: accessId and passphrase (required), scope (default: store.scope of window[store]), baseUrl (only when the app's WDS.connect names one: a
// local mock, a test service), store (the name of the global that holds the app's store, default "store"). Resolves 'deleted'; throws DriveError otherwise.
// The page must still be the app's page (the library loaded, the CSP of the app allows the datastore API). Run it last: the app's own store is
// useless after it.
export async function deleteVault(page, { accessId, passphrase, scope, baseUrl, store = 'store' } = {}) {
  if (!accessId || !passphrase) throw new DriveError('deleteVault needs the accessId and the passphrase that createVault returned');
  const res = await page.evaluate(async (a) => {
    try {
      const W = window.WDSCore;
      if (!W || !W.Client) return 'the library of the page has no WDSCore.Client';
      const st = window[a.store];
      const sc = a.scope || (st && st.scope) || ((window.__wdsStores || [])[0] || {}).scope;
      if (!sc) return 'no scope: pass { scope }, or expose the store as window.' + a.store;
      const o = { scope: sc };
      if (a.baseUrl) o.service = a.baseUrl;
      const c = new W.Client(o);
      await c.unlock({ accessId: a.accessId, passphrase: a.passphrase });
      await c.deleteVault();
      return 'deleted';
    } catch (e) { return 'failed: ' + String((e && e.message) || e).slice(0, 200); }
  }, { accessId, passphrase, scope: scope || null, baseUrl: baseUrl || null, store });
  if (res !== 'deleted') throw new DriveError('deleting the test vault: ' + res);
  return res;
}
