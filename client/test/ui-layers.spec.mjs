// Library dialogs, toasts and the sandbox bar in the top layer: they work above a modal <dialog> of the app (design A of round F).
import { test, expect } from '@playwright/test';
import { startTestWorld, openApp, dialog, createVaultViaUi, nodeClient, pixelAt, writePage } from './ui-helpers.mjs';

let w;
test.beforeEach(async () => { w = await startTestWorld(); });
test.afterEach(async () => { await w.close(); });

const idOf = (v) => v.accessId.replace(/-/g, '');
const wds = (page, name) => page.locator('dialog.wds-dialog [data-wds="' + name + '"]').last();

// An app dialog opened with showModal(), with a form inside and a click-outside handler (a common pattern).
async function openAppModal(page, id = 'appdlg') {
  await page.evaluate((id) => {
    const d = document.createElement('dialog');
    d.id = id;
    d.innerHTML = '<p>App dialog</p><input id="' + id + '-input"><button id="' + id + '-ok" type="button">App OK</button><button id="' + id + '-close" type="button">App close</button>';
    d.querySelector('#' + id + '-close').addEventListener('click', () => d.close());
    d.addEventListener('click', (ev) => { const r = d.getBoundingClientRect(); if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) { d.close(); window.appDialogClosedByOutsideClick = true; } });
    document.body.appendChild(d);
    d.showModal();
  }, id);
}
const appModalOpen = (page, id = 'appdlg') => page.evaluate((id) => !!document.getElementById(id) && document.getElementById(id).open, id);
const unauthorized = async (page) => {   // every record request answers 401: the session counts as expired
  await page.route(/\/records\//, (route) => route.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'www-authenticate': 'Bearer realm="wds"' }, body: '{"error":"unauthorized"}' }));
};

test('a conflict dialog above an app modal is clickable and decides; the app modal stays open underneath', async ({ context }) => {
  const page = await openApp(context, w);
  const vault = await createVaultViaUi(page);
  await page.evaluate(() => store.set('note', { text: 'v1' }));
  const other = nodeClient(w);
  await other.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  await other.get('note');
  await other.put('note', { text: 'theirs v2' });
  await openAppModal(page);
  await page.evaluate(() => { window.setP = store.set('note', { text: 'mine v2' }); });
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'Another device or person saved a newer version' })).toBeVisible();
  await d.getByRole('button', { name: 'Keep mine' }).click();            // no force: the dialog receives the click
  expect((await page.evaluate(() => window.setP)).resolution).toBe('mine');
  expect(await appModalOpen(page)).toBe(true);
  await expect(page.getByRole('button', { name: 'App OK' })).toBeEnabled();   // the app modal is usable again
  await page.locator('#appdlg-ok').click();
});

test('an app dialog that opens after a library dialog does not cover it: the library dialog goes on top again', async ({ context }) => {
  const page = await openApp(context, w);
  await createVaultViaUi(page);
  await page.evaluate(() => { window.shareP = store.share(); });
  await expect(dialog(page).getByRole('heading', { name: 'Sharing and access' })).toBeVisible();
  await openAppModal(page, 'late');   // opened after ours, e.g. an error dialog in a catch
  await page.locator('dialog.wds-dialog [data-wds=close]').click({ timeout: 5000 });   // clickable without force
  await page.evaluate(() => window.shareP);
  expect(await appModalOpen(page, 'late')).toBe(true);
  await page.locator('#late-ok').click();   // and the app dialog is usable once ours is gone
});

test('an app dialog element that was open before, closed and opened again while a library dialog is open, covers nothing: the library dialog goes on top again', async ({ context }) => {
  const page = await openApp(context, w);
  await createVaultViaUi(page);
  await openAppModal(page, 'reused');     // an error box that the app reuses: open once ...
  await page.locator('#reused-close').click();
  await page.evaluate(() => { window.shareP = store.share(); });
  await expect(dialog(page).getByRole('heading', { name: 'Sharing and access' })).toBeVisible();
  await page.evaluate(() => document.getElementById('reused').showModal());   // ... and shown again above the library dialog
  await page.locator('dialog.wds-dialog [data-wds=close]').click({ timeout: 5000 });   // clickable without force
  await page.evaluate(() => window.shareP);
  expect(await appModalOpen(page, 'reused')).toBe(true);
  await page.locator('#reused-ok').click();
});

