// Browser tests of wds-ui.js: the bundle is loaded from a file:// page and talks to the in-memory fake server over HTTP.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  startTestWorld, openApp, mockHibp, shot, dialog, createVaultViaUi, unlockViaUi, lockPage, nodeClient, writePage, tmpDir, SRI, VERSION,
  recoverByFaculty, redeemViaUi, core, I,
} from './ui-helpers.mjs';

let w;
test.beforeEach(async () => { w = await startTestWorld(); });
test.afterEach(async () => { await w.close(); });

const PASS = 'purple-elephant-marching-slowly';

test('create vault: passphrase rules, breach check, access sheet, then set/get and unlock after reload', async ({ context }) => {
  const page = await openApp(context, w);
  const hibp = await mockHibp(page, { pwned: ['Tr0ub4dor-and-3-horses'] });
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const dlg = dialog(page);
  expect(await dlg.evaluate((n) => n.tagName === 'DIALOG' && n.matches(':modal'))).toBe(true); // a real modal <dialog> in the top layer
  await expect(dlg).not.toHaveAttribute('aria-modal', /.*/);
  await expect(dlg.getByRole('heading', { name: 'Unlock your data' })).toBeVisible();
  await shot(page, 'en-unlock');
  await dlg.getByRole('button', { name: 'Create a new vault' }).click();
  await dlg.getByLabel('Join code').fill('ANYCODE1');
  const pw = dlg.getByLabel('Passphrase', { exact: true }), rep = dlg.getByLabel('Repeat passphrase');
  const submit = dlg.getByRole('button', { name: 'Create vault' });

  await pw.fill('short'); await rep.fill('short'); await submit.click();
  await expect(dlg.getByRole('alert').filter({ hasText: 'At least 12 characters' })).toBeVisible();
  await pw.fill('passwordpassword'); await rep.fill('passwordpassword'); await submit.click();
  await expect(dlg.getByRole('alert').filter({ hasText: /common|too easy/ })).toBeVisible();
  await pw.fill(PASS); await rep.fill('something-else-entirely'); await submit.click();
  await expect(dlg.getByRole('alert').filter({ hasText: 'The two passphrases are different' })).toBeVisible();
  expect(hibp.length).toBe(0); // local rules fail before anything leaves the device
  await pw.fill('Tr0ub4dor-and-3-horses'); await rep.fill('Tr0ub4dor-and-3-horses'); await submit.click();
  await expect(dlg.getByRole('alert').filter({ hasText: 'appears 42 times in known data breaches' })).toBeVisible();
  expect(hibp.length).toBe(1);
  expect(hibp[0].prefix).toMatch(/^[0-9A-F]{5}$/);   // the page asks its own service, never another host
  await expect(dlg.getByText('asks Pwned Passwords (USA) on your behalf')).toBeVisible();   // the one privacy sentence of the form

  await pw.fill(PASS); await rep.fill(PASS);
  await expect(dlg.getByText('Strength: strong')).toBeVisible();
  await shot(page, 'en-create');
  await submit.click();
  await expect(dlg.getByRole('heading', { name: 'Save your access sheet' })).toBeVisible();
  const accessId = (await dlg.locator('[data-wds=access-id]').innerText()).trim();
  const recovery = (await dlg.locator('[data-wds=recovery-code]').innerText()).trim();
  expect(accessId).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
  expect(recovery).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/);
  await expect(dlg.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await shot(page, 'en-sheet');

  await expect(dlg.getByRole('button', { name: /key file/i })).toHaveCount(0);   // no key file: the access ID is on the sheet

  const sheetDownload = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'Download access sheet (HTML)' }).click();
  const sheet = readFileSync(await (await sheetDownload).path(), 'utf8');
  expect(sheet).toContain(accessId);
  expect(sheet).toContain(recovery);
  expect(sheet).toContain('the faculty holds a recovery key for emergencies');   // the same escrow sentence as the create form
  expect(sheet).not.toContain(PASS);

  await dlg.getByLabel('I have saved the access sheet and the emergency code.').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();
  const status = await page.evaluate(() => window.unlockP);
  expect(status.role).toBe('owner');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#app')).not.toHaveAttribute('inert', '');

  const got = await page.evaluate(async () => {
    const saved = await store.set('settings', { theme: 'dark', list: [1, 2, 3] });
    return { saved, value: await store.get('settings') };
  });
  expect(got.saved.version).toBe(1);
  expect(got.value).toEqual({ theme: 'dark', list: [1, 2, 3] });
  // the server only holds ciphertext
  const vault = [...w.world.server.vaults.values()][0];
  const stored = JSON.stringify([...vault.records.values()], (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v));
  expect(stored).not.toContain('dark');

  // a new page load with the same browser storage: the access ID is remembered, the passphrase is not
  const page2 = await openApp(context, w);
  await page2.evaluate(() => { window.getP = store.get('settings'); });
  const d2 = dialog(page2);
  await expect(d2.getByLabel('Access ID')).toHaveValue(accessId);
  await d2.getByLabel('Passphrase', { exact: true }).fill('not the passphrase at all');
  await d2.getByRole('button', { name: 'Unlock' }).click();
  await expect(d2.getByRole('alert').filter({ hasText: 'does not match this access ID' })).toBeVisible();
  await d2.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await d2.getByRole('button', { name: 'Unlock' }).click();
  expect(await page2.evaluate(() => window.getP)).toEqual({ theme: 'dark', list: [1, 2, 3] });
  await expect(page2.getByRole('dialog')).toHaveCount(0);
  expect(page.errors).toEqual([]);
});

const idOf = (v) => v.accessId.replace(/-/g, '');

