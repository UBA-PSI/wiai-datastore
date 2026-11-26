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
// Every function that takes "page" finds the dialog itself (the last element with data-wds-view: the newest library dialog, which is also
// the topmost one, because the library's dialogs are <dialog> elements in the top layer and the newest showModal() is on top). The
// functions that take "d" (a Playwright locator of one dialog) are the single steps the high-level ones are made of; wds-verify calls
// them one by one because it also has to react to other dialogs in between. Failures throw DriveError with the text the library showed.
//
// A dialog is READY when it has a data-wds-view (not empty) and no aria-busy="true". A library dialog is never without a view: it opens as
// "loading" (busy), gets its real view when the controls are rendered and enabled, and is busy again while a submit is in flight
// (Argon2id, network). One that cannot go on shows the view "error" with a retry button (data-wds="retry"). Every fill waits for readiness
// (fillWhenReady), so a dialog that is still being built or rebuilt does not make a call fail. When a wait times out, the error says what
// the dialog looked like (view, aria-busy, classes, text; see dialogSummary).
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync, realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export class DriveError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = (d, name) => d.locator('[data-wds="' + name + '"]');

// The topmost dialog of the library (a locator; it may not be visible).
export function dialog(page) { return page.locator('[data-wds-view]').last(); }

// One look at the topmost library dialog, read in a single call (so that the dialog cannot be replaced between two questions):
// { view, busy, visible, classes, text, count }; null when the page has no dialog (the page answered: there is none); { unresponsive: true }
// when the page did not answer within "timeout" ms (it is busy computing, for example Argon2id blocks the main thread for seconds, or it is
// being reloaded): that says nothing about the dialog, so a caller must wait, never take it for "closed". view is '' when the dialog has no
// data-wds-view value. A closed page throws DriveError.
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

// data-wds-view of the dialog that is on screen: 'loading', 'error', 'unlock', 'create', 'redeem', 'sheet', 'conflict', 'history',
// 'share', 'revoke', 'progress', 'notice', 'migrate' or 'migrate-large'; null when no dialog is visible (the page answered); '' when one is
// visible but has no view yet (it is being built: not ready, wait) or when the page did not answer (busy or reloading: not known, wait).
// Only null means "closed". The library never leaves a dialog without a view: it starts as 'loading', and a dialog that cannot go on
// shows 'error' with a retry button.
export async function viewOf(page) {
  const s = await describeDialog(page);
  if (s && s.unresponsive) return '';
  if (!s || !s.visible) return null;
  return s.view;
}

// The seconds since t0, for a message about a wait that timed out (what really passed, not the limit that was configured).
const since = (t0) => Math.round((Date.now() - t0) / 1000);

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

// The error the dialog shows (the text of form-error, or a note that a field was marked invalid); '' when there is none. One call with a short
// limit (1 s): a dialog that closes just before (a successful unlock) has no error to show, and the call must not wait for it (Playwright's own
// limit for a locator that matches nothing is 30 s, or none at all in a test runner without actionTimeout).
export async function formError(d) {
  const r = await d.evaluate((el) => {
    const f = el.querySelector('[data-wds="form-error"]');
    return { text: f ? String(f.innerText || f.textContent || '').trim() : '', invalid: el.querySelectorAll('[aria-invalid="true"]').length };
  }, undefined, { timeout: 1000 }).catch(() => null);
  if (!r) return '';
  return r.text || (r.invalid ? 'a field was marked invalid' : '');
}

// ---- filling ----
// Fill a field of a library dialog when it can take the text: wait until it is visible and editable (a dialog that is being rebuilt, a
// field that is disabled while a request runs), fill, check what the field holds, and try again (up to 3 times, within "timeout" ms in
// all) when the page replaced the field meanwhile. check: 'exact' (the field must hold the text: passphrases), 'nonempty' (fields that
// format what is typed, such as access IDs and codes) or false. Throws the last Playwright error (with its call log; see briefError).
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