test('unlock dialog after an expired session, above an app modal that is still open; onLock ran; the session toast is usable', async ({ context }) => {
  const page = await openApp(context, w);
  const vault = await createVaultViaUi(page);
  await page.evaluate(() => { window.locks = []; store.onLock((r) => { window.locks.push(r); window.relock = store.unlock().then(() => 'unlocked', (e) => e.code); }); });
  await page.evaluate(() => { window.shareP = store.share(); });
  await expect(dialog(page).getByRole('heading', { name: 'Sharing and access' })).toBeVisible();
  await page.evaluate(() => document.querySelector('dialog.wds-dialog [data-wds=close]').click());
  await page.evaluate(() => { window.shareP = store.share(); });
  await openAppModal(page);
  await unauthorized(page);
  const err = await page.evaluate(() => store.get('x').then(() => null, (e) => e.name));
  expect(err).toBe('AuthError');
  expect(await page.evaluate(() => window.locks)).toEqual(['expired']);
  await page.evaluate(() => window.shareP);                       // the share dialog was closed by the lock: its promise settled
  expect(await page.locator('dialog.wds-dialog').count()).toBe(1); // only the unlock dialog
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'Unlock your data' })).toBeVisible();
  await expect(page.locator('[data-wds-toast=session]')).toBeVisible();      // the session notice is hosted in the dialog on top
  await page.unroute(/\/records\//);
  await d.getByLabel('Passphrase', { exact: true }).fill(vault.passphrase);
  await d.getByRole('button', { name: 'Unlock' }).click();          // no force
  expect(await page.evaluate(() => window.relock)).toBe('unlocked');
  expect(await appModalOpen(page)).toBe(true);
});

test('a toast with an action is clickable above an app modal, and a click on it does not reach the modal', async ({ context }) => {
  const page = await openApp(context, w);
  await createVaultViaUi(page);
  await openAppModal(page);
  await page.route(/\/records\//, (route) => route.abort('connectionrefused'));
  const err = await page.evaluate(() => store.set('draft', { text: 'unsaved' }).then(() => null, (e) => e.name));
  expect(err).toBe('OfflineError');
  const action = page.locator('[data-wds-toast=offline] [data-wds=toast-action]');
  await expect(action).toBeVisible();
  const download = page.waitForEvent('download');
  await action.click();                                            // no force
  await download;
  expect(await appModalOpen(page)).toBe(true);
  expect(await page.evaluate(() => window.appDialogClosedByOutsideClick)).toBeUndefined();   // the region stops the click
  await page.locator('[data-wds-toast=offline] [data-wds=toast-dismiss]').click();
  await expect(page.locator('[data-wds-toast=offline]')).toHaveCount(0);
});

test('an app modal that closes while a toast is shown inside it: the toast is back in the page and visible; a removed host is repaired', async ({ context }) => {
  const page = await openApp(context, w);
  await createVaultViaUi(page);
  await openAppModal(page);
  await page.route(/\/records\//, (route) => route.abort('connectionrefused'));
  await page.evaluate(() => store.set('draft', { text: 'unsaved' }).then(() => null, (e) => e.name));
  const toast = page.locator('[data-wds-toast=offline]');
  await expect(toast).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('.wds-toasts').parentElement.id)).toBe('appdlg');
  await page.locator('#appdlg-close').click();
  await expect(toast).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('.wds-toasts').parentElement === document.body)).toBe(true);
  // the host dialog is destroyed without a close event
  await openAppModal(page, 'second');
  await expect(toast).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('.wds-toasts').parentElement.id)).toBe('second');
  await page.evaluate(() => { const d = document.getElementById('second'); d.innerHTML = 'rebuilt'; d.remove(); });
  await expect(toast).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('.wds-toasts').isConnected)).toBe(true);
});