test('new device: type the access ID, new-device notice', async ({ browser }) => {
  const ctx1 = await browser.newContext();
  const page = await openApp(ctx1, w);
  const vault = await createVaultViaUi(page);
  await page.evaluate(() => store.set('a', { x: 1 }));

  const ctx2 = await browser.newContext(); // fresh browser storage = new device
  const p2 = await openApp(ctx2, w);
  await p2.evaluate(() => { window.getP = store.get('a'); });
  const d = dialog(p2);
  await expect(d.getByLabel('Access ID')).toHaveValue('');
  await expect(d.locator('[data-wds=keyfile], [data-wds=keyfile-button]')).toHaveCount(0);
  await d.getByLabel('Access ID').fill(vault.accessId);
  await d.getByLabel('Passphrase', { exact: true }).fill(vault.passphrase);
  await d.getByRole('button', { name: 'Unlock' }).click();
  expect(await p2.evaluate(() => window.getP)).toEqual({ x: 1 });
  await expect(p2.getByText('This device is new to your vault.')).toBeVisible();
  await shot(p2, 'en-new-device');

  // an invalid access ID, an invite code typed into the ID field, and an unknown ID
  const p3 = await openApp(await browser.newContext(), w);
  await p3.evaluate(() => { window.unlockP = store.unlock(); });
  const d3 = dialog(p3);
  await d3.getByLabel('Access ID').fill('1234');
  await d3.getByLabel('Passphrase', { exact: true }).fill('whatever');
  await d3.getByRole('button', { name: 'Unlock' }).click();
  await expect(d3.getByRole('alert').filter({ hasText: 'not valid' })).toBeVisible();
  await d3.getByLabel('Access ID').fill('0000-0000-0000-0000-0000');
  await d3.getByRole('button', { name: 'Unlock' }).click();
  await expect(d3.getByRole('alert').filter({ hasText: /unknown|not valid/ })).toBeVisible();
});

test('records: JSON, bytes, File and Blob values (a file comes back as a Blob with its type), remove', async ({ context }) => {
  const page = await openApp(context, w);
  const vault = await createVaultViaUi(page);
  await page.locator('#file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 hello') });
  const r = await page.evaluate(async () => {
    const bytes = new Uint8Array(70000).map((_, i) => i % 251);
    await store.set('files/data.bin', bytes);
    const f = document.getElementById('file').files[0];
    await store.set('files/' + f.name, f);
    await store.set('note', { t: 1 });
    const blob = await store.get('files/report.pdf');
    const back = await store.get('files/data.bin');
    let reserved = null;
    try { await store.set('.wds/labels', {}); } catch (e) { reserved = e.name; }
    return {
      blobType: blob.type, blobText: await blob.text(), isBlob: back instanceof Blob && blob instanceof Blob,
      same: back.size === 70000 && new Uint8Array(await back.arrayBuffer())[69999] === 69999 % 251, reserved,
      removed: await store.remove('note'), after: await store.get('note'), removedAgain: await store.remove('note'),
    };
  });
  const node = nodeClient(w);
  await node.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  expect((await node.list('files/')).map((x) => [x.name, x.kind, x.mime, x.length])).toEqual([['files/data.bin', 'bytes', null, 70000], ['files/report.pdf', 'bytes', 'application/pdf', 14]]);
  expect(r.isBlob).toBe(true);
  expect(r.blobType).toBe('application/pdf');
  expect(r.blobText).toBe('%PDF-1.4 hello');
  expect(r.same).toBe(true);
  expect(r.reserved).toBe('UsageError');
  expect(r.removed).toEqual({ name: 'note', deleted: true, resolution: 'deleted' });
  expect(r.after).toBeUndefined();
  expect(r.removedAgain).toEqual({ name: 'note', deleted: false, resolution: 'absent' });
});

test('conflict dialog: keep mine, keep theirs (no download), and the merge handler', async ({ context }) => {
  const page = await openApp(context, w);
  const vault = await createVaultViaUi(page);
  await page.evaluate(() => store.set('note', { text: 'v1' }));
  const other = nodeClient(w);
  await other.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  await other.get('note');
  await other.put('note', { text: 'theirs v2' });

  await page.evaluate(() => { window.setP = store.set('note', { text: 'mine v2' }).then((r) => r, (e) => ({ err: e.name })); });
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'Another device or person saved a newer version' })).toBeVisible();
  await expect(d.getByText('theirs v2')).toBeVisible();
  await expect(d.getByText('mine v2')).toBeVisible();
  await shot(page, 'en-conflict');
  await expect(d.getByRole('button', { name: 'Download both' })).toHaveCount(0);
  await expect(d.getByText('stays in the history')).toBeVisible();
  await d.getByRole('button', { name: 'Keep mine' }).click();
  const res = await page.evaluate(() => window.setP);
  expect(res.resolution).toBe('mine');
  expect(res.version).toBe(3);
  expect((await other.getRecord('note')).value).toEqual({ text: 'mine v2' });
  expect((await other.history('note')).versions.length).toBe(3); // theirs stays in the history

  await other.put('note', { text: 'theirs v4' });
  await page.evaluate(() => { window.setP = store.set('note', { text: 'mine v4' }); });
  await dialog(page).getByRole('button', { name: 'Keep theirs' }).click();
  const res2 = await page.evaluate(() => window.setP);
  expect(res2.resolution).toBe('theirs');
  expect(res2.value).toEqual({ text: 'theirs v4' });
  expect(await page.evaluate(() => store.get('note'))).toEqual({ text: 'theirs v4' });

  // an app handler replaces the dialog
  await other.put('note', { text: 'theirs v6' });
  const merged = await page.evaluate(async () => {
    store.onConflict((c) => ({ merged: { text: c.theirs.value.text + ' + ' + c.mine.value.text } }));
    return store.set('note', { text: 'mine v6' });
  });
  expect(merged.resolution).toBe('merged');
  expect((await other.getRecord('note')).value).toEqual({ text: 'theirs v6 + mine v6' });
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // deleting something that changed in the meantime asks first
  await page.evaluate(() => store.onConflict(null));
  await other.get('note');
  await other.put('note', { text: 'changed again' });
  await page.evaluate(() => { window.rmP = store.remove('note'); });
  const dd = dialog(page);
  await expect(dd.getByRole('heading', { name: 'This entry was changed in the meantime' })).toBeVisible();
  await dd.getByRole('button', { name: 'Keep the entry' }).click();
  expect(await page.evaluate(() => window.rmP)).toEqual({ name: 'note', deleted: false, resolution: 'theirs', value: { text: 'changed again' } });
  expect((await other.getRecord('note')).value).toEqual({ text: 'changed again' });
});

