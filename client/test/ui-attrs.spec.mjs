// Stable attributes on the library's controls (data-wds, data-wds-view) and the sandbox presentation of the dialogs.
import { test, expect } from '@playwright/test';
import { startTestWorld, openApp, mockHibp, shot, dialog, nodeClient, writePage, lockPage } from './ui-helpers.mjs';

let w;
test.beforeEach(async () => { w = await startTestWorld(); });
test.afterEach(async () => { await w.close(); });

const PASS = 'purple-elephant-marching-slowly';
const idOf = (id) => id.replace(/-/g, '');

// The controls of the page's library dialogs: nothing may lack data-wds, the innermost dialog has the expected view and names.
async function check(page, view, names) {
  const r = await page.evaluate(() => {
    const dlgs = Array.from(document.querySelectorAll('[data-wds-view]'));
    const d = dlgs[dlgs.length - 1];
    const missing = Array.from(document.querySelectorAll('.wds-root button, .wds-root input, .wds-root select, .wds-root textarea, .wds-root summary'))
      .filter((e) => !e.getAttribute('data-wds')).map((e) => e.outerHTML.slice(0, 120));
    return { view: d ? d.getAttribute('data-wds-view') : null, names: d ? Array.from(d.querySelectorAll('[data-wds]')).map((e) => e.getAttribute('data-wds')) : [], missing };
  });
  expect(r.missing, 'controls without data-wds in view ' + view).toEqual([]);
  expect(r.view).toBe(view);
  for (const n of names) expect(r.names, 'view ' + view + ' has data-wds=' + n).toContain(n);
  return r;
}
const byWds = (page, name) => dialog(page).locator('[data-wds="' + name + '"]');

// Create a vault using nothing but data-wds selectors (works in any language).
async function createByAttrs(page, { joinCode, pass = PASS } = {}) {
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  await byWds(page, 'to-create').click();
  if (joinCode) await byWds(page, 'join-code').fill(joinCode);
  await byWds(page, 'passphrase').fill(pass);
  await byWds(page, 'passphrase-repeat').fill(pass);
  await byWds(page, 'create-submit').click();
  await expect(byWds(page, 'access-id')).toBeVisible();
  const accessId = (await byWds(page, 'access-id').innerText()).trim();
  return accessId;
}
async function finishSheet(page) {
  await byWds(page, 'sheet-confirm').check();
  await byWds(page, 'sheet-continue').click();
  await page.evaluate(() => window.unlockP);
}

for (const [lang, locale] of [['en', 'en-US'], ['de', 'de-DE']]) {
  test('dialog controls carry data-wds, views carry data-wds-view: unlock flow in ' + lang, async ({ browser }) => {
    const ctx = await browser.newContext({ locale });
    const w2 = await startTestWorld({ scope: { enrollment: 'join_code', join_code: 'ABCDEF23' } });
    try {
      // an unknown scope: the error view
      const bad = await openApp(await browser.newContext({ locale }), w2, { cfg: { scope: 'nope-k7m2a9' } });
      await bad.evaluate(() => { window.unlockP = store.unlock().catch(() => {}); });
      await expect(bad.locator('[data-wds=form-error] [role=alert], [data-wds=form-error]').first()).toBeVisible();
      await check(bad, 'error', ['retry', 'form-error']);

      const page = await openApp(ctx, w2);
      await mockHibp(page);
      await page.evaluate(() => { window.unlockP = store.unlock(); });
      await expect(byWds(page, 'unlock-submit')).toBeVisible();
      await check(page, 'unlock', ['access-id-input', 'keyfile', 'keyfile-button', 'passphrase', 'show-passphrase', 'unlock-submit', 'to-create', 'to-redeem', 'form-error']);
      await byWds(page, 'to-redeem').click();
      await check(page, 'redeem', ['invite-code-input', 'passphrase', 'passphrase-repeat', 'show-passphrase', 'redeem-submit', 'back', 'form-error']);
      await byWds(page, 'back').click();
      await byWds(page, 'to-create').click();
      await check(page, 'create', ['join-code', 'passphrase', 'passphrase-repeat', 'show-passphrase', 'recovery-contact-toggle', 'recovery-contact', 'create-submit', 'back', 'form-error']);
      await byWds(page, 'join-code').fill('abcd-ef23');
      await byWds(page, 'passphrase').fill(PASS); await byWds(page, 'passphrase-repeat').fill(PASS);
      await byWds(page, 'show-passphrase').check();
      await byWds(page, 'create-submit').click();
      await expect(byWds(page, 'access-id')).toBeVisible();
      await check(page, 'sheet', ['access-id', 'recovery-code', 'sheet-keyfile', 'sheet-print', 'sheet-download', 'sheet-confirm', 'sheet-continue', 'form-error']);
      await finishSheet(page);
      expect(await page.evaluate(() => store.status().role)).toBe('owner');
    } finally { await w2.close(); }
  });
}