// ---- the join code of a scope (for tests against a scope with the enrollment "join code") ----
// The code is a credential. It is never taken from the command line or the environment (both end up in transcripts and process lists)
// and never printed. The person who owns the scope writes it into a file in their own terminal; this module reads that file:
//   opts.joinCode  (a string; for a test that has the code by other means), else
//   the file named by the environment variable WDS_JOIN_CODE_FILE, else
//   the default file ~/.wds/join-code  (%USERPROFILE%\.wds\join-code on Windows).
// Before it reads, the file must exist, be a regular file, not be readable by other users (not on Windows, where file modes say nothing) and
// not lie in a git repository (an ignored, untracked file in a repository other than the one of the working directory is accepted).
// The content is trimmed. No error message contains it.
export function joinCodeFile() {
  return process.env.WDS_JOIN_CODE_FILE || join(homedir(), '.wds', 'join-code');
}
function repoRootOf(path) {
  for (let p = path; ; p = dirname(p)) {
    if (existsSync(join(p, '.git'))) return p;
    if (dirname(p) === p) return null;
  }
}
function joinCodeHelp(path) {
  const isDefault = !process.env.WDS_JOIN_CODE_FILE;
  const shown = isDefault ? '~/.wds/join-code' : path;
  const dir = isDefault ? '~/.wds' : dirname(path);
  return 'The person who owns the scope (not the agent) creates the file in their own terminal:\n'
    + '    mkdir -p ' + dir + ' && chmod 700 ' + dir + '\n'
    + '    (umask 077; cat > ' + shown + ')        # paste the join code, press Enter, then Ctrl-D\n'
    + '  (on Windows: create ' + (isDefault ? '%USERPROFILE%\\.wds\\join-code' : path) + ' with Notepad)\n'
    + 'and deletes it afterwards (rm ' + shown + '). Never read, print or copy that file, and never ask for the code in the chat: give the person these commands and wait until they say it is there.';
}
export function readJoinCode({ file } = {}) {
  const path = resolve(file || joinCodeFile());
  if (!existsSync(path)) throw new DriveError('this scope asks for a join code and the file ' + path + ' does not exist. ' + joinCodeHelp(path));
  let real, st;
  try { real = realpathSync(path); st = statSync(real); } catch (e) { throw new DriveError('the join code file ' + path + ' cannot be read (' + ((e && e.code) || 'error') + ')'); }
  if (!st.isFile()) throw new DriveError('the join code file ' + path + ' is not a regular file');
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw new DriveError('the join code file ' + path + ' can be read by other users; run: chmod 600 ' + path);
  const repo = repoRootOf(dirname(real));
  if (repo) {
    const mine = repoRootOf(process.cwd());
    const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    const safe = repo !== mine && git('check-ignore', '-q', '--', real).status === 0 && git('ls-files', '--error-unmatch', '--', real).status !== 0;
    if (!safe) throw new DriveError('the join code file ' + path + ' lies in the git repository ' + repo + '; the file must be outside every repository (the default is ~/.wds/join-code)');
  }
  let text;
  try { text = readFileSync(real, 'utf8').trim(); } catch (e) { throw new DriveError('the join code file ' + path + ' cannot be read (' + ((e && e.code) || 'error') + ')'); }
  if (!text) throw new DriveError('the join code file ' + path + ' is empty');
  return text;
}

// ---- single steps (d: the dialog locator) ----
// "Create a new vault" in the unlock dialog.
export async function chooseCreate(d) { await ctl(d, 'to-create').click({ timeout: 5000 }); }
// Fill the create form and press the button. A scope with the enrollment "join code" shows a join-code field: the code comes from the
// option joinCode or from the join code file (see readJoinCode above); without one the call throws a DriveError that says how the
// person creates the file. The code is never printed, and no error message contains it.
export async function submitCreate(d, { passphrase, joinCode } = {}) {
  if (await ctl(d, 'join-code').first().isVisible().catch(() => false)) {
    const code = joinCode !== undefined ? joinCode : readJoinCode();
    await fillWhenReady(ctl(d, 'join-code'), code, { check: 'nonempty' });
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

// ---- the migration dialogs (store.migrateLocal) ----
// The question "take over the data of the earlier version?" (view migrate): download the backup (migrate-backup, when "backup" is true),
// then "Take over" (migrate-yes). When some entries are too large for the vault the library then shows view migrate-large: every
// file is downloaded (migrate-large-download) and the old data is deleted anyway (migrate-delete). Resolves
// { backup: <file name> | null, large: <number of downloaded files>, skipped?: true when the question listed rows that map leaves out }. downloads: an optional array that receives the file names.
export async function answerMigration(page, { backup = true, timeout = 60000, downloads } = {}) {
  const t0 = Date.now();
  const out = { backup: null, large: 0 };
  for (;;) {
    const v = await viewOf(page);
    const d = dialog(page);
    if (v === 'migrate') {
      if (backup && !out.backup) {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), ctl(d, 'migrate-backup').click({ timeout: 5000, noWaitAfter: true })]);
        out.backup = dl.suggestedFilename();
        if (downloads) downloads.push(out.backup);
      }
      if (await ctl(d, 'migrate-skip-ack').count()) {   // rows that map leaves out are deleted with the old data: the box (or the backup) confirms it
        out.skipped = true;
        if (!(await ctl(d, 'migrate-yes').isEnabled({ timeout: 3000 }))) await ctl(d, 'migrate-skip-ack').check({ timeout: 5000 });
      }
      await ctl(d, 'migrate-yes').click({ timeout: 5000 });
      await sleep(200);
    } else if (v === 'migrate-large') {
      const n = await ctl(d, 'migrate-large-download').count();
      for (let i = 0; i < n; i++) {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), ctl(d, 'migrate-large-download').nth(i).click({ timeout: 5000, noWaitAfter: true })]);
        out.large++;
        if (downloads) downloads.push(dl.suggestedFilename());
      }
      await ctl(d, 'migrate-delete').click({ timeout: 10000 });
      await sleep(200);
    } else if (v === null && (out.backup || out.large || Date.now() - t0 > 2000)) return out;
    if (Date.now() - t0 > timeout) throw new DriveError('answering the migration dialogs timed out after ' + since(t0) + ' s; the dialog shows ' + (v ? 'view "' + v + '"' : 'nothing') + '; ' + await dialogSummary(page));
    await sleep(150);
  }
}