test('autosave: debounced, one write for a burst, flush on demand', async ({ context }) => {
  const page = await openApp(context, w);
  await createVaultViaUi(page);
  const puts = () => w.world.server.requests.filter((r) => r.method === 'PUT' && /\/records\//.test(r.path)).length;
  const before = puts();
  await page.evaluate(() => {
    window.state = { n: 0 };
    window.as = store.autosave('draft', () => window.state, { delayMs: 300, onStatus: (s) => { window.status = s; } });
    for (let i = 1; i <= 5; i++) { window.state = { n: i }; window.as.changed(); }
  });
  await expect.poll(() => page.evaluate(() => window.status)).toBe('saved');
  expect(puts() - before).toBe(1);
  expect(await page.evaluate(() => store.get('draft'))).toEqual({ n: 5 });
  await page.evaluate(async () => { window.state = { n: 6 }; window.as.changed(); await window.as.flush(); });
  expect(puts() - before).toBe(2);
  expect(await page.evaluate(() => store.get('draft'))).toEqual({ n: 6 });
  await page.evaluate(() => window.as.stop());
});

test('share: an invite that was opened with its code is revoked, not cancelled; an unused one is cancelled', async ({ browser }) => {
  const owner = await openApp(await browser.newContext(), w);
  await createVaultViaUi(owner);
  await owner.evaluate(async () => { await store.set('a', { v: 1 }); });
  await owner.evaluate(() => { window.shareP = store.openVault(); });
  const sd = dialog(owner);
  const makeInvite = async (label) => {
    void label;
    await sd.getByRole('button', { name: 'Create invite code' }).click();
    const codeEl = sd.locator('[data-wds=invite-code]');
    await expect(codeEl).toBeVisible();
    const code = (await codeEl.innerText()).trim();
    await sd.getByRole('button', { name: 'Create another invite' }).click();
    return code;
  };
  const unusedCode = await makeInvite('Unused'), openedCode = await makeInvite('Opened');
  expect(unusedCode).not.toBe(openedCode);
  // somebody opens the second invite with its token (the first request of a redemption)
  const p = await core.parseInviteCode(openedCode);
  const res = await w.world.server.fetch(w.service + 'api/v1/slots/' + p.accessId, { headers: { Authorization: I.bearerHeader(p.accessId, (await I.deriveSlotKeys(p.secret)).token) } });
  expect(res.status).toBe(200);
  // the dialog reads the server's view again after a reopen
  await sd.getByRole('button', { name: 'Close' }).click();
  await owner.evaluate(() => { window.shareP = store.openVault(); });
  const sd2 = dialog(owner);
  const invites = sd2.locator('li').filter({ hasText: /Invite (not used yet|opened with its code)/ });
  await expect(invites).toHaveCount(2);
  const unused = invites.filter({ hasText: 'Invite not used yet' }), opened = invites.filter({ hasText: 'Invite opened with its code' });
  await expect(opened).toHaveCount(1);   // the roster is refreshed asynchronously after the dialog opened
  await expect(unused.getByRole('button', { name: 'Cancel invite' })).toBeVisible();
  await expect(opened.getByRole('button', { name: 'Cancel invite' })).toHaveCount(0);
  await shot(owner, 'en-share-opened-invite');
  await unused.getByRole('button', { name: 'Cancel invite' }).click();
  await expect(invites).toHaveCount(1);
  const vaultObj = [...w.world.server.vaults.values()][0];
  expect(vaultObj.epoch).toBe(1);
  await opened.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(sd2.getByRole('heading', { name: 'Revoke access?' })).toBeVisible();
  await expect(sd2.getByText(/already been used to open the invite/)).toBeVisible();
  await sd2.getByRole('button', { name: 'Revoke access' }).click();
  await expect(sd2.getByText('Access revoked. All data is re-encrypted.')).toBeVisible();
  expect(vaultObj.epoch).toBe(2);
  expect(await owner.evaluate(() => store.get('a'))).toEqual({ v: 1 });
  const dead = await w.world.server.fetch(w.service + 'api/v1/slots/' + p.accessId, { headers: { Authorization: I.bearerHeader(p.accessId, (await I.deriveSlotKeys(p.secret)).token) } });
  expect(dead.status).toBe(401);
});

test('share: invite, redeem on another browser, redemption notice, revoke with re-encryption', async ({ browser }) => {
  const owner = await openApp(await browser.newContext(), w);
  const vault = await createVaultViaUi(owner);
  await owner.evaluate(async () => {
    await store.set('a', { v: 1 }); await store.set('b', { v: 2 }); await store.set('files/x.bin', new Uint8Array(1000));
    await store.set('a', { v: 1, again: true });
  });
  await owner.evaluate(() => { window.shareP = store.openVault(); });
  const sd = dialog(owner);
  await expect(sd.getByRole('heading', { name: 'Vault' })).toBeVisible();
  await expect(sd.getByText('Faculty key').first()).toBeVisible();
  await sd.getByLabel('Access', { exact: true }).selectOption('write');
  await sd.getByLabel('Label (optional)').fill('Anna');
  await sd.getByRole('button', { name: 'Create invite code' }).click();
  const codeEl = sd.locator('[data-wds=invite-code]');
  await expect(codeEl).toBeVisible();
  const code = (await codeEl.innerText()).trim();
  expect(code).toMatch(/^([0-9A-Z]{4}-){11}[0-9A-Z]{4}$/);
  await shot(owner, 'en-share-invite');

  const member = await openApp(await browser.newContext(), w);
  await member.evaluate(() => { window.unlockP = store.unlock(); });
  const md = dialog(member);
  await md.getByRole('button', { name: 'I have an invite code' }).click();
  await md.getByLabel('Invite code').fill(code);
  await md.getByLabel('Passphrase', { exact: true }).fill('member-passphrase-with-words');
  await md.getByLabel('Repeat passphrase').fill('member-passphrase-with-words');
  await md.getByRole('button', { name: 'Join' }).click();
  await expect(md.getByRole('heading', { name: 'You now have access' })).toBeVisible();
  await expect(md.getByText('You can read and change the data.')).toBeVisible();
  expect(await md.locator('[data-wds=recovery-code]').count()).toBe(0);
  await shot(member, 'en-redeem-done');
  await md.getByLabel('I have saved my access ID.').check();
  await md.getByRole('button', { name: 'Continue' }).click();
  const st = await member.evaluate(() => window.unlockP);
  expect(st.role).toBe('write');
  expect(await member.evaluate(() => store.get('a'))).toEqual({ v: 1, again: true });
  await member.evaluate(() => store.set('c', { v: 3 }));
  // a used invite cannot be used again
  const late = await openApp(await browser.newContext(), w);
  await late.evaluate(() => { window.unlockP = store.unlock(); });
  const ld = dialog(late);
  await ld.getByRole('button', { name: 'I have an invite code' }).click();
  await ld.getByLabel('Invite code').fill(code);
  await ld.getByLabel('Passphrase', { exact: true }).fill('another-passphrase-words-here');
  await ld.getByLabel('Repeat passphrase').fill('another-passphrase-words-here');
  await ld.getByRole('button', { name: 'Join' }).click();
  await expect(ld.getByRole('alert').filter({ hasText: /already used|not valid/ })).toBeVisible();

  // owner: unlocks again, is told about the redemption, reviews it and revokes
  await sd.getByRole('button', { name: 'Close' }).click();
  await lockPage(owner);
  await unlockViaUi(owner, null, vault.passphrase);
  const redeemedDialog = dialog(owner);   // a dialog with OK, not a line that disappears
  await expect(redeemedDialog.getByRole('heading', { name: 'New access' })).toBeVisible();
  await expect(redeemedDialog).toContainText('An invitation was redeemed.');
  await shot(owner, 'en-redeemed-notice');
  await redeemedDialog.getByRole('button', { name: 'OK' }).click();
  await owner.evaluate(() => { window.shareP = store.openVault(); });
  const sd2 = dialog(owner);
  await expect(sd2.getByText('Anna')).toBeVisible();
  await expect(sd2.getByText(/Joined /)).toBeVisible();
  await shot(owner, 'en-share-members');
  await sd2.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(sd2.getByRole('heading', { name: 'Revoke access?' })).toBeVisible();
  await shot(owner, 'en-revoke-confirm');
  await sd2.getByRole('button', { name: 'Revoke access' }).click();
  await expect(sd2.getByText('Access revoked. All data is re-encrypted.')).toBeVisible();
  const vaultObj = [...w.world.server.vaults.values()][0];
  expect(vaultObj.epoch).toBe(2);
  expect(w.world.server.usage(vaultObj).json.old_epoch_blobs).toBe(0);
  await sd2.getByRole('button', { name: 'Close' }).click();

  // the revoked member is locked out at once: a dialog says so, then the page reloads; the owner still reads everything, including what the member wrote
  const r = await member.evaluate(() => store.get('a').then(() => 'read', (e) => e.name));
  expect(r).toBe('AuthError');
  const gone = dialog(member);
  await expect(gone.getByRole('heading', { name: 'Your access was removed' })).toBeVisible();
  await expect(gone.getByText('Your access to this vault was removed')).toBeVisible();
  expect(await member.evaluate(() => store.status().unlocked)).toBe(false);
  const reloaded = member.waitForEvent('load');
  await gone.getByRole('button', { name: 'OK' }).click();
  await reloaded;
  expect(await member.evaluate(() => store.status().unlocked)).toBe(false);
  expect(await owner.evaluate(async () => [await store.get('a'), await store.get('c')])).toEqual([{ v: 1, again: true }, { v: 3 }]);
  await owner.evaluate(() => { window.shareP = store.openVault(); });
  await expect(dialog(owner).getByText('Anna')).toHaveCount(0);
});

test('the vault dialog exports everything as a valid ZIP with a manifest', async ({ context }) => {
  const page = await openApp(context, w);
  await createVaultViaUi(page);
  await page.evaluate(async () => {
    await store.set('settings', { a: 1 }); await store.set('files/data.bin', new Uint8Array([1, 2, 3, 250]));
    await store.set('notes/ü ö.txt', { umlaut: true });
  });
  await page.evaluate(() => { window.vaultP = store.openVault(); });
  const dl = page.waitForEvent('download');
  await dialog(page).getByRole('button', { name: 'Export everything (ZIP, unencrypted)' }).click();
  const file = join(tmpDir(), 'export.zip');
  const download = await dl;
  await download.saveAs(file);
  expect(download.suggestedFilename()).toBe(w.scope + '-export.zip');
  await expect(dialog(page).getByText('Export finished: 3 records.')).toBeVisible();
  const listing = execFileSync('unzip', ['-t', file]).toString();
  expect(listing).toContain('No errors detected');
  const manifest = JSON.parse(execFileSync('unzip', ['-p', file, 'wds-export.json']).toString());
  expect(manifest.format).toBe('wds-export');
  expect(manifest.records.map((x) => x.file).sort()).toEqual(['files/data.bin', 'notes/ü ö.txt.json', 'settings.json']);
  expect([...execFileSync('unzip', ['-p', file, 'files/data.bin'])]).toEqual([1, 2, 3, 250]);
  expect(JSON.parse(execFileSync('unzip', ['-p', file, 'settings.json']).toString())).toEqual({ a: 1 });
  expect(manifest.records.some((x) => /^\.wds/.test(x.name))).toBe(false);
});

test('offline: OfflineError, and one dialog (once per episode) offers the backup', async ({ context }) => {
  const page = await openApp(context, w);
  await createVaultViaUi(page);
  await page.evaluate(() => store.set('draft', { text: 'first' }));
  await page.route('**/datastore/api/**', (route) => route.abort('internetdisconnected'));
  const r = await page.evaluate(() => store.set('draft', { text: 'precious' }).then(() => 'saved', (e) => e.name));
  expect(r).toBe('OfflineError');
  const notice = dialog(page);
  await expect(notice.getByRole('heading', { name: 'Not saved' })).toBeVisible();
  await shot(page, 'en-offline');
  const dl = page.waitForEvent('download');
  await notice.getByRole('button', { name: 'Download unsaved values (backup)' }).click();
  const d = await dl;
  expect(d.suggestedFilename()).toBe('draft.unsaved.json');
  expect(JSON.parse(readFileSync(await d.path(), 'utf8'))).toEqual({ text: 'precious' });
  await notice.getByRole('button', { name: 'Close' }).first().click();
  const again = await page.evaluate(() => store.set('draft', { text: 'again' }).then(() => 'saved', (e) => e.name));
  expect(again).toBe('OfflineError');
  await expect(page.getByRole('dialog')).toHaveCount(0);   // shown once per offline episode
  await page.unroute('**/datastore/api/**');
  expect((await page.evaluate(() => store.set('draft', { text: 'precious' }))).version).toBe(2);
});

test('texts follow <html lang> (also when it changes), without it navigator.language', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'fr-FR' });
  const page = await openApp(ctx, w);
  await page.evaluate(() => document.documentElement.setAttribute('lang', 'de'));
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'Daten entsperren' })).toBeVisible();
  await shot(page, 'de-unlock');
  await d.getByRole('button', { name: 'Neuen Tresor anlegen' }).click();
  await d.getByLabel('Beitrittscode').fill('BELIEBIG1');
  await d.getByLabel('Passphrase', { exact: true }).fill('kurz');
  await d.getByLabel('Passphrase wiederholen').fill('kurz');
  await d.getByRole('button', { name: 'Tresor anlegen' }).click();
  await expect(d.getByRole('alert').filter({ hasText: 'Mindestens 12 Zeichen' })).toBeVisible();
  await d.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await d.getByLabel('Passphrase wiederholen').fill(PASS);
  await shot(page, 'de-create');
  await d.getByRole('button', { name: 'Tresor anlegen' }).click();
  await expect(d.getByRole('heading', { name: 'Zugangsblatt sichern' })).toBeVisible();
  await expect(d.getByText('Notfallcode').first()).toBeVisible();
  await shot(page, 'de-sheet');
  await d.getByLabel('Ich habe das Zugangsblatt und den Notfallcode gesichert.').check();
  await d.getByRole('button', { name: 'Weiter' }).click();
  expect((await page.evaluate(() => window.unlockP)).role).toBe('owner');
  await page.evaluate(() => { window.shareP = store.openVault(); });
  await expect(dialog(page).getByRole('heading', { name: 'Tresor' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Schließen' }).first().click();
  await page.evaluate(() => document.documentElement.removeAttribute('lang'));   // no lang: the browser language (French here) is not German, so English
  await page.evaluate(() => { window.shareP = store.openVault(); });
  await expect(dialog(page).getByRole('heading', { name: 'Vault' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Close' }).first().click();
  await page.evaluate(() => document.documentElement.setAttribute('lang', 'de-AT'));
  await page.evaluate(() => { window.shareP = store.openVault(); });
  await expect(dialog(page).getByRole('heading', { name: 'Tresor' })).toBeVisible();
  await expect(dialog(page).getByText('Schlüssel der Fakultät').first()).toBeVisible();
  await shot(page, 'de-share');
});

test('dialog accessibility: role, label, focus trap, inert page, focus restored, escape does not dismiss unlock', async ({ context }) => {
  const page = await openApp(context, w);
  await page.locator('#app-button').focus();
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const d = dialog(page);
  expect(await d.evaluate((n) => n.tagName)).toBe('DIALOG'); // implicit role dialog; the browser makes the rest of the page inert
  const labelledby = await d.getAttribute('aria-labelledby');
  await expect(page.locator('#' + labelledby)).toHaveText('Unlock your data');
  const inertProbe = () => page.evaluate(() => { const b = document.querySelector('#app-button'); b.focus(); return document.activeElement === b; });
  expect(await inertProbe()).toBe(false); // the page behind the modal dialog cannot take focus
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press(i % 2 ? 'Tab' : 'Shift+Tab');
    expect(await page.evaluate(() => !document.activeElement.closest('#app'))).toBe(true); // never reaches the page behind (the browser's own cycle)
  }
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !document.activeElement.closest('#app'))).toBe(true);
  }
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
  await expect(d).toBeVisible();
  // every input has an accessible name
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('.wds-dialog input:not([type=hidden]), .wds-dialog select')].filter((i) => !(i.labels && i.labels.length) && !i.getAttribute('aria-label')).length);
  expect(unnamed).toBe(0);
  await createVaultViaUi(page);
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('app-button'); // focus returned to the opener
  expect(await inertProbe()).toBe(true); // the page is usable again
});