test('dialog controls carry data-wds: conflict, history, the vault dialog, revoking, the recovery notice, offline, revoked', async ({ browser }) => {
  const page = await openApp(await browser.newContext(), w);
  const accessId = await createByAttrs(page);
  await finishSheet(page);
  const vault = { accessId, passphrase: PASS };
  const other = nodeClient(w);
  await other.unlock({ accessId: idOf(accessId), passphrase: PASS });

  // conflict (set and remove)
  await page.evaluate(() => store.set('note', { t: 1 }));
  await other.get('note'); await other.put('note', { t: 2 });
  await page.evaluate(() => { window.p = store.set('note', { t: 3 }); });
  await expect(byWds(page, 'conflict-mine')).toBeVisible();
  await check(page, 'conflict', ['conflict-theirs', 'conflict-mine', 'conflict-download', 'form-error']);
  await byWds(page, 'conflict-mine').click();
  await page.evaluate(() => window.p);
  await other.get('note'); await other.put('note', { t: 4 });
  await page.evaluate(() => { window.p = store.remove('note'); });
  await expect(byWds(page, 'conflict-theirs')).toBeVisible();
  await check(page, 'conflict', ['conflict-theirs', 'conflict-mine', 'conflict-download']);
  await byWds(page, 'conflict-theirs').click();
  await page.evaluate(() => window.p);

  // history
  await page.evaluate(() => { window.p = store.showHistory('note'); });
  await expect(byWds(page, 'history-restore').first()).toBeVisible();
  const h = await check(page, 'history', ['close', 'form-error', 'history-version', 'history-preview', 'history-restore']);
  expect(h.names.filter((n) => n === 'history-version').length).toBeGreaterThan(1);
  expect(await dialog(page).locator('[data-wds=history-version]').evaluateAll((els) => els.map((e) => e.getAttribute('data-wds-version')))).toEqual(expect.arrayContaining(['1', '2']));
  await byWds(page, 'close').click();
  await page.evaluate(() => window.p);

  // sharing: owner with an unused invite, a redeemed member, an invite code on screen
  await page.evaluate(() => { window.shareP = store.openVault(); });
  await expect(byWds(page, 'invite-create')).toBeVisible();
  await check(page, 'share', ['close', 'form-error', 'invite-role', 'invite-label', 'invite-create', 'me-sheet', 'me-keyfile', 'me-renew', 'me-export', 'me-lock', 'me-passphrase-toggle', 'passphrase', 'passphrase-repeat', 'show-passphrase', 'me-passphrase-submit']);
  await byWds(page, 'invite-label').fill('Anna');
  await byWds(page, 'invite-create').click();
  await expect(byWds(page, 'invite-code')).toBeVisible();
  await check(page, 'share', ['invite-code', 'invite-copy', 'invite-another']);
  const code = (await byWds(page, 'invite-code').innerText()).trim();
  await byWds(page, 'invite-another').click();
  await byWds(page, 'invite-role').selectOption('read');
  await byWds(page, 'invite-create').click();
  await expect(byWds(page, 'invite-code')).toBeVisible();
  await byWds(page, 'invite-another').click();
  await byWds(page, 'close').click();
  const member = nodeClient(w);
  await member.redeemInvite({ inviteCode: code, passphrase: 'member passphrase with words' });
  await page.evaluate(() => { window.shareP = store.openVault(); });
  await expect(byWds(page, 'revoke').first()).toBeVisible({ timeout: 20000 });
  await check(page, 'share', ['person', 'member-role', 'cancel-invite', 'revoke']);
  await byWds(page, 'revoke').first().click();
  await check(page, 'revoke', ['revoke-confirm', 'revoke-cancel', 'revoke-id']);
  await byWds(page, 'revoke-cancel').click();
  await expect(byWds(page, 'invite-create')).toBeVisible();
  await check(page, 'share', ['person']);
  await byWds(page, 'close').click();

  // the access sheet again, from the vault dialog
  await page.evaluate(() => { window.shareP = store.openVault(); });
  await byWds(page, 'me-sheet').click();
  await check(page, 'sheet', ['access-id', 'sheet-keyfile', 'sheet-print', 'sheet-download', 'sheet-continue']);
  expect(await dialog(page).locator('[data-wds=recovery-code], [data-wds=sheet-confirm]').count()).toBe(0);
  await byWds(page, 'sheet-continue').click();
  await check(page, 'share', ['me-sheet']);
  await byWds(page, 'close').click();

  // a recovery request notice
  await lockPage(page);
  const v = [...w.world.server.vaults.values()][0];
  v.recovery = { method: 'code', requested: Math.floor(Date.now() / 1000), ready_at: Math.floor(Date.now() / 1000) + 259200 };
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  await byWds(page, 'access-id-input').fill(vault.accessId);
  await byWds(page, 'passphrase').fill(PASS);
  await byWds(page, 'unlock-submit').click();
  await expect(byWds(page, 'recovery-cancel')).toBeVisible();
  await check(page, 'notice', ['recovery-cancel', 'recovery-keep', 'close', 'form-error']);
  await byWds(page, 'recovery-keep').click();
  await page.evaluate(() => window.unlockP);

  // offline with an unsaved value: a dialog with the backup and a retry
  await page.route('**/datastore/api/**', (route) => route.abort('internetdisconnected'));
  await page.evaluate(() => store.set('draft', { x: 1 }).catch(() => {}));
  await expect(byWds(page, 'offline-retry')).toBeVisible();
  await check(page, 'offline', ['offline-retry', 'backup', 'close']);
  await byWds(page, 'close').click();
  await page.unroute('**/datastore/api/**');
});

