// Browser tests of what a person sees in the dialogs of wds-ui.js: layout inside a host page with aggressive global CSS, error
// texts, the language switch, notices. (ui.spec.mjs covers the behaviour; these tests cover the look and the wording.)
import { test, expect } from '@playwright/test';
import { startTestWorld, openApp, mockHibp, dialog, createVaultViaUi, unlockViaUi, lockPage, nodeClient, writePage, core } from './ui-helpers.mjs';

let w;
test.beforeEach(async () => { w = await startTestWorld(); });
test.afterEach(async () => { await w.close(); });

const PASS = 'purple-elephant-marching-slowly';
// What many apps do: every input is a full-width box, every label a block with bold text.
const HOSTILE = 'input,select,textarea{width:100%;min-height:2.5rem;padding:.45rem .6rem;border:1px solid #333;display:block;margin:.3rem 0}' +
  'label{display:block;font-weight:800;font-size:.8rem;margin-top:.5rem;text-transform:uppercase}label>input{margin-top:.25rem}button{min-height:2.5rem}';

// every checkbox row of the open dialog: the box is a normal box, the label sits beside it and inside the dialog
async function checkRows(page) {
  return page.evaluate(() => {
    const dlg = document.querySelector('.wds-dialog').getBoundingClientRect();
    return [...document.querySelectorAll('.wds-dialog .wds-check')].map((row) => {
      const box = row.querySelector('input').getBoundingClientRect(), label = row.querySelector('label').getBoundingClientRect();
      const style = getComputedStyle(row.querySelector('label'));
      return { text: row.querySelector('label').textContent, boxW: box.width, boxH: box.height, boxLeft: box.left, boxRight: box.right,
        labelLeft: label.left, labelRight: label.right, dlgLeft: dlg.left, dlgRight: dlg.right, upper: style.textTransform, weight: style.fontWeight };
    });
  });
}
function expectGoodRows(rows, count) {
  expect(rows.length).toBe(count);
  for (const r of rows) {
    expect(r.boxW, r.text).toBeLessThanOrEqual(24);
    expect(r.boxH, r.text).toBeLessThanOrEqual(24);
    expect(r.labelLeft, r.text).toBeGreaterThanOrEqual(r.boxRight - 1);          // beside the box, not under it
    expect(r.labelLeft - r.boxRight, r.text).toBeLessThan(24);
    expect(r.labelRight, r.text).toBeLessThanOrEqual(r.dlgRight + 1);            // inside the white dialog
    expect(r.boxLeft, r.text).toBeGreaterThanOrEqual(r.dlgLeft);
    expect(r.upper, r.text).toBe('none');
  }
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 800 }]) {
  test('checkbox rows stay intact in a host page with global input and label rules (' + viewport.width + ' px)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport });
    const page = await openApp(ctx, w, { page: writePage('hostile.html', { css: HOSTILE }) });
    await mockHibp(page);
    await page.evaluate(() => { window.unlockP = store.unlock(); });
    const dlg = dialog(page);
    // unlock: "show passphrase"
    await expect(dlg.getByRole('button', { name: 'Create a new vault' })).toBeVisible();
    expectGoodRows(await checkRows(page), 1);
    await dlg.getByRole('button', { name: 'Create a new vault' }).click();
    expectGoodRows(await checkRows(page), 1);
    await dlg.getByLabel('Show passphrase').check();                              // the label is the control's name and clickable
    await expect(dlg.getByLabel('Passphrase', { exact: true })).toHaveAttribute('type', 'text');
    await dlg.getByLabel('Passphrase', { exact: true }).fill(PASS);
    await dlg.getByLabel('Repeat passphrase').fill(PASS);
    await dlg.getByRole('button', { name: 'Create vault' }).click();
    await expect(dlg.getByRole('heading', { name: 'Save your access sheet' })).toBeVisible();
    // the access sheet: the box that has to be ticked before "Continue" works
    expectGoodRows(await checkRows(page), 1);
    const ack = dlg.getByLabel('I have saved the access sheet and the recovery code.');
    await ack.scrollIntoViewIfNeeded();
    await expect(ack).toBeVisible();
    expect((await ack.boundingBox()).width).toBeLessThanOrEqual(24);
    await ack.check();
    await expect(dlg.getByRole('button', { name: 'Continue' })).toBeEnabled();
    await dlg.getByRole('button', { name: 'Continue' }).click();
    await page.evaluate(() => window.unlockP);
    await ctx.close();
  });
}

test('unlocking a deleted vault says that the vault was deleted, not that an invite expired', async ({ browser }) => {
  for (const [locale, deleted, expired] of [['en-US', 'This vault was deleted.', 'invite has expired'], ['de-DE', 'Dieser Tresor wurde gelöscht.', 'Einladung ist abgelaufen']]) {
    const w2 = await startTestWorld();
    try {
      const ctx = await browser.newContext({ locale: 'en-US' });
      const page = await openApp(ctx, w2);
      const vault = await createVaultViaUi(page);
      await lockPage(page);
      const owner = nodeClient(w2);                                               // the owner deletes the vault from another device
      await owner.unlock({ accessId: core.normalizeCode(vault.accessId), passphrase: vault.passphrase });
      await owner.deleteVault();
      await page.evaluate((l) => { document.documentElement.setAttribute('lang', l); window.unlockP = store.unlock().catch(() => {}); }, locale.slice(0, 2));
      const d = dialog(page);
      await d.getByLabel(locale === 'en-US' ? 'Access ID' : 'Zugangskennung').fill(vault.accessId);
      await d.getByLabel(locale === 'en-US' ? 'Passphrase' : 'Passphrase', { exact: true }).fill(vault.passphrase);
      await d.getByRole('button', { name: locale === 'en-US' ? 'Unlock' : 'Entsperren' }).click();
      const alert = d.getByRole('alert').filter({ hasText: deleted });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(locale === 'en-US' ? '30 days' : '30 Tagen');
      await expect(d).not.toContainText(expired);
      await ctx.close();
    } finally { await w2.close(); }
  }
});