test('the bundle loads from a file:// page with Subresource Integrity, and a wrong hash blocks it', async ({ context }) => {
  const src = w.service + 'client/wds-' + VERSION + '.js';
  const ok = await context.newPage();
  await ok.goto(writePage('sri-ok.html', { src, integrity: SRI }));
  // the vendored hash-wasm runs in a private scope: no global, no test hooks on WDSCore (review finding)
  expect(await ok.evaluate(() => typeof WDS.connect + ' ' + typeof WDSCore.Client + ' ' + typeof hashwasm + ' ' + typeof WDSCore.setRandom + ' ' + typeof WDSCore.internals)).toBe('function function undefined undefined undefined');
  const bad = await context.newPage();
  await bad.goto(writePage('sri-bad.html', { src, integrity: 'sha384-' + 'A'.repeat(64) }));
  expect(await bad.evaluate(() => typeof WDS)).toBe('undefined');
});

test('history dialog: list versions, preview, restore', async ({ context }) => {
  const page = await openApp(context, w);
  const vault = await createVaultViaUi(page);
  await page.evaluate(async () => { await store.set('doc', { t: 'one' }); await store.set('doc', { t: 'two' }); await store.set('doc', { t: 'three' }); });
  await page.evaluate(() => { window.histP = store.showHistory('doc'); });
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'History of this entry' })).toBeVisible();
  await expect(d.locator('li')).toHaveCount(3);
  await d.locator('li').filter({ hasText: 'Version 1' }).getByRole('button', { name: 'Preview' }).click();
  await expect(d.locator('pre')).toContainText('one');
  await shot(page, 'en-history');
  await expect(d.locator('li').filter({ hasText: 'Version 3' }).getByRole('button', { name: 'Restore' })).toBeDisabled();
  await d.locator('li').filter({ hasText: 'Version 1' }).getByRole('button', { name: 'Restore' }).click();
  expect(await page.evaluate(() => window.histP)).toEqual({ restored: 1 });
  expect(await page.evaluate(() => store.get('doc'))).toEqual({ t: 'one' });
  const node = nodeClient(w);
  await node.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  expect((await node.history('doc')).versions.length).toBe(4);
});

