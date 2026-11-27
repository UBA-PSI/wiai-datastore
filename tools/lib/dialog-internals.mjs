// The steps that drive-library.mjs and the dynamic checks of wds-verify are made of (tests of an app use drive-library.mjs). A dialog is
// READY when it has a data-wds-view and no aria-busy="true"; the library never leaves a dialog without a view ("loading" while it is built,
// "error" with a retry when it cannot go on). Failures throw DriveError; a timeout says what the dialog looked like (dialogSummary).
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync, realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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

// ---- the join code of a scope (for tests against a scope with the enrollment "join code") ----
// The code is a credential: never taken from the command line or the environment, never printed. The person who owns the scope writes it
// into a file in their own terminal: opts.joinCode, else the file in WDS_JOIN_CODE_FILE, else ~/.wds/join-code. The file must be a regular
// file, not readable by other users (not checked on Windows) and outside every git repository (an ignored, untracked file in another
// repository than the working directory's is accepted). No error message contains the code.
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
// Fill the create form and press the button. A join-code field gets the option joinCode or the join code file (see readJoinCode).
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

// ---- whole flows ----
// A passphrase that passes the library's rules.
export function newPassphrase() { return 'wdsv-' + randomBytes(5).toString('hex') + '-' + randomBytes(5).toString('hex') + '-' + randomBytes(5).toString('hex'); }
