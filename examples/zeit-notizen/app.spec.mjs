// Playwright tests of the example app examples/zeit-notizen/index.html against a LOCAL stack: the real server with a temporary
// database (client/test/integration-env.mjs). The app itself is unchanged except for a temporary copy in which the integrity hash
// of the library tag and the scope ID are replaced by those of the local stack (the production values cannot be used: the local
// bundle pins other escrow keys). The library URL and the service URL of the app stay the production ones; the browser context
// maps every request to https://wiai.uni-bamberg.de/datastore/ to the local server, so the default service URL is what is tested.
// Run with scripts/test-examples.sh (Chromium; WDS_BROWSERS=chromium,firefox,webkit for more).
import { test as base, expect } from '../../client/node_modules/@playwright/test/index.mjs';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStack } from '../../client/test/integration-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROD = 'https://wiai.uni-bamberg.de';
const PASS = 'purple-elephant-marching-slowly';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n% Zeit-Notizen test file\n'), Buffer.alloc(3000, 7), Buffer.from('\n%%EOF\n')]);

const test = base.extend({
  stack: [async ({}, use) => {
    const stack = await startStack();
    const dir = mkdtempSync(join(tmpdir(), 'zn-app-'));
    let html = readFileSync(join(HERE, 'index.html'), 'utf8');
    const lib = html.match(/integrity="(sha384-[^"]+)"/)[1];
    html = html.replace(lib, stack.sri);
    const scope = html.match(/WDS\.connect\(\{ scope: "([^"]+)"/)[1];
    html = html.replace('scope: "' + scope + '"', 'scope: "' + stack.scope + '"');
    expect(html).toContain(stack.sri);
    expect(html).toContain(stack.scope);
    stack.appUrl = 'file://' + join(dir, 'index.html');
    writeFileSync(join(dir, 'index.html'), html);
    cpSync(join(HERE, 'old'), join(dir, 'old'), { recursive: true });       // the older, local-only version of the app, for the take-over of old data
    stack.oldUrl = 'file://' + join(dir, 'old', 'index.html');
    stack.dir = dir;
    try { await use(stack); } finally { await stack.stop(); rmSync(dir, { recursive: true, force: true }); }
  }, { scope: 'worker' }],
});
test.describe.configure({ mode: 'serial' });
test.setTimeout(240000);

const dialogOf = (page) => page.getByRole('dialog').last();

async function newContext(browser, stack, opts = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 900 }, locale: 'de-DE', ...opts });
  // The app names the production service; every request to it goes to the local server (library file and API).
  await ctx.route(PROD + '/datastore/**', async (route) => {
    const response = await route.fetch({ url: route.request().url().replace(PROD, stack.origin) });
    await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
  });
  // the breach check of the passphrase dialogs: padded noise, no match
  await ctx.route('https://api.pwnedpasswords.com/range/*', (route) => route.fulfill({
    status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n' }));
  return ctx;
}
async function openApp(ctx, stack) {
  const page = await ctx.newPage();
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push('pageerror: ' + e));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.problems.push('console.error: ' + m.text()); });
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI));
  });
  await page.goto(stack.appUrl);
  return page;
}
async function createVault(page, stack, { waitForApp = true } = {}) {
  const dlg = dialogOf(page);
  await dlg.getByRole('button', { name: 'Neuen Tresor anlegen' }).click();
  await dlg.getByLabel('Beitrittscode').fill(stack.joinCode);
  await dlg.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await dlg.getByLabel('Passphrase wiederholen').fill(PASS);
  await dlg.getByRole('button', { name: 'Tresor anlegen' }).click();
  await expect(dlg.getByRole('heading', { name: 'Zugangsblatt sichern' })).toBeVisible({ timeout: 60000 });
  const accessId = (await dlg.locator('[data-wds=access-id]').innerText()).trim();
  await dlg.getByLabel('Ich habe das Zugangsblatt und den Wiederherstellungscode gesichert.').check();
  await dlg.getByRole('button', { name: 'Weiter' }).click();
  if (waitForApp) await expect(page.locator('#app')).toBeVisible({ timeout: 60000 });
  return accessId;
}
async function unlock(page, accessId) {
  const dlg = dialogOf(page);
  await dlg.getByLabel('Zugangskennung').fill(accessId);
  await dlg.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await dlg.getByRole('button', { name: 'Entsperren' }).click();
  await expect(page.locator('#app')).toBeVisible({ timeout: 60000 });
}
// The unlock dialog by its stable attributes: it works in either language (a page opened after the person chose English starts in English).
async function unlockAnyLanguage(page, accessId) {
  const u = page.locator('[data-wds-view="unlock"]');
  await u.locator('[data-wds="access-id-input"]').fill(accessId);
  await u.locator('[data-wds="passphrase"]').fill(PASS);
  await u.locator('[data-wds="unlock-submit"]').click();
  await expect(page.locator('#app')).toBeVisible({ timeout: 60000 });
}
async function redeem(page, code) {
  const dlg = dialogOf(page);
  await dlg.getByRole('button', { name: 'Ich habe einen Einladungscode' }).click();
  await dlg.getByLabel('Einladungscode').fill(code);
  await dlg.getByLabel('Passphrase', { exact: true }).fill('member-passphrase-with-words');
  await dlg.getByLabel('Passphrase wiederholen').fill('member-passphrase-with-words');
  await dlg.getByRole('button', { name: 'Beitreten' }).click();
  await expect(dlg.getByRole('heading', { name: 'Sie haben jetzt Zugriff' })).toBeVisible({ timeout: 60000 });
  await dlg.getByLabel('Ich habe meine Zugangskennung gesichert.').check();
  await dlg.getByRole('button', { name: 'Weiter' }).click();
  await expect(page.locator('#app')).toBeVisible({ timeout: 60000 });
}
async function inviteCode(page, role) {
  await page.locator('#btn-share').click();
  const sd = dialogOf(page);
  await expect(sd.getByText('Personen mit Zugriff')).toBeVisible();
  // the dialog redraws while it loads the member list and the names: choose the role until the choice has settled
  const select = sd.getByLabel('Zugriff', { exact: true });
  for (let i = 0; i < 10; i++) {
    await select.selectOption(role);
    await page.waitForTimeout(400);
    if ((await select.inputValue()) === role) break;
  }
  await expect(select).toHaveValue(role);
  await sd.getByRole('button', { name: 'Einladungscode erzeugen' }).click();
  const code = (await sd.locator('[data-wds=invite-code]').innerText()).trim();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return code;
}
async function noViolations(...pages) {
  for (const p of pages) {
    expect(await p.evaluate(() => window.__violations), 'Content-Security-Policy violations').toEqual([]);
    expect(p.problems).toEqual([]);
  }
}
function readZip(buf) {   // ZIP written without compression
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < count; k++) {
    const size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files[name] = buf.subarray(start, start + size);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
function thisWeek() {
  const now = new Date(), mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const tue = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 1);
  return { monday: ymd(mon), tuesday: ymd(tue) };
}
// ZN_SHOTS=<directory> saves screenshots of the main screens (for a look at the design; not part of the checks)
async function shot(page, name) { if (process.env.ZN_SHOTS) await page.screenshot({ path: join(process.env.ZN_SHOTS, name + '.png'), fullPage: true }); }
const shared = {};   // state handed from one test to the next: the vault of the first test is used by all of them