test('a pending faculty recovery request is shown at unlock and can be cancelled', async ({ context }) => {
  const page = await openApp(context, w);
  const vault = await createVaultViaUi(page);
  await lockPage(page);
  const v = [...w.world.server.vaults.values()][0];
  v.recovery = { method: 'code', requested: Math.floor(Date.now() / 1000), ready_at: Math.floor(Date.now() / 1000) + 259200 };
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const d = dialog(page);
  await d.getByLabel('Passphrase', { exact: true }).fill(vault.passphrase);
  await d.getByRole('button', { name: 'Unlock' }).click();
  const notice = dialog(page);
  await expect(notice.getByRole('heading', { name: 'A recovery of this vault was requested' })).toBeVisible();
  await shot(page, 'en-recovery-request');
  await notice.getByRole('button', { name: 'Cancel the request' }).click();
  await page.evaluate(() => window.unlockP);
  expect(v.recovery).toBeNull();
  await expect(page.getByText('The recovery request was cancelled.')).toBeVisible();
});

test('an unknown scope is reported, and dark and narrow screens render', async ({ browser }) => {
  const page = await openApp(await browser.newContext(), w, { cfg: { scope: 'nope-k7m2a9' } });
  await page.evaluate(() => { window.unlockP = store.unlock().catch(() => {}); });
  await expect(dialog(page).getByRole('alert').filter({ hasText: 'not registered' })).toBeVisible();
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 390, height: 844 } });
  const p2 = await openApp(ctx, w);
  await p2.evaluate(() => { window.unlockP = store.unlock(); });
  await expect(dialog(p2).getByRole('heading', { name: 'Unlock your data' })).toBeVisible();
  await shot(p2, 'en-unlock-dark-narrow');
  await dialog(p2).getByRole('button', { name: 'Create a new vault' }).click();
  await dialog(p2).getByLabel('Passphrase', { exact: true }).fill(PASS);
  await shot(p2, 'en-create-dark-narrow');
});

