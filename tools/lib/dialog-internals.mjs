// Driving the library's dialogs from a Playwright page by their stable attributes (data-wds-view on the dialog, data-wds on every control; they do
// not change with the language). One internal module for wds-verify and the repository tests; an app's own end-to-end test selects the dialogs by
// their data-wds attributes (tools/README.md). A dialog is READY when it has a data-wds-view and no aria-busy="true"; the library never leaves a
// dialog without a view ("loading" while it is built, "error" with a retry when it cannot go on). Failures throw DriveError; a timeout says what the
// dialog looked like (dialogSummary).
//   createVault(page, { passphrase?, joinCode?, confirm?, timeout? })  -> { accessId, passphrase, next }   the unlock dialog is open: create a vault
//   unlock(page, { accessId?, passphrase, timeout? })                  -> { next }                           the unlock dialog is open: unlock the vault
//   redeemInvite(page, { code, passphrase?, confirm?, timeout? })      -> { accessId, passphrase }          join with an invite code
//   confirmSheet(page)                                                 -> the access ID                      the access sheet is open: confirm it
//   answerMigration(page, { backup?, timeout?, downloads? })           -> { backup }                         answer the question of store.migrateLocal
// next: the view the dialog ended on: null when it is gone, else 'notice', 'sheet', 'migrate', 'progress', ... (an app that calls migrateLocal after
// the unlock continues with answerMigration). Do not await store.unlock() before the call: it settles only after the dialogs are answered.
import { randomBytes } from 'node:crypto';

export class DriveError extends Error {}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ctl = (d, name) => d.locator('[data-wds="' + name + '"]');

// The topmost dialog of the library (a locator; it may not be visible).
export function dialog(page) { return page.locator('[data-wds-view]').last(); }

// One look at the topmost library dialog, in a single call: { view, busy, visible, classes, text, count }; null when the page has no dialog;
// { unresponsive: true } when the page did not answer within "timeout" ms (Argon2id blocks it for seconds, or it is reloading): that says
// nothing about the dialog, so a caller waits and never takes it for "closed". A closed page throws DriveError.
export async function describeDialog(page, { timeout = 2000 } = {}) {
  if (page.isClosed()) throw new DriveError('the page is closed');
  const read = page.evaluate(() => {
    const all = document.querySelectorAll('[data-wds-view]');
    const el = all[all.length - 1];
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      view: el.getAttribute('data-wds-view') || '', busy: el.getAttribute('aria-busy') === 'true', count: all.length,
      visible: el.getClientRects().length > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
      classes: String(el.className || ''), text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    };
  }).catch(() => ({ unresponsive: true }));   // a navigation destroys the context of the call: unknown, not "no dialog"
  let timer;
  const late = new Promise((r) => { timer = setTimeout(() => r({ unresponsive: true }), timeout); });
  try { return await Promise.race([read, late]); } finally { clearTimeout(timer); }
}

// A line for an error message: what the topmost library dialog looks like (view, busy, classes, text), or that there is none.
export async function dialogSummary(page) {
  const s = await describeDialog(page, { timeout: 3000 });
  if (!s) return 'no library dialog in the page';
  if (s.unresponsive) return 'the page did not answer within 3 s (busy, or being reloaded)';
  return 'the topmost library dialog has ' + (s.view ? 'view "' + s.view + '"' : 'no view') + (s.busy ? ', aria-busy' : '') + (s.visible ? '' : ', is not visible')
    + ', class "' + s.classes + '", text "' + s.text + '"' + (s.count > 1 ? ' (' + s.count + ' dialogs)' : '');
}

// data-wds-view of the dialog on screen; null when no dialog is visible (only null means "closed"); '' when one has no view yet or the page
// did not answer (not known: wait).
export async function viewOf(page) {
  const s = await describeDialog(page);
  if (s && s.unresponsive) return '';
  if (!s || !s.visible) return null;
  return s.view;
}

// The seconds since t0, for a message about a wait that timed out (what really passed, not the limit that was configured).
export const since = (t0) => Math.round((Date.now() - t0) / 1000);

// The state of one dialog (a locator): { view, busy, ready }; null when it is not there (or goes away while it is asked).
export async function dialogState(d) {
  const s = await d.evaluate((el) => ({ view: el.getAttribute('data-wds-view') || '', busy: el.getAttribute('aria-busy') === 'true' }), undefined, { timeout: 2000 }).catch(() => null);
  return s ? { ...s, ready: !!s.view && !s.busy } : null;
}