// ---------------------------------------------------------------------------------------------------------------------------

test('projects, timer, manual entries and the weekly overview', async ({ browser, stack }) => {
  const ctx = await newContext(browser, stack);
  const page = await openApp(ctx, stack);
  shared.accessId = await createVault(page, stack);
  await expect(page.getByRole('heading', { name: 'Zeit erfassen' })).toBeVisible();
  await expect(page.locator('#role-badge')).toHaveText('Eigentümer');
  await expect(page.locator('#no-projects-hint')).toBeVisible();

  // projects
  await page.locator('#tab-projects').click();
  await page.locator('#project-add').click();
  await expect(page.locator('#project-error')).toHaveText('Bitte einen Namen eingeben.');
  for (const name of ['Projekt Alpha', 'Projekt Beta']) {
    await page.locator('#project-name').fill(name);
    await page.locator('#project-add').click();
    await expect(page.locator('#project-list')).toContainText(name);
  }
  await page.locator('#project-name').fill('projekt alpha');
  await page.locator('#project-add').click();
  await expect(page.locator('#project-error')).toHaveText('Ein Projekt mit diesem Namen gibt es schon.');

  // timer
  await page.locator('#tab-time').click();
  await expect(page.locator('#no-projects-hint')).toBeHidden();
  await page.locator('#timer-project').selectOption({ label: 'Projekt Alpha' });
  await page.locator('#timer-desc').fill('Timer-Test mit Umlauten äöü');
  await page.locator('#timer-start').click();
  await expect(page.locator('#timer-running')).toBeVisible();
  await expect(page.locator('#timer-info')).toContainText('Projekt Alpha');
  const first = await page.locator('#timer-elapsed').innerText();
  await expect.poll(() => page.locator('#timer-elapsed').innerText()).not.toBe(first);

  // the timer survives a reload (it is a record of the vault, not browser storage)
  const page2 = await openApp(ctx, stack);
  await unlock(page2, shared.accessId);
  await expect(page2.locator('#timer-running')).toBeVisible();
  await page2.locator('#timer-stop').click();
  await expect(page2.locator('#timer-running')).toBeHidden();
  await expect(page2.locator('#entries')).toContainText('Timer-Test mit Umlauten äöü');
  await expect(page2.locator('#entries .entry').first()).toContainText('0:01');
  await page.close();

  // manual entries: one on Monday and one on Tuesday of this week, and an invalid one
  const w = thisWeek();
  const add = async (project, date, duration, desc) => {
    await page2.locator('#entry-project').selectOption({ label: project });
    await page2.locator('#entry-date').fill(date);
    await page2.locator('#entry-duration').fill(duration);
    await page2.locator('#entry-desc').fill(desc);
    await page2.locator('#entry-add').click();
    if (desc !== 'kaputt') await expect(page2.locator('#entries')).toContainText(desc);
  };
  await add('Projekt Alpha', w.monday, 'abc', 'kaputt');
  await expect(page2.locator('#entry-error')).toContainText('Die Dauer wurde nicht erkannt');
  await add('Projekt Alpha', w.monday, '45 min', 'Planung');
  await expect(page2.locator('#entries')).toContainText('Planung');
  await add('Projekt Alpha', w.tuesday, '1:00', 'Umsetzung');
  await add('Projekt Beta', w.monday, '1,5 Stunden', 'Beratung');
  await expect(page2.locator('#entries')).toContainText('Beratung');
  // the next entry is for today again, not for the day of the last one
  await expect(page2.locator('#entry-date')).toHaveValue(ymd(new Date()));

  // weekly overview: totals per project and day
  await page2.locator('#tab-week').click();
  const table = page2.locator('#week-table');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  const row = (name) => table.locator('tbody tr').filter({ hasText: name });
  await expect(row('Projekt Beta').locator('td').last()).toHaveText('1:30');
  await expect(row('Projekt Alpha').locator('td').last()).toHaveText('1:46');   // 0:45 + 1:00 + the 1 minute of the timer
  await expect(table.locator('tfoot td').last()).toHaveText('3:16');
  await shot(page2, 'week');
  await expect(page2.locator('#week-label')).toContainText('KW');
  await page2.locator('#week-prev').click();
  await expect(table).toContainText('In dieser Woche gibt es keine Einträge.');
  await page2.locator('#week-today').click();
  await expect(table.locator('tfoot td').last()).toHaveText('3:16');

  // a timer can be started again after it was stopped or discarded (the timer record is deleted and written again)
  await page2.locator('#tab-time').click();
  for (let round = 0; round < 2; round++) {
    await page2.locator('#timer-project').selectOption({ label: 'Projekt Beta' });
    await page2.locator('#timer-start').click();
    await expect(page2.locator('#timer-running')).toBeVisible();
    await page2.locator('#timer-discard').click();
    await page2.locator('dialog[open]').getByRole('button', { name: 'Verwerfen' }).click();
    await expect(page2.locator('#timer-running')).toBeHidden();
  }
  await expect(page2.locator('#toast')).toContainText('Timer verworfen');

  // edit and delete an entry
  await page2.locator('#tab-time').click();
  await shot(page2, 'time');
  await page2.getByRole('button', { name: 'Eintrag bearbeiten: Umsetzung' }).click();
  const dlg = page2.locator('dialog[open]');
  await dlg.getByLabel('Dauer').fill('1:15');
  await dlg.getByRole('button', { name: 'Speichern' }).click();
  await expect(page2.locator('#entries')).toContainText('1:15');
  await page2.locator('#tab-week').click();
  await expect(table.locator('tfoot td').last()).toHaveText('3:31');
  await page2.locator('#tab-time').click();
  await page2.getByRole('button', { name: 'Eintrag löschen: Beratung' }).click();
  await page2.locator('dialog[open]').getByRole('button', { name: 'Löschen' }).click();
  await expect(page2.locator('#entries')).not.toContainText('Beratung');
  await noViolations(page2);
  await ctx.close();
});