test('a revoked access ends with a dialog (backup, OK) and a reload; notices carry no controls', async ({ browser }) => {
  const page = await openApp(await browser.newContext(), w);
  const accessId = await createByAttrs(page);
  await finishSheet(page);
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(accessId), passphrase: PASS });
  const inv = await owner.createInvite({ role: 'write' });
  const m = await openApp(await browser.newContext(), w);
  await m.evaluate(() => { window.unlockP = store.unlock(); });
  await byWds(m, 'to-redeem').click();
  await byWds(m, 'invite-code-input').fill(inv.code.display);
  await byWds(m, 'passphrase').fill('member passphrase with words'); await byWds(m, 'passphrase-repeat').fill('member passphrase with words');
  await byWds(m, 'redeem-submit').click();
  await finishSheet(m);
  expect(await m.evaluate(() => document.documentElement.getAttribute('data-wds-role'))).toBe('write');
  await m.evaluate(() => { window.h = store.autosave('draft', () => ({ x: 1 }), { delayMs: 60000 }); h.changed(); });
  await owner.revoke(owner.members().find((x) => !x.self && !x.escrow).slotId);
  await m.evaluate(() => store.get('anything').catch(() => {}));
  await expect(byWds(m, 'end-ok')).toBeVisible();
  await check(m, 'revoked', ['backup', 'end-ok']);
  expect(await m.evaluate(() => document.documentElement.hasAttribute('data-wds-role'))).toBe(false);
  const loaded = m.waitForEvent('load');
  await byWds(m, 'end-ok').click();
  await loaded;
  expect(await m.evaluate(() => store.status().unlocked)).toBe(false);
  // a notice has no control and takes no click
  await m.evaluate(() => { window.unlockP = store.unlock().catch(() => {}); });
  await expect(byWds(m, 'unlock-submit')).toBeVisible();
});

test('a read-only member: the sharing dialog has only the own-access controls', async ({ browser }) => {
  const page = await openApp(await browser.newContext(), w);
  const accessId = await createByAttrs(page);
  await finishSheet(page);
  const owner = nodeClient(w);
  await owner.unlock({ accessId: idOf(accessId), passphrase: PASS });
  const inv = await owner.createInvite({ role: 'read' });
  const m = await openApp(await browser.newContext(), w);
  await m.evaluate(() => { window.unlockP = store.unlock(); });
  await byWds(m, 'to-redeem').click();
  await byWds(m, 'invite-code-input').fill(inv.code.display);
  await byWds(m, 'passphrase').fill('member passphrase with words'); await byWds(m, 'passphrase-repeat').fill('member passphrase with words');
  await byWds(m, 'redeem-submit').click();
  await expect(byWds(m, 'sheet-confirm')).toBeVisible();
  await check(m, 'sheet', ['access-id', 'sheet-keyfile', 'sheet-confirm', 'sheet-continue']);
  expect(await dialog(m).locator('[data-wds=recovery-code]').count()).toBe(0);
  await finishSheet(m);
  await m.evaluate(() => { window.shareP = store.openVault(); });
  await expect(byWds(m, 'me-keyfile')).toBeVisible();
  const r = await check(m, 'share', ['me-sheet', 'me-keyfile', 'me-renew', 'me-export', 'me-lock', 'me-passphrase-toggle']);
  expect(r.names).not.toContain('invite-create');
});