// ---- whole flows ----
// A passphrase that passes the library's rules.
export function newPassphrase() { return 'wdsv-' + randomBytes(5).toString('hex') + '-' + randomBytes(5).toString('hex') + '-' + randomBytes(5).toString('hex'); }

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

// The app has called store.unlock() and its dialog is open: create a vault (unlock dialog -> create -> access sheet -> confirmed).
// Resolves { accessId, passphrase }. Do not await store.unlock() before this call: it resolves only after the dialogs are answered.
// opts: passphrase (default: a generated one), joinCode (for a scope that needs one; default: the join code file, see readJoinCode), confirm (default true; false leaves the access
// sheet open for confirmSheet(page)), timeout (ms per step).
export async function createVault(page, { passphrase = newPassphrase(), joinCode, confirm = true, timeout = 60000 } = {}) {
  const view = await waitForView(page, ['unlock', 'create'], { timeout });
  if (view === 'unlock') { await chooseCreate(dialog(page)); }
  await waitForView(page, 'create', { timeout });
  const d = dialog(page);
  await submitCreate(d, { passphrase, joinCode });
  await waitForSheet(page, d, 'creating the vault', timeout);
  const accessId = confirm ? await confirmSheet(page) : ((await ctl(dialog(page), 'access-id').first().innerText({ timeout: 3000 }).catch(() => '')) || '').trim();
  return { accessId, passphrase };
}

// The app has called store.unlock() and its dialog is open: join a vault with an invite code (unlock dialog -> "I have an invite" -> redeem form
// -> access sheet -> confirmed). Resolves { accessId, passphrase }. opts: code (the invite code, required), passphrase (default: generated;
// the member's own passphrase), confirm (default true), timeout.
export async function redeemInvite(page, { code, passphrase = newPassphrase(), confirm = true, timeout = 60000 } = {}) {
  if (!code) throw new DriveError('redeemInvite needs the invite code');
  await waitForView(page, ['unlock', 'redeem'], { timeout });
  const d = dialog(page);
  await submitRedeem(d, { code, passphrase });
  await waitForSheet(page, dialog(page), 'redeeming the invite', timeout);
  const accessId = confirm ? await confirmSheet(page) : ((await ctl(dialog(page), 'access-id').first().innerText({ timeout: 3000 }).catch(() => '')) || '').trim();
  return { accessId, passphrase };
}

// The app has called store.unlock() and the unlock dialog is open: unlock an existing vault. Resolves when the dialog is gone;
// throws DriveError with the dialog's error (wrong passphrase, ...). opts: accessId (needed unless the library remembers it), passphrase.
export async function unlock(page, { accessId, passphrase, timeout = 30000 }) {
  await waitForView(page, 'unlock', { timeout });
  const d = dialog(page);
  await submitUnlock(d, { accessId, passphrase });
  const t0 = Date.now();
  const done = (v) => v === null || v === 'notice' || v === 'sheet';   // gone, or the library has more to say (a notice, a new access sheet): the caller answers it
  for (;;) {
    const view = await viewOf(page);   // null only when the page answered and has no dialog; '' while the page is busy (Argon2id) or reloading
    if (done(view)) return;
    const err = view === '' ? '' : await formError(d);
    if (err) {
      if (done(await viewOf(page))) return;   // the dialog closed while its error was read: the unlock worked
      throw new DriveError('unlocking failed: ' + err);
    }
    if (Date.now() - t0 > timeout) {
      const last = await viewOf(page);
      if (done(last)) return;
      throw new DriveError('unlocking timed out after ' + since(t0) + ' s; the dialog shows ' + (last ? 'view "' + last + '"' : 'no view (or the page did not answer)') + '; ' + await dialogSummary(page));
    }
    await sleep(150);
  }
}

// Delete the vault that the test created (the test vault of a scope: nobody else needs it; the dashboard shows vaults but a person should not have to
// guess which one was the test). The library's store has no call for this, so the helper opens a second client of the page's library
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

// In your own automated browser (never in the app): let store.migrateLocal delete the old data in the sandbox as well. Call it on the
// Playwright context before the page loads. The library honours the global only when navigator.webdriver is true, which it is in a
// browser that Playwright drives; wds-verify --migration-delete does the same.
export async function enableMigrationDelete(context) {
  await context.addInitScript(() => { window.__WDS_MIGRATION_TEST__ = true; });
}