test('notes: autosave, tags, search, attachments with preview and download', async ({ browser, stack }) => {
  const ctx = await newContext(browser, stack);
  const page = await openApp(ctx, stack);
  await unlock(page, shared.accessId);
  await page.locator('#tab-notes').click();
  await expect(page.locator('#note-count')).toContainText('0 von 0');

  // typing right after "New note" must work at once
  await page.locator('#note-new').click();
  await page.keyboard.type('Kickoff mit dem Team');
  await expect(page.locator('#note-title')).toHaveValue('Kickoff mit dem Team');
  await page.locator('#note-project').selectOption({ label: 'Projekt Alpha' });
  await page.locator('#note-tags').fill('planung, Kunde');
  await page.locator('#note-text').fill('Agenda: Überblick, Zeitplan, Risiken.\nNächster Termin am Montag.');
  await expect(page.locator('#note-status')).toHaveText('Gespeichert', { timeout: 20000 });
  await page.locator('#note-new').click();
  await page.locator('#note-title').fill('Einkaufsliste');
  await page.locator('#note-text').fill('Kaffee, Tee und Milch');
  await page.locator('#note-tags').fill('privat');
  await expect(page.locator('#note-status')).toHaveText('Gespeichert', { timeout: 20000 });
  await expect(page.locator('#note-list li')).toHaveCount(2);
  await expect(page.locator('#note-list li').first()).toContainText('Einkaufsliste');   // the one edited last is on top

  // search: title, text, tag, project name; without regard to case and umlauts
  const search = page.locator('#note-search');
  await search.fill('KICKOFF');
  await expect(page.locator('#note-list li')).toHaveCount(1);
  await expect(page.locator('#note-list mark')).toHaveText('Kickoff');
  await search.fill('uberblick');
  await expect(page.locator('#note-list li')).toHaveCount(1);
  await expect(page.locator('#note-count')).toContainText('1 von 2');
  await search.fill('milch tee');
  await expect(page.locator('#note-list li')).toContainText('Einkaufsliste');
  await search.fill('projekt alpha');
  await expect(page.locator('#note-list li')).toContainText('Kickoff');
  await search.fill('gibt es nicht');
  await expect(page.locator('#note-list')).toContainText('Keine Notizen gefunden.');
  await search.fill('');
  await page.locator('#tag-filter').getByRole('button', { name: /^privat/ }).click();
  await expect(page.locator('#note-list li')).toHaveCount(1);
  await page.locator('#tag-filter').getByRole('button', { name: /^privat/ }).click();
  await page.keyboard.press('Escape');

  // attachments on the first note: an image (preview), a PDF (download), a file that is too large (refused before the upload)
  await page.locator('#note-list li').filter({ hasText: 'Kickoff' }).locator('button').click();
  await expect(page.locator('#note-title')).toHaveValue('Kickoff mit dem Team');
  await page.locator('#note-file').setInputFiles([{ name: 'Skizze Büro.png', mimeType: 'image/png', buffer: PNG }, { name: 'angebot.pdf', mimeType: 'application/pdf', buffer: PDF }]);
  await expect(page.locator('#file-list .file')).toHaveCount(2, { timeout: 30000 });
  const img = page.locator('#file-list img');
  await expect(img).toBeVisible();
  expect(await img.evaluate((i) => i.naturalWidth)).toBe(1);
  await expect(page.locator('#file-list')).toContainText('angebot.pdf');
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Herunterladen: angebot.pdf' }).click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe('angebot.pdf');
  expect(readFileSync(await download.path()).equals(PDF)).toBe(true);
  await img.click();
  await expect(page.locator('dialog[open] img.big-img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.locator('#note-file').setInputFiles([{ name: 'riesig.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(11 * 1024 * 1024, 1) }]);
  await expect(page.locator('#toast')).toContainText('größer als');
  await expect(page.locator('#file-list .file')).toHaveCount(2);
  // attachments are searchable by file name
  await search.fill('angebot');
  await expect(page.locator('#note-list li')).toHaveCount(1);
  await search.fill('');
  // remove one
  await page.getByRole('button', { name: 'Entfernen: angebot.pdf' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Entfernen' }).click();
  await expect(page.locator('#file-list .file')).toHaveCount(1);
  await page.locator('#note-file').setInputFiles([{ name: 'angebot.pdf', mimeType: 'application/pdf', buffer: PDF }]);
  await expect(page.locator('#file-list .file')).toHaveCount(2, { timeout: 30000 });

  await shot(page, 'notes');
  // history of the note
  await page.locator('#note-history').click();
  await expect(dialogOf(page).getByRole('heading')).toContainText('Verlauf von „Kickoff mit dem Team“');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await noViolations(page);
  await ctx.close();
});

test('reload, export, CSV, language, lock', async ({ browser, stack }) => {
  const ctx = await newContext(browser, stack);
  const page = await openApp(ctx, stack);
  await unlock(page, shared.accessId);
  // everything came back: the lists (collection indexes) name what to read, the attachments are listed without being downloaded
  await page.locator('#tab-notes').click();
  await expect(page.locator('#note-list li')).toHaveCount(2);
  await page.locator('#note-list li').filter({ hasText: 'Kickoff' }).locator('button').click();
  await expect(page.locator('#note-text')).toHaveValue(/Nächster Termin am Montag/);
  await expect(page.locator('#note-tags')).toHaveValue('planung, Kunde');
  await expect(page.locator('#file-list .file')).toHaveCount(2);
  await expect(page.locator('#file-list img')).toBeVisible();

  // export of everything (library)
  const ex = page.waitForEvent('download');
  await page.locator('#btn-export').click();
  const zip = readZip(readFileSync(await (await ex).path()));
  const names = Object.keys(zip);
  expect(names).toContain('wds-export.json');
  expect(names).toEqual(expect.arrayContaining(['projects.index.json', 'time.index.json', 'notes.index.json', 'files.index.json']));   // the lists are records of their own
  expect(names.filter((n) => n.startsWith('notes/') && n.endsWith('.json'))).toHaveLength(2);
  expect(names.filter((n) => n.startsWith('projects/'))).toHaveLength(2);
  expect(names.filter((n) => n.startsWith('files/') && n.endsWith('.pdf'))).toHaveLength(1);
  expect(names.filter((n) => n.startsWith('files/') && n.endsWith('.png'))).toHaveLength(1);
  const pdfName = names.find((n) => n.endsWith('.pdf'));
  expect(zip[pdfName].equals(PDF)).toBe(true);
  // one confirmation only, and it is the library's (in the language of the app); the app adds none of its own
  await expect(page.locator('.wds-toast').filter({ hasText: /Export abgeschlossen: \d+ Datensätze\./ })).toBeVisible();
  await expect(page.locator('#toast')).toHaveText('');

  // CSV of the time entries
  await page.locator('#tab-week').click();
  const csv = page.waitForEvent('download');
  await page.locator('#csv-all').click();
  const csvDownload = await csv;
  expect(csvDownload.suggestedFilename()).toMatch(/^zeiteintraege-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = readFileSync(await csvDownload.path(), 'utf8');
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const lines = text.slice(1).trim().split('\r\n');
  expect(lines[0]).toBe('Datum;Projekt;Beschreibung;Dauer (h:mm);Stunden (dezimal)');
  expect(lines).toHaveLength(4);   // header + timer entry + Planung + Umsetzung (Beratung was deleted)
  const w = thisWeek();
  expect(lines).toContain(w.monday + ';Projekt Alpha;Planung;0:45;0,75');
  expect(lines).toContain(w.tuesday + ';Projekt Alpha;Umsetzung;1:15;1,25');

  // language toggle (a personal preference: this browser's localStorage, not the vault) and back
  await page.locator('#btn-lang').click();
  await expect(page.locator('#tab-week')).toHaveText('Week');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#h-week')).toHaveText('Weekly overview');
  // the dialogs of the library speak the language of the app, too (not the one of the browser)
  await page.locator('#btn-share').click();
  await expect(dialogOf(page).getByRole('heading', { name: 'Sharing and access' })).toBeVisible();
  await expect(dialogOf(page).locator('[data-wds=person-escrow] .wds-badge')).toHaveText('Faculty, recovery only');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const page2 = await openApp(ctx, stack);
  await expect(page2.locator('html')).toHaveAttribute('lang', 'en');             // the choice is this browser's (localStorage): a new page starts in English, the library's dialogs included
  await unlockAnyLanguage(page2, shared.accessId);
  await expect(page2.locator('#tab-week')).toHaveText('Week');
  await page2.locator('#btn-lang').click();
  await expect(page2.locator('#tab-week')).toHaveText('Woche');
  await expect(page2.locator('#toast')).toContainText('Sprache: Deutsch');

  // lock: everything disappears, unlocking brings it back
  await page2.locator('#btn-lock').click();
  await expect(page2.locator('#app')).toBeHidden();
  await expect(page2.locator('#screen')).toContainText('Der Tresor ist gesperrt');
  await expect(page2.locator('#toast')).toHaveText('');   // the app's own toast ("Sprache: Deutsch") goes away with the lock, too
  await page2.locator('#screen-btn').click();
  await unlock(page2, shared.accessId);
  await expect(page2.locator('#tab-time')).toHaveAttribute('aria-current', 'page');
  await noViolations(page2);
  await page.close();
  await ctx.close();
});

test('sharing: write member, conflict dialog, new entries after reload, read-only member', async ({ browser, stack }) => {
  const ownerCtx = await newContext(browser, stack);
  const owner = await openApp(ownerCtx, stack);
  await unlock(owner, shared.accessId);
  const writeCode = await inviteCode(owner, 'write');
  const readCode = await inviteCode(owner, 'read');

  const memberCtx = await newContext(browser, stack);
  const member = await openApp(memberCtx, stack);
  await redeem(member, writeCode);
  await expect(member.locator('#role-badge')).toHaveText('Schreibzugriff');
  await member.locator('#tab-notes').click();
  await expect(member.locator('#note-list li')).toHaveCount(2);
  await member.locator('#note-list li').filter({ hasText: 'Kickoff' }).locator('button').click();
  await expect(member.locator('#note-title')).toHaveValue('Kickoff mit dem Team');

  // the owner changes the note; the member (who still holds the old version) types as well: conflict dialog with readable texts
  await owner.locator('#tab-notes').click();
  await owner.locator('#note-list li').filter({ hasText: 'Kickoff' }).locator('button').click();
  await owner.locator('#note-text').fill('Fassung der Eigentümerin');
  await expect(owner.locator('#note-status')).toHaveText('Gespeichert', { timeout: 20000 });
  await member.locator('#note-text').click();   // (Firefox: fill() alone left the focus in the title field of this page)
  await member.locator('#note-text').fill('Fassung des Kollegen');
  const cf = member.locator('dialog[open]');
  await expect(cf.getByRole('heading', { name: 'Es gibt eine neuere Fassung' })).toBeVisible({ timeout: 30000 });
  await expect(cf).toContainText('Fassung der Eigentümerin');
  await expect(cf).toContainText('Fassung des Kollegen');
  await shot(member, 'conflict');
  await expect(cf).not.toContainText('{"');           // no raw JSON
  // which one is newer: the own version is not saved yet, the other one says when it was; the lines that differ are marked
  await expect(cf.locator('.versions > div').nth(0)).toContainText('Noch nicht gespeichert');
  await expect(cf.locator('.versions > div').nth(1)).toContainText(/Gespeichert: .*\d/);
  await expect(cf.locator('.versions > div').nth(0).locator('.ln.diff')).toContainText(['Fassung des Kollegen']);
  await expect(cf.locator('.versions > div').nth(1).locator('.ln.diff')).toContainText(['Fassung der Eigentümerin']);
  await expect(cf.locator('.versions > div').nth(0).locator('.ln:not(.diff)').first()).toContainText('Kickoff mit dem Team');   // the title is the same in both
  await cf.getByRole('button', { name: 'Meine Fassung behalten' }).click();
  await expect(member.locator('#note-status')).toHaveText('Gespeichert', { timeout: 20000 });
  expect(await member.locator('#note-text').inputValue()).toBe('Fassung des Kollegen');

  // second round: the other way round, keep the newer version: the editor shows it
  await owner.locator('#note-text').fill('Zweite Fassung der Eigentümerin');
  const cf2 = owner.locator('dialog[open]');
  await expect(cf2.getByRole('heading', { name: 'Es gibt eine neuere Fassung' })).toBeVisible({ timeout: 30000 });
  await cf2.getByRole('button', { name: 'Neuere Fassung behalten' }).click();
  await expect(owner.locator('#note-text')).toHaveValue('Fassung des Kollegen', { timeout: 20000 });

  // new entries of others appear when the window of the owner gets focus (the collections notice the changed list), or at "Neu laden"
  await member.locator('#tab-projects').click();
  await member.locator('#project-name').fill('Projekt Gamma');
  await member.locator('#project-add').click();
  await expect(member.locator('#project-list')).toContainText('Projekt Gamma');
  await owner.locator('#tab-projects').click();
  await expect(owner.locator('#project-list')).not.toContainText('Projekt Gamma');
  await expect.poll(async () => {          // the library checks at most every 15 seconds
    await owner.evaluate(() => window.dispatchEvent(new Event('focus')));
    return owner.locator('#project-list').innerText();
  }, { timeout: 45000, intervals: [2500] }).toContain('Projekt Gamma');
  // a second project from the member, then the button: the same result without waiting for focus
  await member.locator('#project-name').fill('Projekt Delta');
  await member.locator('#project-add').click();
  await expect(member.locator('#project-list')).toContainText('Projekt Delta');
  await owner.locator('#btn-reload').click();
  await expect(owner.locator('#project-list')).toContainText('Projekt Delta');

  // two people add entries at the same time: the list of the collection is merged (the changes are replayed on the newest list), nothing is lost
  await Promise.all([owner, member].map(async (p, i) => {
    await p.locator('#tab-time').click();
    await p.locator('#entry-project').selectOption({ label: 'Projekt Gamma' });
    await p.locator('#entry-duration').fill(i ? '2:00' : '3:00');
    await p.locator('#entry-desc').fill(i ? 'Kollege parallel' : 'Eigentümerin parallel');
    await p.locator('#entry-add').click();
  }));
  await expect(owner.locator('#entries')).toContainText('Eigentümerin parallel');
  await expect(member.locator('#entries')).toContainText('Kollege parallel');
  await owner.locator('#btn-reload').click();
  await expect(owner.locator('#entries')).toContainText('Kollege parallel');
  await expect(owner.locator('#entries')).toContainText('Eigentümerin parallel');
  await member.locator('#btn-reload').click();
  await expect(member.locator('#entries')).toContainText('Eigentümerin parallel');
  await expect(member.locator('#entries')).toContainText('Kollege parallel');

  // a read member sees everything and cannot change anything
  const readCtx = await newContext(browser, stack);
  const reader = await openApp(readCtx, stack);
  await redeem(reader, readCode);
  await expect(reader.locator('#role-badge')).toHaveText('Nur lesen');
  await expect(reader.getByRole('heading', { name: 'Zeiteinträge' })).toBeVisible();     // not "Zeit erfassen": a reader cannot record time
  await expect(reader.getByRole('heading', { name: 'Zeit erfassen' })).toHaveCount(0);
  await expect(reader.locator('#timer-card')).toBeHidden();
  await expect(reader.locator('#manual-card')).toBeHidden();
  await expect(reader.locator('#entries')).toContainText('Kollege parallel');
  await expect(reader.locator('#entries').getByRole('button', { name: /bearbeiten/ })).toHaveCount(0);
  await reader.locator('#tab-notes').click();
  await expect(reader.locator('#note-new')).toBeHidden();
  await reader.locator('#note-list li').filter({ hasText: 'Kickoff' }).locator('button').click();
  await expect(reader.locator('#note-text')).toBeDisabled();
  await expect(reader.locator('#note-text')).toHaveValue('Fassung des Kollegen');
  await expect(reader.locator('#note-delete')).toBeHidden();
  await expect(reader.locator('#file-hint')).toBeHidden();                              // no upload hint for someone who cannot upload
  await expect(reader.locator('#file-list').getByRole('button', { name: /^Herunterladen/ }).first()).toBeVisible();
  await reader.locator('#tab-projects').click();
  await expect(reader.locator('#project-form')).toBeHidden();
  await expect(reader.locator('#shared-hint')).toContainText('nur Lesezugriff');
  // the owner revokes the write member. After "Neu laden" the member sees the lock screen and the notice of the library, and no
  // app message that quotes the English text of the error
  await owner.locator('#btn-share').click();
  const sd = dialogOf(owner);
  const people = sd.locator('[data-wds=person]').filter({ has: owner.locator('select') });
  await expect(people).toHaveCount(2);
  let target = -1;
  for (let i = 0; i < 2; i++) if ((await people.nth(i).locator('select').inputValue()) === 'write') target = i;
  expect(target).toBeGreaterThanOrEqual(0);
  await people.nth(target).getByRole('button', { name: 'Entziehen' }).click();
  await sd.getByRole('button', { name: 'Zugriff entziehen' }).click();
  await expect(sd.getByText('Zugriff entzogen. Alle Daten sind neu verschlüsselt.')).toBeVisible({ timeout: 120000 });
  await owner.keyboard.press('Escape');
  await member.locator('#btn-reload').click();
  await expect(member.locator('#screen')).toContainText('Ihr Zugang wurde entzogen');
  await expect(member.locator('.wds-toast').filter({ hasText: 'Ihr Zugang zu diesem Tresor wurde entfernt' })).toBeVisible();
  await expect(member.locator('#toast')).toHaveText('');
  const bodyText = await member.locator('body').innerText();
  expect(bodyText).not.toMatch(/revoked|Das hat nicht geklappt/);
  await shot(member, 'revoked');
  await noViolations(owner, member, reader);
  await ownerCtx.close(); await memberCtx.close(); await readCtx.close();
});

test('weekly overview: a long project name wraps, the totals stay in view, a narrow screen gets cards', async ({ browser, stack }) => {
  const LONG = 'Verwaltung und Gremien mit einem sehr langen Projektnamen';
  const ctx = await newContext(browser, stack, { viewport: { width: 1280, height: 900 } });
  const page = await openApp(ctx, stack);
  await unlock(page, shared.accessId);
  await page.locator('#tab-projects').click();
  await page.locator('#project-name').fill(LONG);
  await page.locator('#project-add').click();
  await expect(page.locator('#project-list')).toContainText(LONG);
  await page.locator('#tab-time').click();
  await page.locator('#entry-project').selectOption({ label: LONG });
  await page.locator('#entry-date').fill(thisWeek().monday);
  await page.locator('#entry-duration').fill('0:45');
  await page.locator('#entry-desc').fill('Gremium');
  await page.locator('#entry-add').click();
  await expect(page.locator('#entries')).toContainText('Gremium');
  await page.locator('#tab-week').click();
  await expect(page.locator('#week-table tbody tr').filter({ hasText: LONG })).toHaveCount(1);

  const measure = () => page.evaluate(() => {
    const wrap = document.querySelector('.tablewrap'), wr = wrap.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    const rect = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    const visible = (e) => e.offsetParent !== null && getComputedStyle(e).display !== 'none';
    const row = [...document.querySelectorAll('#week-table tbody tr')].find((r) => r.textContent.includes('Projektnamen'));
    const name = row.querySelector('th');
    return {
      vw, pageOverflow: document.documentElement.scrollWidth - innerWidth, scrollable: wrap.scrollWidth - wrap.clientWidth, wrapRight: wr.right,
      totals: [...document.querySelectorAll('#week-table td.tot, #week-table th.tot')].filter(visible).map(rect),
      sundayHead: rect(document.querySelector('#week-table thead th:nth-last-child(2)')),
      nameCut: name.scrollWidth - name.clientWidth, nameRect: rect(name), rowRect: rect(row),
      theadHidden: getComputedStyle(document.querySelector('#week-table thead')).position === 'absolute',
      chips: [...row.querySelectorAll('td.day')].filter(visible).map((c) => c.getAttribute('data-label') + ' ' + c.textContent),
    };
  });
  for (const width of [1280, 1024, 800, 380]) {
    await page.setViewportSize({ width, height: 900 });
    const m = await measure();
    const label = width + ' px';
    expect(m.pageOverflow, label + ': page overflow').toBeLessThanOrEqual(0);
    expect(m.totals.length, label + ': totals').toBeGreaterThanOrEqual(3);          // header, one project, the total row (header hidden in cards)
    for (const t of m.totals) { expect(t.left, label + ': total starts in view').toBeGreaterThanOrEqual(0); expect(t.right, label + ': total ends in view').toBeLessThanOrEqual(m.vw + 0.5); }
    expect(m.nameCut, label + ': the project name is not cut off').toBeLessThanOrEqual(1);
    if (width >= 1024) {
      expect(m.scrollable, label + ': nothing to scroll sideways').toBeLessThanOrEqual(0);
      expect(m.sundayHead.right, label + ': Sunday is visible').toBeLessThanOrEqual(m.wrapRight + 0.5);
    }
    if (width <= 760) {
      expect(m.theadHidden, label + ': cards instead of a table').toBe(true);
      expect(m.chips.join(' ')).toContain('0:45');                                    // the day with time is shown, with its date
      expect(m.chips.join(' ')).toMatch(/Mo/);
    }
    await shot(page, 'week-' + width);
  }
  await noViolations(page);
  await ctx.close();
});

test('layout: the app toast never covers a button of the header or a tab', async ({ browser, stack }) => {
  for (const width of [1280, 960, 900, 700, 390]) {
    const ctx = await newContext(browser, stack, { viewport: { width, height: 800 } });
    const page = await openApp(ctx, stack);
    await unlock(page, shared.accessId);
    await page.locator('#btn-reload').click();
    await expect(page.locator('#toast p')).toBeVisible();
    const r = await page.evaluate(() => {
      const t = document.querySelector('#toast p').getBoundingClientRect();
      const hit = [...document.querySelectorAll('header.top button, nav.tabs button, nav.tabs a')]
        .filter((e) => e.offsetParent !== null)
        .filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top; })
        .map((e) => e.id || e.textContent.trim());
      return { hit, inView: t.top >= 0 && t.bottom <= window.innerHeight && t.left >= 0 && t.right <= window.innerWidth + 0.5 };
    });
    expect(r.hit, 'toast covers buttons at ' + width).toEqual([]);
    expect(r.inView, 'toast is inside the viewport at ' + width).toBe(true);
    await shot(page, 'toast-' + width);
    await ctx.close();
  }
});

test('layout: 380 px wide, light and dark, no horizontal scrolling; labels for every field', async ({ browser, stack }) => {
  for (const scheme of ['light', 'dark']) {
    const ctx = await newContext(browser, stack, { viewport: { width: 380, height: 760 }, colorScheme: scheme });
    const page = await openApp(ctx, stack);
    await unlock(page, shared.accessId);
    for (const view of ['time', 'week', 'notes', 'projects']) {
      await page.locator('#tab-' + view).click();
      if (view === 'notes') {
        await page.locator('#note-list li').first().locator('button').click();
        await expect(page.locator('#note-editor')).toBeVisible();
        await expect(page.locator('#note-list')).toBeHidden();      // one pane at a time on a narrow screen
        await shot(page, 'narrow-' + scheme + '-note');
        await page.locator('#note-back').click();
        await expect(page.locator('#note-list')).toBeVisible();
      }
      await shot(page, 'narrow-' + scheme + '-' + view);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, view + ' (' + scheme + ')').toBeLessThanOrEqual(0);
      const unnamed = await page.evaluate(() => [...document.querySelectorAll('#app input, #app select, #app textarea, #app button')]
        .filter((e) => e.offsetParent !== null && e.type !== 'hidden')
        .filter((e) => !(e.getAttribute('aria-label') || (e.labels && e.labels.length) || e.textContent.trim() || e.title))
        .map((e) => e.id || e.outerHTML.slice(0, 60)));
      expect(unnamed, 'controls without a name in ' + view).toEqual([]);
    }
    await noViolations(page);
    await ctx.close();
  }
});

test('browser language: an English browser gets the app and the dialogs of the library in English before the vault is open', async ({ browser, stack }) => {
  const ctx = await newContext(browser, stack, { locale: 'en-US' });
  const page = await openApp(ctx, stack);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(dialogOf(page).getByRole('heading', { name: 'Unlock your data' })).toBeVisible();
  await expect(page.locator('#btn-lang')).toHaveText('DE');
  await noViolations(page);
  await ctx.close();
});

test('repair lists: a list that is gone is rebuilt from the records, and the app says so', async ({ browser, stack }) => {
  const ctx = await newContext(browser, stack);
  // behind the app's back: delete the list (index record) of the notes with the core client of the same library file
  const core = await ctx.newPage();
  writeFileSync(join(stack.dir, 'core.html'), '<!doctype html><meta charset="utf-8"><script src="file://' + stack.bundleFile + '"></script><p>core</p>');
  await core.goto('file://' + join(stack.dir, 'core.html'));
  await core.evaluate(async ({ scope, service, accessId, passphrase }) => {
    const c = new WDSCore.Client({ scope, service });
    await c.unlock({ accessId, passphrase });
    if (!(await c.delete('notes.index'))) throw new Error('there was no notes.index');
  }, { scope: stack.scope, service: stack.service, accessId: shared.accessId, passphrase: PASS });
  await core.close();

  const page = await openApp(ctx, stack);
  await unlock(page, shared.accessId);
  await page.locator('#tab-notes').click();
  await expect(page.locator('#note-count')).toContainText('0 von 0');              // the records are there, the list is not
  await page.locator('#btn-repair').click();
  await expect(page.locator('#toast')).toContainText('Listen repariert', { timeout: 60000 });
  await expect(page.locator('#note-list li')).toHaveCount(2);
  await expect(page.locator('#note-list')).toContainText('Kickoff mit dem Team');
  // the repaired list is in the vault: a new page load shows the notes without repairing
  const page2 = await openApp(ctx, stack);
  await unlock(page2, shared.accessId);
  await page2.locator('#tab-notes').click();
  await expect(page2.locator('#note-list li')).toHaveCount(2);
  await noViolations(page, page2);
  await ctx.close();
});

test('old data of the local-only version is taken over: asked once, copied, checked and deleted; the attachment belongs to its note, the timer runs, the language row is skipped', async ({ browser, browserName, stack }) => {
  test.skip(browserName !== 'chromium', 'the old page and the new app are two files: only Chromium shares the storage of file:// pages (in Firefox and Safari the new file replaces the old one)');
  const ctx = await newContext(browser, stack);
  // the old app: two projects, two time entries, a note with an attachment, a running timer, the language
  const old = await ctx.newPage();
  await old.goto(stack.oldUrl);
  for (const name of ['Altes Projekt Alpha', 'Altes Projekt Beta']) { await old.locator('#project-name').fill(name); await old.locator('#project-add').click(); }
  await old.locator('#entry-project').selectOption({ label: 'Altes Projekt Alpha' });
  await old.locator('#entry-date').fill(ymd(new Date()));     // within the 14 days that the app lists at first
  await old.locator('#entry-minutes').fill('90');
  await old.locator('#entry-desc').fill('Alter Eintrag eins');
  await old.locator('#entry-add').click();
  await old.locator('#entry-project').selectOption({ label: 'Altes Projekt Beta' });
  await old.locator('#entry-minutes').fill('45');
  await old.locator('#entry-desc').fill('Alter Eintrag zwei');
  await old.locator('#entry-add').click();
  await expect(old.locator('#entry-list li')).toHaveCount(2);
  await old.locator('#note-title').fill('Alte Notiz mit Anhang');
  await old.locator('#note-text').fill('Text der alten Notiz mit Umlauten äöü');
  await old.locator('#note-tags').fill('alt, import');
  await old.locator('#note-file').setInputFiles([{ name: 'plan.pdf', mimeType: 'application/pdf', buffer: PDF }]);
  await old.locator('#note-add').click();
  await expect(old.locator('#note-list li')).toHaveCount(1);
  await old.locator('#timer-project').selectOption({ label: 'Altes Projekt Beta' });
  await old.locator('#timer-desc').fill('Alter Timer läuft');
  await old.locator('#timer-start').click();
  await expect(old.locator('#timer-info')).toHaveText('Timer läuft');
  await old.locator('#lang').selectOption('en');
  await old.waitForTimeout(500);
  await old.close();

  const page = await openApp(ctx, stack);
  const accessId = await createVault(page, stack, { waitForApp: false });
  // the library asks once: 7 entries (2 projects, 2 time entries, the note, its file, the timer); the language row is skipped (a personal preference): "Take over" waits for the backup; the backup is a ZIP with the file in it
  const q = page.locator('[data-wds-view="migrate"]');
  await expect(q).toBeVisible({ timeout: 30000 });
  await expect(q).toContainText('7 Einträge');
  const backup = page.waitForEvent('download');
  await q.locator('[data-wds="migrate-backup"]').click();
  const zipDownload = await backup;
  expect(zipDownload.suggestedFilename()).toMatch(/^zeitnotizen-old-data-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = readZip(readFileSync(await zipDownload.path()));
  expect(Object.keys(zip)).toContain('data.json');
  expect(zip[Object.keys(zip).find((n) => /^files\/.*plan\.pdf$/.test(n))].equals(PDF)).toBe(true);
  await q.locator('[data-wds="migrate-yes"]').click();
  await expect(page.locator('#app')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.wds-toast').filter({ hasText: '7 Einträge sind jetzt in Ihrem Tresor' })).toBeVisible();

  // everything is there; the language of the old app was not taken over (the new app starts in the language of the browser)
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.locator('#tab-projects').click();
  await expect(page.locator('#project-list')).toContainText('Altes Projekt Alpha');
  await expect(page.locator('#project-list')).toContainText('Altes Projekt Beta');
  await page.locator('#tab-time').click();
  await expect(page.locator('#entries')).toContainText('Alter Eintrag eins');
  await expect(page.locator('#entries')).toContainText('1:30');
  await expect(page.locator('#entries')).toContainText('Alter Eintrag zwei');
  await expect(page.locator('#timer-running')).toBeVisible();                                   // the timer record, with the project of the new id
  await expect(page.locator('#timer-info')).toContainText('Altes Projekt Beta');
  await expect(page.locator('#timer-info')).toContainText('Alter Timer läuft');
  await page.locator('#tab-notes').click();
  await page.locator('#note-list li').filter({ hasText: 'Alte Notiz mit Anhang' }).locator('button').click();
  await expect(page.locator('#note-text')).toHaveValue('Text der alten Notiz mit Umlauten äöü');
  await expect(page.locator('#note-tags')).toHaveValue('alt, import');
  await expect(page.locator('#file-list .file')).toHaveCount(1);                                // the file belongs to its note
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: /plan\.pdf/ }).first().click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe('plan.pdf');
  expect(readFileSync(await download.path()).equals(PDF)).toBe(true);

  // the old storage is empty (the tag of this browser stays); the question does not come again, and the language the person chooses now stays (localStorage)
  const oldState = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('zeitnotizen'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const counts = {};
    for (const s of ['notes', 'files', 'meta']) counts[s] = await new Promise((resolve) => { const r = db.transaction(s).objectStore(s).count(); r.onsuccess = () => resolve(r.result); });
    db.close();
    return { counts, data: localStorage.getItem('zeitnotizen.daten'), tag: /^[0-9a-f]{8}$/.test(localStorage.getItem('wds:migrate:zeitnotizen:tag') || '') };
  });
  expect(oldState).toEqual({ counts: { notes: 0, files: 0, meta: 0 }, data: null, tag: true });
  await page.locator('#btn-lang').click();                                                      // German -> English
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#toast')).toContainText('Language');
  const again = await openApp(ctx, stack);
  await unlockAnyLanguage(again, accessId);
  await expect(again.locator('[data-wds-view="migrate"]')).toHaveCount(0);
  await expect(again.locator('html')).toHaveAttribute('lang', 'en');
  await noViolations(page, again);
  await ctx.close();
});

test('old data that nothing refers to any more is kept, not dropped: an attachment whose note is gone and a timer of a deleted project are taken over', async ({ browser, browserName, stack }) => {
  test.skip(browserName !== 'chromium', 'the old page and the new app are two files: only Chromium shares the storage of file:// pages');
  const ctx = await newContext(browser, stack);
  const old = await ctx.newPage();
  await old.goto(stack.oldUrl);
  await old.locator('#project-name').fill('Einziges Projekt');
  await old.locator('#project-add').click();
  await old.waitForTimeout(300);
  await old.evaluate(async (pdf) => {     // what an older version left behind: a file of a note that no longer exists, and a timer of a project that no longer exists
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('zeitnotizen'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['files', 'meta'], 'readwrite');
      tx.objectStore('files').add({ noteId: 999, name: 'verwaist.pdf', type: 'application/pdf', blob: new File([new Uint8Array(pdf)], 'verwaist.pdf', { type: 'application/pdf' }) });
      tx.objectStore('meta').put({ project: 77, desc: 'Timer ohne Projekt', start: Date.now() - 120000 }, 'timer');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, Array.from(PDF));
  await old.close();
  const page = await openApp(ctx, stack);
  await createVault(page, stack, { waitForApp: false });
  const q = page.locator('[data-wds-view="migrate"]');
  await expect(q).toBeVisible({ timeout: 30000 });
  await expect(q).toContainText('3 Einträge');                       // the project, the orphan file, the timer: nothing is skipped, so there is no box to tick
  await expect(q.locator('[data-wds="migrate-skip-ack"]')).toHaveCount(0);
  await q.locator('[data-wds="migrate-yes"]').click();
  await expect(page.locator('#app')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.wds-toast').filter({ hasText: '3 Einträge sind jetzt in Ihrem Tresor' })).toBeVisible();
  await expect(page.locator('#timer-running')).toBeVisible();        // the timer keeps running, without its project
  await expect(page.locator('#timer-info')).toContainText('(gelöschtes Projekt)');
  await expect(page.locator('#timer-info')).toContainText('Timer ohne Projekt');
  await ctx.close();
});