test('Escape: a mandatory dialog stays (also with the focus on the page body), a cancelable one closes and rejects with "cancelled"', async ({ context }) => {
  const page = await openApp(context, w);
  await page.evaluate(() => { window.unlockP = store.unlock().then(() => 'unlocked', (e) => e.code); });
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'Unlock your data' })).toBeVisible();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
  await expect(d).toBeVisible();
  await expect(d).toHaveAttribute('data-wds-view', 'unlock');
  await page.evaluate(() => { document.activeElement.blur(); });   // nothing focused: the keydown goes to the body
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
  await expect(d).toBeVisible();
  await expect(d).toHaveAttribute('data-wds-view', 'unlock');
  expect(await page.evaluate(() => document.querySelectorAll('dialog.wds-dialog').length)).toBe(1);
  // finish the unlock, then a cancelable one
  const vault = await createVaultViaUi(page);
  expect(vault.accessId).toBeTruthy();
  await page.evaluate(() => store.lock());
  await page.evaluate(() => { window.cancelP = store.unlock({ cancelable: true }).then(() => 'unlocked', (e) => e.code); });
  await expect(dialog(page)).toBeVisible();
  await page.evaluate(() => { document.activeElement.blur(); });
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.cancelP)).toBe('cancelled');
  await expect(page.locator('dialog.wds-dialog')).toHaveCount(0);
});

test('focus returns to the button that opened share(); nested library dialogs: only the top one is usable, closing it focuses the one below', async ({ context }) => {
  const page = await openApp(context, w);
  const vault = await createVaultViaUi(page);
  await page.locator('#app-button').focus();
  await page.evaluate(() => { window.shareP = store.share(); });
  const share = dialog(page);
  await expect(share.getByRole('heading', { name: 'Sharing and access' })).toBeVisible();
  // a conflict opens above the share dialog
  await page.evaluate(() => store.set('note', { text: 'v1' }));
  const other = nodeClient(w);
  await other.unlock({ accessId: idOf(vault), passphrase: vault.passphrase });
  await other.get('note'); await other.put('note', { text: 'theirs' });
  await page.evaluate(() => { window.setP = store.set('note', { text: 'mine' }); });
  await expect(page.locator('dialog.wds-dialog')).toHaveCount(2);
  const top = dialog(page);
  await expect(top).toHaveAttribute('data-wds-view', 'conflict');
  expect(await page.evaluate(() => { const d = document.querySelectorAll('dialog.wds-dialog'); return [d[0].matches(':modal'), d[1].matches(':modal')]; })).toEqual([true, true]);
  // the dialog below is inert: its close button cannot take focus
  expect(await page.evaluate(() => { const b = document.querySelector('dialog.wds-dialog [data-wds=close]'); b.focus(); return document.activeElement === b; })).toBe(false);
  await top.getByRole('button', { name: 'Keep theirs' }).click();
  await page.evaluate(() => window.setP);
  await expect(page.locator('dialog.wds-dialog')).toHaveCount(1);
  expect(await page.evaluate(() => !!document.activeElement.closest('dialog.wds-dialog') && document.activeElement.closest('dialog').getAttribute('data-wds-view'))).toBe('share');
  await share.locator('[data-wds=close]').click();
  await page.evaluate(() => window.shareP);
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('app-button');
});

test('hostile app CSS for dialog does not change the box or hide the backdrop', async ({ context }) => {
  const css = [
    'dialog{padding:3rem;max-width:200px;border:5px solid red;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;opacity:0;transition:opacity .5s;overflow:hidden;width:200px;height:100px;margin:0}',
    'dialog.open{opacity:1}', 'dialog::backdrop{background:transparent}', 'dialog[open]{opacity:0}',
  ].join('');
  const page = await openApp(context, w, { page: writePage('hostile.html', { css }) });
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'Unlock your data' })).toBeVisible();
  const r = await page.evaluate(() => {
    const el = document.querySelector('dialog.wds-dialog'), cs = getComputedStyle(el), b = el.getBoundingClientRect();
    return { opacity: cs.opacity, padding: cs.padding, border: cs.borderTopWidth, transform: cs.transform, display: cs.display, width: b.width, left: b.left, top: b.top, right: b.right, bottom: b.bottom, vw: innerWidth, vh: innerHeight,
      backdrop: getComputedStyle(el, '::backdrop').backgroundColor };
  });
  expect(r.opacity).toBe('1');
  expect(r.padding).toBe('0px');
  expect(r.border).toBe('0px');
  expect(r.transform).toBe('none');
  expect(r.display).toBe('block');
  expect(r.width).toBeGreaterThan(400);
  expect(r.left).toBeGreaterThanOrEqual(0); expect(r.top).toBeGreaterThanOrEqual(0); expect(r.right).toBeLessThanOrEqual(r.vw); expect(r.bottom).toBeLessThanOrEqual(r.vh + 1);
  expect(r.backdrop).not.toBe('rgba(0, 0, 0, 0)');
  await d.getByLabel('Passphrase', { exact: true }).click();    // really clickable
});