// ---------------------------------------------------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------------------------------------------------
async function sandboxWorld(extra) {
  await w.close();
  w = await startTestWorld({ scope: Object.assign({ hibp: false, sandbox: { next_wipe: Math.floor(Date.now() / 1000) + 6 * 3600, last_wipe: null } }, extra || {}) });
  return w;
}
const HIDE_CSS = '[data-wds=sandbox-banner],[data-wds=sandbox-badge],.wds-msg{display:none!important;visibility:hidden!important;opacity:0!important}';

for (const [lang, locale, t] of [
  ['en', 'en-US', { unlock: 'Sandbox: Unlock your data', create: 'Sandbox: Create your vault', btn: 'Create sandbox vault', sheet: 'Sandbox access (deleted tonight)', note: 'No recovery in the sandbox; this vault is deleted tonight.', banner: 'Sandbox for testing.', badge: 'Sandbox', escrow: 'the sandbox offers no recovery' }],
  ['de', 'de-DE', { unlock: 'Testumgebung: Daten entsperren', create: 'Testumgebung: Tresor anlegen', btn: 'Testtresor anlegen', sheet: 'Zugang zur Testumgebung (wird heute Nacht gelöscht)', note: 'Keine Wiederherstellung in der Testumgebung; dieser Tresor wird heute Nacht gelöscht.', banner: 'Testumgebung. Hier kann jede Person', badge: 'Testumgebung', escrow: 'die Testumgebung bietet keine Wiederherstellung' }],
]) {
  test('sandbox scope: titles, banner, create button, no recovery, corner badge (' + lang + ')', async ({ browser }) => {
    await sandboxWorld();
    const page = await openApp(await browser.newContext({ locale }), w, { page: writePage('sandbox-' + lang + '.html', { css: HIDE_CSS, lang }) });
    await page.evaluate(() => { window.unlockP = store.unlock(); });
    await expect(byWds(page, 'unlock-submit')).toBeVisible();
    await expect(dialog(page).locator('h2')).toHaveText(t.unlock);
    // the host page tries to hide the banner: inline !important styles win
    const banner = dialog(page).locator('[data-wds=sandbox-banner]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(t.banner);
    expect(await banner.evaluate((e) => ['display', 'visibility', 'opacity'].map((p) => e.style.getPropertyPriority(p)))).toEqual(['important', 'important', 'important']);
    // many apps share the sandbox scope: the line names the page as well (document.title), then the scope
    await expect(dialog(page).locator('.wds-sub').first()).toHaveText('App: wds ui test – Test');
    await shot(page, lang + '-sandbox-unlock');
    await byWds(page, 'to-create').click();
    await expect(dialog(page).locator('h2')).toHaveText(t.create);
    await expect(dialog(page).locator('[data-wds=sandbox-banner]')).toBeVisible();
    await expect(byWds(page, 'create-submit')).toHaveText(t.btn);
    expect(await dialog(page).locator('[data-wds=recovery-contact], [data-wds=recovery-contact-toggle]').count()).toBe(0);
    await check(page, 'create', ['passphrase', 'passphrase-repeat', 'create-submit', 'back', 'sandbox-banner']);
    await expect(dialog(page).locator('.wds-box')).toContainText(t.escrow);   // no promise of a recovery that the sandbox does not offer
    await shot(page, lang + '-sandbox-create');
    await byWds(page, 'passphrase').fill(PASS); await byWds(page, 'passphrase-repeat').fill(PASS);
    await byWds(page, 'create-submit').click();
    await expect(byWds(page, 'access-id')).toBeVisible();
    await expect(dialog(page).locator('h2')).toHaveText(t.sheet);
    await expect(dialog(page).getByText(t.note)).toBeVisible();
    expect(await dialog(page).locator('[data-wds=recovery-code]').count()).toBe(0);
    await check(page, 'sheet', ['access-id', 'sheet-keyfile', 'sheet-confirm', 'sheet-continue', 'sandbox-banner']);
    await shot(page, lang + '-sandbox-sheet');
    await expect(dialog(page).locator('dl dd').first()).toHaveText('wds ui test – Test');
    expect(await byWds(page, 'access-id').evaluate((e) => getComputedStyle(e).whiteSpace)).toBe('nowrap');   // a code is not broken over two lines
    const kf = page.waitForEvent('download');
    await byWds(page, 'sheet-keyfile').click();
    expect((await kf).suggestedFilename()).toMatch(/^wds-ui-test-[a-z0-9-]+-[A-Z0-9]{4}\.wds\.json$/);   // the file name carries the page, too
    const dl = page.waitForEvent('download');
    await byWds(page, 'sheet-download').click();
    const sheetHtml = await (await dl).createReadStream().then((s) => new Promise((res) => { let b = ''; s.on('data', (c) => { b += c; }); s.on('end', () => res(b)); }));
    expect(sheetHtml).toContain(t.note);
    expect(sheetHtml).not.toMatch(/<th scope="row">(Wiederherstellungscode|Recovery code)</);   // the row of the code is gone
    await finishSheet(page);
    // after unlock: a corner badge stays for the whole session; the host page cannot hide it, and it takes no click
    const badge = page.locator('[data-wds=sandbox-badge]');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(t.badge);
    expect(await badge.evaluate((e) => getComputedStyle(e).position)).toBe('fixed');
    expect(await badge.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe('none');
    expect(await badge.evaluate((e) => e.style.getPropertyPriority('display'))).toBe('important');
    expect(await page.evaluate(() => document.documentElement.style.paddingTop)).toBe('');   // the page is not moved
    await shot(page, lang + '-sandbox-badge');
    expect(await page.evaluate(() => store.status().sandbox)).toBe(true);
    await lockPage(page);
    await expect(badge).toHaveCount(0);   // the reloaded page shows nothing of the vault until it is unlocked
  });
}

test('a normal scope shows none of the sandbox marks; status().sandbox is false', async ({ browser }) => {
  const page = await openApp(await browser.newContext(), w);
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  await expect(dialog(page).locator('h2')).toHaveText('Unlock your data');
  expect(await page.locator('[data-wds=sandbox-banner]').count()).toBe(0);
  await byWds(page, 'to-create').click();
  await expect(byWds(page, 'create-submit')).toHaveText('Create vault');
  expect(await dialog(page).locator('[data-wds=recovery-contact]').count()).toBe(1);
  await byWds(page, 'passphrase').fill(PASS); await byWds(page, 'passphrase-repeat').fill(PASS);
  await mockHibp(page);
  await byWds(page, 'create-submit').click();
  await expect(byWds(page, 'recovery-code')).toBeVisible();
  await finishSheet(page);
  expect(await page.locator('[data-wds=sandbox-badge]').count()).toBe(0);
  expect(await page.evaluate(() => store.status().sandbox)).toBe(false);
});

test('sandbox: an access ID remembered from before the last wipe opens the create view with a notice', async ({ browser }) => {
  await sandboxWorld();
  const ctx = await browser.newContext();
  const page = await openApp(ctx, w);
  await createByAttrs(page);
  await finishSheet(page);
  expect(await page.evaluate((s) => localStorage.getItem('wds:' + s + ':access_id'), w.scope)).toContain('"t"');
  // the nightly wipe ran after this device last unlocked
  w.world.server.scopes.get(w.scope).sandbox.last_wipe = Math.floor(Date.now() / 1000) + 60;
  const p2 = await openApp(ctx, w);
  await p2.evaluate(() => { window.unlockP = store.unlock(); });
  await expect(dialog(p2).locator('h2')).toHaveText('Sandbox: Create your vault');
  await expect(dialog(p2).getByText('The sandbox was emptied on')).toBeVisible();
  expect(await p2.evaluate((s) => localStorage.getItem('wds:' + s + ':access_id'), w.scope)).toBeNull();
  // an ID remembered after the wipe is kept
  w.world.server.scopes.get(w.scope).sandbox.last_wipe = Math.floor(Date.now() / 1000) - 3600;
  const ctx2 = await browser.newContext();
  const p3 = await openApp(ctx2, w);
  await createByAttrs(p3);
  await finishSheet(p3);
  const p4 = await openApp(ctx2, w);
  await p4.evaluate(() => { window.unlockP = store.unlock(); });
  await expect(dialog(p4).locator('h2')).toHaveText('Sandbox: Unlock your data');
  await expect(byWds(p4, 'access-id-input')).not.toHaveValue('');
});

test('sandbox: an unlocked session whose vault disappeared after the wipe time reloads the page, which reports the sandbox as emptied', async ({ browser }) => {
  await sandboxWorld({ sandbox: { next_wipe: Math.floor(Date.now() / 1000) + 2, last_wipe: null } });
  const page = await openApp(await browser.newContext(), w);
  await createByAttrs(page);
  await finishSheet(page);
  await page.waitForTimeout(2500);
  w.world.server.wipe(w.scope);
  w.world.server.scopes.get(w.scope).sandbox.last_wipe = Math.floor(Date.now() / 1000) + 60;
  const loaded = page.waitForEvent('load');
  const err = await page.evaluate(() => store.get('x').then(() => null, (e) => e.name));
  expect(err).toBe('AuthError');
  await loaded;
  expect(await page.evaluate(() => store.status().unlocked)).toBe(false);
  await page.evaluate(() => { window.unlockP = store.unlock().catch(() => {}); });
  await expect(dialog(page).getByText('The sandbox was emptied on')).toBeVisible();
  await expect(page.locator('[data-wds=sandbox-badge]')).toHaveCount(0);
});

test('sandbox: a full sandbox says that it is emptied every night', async ({ browser }) => {
  await sandboxWorld({ limits: { max_vaults: 0 } });
  const page = await openApp(await browser.newContext(), w);
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  await byWds(page, 'to-create').click();
  await byWds(page, 'passphrase').fill(PASS); await byWds(page, 'passphrase-repeat').fill(PASS);
  await byWds(page, 'create-submit').click();
  await expect(dialog(page).locator('[data-wds=form-error]')).toContainText('The sandbox is emptied every night.');
});

test('sandbox: the share dialog offers only "until the wipe", and that invite is accepted; close to the wipe it says that no invite can be made', async ({ browser }) => {
  const nextWipe = Math.floor(Date.now() / 1000) + 6 * 3600;
  await sandboxWorld({ sandbox: { next_wipe: nextWipe, last_wipe: null } });
  const page = await openApp(await browser.newContext(), w);
  await createByAttrs(page);
  await finishSheet(page);
  await page.evaluate(() => { window.shareP = store.openVault(); });
  await expect(byWds(page, 'invite-create')).toBeVisible();
  await byWds(page, 'invite-create').click();
  await expect(byWds(page, 'invite-code')).toBeVisible();   // the server (fake) refuses an invite that outlives the wipe
  const code = (await byWds(page, 'invite-code').innerText()).trim();
  await byWds(page, 'close').click();
  const member = nodeClient(w);
  await member.redeemInvite({ inviteCode: code, passphrase: 'member passphrase with words' });
  expect(member.status().role).toBe('write');

  // 30 minutes before the wipe: not enough for the shortest invite (one hour)
  w.world.server.scopes.get(w.scope).sandbox.next_wipe = Math.floor(Date.now() / 1000) + 1800;
  const p2 = await openApp(page.context(), w);
  await p2.evaluate(() => { window.unlockP = store.unlock(); });
  await byWds(p2, 'passphrase').fill(PASS);
  await byWds(p2, 'unlock-submit').click();
  await p2.evaluate(() => window.unlockP);
  await p2.evaluate(() => { window.shareP = store.openVault(); });
  await expect(dialog(p2).getByText('An invite must be valid for at least one hour')).toBeVisible();
  expect(await byWds(p2, 'invite-create').count()).toBe(0);
});

test('sandbox: a vault that was swept after the dialog opened fails the unlock; the next start reports it as emptied', async ({ browser }) => {
  await sandboxWorld();
  const ctx = await browser.newContext();
  const page = await openApp(ctx, w);
  await createByAttrs(page);
  await finishSheet(page);
  const p2 = await openApp(ctx, w);
  await p2.evaluate(() => { window.unlockP = store.unlock(); });
  await expect(dialog(p2).locator('h2')).toHaveText('Sandbox: Unlock your data');
  // the wipe time passed and the sweep ran while the dialog was open
  w.world.server.wipe(w.scope);
  w.world.server.scopes.get(w.scope).sandbox.last_wipe = Math.floor(Date.now() / 1000) + 60;
  await byWds(p2, 'passphrase').fill(PASS);
  await byWds(p2, 'unlock-submit').click();
  await expect(byWds(p2, 'form-error')).not.toBeEmpty();
  const p3 = await openApp(ctx, w);
  await p3.evaluate(() => { window.unlockP = store.unlock(); });
  await expect(dialog(p3).locator('h2')).toHaveText('Sandbox: Create your vault');
  await expect(dialog(p3).getByText('The sandbox was emptied on')).toBeVisible();
});

test('data-wds-view is never empty or missing while a dialog is visible; aria-busy marks loading, progress and a submit in flight', async ({ browser }) => {
  const page = await openApp(await browser.newContext(), w);
  await mockHibp(page);
  await page.evaluate(() => {
    window.seen = [];
    new MutationObserver(() => { document.querySelectorAll('dialog.wds-dialog').forEach((d) => window.seen.push([d.getAttribute('data-wds-view'), d.getAttribute('aria-busy')])); })
      .observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-wds-view', 'aria-busy'] });
  });
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  await expect(dialog(page)).toHaveAttribute('data-wds-view', 'unlock');
  await expect(dialog(page)).not.toHaveAttribute('aria-busy', /.*/);       // a view with its controls is ready
  await byWds(page, 'to-create').click();
  await byWds(page, 'passphrase').fill(PASS); await byWds(page, 'passphrase-repeat').fill(PASS);
  w.world.server.delayMs = 400;                                            // the vault creation request takes a moment
  await byWds(page, 'create-submit').click();
  await expect(dialog(page)).toHaveAttribute('aria-busy', 'true');         // Argon2id and the request: not ready
  await expect(dialog(page)).toHaveAttribute('data-wds-view', 'create');
  await expect(byWds(page, 'access-id')).toBeVisible();
  w.world.server.delayMs = 0;
  await expect(dialog(page)).toHaveAttribute('data-wds-view', 'sheet');
  await expect(dialog(page)).not.toHaveAttribute('aria-busy', /.*/);
  await byWds(page, 'sheet-confirm').check(); await byWds(page, 'sheet-continue').click();
  await page.evaluate(() => window.unlockP);
  const seen = await page.evaluate(() => window.seen);
  expect(seen.length).toBeGreaterThan(2);
  for (const [view] of seen) expect(view).toBeTruthy();
  expect(seen.some(([view, busy]) => view === 'loading' && busy === 'true')).toBe(true);
});

test('share dialog: aria-busy until the roster is refreshed; what the person chose in the invite form survives the refresh, with the focus', async ({ browser }) => {
  const page = await openApp(await browser.newContext(), w);
  await createByAttrs(page);
  await finishSheet(page);
  let release; w.world.server.gate = { path: '/slots/', until: new Promise((res) => { release = res; }) };   // the refresh of the roster (maintain) is held back
  await page.evaluate(() => { window.shareP = store.openVault(); });
  await expect(byWds(page, 'invite-create')).toBeVisible();
  await expect(dialog(page)).toHaveAttribute('aria-busy', 'true');
  await byWds(page, 'invite-role').selectOption('read');
  await byWds(page, 'invite-label').fill('Zoe');   // typing in the label leaves the focus there
  await expect(dialog(page)).toHaveAttribute('aria-busy', 'true');   // still waiting: the refresh did not come before the input
  release(); w.world.server.gate = null;
  await expect(dialog(page)).not.toHaveAttribute('aria-busy', /.*/);
  await expect(byWds(page, 'invite-role')).toHaveValue('read');
  await expect(byWds(page, 'invite-label')).toHaveValue('Zoe');
  await expect(byWds(page, 'invite-label')).toBeFocused();
  await byWds(page, 'invite-create').click();
  await expect(byWds(page, 'invite-code')).toBeVisible();
  await expect(byWds(page, 'member-role')).toHaveValue('read');
  await expect(byWds(page, 'person').filter({ hasText: 'Zoe' })).toHaveCount(1);
  await byWds(page, 'invite-another').click();   // the form starts again after an invite was created
  await expect(byWds(page, 'invite-role')).toHaveValue('write');
  await expect(byWds(page, 'invite-label')).toHaveValue('');
});