test('a wrong join code is reported at the join code field, which takes the focus', async ({ context }) => {
  const w2 = await startTestWorld({ scope: { enrollment: 'join_code', join_code: 'ABCDEF23' } });
  try {
    const page = await openApp(context, w2);
    await mockHibp(page);
    await page.setViewportSize({ width: 390, height: 600 });
    await page.evaluate(() => { window.unlockP = store.unlock(); });
    const d = dialog(page);
    await d.getByRole('button', { name: 'Create a new vault' }).click();
    await d.getByLabel('Join code').fill('WRONG-CODE-0');
    await d.getByLabel('Passphrase', { exact: true }).fill(PASS);
    await d.getByLabel('Repeat passphrase').fill(PASS);
    await d.getByRole('button', { name: 'Create vault' }).click();
    const field = d.locator('.wds-field').first();                                 // the join code is the first field of the form
    await expect(field.getByRole('alert')).toContainText('join code is not correct');
    await expect(d.getByLabel('Join code')).toBeFocused();
    await expect(d.getByLabel('Join code')).toHaveAttribute('aria-invalid', 'true');
    await expect(d.getByRole('alert').filter({ hasText: 'join code is not correct' })).toHaveCount(1);   // not a second time at the bottom
    const box = await d.getByLabel('Join code').boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(600);                           // in view
  } finally { await w2.close(); }
});

test('passphrases: well-known German ones are refused, and without a breach check the rules are stricter', async ({ context }) => {
  const page = await openApp(context, w);
  await mockHibp(page, { down: true });
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const d = dialog(page);
  await d.getByRole('button', { name: 'Create a new vault' }).click();
  const pw = d.getByLabel('Passphrase', { exact: true }), rep = d.getByLabel('Repeat passphrase');
  await pw.fill('ichliebedich123'); await rep.fill('ichliebedich123');
  await d.getByRole('button', { name: 'Create vault' }).click();
  await expect(d.getByRole('alert').filter({ hasText: /common|too easy/ })).toBeVisible();   // locally, before any breach check
  // middling strength and the breach check not reachable: refused with an explanation
  await pw.fill('meinhundheisstmax'); await rep.fill('meinhundheisstmax');
  await d.getByRole('button', { name: 'Create vault' }).click();
  await expect(d.getByRole('alert').filter({ hasText: 'not strong enough' })).toBeVisible();
  await expect(d.getByRole('alert').filter({ hasText: 'not strong enough' })).toContainText('not available');
  await pw.fill(PASS); await rep.fill(PASS);
  await d.getByRole('button', { name: 'Create vault' }).click();
  await expect(d.getByRole('heading', { name: 'Save your access sheet' })).toBeVisible();
});

test('<html lang>: dialogs follow the page language; the faculty key has its own badge; hints sit under their buttons; lock leaves no notice', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1000, height: 900 } });
  const page = await openApp(ctx, w);
  await createVaultViaUi(page);
  await page.evaluate(() => document.documentElement.setAttribute('lang', 'de-AT'));
  await page.evaluate(() => { window.shareP = store.openVault(); });
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'Tresor' })).toBeVisible();
  const escrow = d.locator('[data-wds=person-escrow]');
  await expect(escrow).toContainText('Wiederherstellungsschlüssel der Fakultät');
  await expect(escrow.locator('.wds-badge')).toHaveText('Fakultät, nur zur Wiederherstellung');
  await expect(escrow).not.toContainText('Eigentümer');
  // each explanation directly below its button
  const group = d.locator('.wds-act').filter({ has: page.getByRole('button', { name: 'Meine Schlüssel erneuern' }) });
  await expect(group).toHaveCount(1);
  await expect(group.locator('.wds-hint')).toContainText('Ersetzt die Schlüssel');
  await expect(d.locator('.wds-act').filter({ has: page.getByRole('button', { name: 'Jetzt sperren' }) }).locator('.wds-hint')).toBeVisible();
  // the export reports in the language of the page
  await page.evaluate(() => store.set('a', { x: 1 }));
  await d.getByRole('button', { name: 'Alles exportieren (ZIP, unverschlüsselt)' }).click();
  await expect(d.getByText('Export abgeschlossen: 1 Datensätze.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await lockPage(page);
  await expect(page.locator('.wds-notice')).toHaveCount(0);
  await ctx.close();
});

test('a notice on a 390 px screen stays inside the screen', async ({ browser }) => {
  const first = await openApp(await browser.newContext(), w);
  const vault = await createVaultViaUi(first);
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 700 } });
  const page = await openApp(ctx, w);
  await unlockViaUi(page, vault.accessId, vault.passphrase);   // a new device: a notice
  await expect(page.locator('[data-wds-notice=newdevice]')).toBeVisible();
  const box = await page.locator('.wds-notices').boundingBox();
  expect(box.height).toBeLessThanOrEqual(700 * 0.4 + 2);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await ctx.close();
});