test('a page that re-renders its body and removes the open library dialog gets the dialog back', async ({ context }) => {
  const page = await openApp(context, w);
  await page.evaluate(() => { window.unlockP = store.unlock().then(() => 'unlocked', (e) => e.code); });
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'Unlock your data' })).toBeVisible();
  await page.evaluate(() => { document.querySelector('dialog.wds-dialog').remove(); });
  await expect(page.locator('dialog.wds-dialog')).toHaveCount(1);
  await expect(dialog(page).getByRole('heading', { name: 'Unlock your data' })).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('dialog.wds-dialog').matches(':modal'))).toBe(true);
});

test('a closed library dialog is re-opened when the browser or the app closes it (mandatory), and cancelled when cancelable', async ({ context }) => {
  const page = await openApp(context, w);
  await page.evaluate(() => { window.unlockP = store.unlock().then(() => 'unlocked', (e) => e.code); });
  await expect(dialog(page).getByRole('heading', { name: 'Unlock your data' })).toBeVisible();
  await page.evaluate(() => document.querySelectorAll('dialog').forEach((x) => x.close()));   // an app sweep in onLock
  await expect(dialog(page).getByRole('heading', { name: 'Unlock your data' })).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('dialog.wds-dialog').matches(':modal'))).toBe(true);
});

test('sandbox: the bar stays above an app modal and above library dialogs, and dialogs start below it', async ({ browser }) => {
  await w.close();
  w = await startTestWorld({ scope: { hibp: false, sandbox: { next_wipe: Math.floor(Date.now() / 1000) + 6 * 3600, last_wipe: null } } });
  const page = await openApp(await browser.newContext(), w);
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  await wds(page, 'to-create').click();
  await wds(page, 'passphrase').fill('purple-elephant-marching-slowly'); await wds(page, 'passphrase-repeat').fill('purple-elephant-marching-slowly');
  await wds(page, 'create-submit').click();
  await wds(page, 'sheet-confirm').check(); await wds(page, 'sheet-continue').click();
  await page.evaluate(() => window.unlockP);
  const bar = page.locator('[data-wds=sandbox-bar]');
  await expect(bar).toBeVisible();
  await openAppModal(page);
  // the colour of the bar (#fff4cc) is on the screen untouched: no backdrop lies over it ("elementFromPoint" cannot tell, the bar is inert)
  const onTop = async () => { const png = await page.screenshot(); const px = pixelAt(png, 40, 8); return px.join(',') === '255,244,204'; };
  expect(await onTop()).toBe(true);
  await page.evaluate(() => { window.shareP = store.share(); });
  await expect(page.locator('dialog.wds-dialog')).toBeVisible();
  expect(await onTop()).toBe(true);
  const r = await page.evaluate(() => ({ bar: document.querySelector('[data-wds=sandbox-bar]').getBoundingClientRect().bottom, dlg: document.querySelector('dialog.wds-dialog').getBoundingClientRect().top }));
  expect(r.dlg).toBeGreaterThanOrEqual(r.bar);
});

test('a user lock after an expired session still locks (a lock that finished synchronously is not remembered as running)', async ({ context }) => {
  const page = await openApp(context, w);
  const vault = await createVaultViaUi(page);
  await page.evaluate(() => { window.locks = []; store.onLock((r) => { window.locks.push(r); }); });
  await unauthorized(page);
  expect(await page.evaluate(() => store.get('x').then(() => null, (e) => e.name))).toBe('AuthError');
  await page.unroute(/\/records\//);
  expect(await page.evaluate(() => store.status().unlocked)).toBe(false);
  await page.evaluate(() => { window.unlockP = store.unlock(); });
  const d = dialog(page);
  await d.getByLabel('Passphrase', { exact: true }).fill(vault.passphrase);
  await d.getByRole('button', { name: 'Unlock' }).click();
  await page.evaluate(() => window.unlockP);
  await page.evaluate(() => store.lock());
  expect(await page.evaluate(() => window.locks)).toEqual(['expired', 'user']);
  expect(await page.evaluate(() => store.status().unlocked)).toBe(false);
});