test('faculty recovery: the owner is told at unlock, must acknowledge before changing access, and sees the added owner', async ({ browser }) => {
  const page = await openApp(await browser.newContext(), w);
  const vault = await createVaultViaUi(page);
  await page.evaluate(() => store.set('data', { precious: true }));
  const founder = nodeClient(w);
  await founder.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const recoveryCode = await recoverByFaculty(w, founder);
  expect(recoveryCode).toMatch(/^([0-9A-Z]{4}-){11}[0-9A-Z]{4}$/);

  // variant 1: dismiss the notice without acknowledging
  await lockPage(page);
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const d = dialog(page);
  await d.getByLabel('Passphrase', { exact: true }).fill(vault.passphrase);
  await d.getByRole('button', { name: 'Unlock' }).click();
  const notice = dialog(page);
  await expect(notice.getByRole('heading', { name: 'The faculty added an owner access' })).toBeVisible();
  await shot(page, 'en-recovered-notice');
  await notice.getByRole('button', { name: 'Close' }).click();
  await page.evaluate(() => window.unlockP);
  await page.evaluate(() => { window.shareP = store.openVault(); });
  const sd = dialog(page);
  await expect(sd.locator('[data-wds=recovered-notice]')).toBeVisible();
  await expect(sd.getByText('Added by the faculty during a recovery')).toBeVisible();
  await sd.getByRole('button', { name: 'Create invite code' }).click();
  await expect(sd.getByText('Confirm the notice about the faculty access first.')).toBeVisible();
  // acknowledging in the dialog unlocks the owner functions
  await sd.getByRole('button', { name: 'I know about this' }).click();
  await expect(sd.locator('[data-wds=recovered-notice]')).toHaveCount(0);
  await sd.getByRole('button', { name: 'Create invite code' }).click();
  await expect(sd.locator('[data-wds=invite-code]')).toBeVisible();
  await sd.getByRole('button', { name: 'Close' }).click();

  // the acknowledgement is remembered on this device: the next unlock does not show the notice again (review finding)
  await lockPage(page);
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const d2 = dialog(page);
  await d2.getByLabel('Passphrase', { exact: true }).fill(vault.passphrase);
  await d2.getByRole('button', { name: 'Unlock' }).click();
  await page.evaluate(() => window.unlockP);
  await expect(page.locator('[data-wds=recovered-notice]')).toHaveCount(0);
  await page.evaluate(() => { window.shareP = store.openVault(); });
  await expect(dialog(page).getByRole('heading', { name: 'Vault' })).toBeVisible();
  await expect(dialog(page).locator('[data-wds=recovered-notice]')).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Create invite code' }).click();
  await expect(dialog(page).locator('[data-wds=invite-code]')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Close' }).click();

  // the person who holds the recovery code redeems it, becomes an owner and reads the data
  const newOwner = await openApp(await browser.newContext(), w);
  const st = await redeemViaUi(newOwner, recoveryCode, 'brand-new-owner-passphrase');
  expect(st.role).toBe('owner');
  expect(await newOwner.evaluate(() => store.get('data'))).toEqual({ precious: true });
});

test('faculty recovery: the recovered owner can revoke the old owner slot, and the dialog shows IDs next to names', async ({ browser }) => {
  const page = await openApp(await browser.newContext(), w);
  const vault = await createVaultViaUi(page);
  await page.evaluate(() => store.set('data', { precious: true }));
  const founder = nodeClient(w);
  await founder.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const oldSlot = founder.status().slotId;
  const recoveryCode = await recoverByFaculty(w, founder);

  const owner = await openApp(await browser.newContext(), w);
  await redeemViaUi(owner, recoveryCode, 'brand-new-owner-passphrase');
  await owner.evaluate(() => { window.shareP = store.openVault(); });
  const sd = dialog(owner);
  const row = sd.locator('[data-wds=person]').filter({ hasText: 'ID ' + oldSlot.slice(0, 8) });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('Owner')).toBeVisible();
  await expect(sd.getByText('Names are notes kept inside the vault.')).toBeVisible();
  await shot(owner, 'en-share-recovered-owner');
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(sd.getByRole('heading', { name: 'Revoke access?' })).toBeVisible();
  await expect(sd.getByText('including the right to manage who has access')).toBeVisible();
  await expect(sd.locator('[data-wds=revoke-id]')).toContainText(oldSlot.slice(0, 8));
  await shot(owner, 'en-revoke-owner-confirm');
  await sd.getByRole('button', { name: 'Revoke access' }).click();
  await expect(sd.getByText('Access revoked. All data is re-encrypted.')).toBeVisible();
  await expect(sd.locator('[data-wds=person]').filter({ hasText: 'ID ' + oldSlot.slice(0, 8) })).toHaveCount(0);
  await shot(owner, 'en-revoke-owner-done');
  await sd.getByRole('button', { name: 'Close' }).click();
  expect(await owner.evaluate(() => store.get('data'))).toEqual({ precious: true });
  // the old owner credential is gone
  let failure = null;
  try { await nodeClient(w).unlock({ accessId: idOf(vault), passphrase: vault.passphrase }); } catch (e) { failure = e; }
  expect(failure).not.toBeNull();
});