// A short text for a failure: the Playwright message with its call log (up to 8 lines and 800 characters), without colour codes.
export function briefError(e, lines = 8, chars = 800) {
  const text = String((e && e.message) || e).replace(/\x1b\[[0-9;]*m/g, '');
  const out = text.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(0, lines).join('\n');
  return out.length > chars ? out.slice(0, chars - 3) + '...' : out;
}

// Wait until the dialog shows one of the views (a name or a list of names); resolves the view. views = null waits for no dialog at all.
export async function waitForView(page, views, { timeout = 30000 } = {}) {
  const want = views === null ? [null] : [].concat(views);
  const t0 = Date.now();
  let seen;
  for (;;) {
    seen = await viewOf(page);
    if (want.includes(seen)) return seen;
    if (Date.now() - t0 > timeout) throw new DriveError('waiting for the library dialog ' + (views === null ? 'to close' : 'view ' + want.join(' or ')) + ' timed out after ' + since(t0) + ' s; it shows ' + (seen ? 'view "' + seen + '"' : seen === '' ? 'a dialog that is not ready (no view yet, or the page did not answer)' : 'nothing') + '; ' + await dialogSummary(page));
    await sleep(100);
  }
}

// The error the dialog shows (form-error, or a note that a field was marked invalid); '' when there is none. One call with a 1 s limit: a
// dialog that has just closed must not make it wait for Playwright's own limit.
export async function formError(d) {
  const r = await d.evaluate((el) => {
    const f = el.querySelector('[data-wds="form-error"]');
    return { text: f ? String(f.innerText || f.textContent || '').trim() : '', invalid: el.querySelectorAll('[aria-invalid="true"]').length };
  }, undefined, { timeout: 1000 }).catch(() => null);
  if (!r) return '';
  return r.text || (r.invalid ? 'a field was marked invalid' : '');
}

// ---- filling ----
// Fill a field when it can take the text: wait until it is visible and editable, fill, check what it holds, and try again (3 times, within
// "timeout" ms) when the page replaced the field meanwhile. check: 'exact' (passphrases), 'nonempty' (fields that format the text) or false.
export async function fillWhenReady(locator, text, { timeout = 15000, attempts = 3, check = 'exact' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const left = () => Math.max(500, deadline - Date.now());
      await locator.waitFor({ state: 'visible', timeout: left() });
      for (;;) {
        if (await locator.isEditable({ timeout: 1000 }).catch(() => false)) break;
        if (Date.now() > deadline) throw new Error('the field is not editable after ' + Math.round(timeout / 1000) + ' s');
        await sleep(100);
      }
      await locator.fill(text, { timeout: Math.min(5000, left()) });
      if (check) {
        const held = await locator.inputValue({ timeout: 2000 });
        if (check === 'exact' ? held !== text : !held) throw new Error('the field does not hold the text that was filled in');
      }
      return;
    } catch (e) {
      last = e;
      if (Date.now() > deadline) break;
      await sleep(200 * (i + 1));
    }
  }
  throw last;
}

// ---- single steps (d: the dialog locator) ----
// "Create a new vault" in the unlock dialog.
export async function chooseCreate(d) { await ctl(d, 'to-create').click({ timeout: 5000 }); }
// Fill the create form and press the button. A join-code field is filled from the option joinCode.
export async function submitCreate(d, { passphrase, joinCode } = {}) {
  if (await ctl(d, 'join-code').first().isVisible().catch(() => false)) {
    if (joinCode === undefined) throw new DriveError('this scope asks for a join code: pass { joinCode }');
    await fillWhenReady(ctl(d, 'join-code'), joinCode, { check: 'nonempty' });
  }
  await fillWhenReady(ctl(d, 'passphrase'), passphrase);
  await fillWhenReady(ctl(d, 'passphrase-repeat'), passphrase);
  await ctl(d, 'create-submit').click({ timeout: 5000 });
}
// Fill the unlock form and press the button. The access ID is filled only when it is given and the field is empty (the library
// remembers the access ID of the last vault on this device).
export async function submitUnlock(d, { accessId, passphrase }) {
  const id = ctl(d, 'access-id-input');
  if (accessId) {
    await id.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if (!(await id.inputValue({ timeout: 2000 }).catch(() => '')).trim()) await fillWhenReady(id, accessId, { check: 'nonempty' }).catch(() => {});
  }
  await fillWhenReady(ctl(d, 'passphrase'), passphrase);
  await ctl(d, 'unlock-submit').click({ timeout: 5000 });
}
// "I have an invite" (unlock dialog, button to-redeem) -> fill the redeem form and press the button.
export async function submitRedeem(d, { code, passphrase }) {
  if (!code) throw new DriveError('submitRedeem needs the invite code');
  if (await ctl(d, 'to-redeem').first().isVisible().catch(() => false)) await ctl(d, 'to-redeem').click({ timeout: 5000 });
  await fillWhenReady(ctl(d, 'invite-code-input'), code, { check: 'nonempty' });
  await fillWhenReady(ctl(d, 'passphrase'), passphrase);
  await fillWhenReady(ctl(d, 'passphrase-repeat'), passphrase);
  await ctl(d, 'redeem-submit').click({ timeout: 5000 });
}

// ---- whole flows ----
// A passphrase that passes the library's rules.
export function newPassphrase() { return 'wdsv-' + randomBytes(5).toString('hex') + '-' + randomBytes(5).toString('hex') + '-' + randomBytes(5).toString('hex'); }

// ---- whole flows (what a test of an app does with the dialogs) ----
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

// The question of store.migrateLocal (view migrate): download the copy of the old data first (migrate-backup, when "backup" is true), then "Take over"
// (migrate-yes). Resolves { backup: <file name> | null }; throws DriveError when the library ends in its failure dialog (view migrate-failed).
// downloads: an optional array that receives the file names.
export async function answerMigration(page, { backup = true, timeout = 60000, downloads } = {}) {
  const t0 = Date.now();
  const out = { backup: null };
  for (;;) {
    const v = await viewOf(page);
    const d = dialog(page);
    if (v === 'migrate') {
      if (backup && !out.backup) {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), ctl(d, 'migrate-backup').click({ timeout: 5000, noWaitAfter: true })]);
        out.backup = dl.suggestedFilename();
        if (downloads) downloads.push(out.backup);
      }
      await ctl(d, 'migrate-yes').click({ timeout: 5000 });
      await sleep(200);
    } else if (v === 'migrate-failed') {
      throw new DriveError('the migration failed: ' + (((await d.innerText({ timeout: 2000 }).catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 200)));
    } else if (v === null && (out.backup || Date.now() - t0 > 2000)) return out;
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
// opts: passphrase (default: a generated one), joinCode (for a scope that needs one), confirm (default true;
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
