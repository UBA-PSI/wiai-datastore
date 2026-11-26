// tools/lib/drive-library.mjs: the dialogs of the library driven from a Playwright page by their stable attributes, as a developer's own test would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpDir } from './helpers.mjs';
import { startMock } from '../lib/wds-mock.mjs';
import { createVault, redeemInvite, deleteVault, answerMigration, enableMigrationDelete, unlock, confirmSheet, viewOf, waitForView, dialog, dialogState, fillWhenReady, briefError, readJoinCode, joinCodeFile, DriveError } from '../lib/drive-library.mjs';

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

test('a scope with a join code: the code comes from the join code file (WDS_JOIN_CODE_FILE), never from the environment; a missing file is a DriveError that says how the person creates it; nothing prints the code', { timeout: 120000 }, async () => {
  const code = 'K7M2QX9A-secret';
  const created = await mock.createScope('joinscope', { enrollment: 'join_code', joinCode: code });
  const open2 = async () => {
    const page = (await (await browser.newContext()).newPage());
    await page.goto(appUrl);
    await page.evaluate(([s, base]) => { window.store = WDS.connect({ scope: s, baseUrl: base }); }, [created.scope, mock.service]);
    await page.evaluate(() => { window.p = store.unlock(); });
    return page;
  };
  const dir = tmpDir('wds-joincode-');
  const file = join(dir, 'join-code');
  const saved = { file: process.env.WDS_JOIN_CODE_FILE, env: process.env.WDS_JOIN_CODE };
  const printed = [];
  const out = process.stdout.write.bind(process.stdout), err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c, ...a) => { printed.push(String(c)); return out(c, ...a); };
  process.stderr.write = (c, ...a) => { printed.push(String(c)); return err(c, ...a); };
  try {
    process.env.WDS_JOIN_CODE_FILE = file;
    process.env.WDS_JOIN_CODE = code;   // the old way: it is not read any more
    const page = await open2();
    // no file: a DriveError with the commands for the person, no code
    await assert.rejects(createVault(page), (e) => e instanceof DriveError && e.message.includes(file) && /mkdir -p/.test(e.message) && /umask 077; cat >/.test(e.message) && /Never read, print or copy that file/.test(e.message) && !e.message.includes(code));
    // a file that others can read
    writeFileSync(file, code + '\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    if (process.platform !== 'win32') await assert.rejects(createVault(page), (e) => e instanceof DriveError && /chmod 600/.test(e.message) && !e.message.includes(code));
    // the create dialog is still open: with the file in order the code of the file is used (trimmed)
    chmodSync(file, 0o600);
    const { accessId } = await createVault(page);
    assert.match(accessId, /^[0-9A-Z-]{20,}$/);
    await page.evaluate(() => window.p);
    assert.equal(await page.evaluate(() => store.status().unlocked), true);
    // a wrong code is the error of the dialog
    writeFileSync(file, 'not-the-code\n', { mode: 0o600 });
    const other = await open2();
    await assert.rejects(createVault(other, { timeout: 20000 }), (e) => e instanceof DriveError && /creating the vault failed/.test(e.message) && !e.message.includes('not-the-code') && !e.message.includes(code));
  } finally {
    process.stdout.write = out; process.stderr.write = err;
    for (const [k, v] of [['WDS_JOIN_CODE_FILE', saved.file], ['WDS_JOIN_CODE', saved.env]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.ok(!printed.join('').includes(code) && !printed.join('').includes('not-the-code'), 'the join code was printed');
});

test('readJoinCode: the file must exist, be a regular file, be private and lie outside every repository; the content is trimmed and in no error', () => {
  const code = 'Z9Y8X7W6-private';
  const dir = tmpDir('wds-joincode-unit-');
  const f = join(dir, 'join-code');
  const fails = (arg, re) => assert.throws(() => readJoinCode(arg), (e) => e instanceof DriveError && re.test(e.message) && !e.message.includes(code), String(re));
  // missing: names the path and the commands
  fails({ file: f }, /does not exist[\s\S]*mkdir -p[\s\S]*umask 077; cat >/);
  const savedFile = process.env.WDS_JOIN_CODE_FILE, savedHome = process.env.HOME;
  try {
    delete process.env.WDS_JOIN_CODE_FILE;
    assert.equal(joinCodeFile(), join(homedir(), '.wds', 'join-code'));
    process.env.WDS_JOIN_CODE_FILE = f;
    assert.equal(joinCodeFile(), f);
    if (process.platform !== 'win32') {
      // the default file lives in ~/.wds (HOME is honoured by os.homedir on Unix)
      process.env.HOME = dir;
      delete process.env.WDS_JOIN_CODE_FILE;
      assert.equal(joinCodeFile(), join(dir, '.wds', 'join-code'));
      fails({}, /does not exist[\s\S]*mkdir -p ~\/\.wds && chmod 700 ~\/\.wds[\s\S]*\(umask 077; cat > ~\/\.wds\/join-code\)/);
    }
  } finally { if (savedFile === undefined) delete process.env.WDS_JOIN_CODE_FILE; else process.env.WDS_JOIN_CODE_FILE = savedFile; if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; }
  // a directory, an empty file
  mkdirSync(join(dir, 'd'));
  fails({ file: join(dir, 'd') }, /not a regular file/);
  writeFileSync(f, '  \n', { mode: 0o600 });
  fails({ file: f }, /is empty/);
  // too open (not checked on Windows)
  writeFileSync(f, '  ' + code + '  \n', { mode: 0o600 });
  if (process.platform !== 'win32') {
    chmodSync(f, 0o640);
    fails({ file: f }, /can be read by other users; run: chmod 600 /);
    chmodSync(f, 0o604);
    fails({ file: f }, /chmod 600/);
    chmodSync(f, 0o600);
  }
  assert.equal(readJoinCode({ file: f }), code);   // trimmed
  assert.equal(readJoinCode({ file: f }), code);   // and it can be read again: nothing is consumed
  // inside a git repository: not accepted; ignored by a repository other than the one of the working directory and untracked: accepted
  if (spawnSync('git', ['--version']).status === 0) {
    const repo = tmpDir('wds-joincode-repo-');
    assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
    const inRepo = join(repo, 'sub', 'join-code');
    mkdirSync(join(repo, 'sub'));
    writeFileSync(inRepo, code + '\n', { mode: 0o600 });
    fails({ file: inRepo }, /lies in the git repository .*outside every repository/);
    writeFileSync(join(repo, '.gitignore'), 'sub/\n');
    assert.equal(readJoinCode({ file: inRepo }), code);
    assert.equal(spawnSync('git', ['-C', repo, 'add', '-f', 'sub/join-code']).status, 0);
    fails({ file: inRepo }, /lies in the git repository/);
    // a symlink into a repository is the file it points to
    const link = join(dir, 'link');
    symlinkSync(inRepo, link);
    fails({ file: link }, /lies in the git repository/);
  }
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

test('redeemInvite: an invite code of the owner opens a vault for a member in another browser; a wrong code is a DriveError; deleteVault removes the test vault', { timeout: 180000 }, async () => {
  const owner = await open(await browser.newContext());
  await owner.evaluate(() => { window.p = store.unlock(); });
  const ownerAccess = await createVault(owner);
  await owner.evaluate(() => window.p);
  await owner.evaluate(() => { window.sp = store.share(); });
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
  // the test vault deletes itself
  assert.equal(await deleteVault(owner, { ...ownerAccess, baseUrl: mock.service }), 'deleted');
  await assert.rejects(deleteVault(owner, { ...ownerAccess, baseUrl: mock.service }), (e) => e instanceof DriveError && /deleting the test vault: failed/.test(e.message));
  await assert.rejects(deleteVault(owner, {}), /needs the accessId and the passphrase/);
});

test('confirmSheet: a sheet that cannot be confirmed is a DriveError with the text of the dialog, not a timeout of the disabled button', { timeout: 120000 }, async () => {
  const page = await open(await browser.newContext());
  await page.evaluate(() => { window.p = store.unlock(); });
  await createVault(page, { confirm: false });
  // the app (or a bug) makes the checkbox impossible to tick
  await page.evaluate(() => { const c = document.querySelector('[data-wds="sheet-confirm"]'); c.disabled = true; });
  await assert.rejects(confirmSheet(page), (e) => e instanceof DriveError && /the access sheet could not be confirmed/.test(e.message) && /the dialog says/.test(e.message));
});

test('answerMigration: the backup is downloaded, "Take over" pressed; migrate-large: every file downloaded one by one, then "delete anyway"; enableMigrationDelete sets the global', { timeout: 60000 }, async () => {
  const context = await browser.newContext({ acceptDownloads: true });
  await enableMigrationDelete(context);
  const page = await context.newPage();
  await page.goto(appUrl);
  assert.equal(await page.evaluate(() => window.__WDS_MIGRATION_TEST__ === true), true);
  await page.evaluate(() => {
    const dl = (name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['x'])); a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
    const dialog = (view, html) => { const d = document.createElement('div'); d.className = 'wds-root'; d.setAttribute('data-wds-view', view); d.innerHTML = html; document.body.appendChild(d); return d; };
    window.log = [];
    const q = dialog('migrate', '<button data-wds="migrate-backup">b</button><button data-wds="migrate-yes">y</button>');
    q.querySelector('[data-wds=migrate-backup]').onclick = () => { window.log.push('backup'); dl('old-data.json'); };
    q.querySelector('[data-wds=migrate-yes]').onclick = () => {
      window.log.push('yes'); q.remove();
      const big = dialog('migrate-large', '<button data-wds="migrate-large-download">1</button><button data-wds="migrate-large-download">2</button><button data-wds="migrate-delete" disabled>d</button>');
      let left = 2; const del = big.querySelector('[data-wds=migrate-delete]');
      big.querySelectorAll('[data-wds=migrate-large-download]').forEach((b, i) => { b.onclick = () => { window.log.push('file' + i); dl('large-' + i + '.bin'); if (--left === 0) del.disabled = false; }; });
      del.onclick = () => { window.log.push('delete'); big.remove(); };
    };
  });
  const files = [];
  const res = await answerMigration(page, { downloads: files });
  assert.deepEqual(res, { backup: 'old-data.json', large: 2 });
  assert.deepEqual(files, ['old-data.json', 'large-0.bin', 'large-1.bin']);
  assert.deepEqual(await page.evaluate(() => window.log), ['backup', 'yes', 'file0', 'file1', 'delete']);
  // without the backup
  await page.evaluate(() => {
    const d = document.createElement('div'); d.className = 'wds-root'; d.setAttribute('data-wds-view', 'migrate');
    d.innerHTML = '<button data-wds="migrate-backup">b</button><button data-wds="migrate-yes">y</button>'; document.body.appendChild(d);
    d.querySelector('[data-wds=migrate-yes]').onclick = () => { window.log.push('yes2'); d.remove(); };
  });
  assert.deepEqual(await answerMigration(page, { backup: false }), { backup: null, large: 0 });
  assert.equal((await page.evaluate(() => window.log)).slice(-1)[0], 'yes2');
  await context.close();
});