test('own access: change passphrase, lock', async ({ context }) => {
  const page = await openApp(context, w);
  const hibp = await mockHibp(page);
  const vault = await createVaultViaUi(page);
  await page.evaluate(() => store.set('x', { n: 1 }));
  await page.evaluate(() => { window.shareP = store.openVault(); });
  const sd = dialog(page);
  await sd.locator('summary').filter({ hasText: 'Change passphrase' }).click();
  await sd.getByLabel('New passphrase').fill('a-completely-different-passphrase');
  await sd.getByLabel('Repeat passphrase').fill('a-completely-different-passphrase');
  await sd.getByRole('button', { name: 'Change passphrase' }).click();
  await expect(sd.getByText('Passphrase changed.')).toBeVisible();
  expect(hibp.length).toBeGreaterThan(0);
  await expect(sd.getByRole('button', { name: /Renew my keys|Download key file/ })).toHaveCount(0);
  const reloaded = page.waitForEvent('load');
  await sd.getByRole('button', { name: 'Lock now' }).click();   // lock = save what is pending, then reload the page
  await reloaded;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => store.status().unlocked)).toBe(false);
  // the old passphrase no longer works, the new one does, and the data is intact
  await page.evaluate(() => { window.getP = store.get('x'); });
  const d = dialog(page);
  await d.getByLabel('Passphrase', { exact: true }).fill(vault.passphrase);
  await d.getByRole('button', { name: 'Unlock' }).click();
  await expect(d.getByRole('alert').filter({ hasText: 'does not match' })).toBeVisible();
  await d.getByLabel('Passphrase', { exact: true }).fill('a-completely-different-passphrase');
  await d.getByRole('button', { name: 'Unlock' }).click();
  expect(await page.evaluate(() => window.getP)).toEqual({ n: 1 });
});

test('read-only member: no invite section, writes are refused with a notice', async ({ browser }) => {
  const owner = await openApp(await browser.newContext(), w);
  const vault = await createVaultViaUi(owner);
  await owner.evaluate(() => store.set('x', { n: 1 }));
  const ownerNode = nodeClient(w);
  await ownerNode.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const invite = await ownerNode.createInvite({ role: 'read' });
  const member = await openApp(await browser.newContext(), w);
  const st = await redeemViaUi(member, invite.code.display, 'read-only-member-passphrase');
  expect(st.role).toBe('read');
  expect(await member.evaluate(() => store.get('x'))).toEqual({ n: 1 });
  const r = await member.evaluate(() => store.set('x', { n: 2 }).then(() => 'saved', (e) => e.name + ':' + e.code));
  expect(r).toBe('AuthError:forbidden');
  await expect(member.getByText('This access is read-only')).toBeVisible();
  await member.evaluate(() => { window.shareP = store.openVault(); });
  const sd = dialog(member);
  await expect(sd.getByText('You have access as: Read only.')).toBeVisible();
  await expect(sd.getByText('Only the owner can invite people or change who has access.')).toBeVisible();
  await expect(sd.getByRole('heading', { name: 'Invite someone' })).toHaveCount(0);
  await shot(member, 'en-share-member');
});

test('concurrent calls while locked share one unlock dialog', async ({ context }) => {
  const page = await openApp(context, w);
  await page.evaluate(() => { window.calls = Promise.all([store.get('a'), store.set('b', { n: 1 }), store.get('c')]); });
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  const d = dialog(page);
  await d.getByRole('button', { name: 'Create a new vault' }).click();
  await d.getByLabel('Join code').fill('ANYCODE1');
  await d.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await d.getByLabel('Repeat passphrase').fill(PASS);
  await d.getByRole('button', { name: 'Create vault' }).click();
  await d.getByLabel('I have saved the access sheet and the emergency code.').check();
  await d.getByRole('button', { name: 'Continue' }).click();
  const [a, b, c] = await page.evaluate(() => window.calls);
  expect(a).toBeUndefined();
  expect(b.version).toBe(1);
  expect(c).toBeUndefined();
});

test('enrollment by join code, and the breach check being unreachable is reported but does not block', async ({ context }) => {
  const w2 = await startTestWorld({ scope: { join_code: 'ABCDEF23' } });
  try {
    const page = await openApp(context, w2);
    await mockHibp(page, { down: true });
    await page.evaluate(() => { window.unlockP = store.unlock(); });
    const d = dialog(page);
    await d.getByRole('button', { name: 'Create a new vault' }).click();
    await d.getByLabel('Passphrase', { exact: true }).fill(PASS);
    await d.getByLabel('Repeat passphrase').fill(PASS);
    await d.getByRole('button', { name: 'Create vault' }).click();
    await expect(d.getByRole('alert').filter({ hasText: 'Enter the join code.' })).toBeVisible();
    await d.getByLabel('Join code').fill('WRONG-CODE-0');
    await d.getByRole('button', { name: 'Create vault' }).click();
    await expect(d.getByRole('alert').filter({ hasText: 'join code is not correct' })).toBeVisible();
    await d.getByLabel('Join code').fill('abcd-ef23');
    await d.getByRole('button', { name: 'Create vault' }).click();
    await expect(d.getByRole('heading', { name: 'Save your access sheet' })).toBeVisible();
    await expect(d.getByText('the breach check was not available')).toBeVisible();   // the service answered 503: the strict local rules decided
    await shot(page, 'en-sheet-hibp-down');
  } finally { await w2.close(); }
});

test('a paused app, an outdated-library advisory and a suspended scope', async ({ context }) => {
  const w2 = await startTestWorld();
  try {
    w2.world.server.scopes.get(w2.scope).status = 'suspended';
    const orig = w2.world.server.getScope.bind(w2.world.server);
    w2.world.server.getScope = (id) => { const r = orig(id); r.json.library.deprecated = [VERSION]; return r; };
    const page = await openApp(context, w2);
    await page.evaluate(() => { window.unlockP = store.unlock().catch(() => {}); });
    await dialog(page).getByRole('button', { name: 'Create a new vault' }).click();
    await expect(dialog(page).getByText('This app is paused by the faculty. New vaults cannot be created.')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'I already have a vault' }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Unlock your data' })).toBeVisible();
  } finally { await w2.close(); }
  // an existing vault in a deprecated library version: dismissible advisory, never a block
  const w3 = await startTestWorld();
  try {
    const page = await openApp(context, w3);
    const vault = await createVaultViaUi(page);
    const orig = w3.world.server.getScope.bind(w3.world.server);
    w3.world.server.getScope = (id) => { const r = orig(id); r.json.library.deprecated = [VERSION]; r.json.status = 'suspended'; return r; };
    await lockPage(page);
    await unlockViaUi(page, null, vault.passphrase);
    await expect(page.locator('[data-wds-notice=advisory]')).toContainText('outdated version of the storage library');
    await expect(page.locator('[data-wds-notice=suspended]')).toContainText('paused by the faculty');
    await expect(page.locator('[data-wds-notice=advisory]')).toHaveCount(0, { timeout: 12000 });   // a notice is a status line: it goes away by itself
    expect(await page.evaluate(() => store.get('nothing'))).toBeUndefined();
  } finally { await w3.close(); }
});

test('changes saved elsewhere reach onChange on focus (remote: true); interrupted re-encryption resumes at unlock', async ({ browser }) => {
  const page = await openApp(await browser.newContext(), w);
  const vault = await createVaultViaUi(page);
  await page.evaluate(async () => { await store.set('shared', { n: 1 }); await store.set('other', { n: 1 }); });
  const node = nodeClient(w);
  await node.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  await node.get('shared');
  await node.put('shared', { n: 2 });
  await page.evaluate(() => { window.changes = []; store.onChange((c) => window.changes.push(c)); window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => page.evaluate(() => window.changes)).toEqual([{ names: ['shared'], remote: true }]);
  expect(await page.locator('[data-wds-notice=stale]').count()).toBe(0);   // no notice of the library: the app renders on onChange
  await node.put('shared', { n: 3 });
  // revoke from another device without re-encrypting, then unlock here: the library resumes the work and says so
  const inv = await node.createInvite({ role: 'write' });
  const member = nodeClient(w);
  await member.redeemInvite({ inviteCode: inv.code.display, passphrase: 'node member passphrase' });
  await node.revoke(member.status().slotId, { rekey: false });
  const v = [...w.world.server.vaults.values()][0];
  expect(w.world.server.usage(v).json.old_epoch_blobs).toBeGreaterThan(0);
  await lockPage(page);
  await unlockViaUi(page, null, vault.passphrase);
  await expect(page.locator('[data-wds-notice=rekey]')).toContainText('Re-encryption finished');
  expect(w.world.server.usage(v).json.old_epoch_blobs).toBe(0);
  expect(await page.evaluate(() => store.get('shared'))).toEqual({ n: 3 });
});

test('print sheet, and themeable through CSS custom properties', async ({ context }) => {
  const page = await openApp(context, w);
  // stand-in for the print dialog: the sheet is loaded into a hidden iframe whose print() is replaced before the library calls it
  await page.addInitScript(() => {
    document.addEventListener('load', (ev) => {
      if (ev.target && ev.target.tagName === 'IFRAME') ev.target.contentWindow.print = () => { window.__prints = (window.__prints || 0) + 1; };
    }, true);
  });
  await page.reload();
  await page.evaluate(() => document.documentElement.style.setProperty('--wds-accent', 'rgb(200, 0, 0)'));
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const d = dialog(page);
  expect(await d.getByRole('button', { name: 'Unlock' }).evaluate((b) => getComputedStyle(b).backgroundColor)).toBe('rgb(200, 0, 0)');
  await d.getByRole('button', { name: 'Create a new vault' }).click();
  await d.getByLabel('Join code').fill('ANYCODE1');
  await d.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await d.getByLabel('Repeat passphrase').fill(PASS);
  await d.getByRole('button', { name: 'Create vault' }).click();
  await expect(d.getByRole('heading', { name: 'Save your access sheet' })).toBeVisible();
  const accessId = (await d.locator('[data-wds=access-id]').innerText()).trim();
  await d.getByRole('button', { name: 'Print access sheet' }).click();
  await expect.poll(() => page.evaluate(() => window.__prints || 0)).toBe(1);
  expect(await page.locator('iframe[srcdoc]').getAttribute('srcdoc')).toContain(accessId);
});

test('dialogs name a record by the title of its list entry, else "this entry", never by its name; a read member cannot press Restore', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await openApp(ctx, w);
  const vault = await createVaultViaUi(page);
  const name = await page.evaluate(async () => {
    window.books = store.collection('books/', { meta: (v) => ({ title: v.title }) });
    await books.load();
    const added = await books.add({ title: 'My book', t: 'one' });
    await store.set(added.name, { title: 'My book', t: 'two' });
    return added.name;
  });
  await page.evaluate((n) => { window.h1 = store.showHistory(n); }, name);
  await expect(dialog(page).getByRole('heading', { name: 'History of "My book"' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Close' }).first().click();
  await page.evaluate(() => store.set('plain/entry', { t: 1 }));
  await page.evaluate(() => { window.h2 = store.showHistory('plain/entry'); });
  await expect(dialog(page).getByRole('heading', { name: 'History of this entry' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Close' }).first().click();
  // the conflict dialog says "My book", not the record name
  const other = nodeClient(w);
  await other.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  await other.get(name);
  await other.put(name, { title: 'My book', t: 'theirs' });
  await page.evaluate((n) => { window.setP = store.set(n, { title: 'My book', t: 'mine' }); }, name);
  const d = dialog(page);
  await expect(d.getByText('changed "My book" after you last loaded it.')).toBeVisible();
  await expect(d.getByText(name.slice('books/'.length))).toHaveCount(0);
  await d.getByRole('button', { name: 'Keep mine' }).click();
  await page.evaluate(() => window.setP);

  // a read member sees the history but cannot restore
  const ownerNode = nodeClient(w);
  await ownerNode.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  const invite = await ownerNode.createInvite({ role: 'read' });
  const member = await openApp(await browser.newContext(), w);
  await redeemViaUi(member, invite.code.display, 'read-member-passphrase-2');
  await member.evaluate((n) => { window.h = store.showHistory(n); }, name);
  const md = dialog(member);
  await expect(md.locator('li')).toHaveCount(4);
  const restores = md.getByRole('button', { name: 'Restore' });
  for (let i = 0; i < 4; i++) await expect(restores.nth(i)).toBeDisabled();
  await md.getByRole('button', { name: 'Preview' }).first().click();
  await expect(md.locator('pre')).toBeVisible();
  // the owner can restore an old version
  await page.evaluate((n) => { window.h3 = store.showHistory(n); }, name);
  await expect(dialog(page).locator('li').filter({ hasText: 'Version 1' }).getByRole('button', { name: 'Restore' })).toBeEnabled();
});
