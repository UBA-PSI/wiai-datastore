// Documentation and export tool, against the REAL server and the REAL bundle, in Chromium, Firefox and WebKit
// (playwright.integration.config.mjs, scripts/test-integration.sh).
//  - The example app of docs/site/integration.md is taken from the rendered page and run from a file:// page with the
//    documented script tag and Content-Security-Policy: no policy violation, Argon2id works, data survives a reload, export works.
//  - A negative control shows that the policy really blocks (without 'wasm-unsafe-eval' no vault can be created).
//  - The onerror fallback shows the message when the library cannot be loaded or its hash does not match.
//  - docs/site/export.html: served page and a saved copy opened from file://, with typed access ID and with a key file.
import { test as base, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startStack, ROOT } from './integration-env.mjs';

const PASS = 'purple-elephant-marching-slowly';
const NOTE_CANARY = 'DOCSCANARY-4e1b7a90-note-text';

const test = base.extend({
  stack: [async ({}, use) => {
    const stack = await startStack();
    const docs = await stack.startServer({ publicBase: true });
    stack.docs = docs;
    try { await use(stack); } finally { await stack.stop(); }
  }, { scope: 'worker' }],
});
test.describe.configure({ mode: 'serial' });
test.setTimeout(240000);

// ---- helpers ----
let fileCount = 0;
function writeTemp(stack, name, text) {
  const dir = join(stack.tmp, 'docs-pages');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, (++fileCount) + '-' + name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}
async function fetchText(url) {
  const r = await fetch(url);
  if (r.status !== 200) throw new Error(url + ' answered ' + r.status);
  return { text: await r.text(), headers: r.headers };
}
// The example app: the html block after the heading "## 14." of the rendered integration.md, with the scope ID replaced.
async function exampleRaw(stack) {
  const { text } = await fetchText(stack.docs.origin + '/datastore/docs/integration.md');
  const part = text.slice(text.indexOf('## 14.'));
  const m = part.match(/```html\n([\s\S]*?)\n```/);
  if (!m) throw new Error('no example app in integration.md');
  expect(m[1]).toContain('myapp-k7m2a9');
  const steps = text.slice(text.indexOf('## 12.')).match(/```json\n([\s\S]*?)\n```/);
  if (!steps) throw new Error('no wds-verify.json example in integration.md');
  return { html: m[1], steps: steps[1] };
}
async function exampleApp(stack) {
  const m = [null, (await exampleRaw(stack)).html];
  return m[1].replace('myapp-k7m2a9', stack.scope).replace('const store = WDS.connect({ scope: "' + stack.scope + '" });',
    'const store = WDS.connect({ scope: "' + stack.scope + '", baseUrl: "' + stack.docs.service + '" });');
}
function newPage(ctx) {
  return ctx.newPage().then(async (page) => {
    page.problems = [];
    page.on('pageerror', (e) => page.problems.push('pageerror: ' + e));
    // (the 404 of the library's lookup of a fresh access ID is expected and shows up as 'Failed to load resource')
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.problems.push('console.error: ' + m.text()); });
    await page.addInitScript(() => {
      window.__violations = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI));
    });
    return page;
  });
}
async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 800 }, locale: 'en-US', ...opts });
  // the breach check of the passphrase dialogs: padded noise, no match (the real service is not reachable from tests)
  await ctx.route('https://api.pwnedpasswords.com/range/*', (route) => route.fulfill({
    status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n' }));
  return ctx;
}
const dialogOf = (page) => page.getByRole('dialog').last();

async function createVaultThroughDialog(page, stack, passphrase = PASS) {
  const dlg = dialogOf(page);
  await dlg.getByRole('button', { name: 'Create a new vault' }).click();
  await dlg.getByLabel('Join code').fill(stack.joinCode);
  await dlg.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await dlg.getByLabel('Repeat passphrase').fill(passphrase);
  await dlg.getByRole('button', { name: 'Create vault' }).click();
  await expect(dlg.getByRole('heading', { name: 'Save your access sheet' })).toBeVisible({ timeout: 60000 });
  const accessId = (await dlg.locator('[data-wds=access-id]').innerText()).trim();
  const kf = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'Download key file' }).click();
  const keyFile = await (await kf).path();
  await dlg.getByLabel('I have saved the access sheet and the recovery code.').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();
  return { accessId, keyFile: readFileSync(keyFile, 'utf8') };
}
async function unlockThroughDialog(page, accessId, passphrase = PASS) {
  const dlg = dialogOf(page);
  await dlg.getByLabel('Access ID').fill(accessId);
  await dlg.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await dlg.getByRole('button', { name: 'Unlock' }).click();
}

// Read the files of a ZIP written without compression (central directory, so sizes are certain).
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (method !== 0) throw new Error('compressed entry ' + name);
    files[name] = buf.subarray(start, start + size);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---- tests ----

test('documentation pages are served with the current library tag and policy', async ({ stack }) => {
  const o = stack.docs.origin + '/datastore';
  const llms = await fetchText(o + '/llms.txt');
  expect(llms.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(llms.text).toContain('wds-' + stack.version + '.js');
  const md = await fetchText(o + '/docs/integration.md');
  expect(md.text).toContain('src="' + o + '/client/wds-' + stack.version + '.js"');
  expect(md.text).toContain('integrity="' + stack.sri + '"');
  expect(md.text).toContain("script-src 'unsafe-inline' 'wasm-unsafe-eval' " + o + '/client/;');
  const html = await fetchText(o + '/docs/integration');
  expect(html.text).toContain('<h1 id=');
  expect(html.text).not.toContain('<script');
  // the tag in the document is the tag of the bundle the server serves: fetch it and hash it
  const lib = new Uint8Array(await (await fetch(o + '/client/wds-' + stack.version + '.js')).arrayBuffer());
  const digest = 'sha384-' + Buffer.from(await crypto.subtle.digest('SHA-384', lib)).toString('base64');
  expect(digest).toBe(stack.sri);
});

test('the example app of integration.md runs from file:// under the documented policy', async ({ browser, stack }) => {
  const html = await exampleApp(stack);
  expect(html).toContain('Content-Security-Policy');
  expect(html).toContain('integrity="' + stack.sri + '"');
  const url = 'file://' + writeTemp(stack, 'example.html', html);
  const ctx = await newContext(browser);
  const page = await newPage(ctx);
  await page.goto(url);
  const created = await createVaultThroughDialog(page, stack);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'New note' }).click();
  const text = page.getByLabel('Note text');
  await expect(text).toBeEnabled();
  await text.fill(NOTE_CANARY + '\nsecond line');
  await expect(page.locator('#status')).toHaveText('saved', { timeout: 20000 });
  await expect(page.locator('#list')).toContainText(NOTE_CANARY);

  // the members dialog and the export button work under the policy, too
  await page.getByRole('button', { name: 'Share' }).click();
  await expect(dialogOf(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const zip = readZip(readFileSync(await (await dl).path()));
  expect(Object.keys(zip)).toContain('wds-export.json');
  expect(Buffer.concat(Object.values(zip)).toString('utf8')).toContain(NOTE_CANARY);

  // a new page load: unlock with access ID and passphrase, the note is there
  const page2 = await newPage(ctx);
  await page2.goto(url);
  await unlockThroughDialog(page2, created.accessId);
  await expect(page2.locator('#list')).toContainText(NOTE_CANARY, { timeout: 30000 });
  await page2.locator('#list .open').first().click();
  await expect(page2.getByLabel('Note text')).toHaveValue(NOTE_CANARY + '\nsecond line');
  // typing right after "New note" must not lose characters or land in the note that was open (trial finding)
  await page2.getByRole('button', { name: 'New note' }).click();
  await page2.keyboard.type('Second note');
  await expect(page2.getByLabel('Note text')).toHaveValue('Second note');
  await expect(page2.locator('#status')).toHaveText('saved', { timeout: 20000 });
  await page2.locator('#list .open').filter({ hasText: NOTE_CANARY }).click();
  await expect(page2.getByLabel('Note text')).toHaveValue(NOTE_CANARY + '\nsecond line');

  for (const p of [page, page2]) {
    expect(await p.evaluate(() => window.__violations), 'policy violations').toEqual([]);
    expect(p.problems).toEqual([]);
  }
  await ctx.close();
});

test('the example app and its wds-verify.json pass the static checks of tools/wds-verify.mjs (production URLs, hashes of this bundle)', async ({ browserName, stack }) => {
  test.skip(browserName !== 'chromium', 'the same for every browser');
  const prod = 'https://wiai.uni-bamberg.de/datastore';
  const { html, steps } = await exampleRaw(stack);
  const app = writeTemp(stack, 'verify/index.html', html.replaceAll(stack.docs.origin + '/datastore', prod));
  writeFileSync(join(app, '..', 'wds-verify.json'), steps);
  // the static run needs no network: the scope check (which would ask production about the example's placeholder scope) is switched off here and tested against the local stack below
  const run = (file, ...extra) => spawnSync('node', [join(ROOT, 'tools', 'wds-verify.mjs'), file, '--static-only', '--hashes', join(stack.bundleDir, 'hashes.json'), ...extra], { encoding: 'utf8', env: { ...process.env, WDS_VERIFY_OFFLINE: '1' } });
  const ok = run(app);
  expect(ok.status, ok.stdout + ok.stderr).toBe(0);
  expect(ok.stdout).toContain('Content Security Policy | pass');
  expect(ok.stdout).toContain('Subresource integrity | pass');
  // the tool and the document agree on what is too wide
  const wide = writeTemp(stack, 'verify-wide/index.html', html.replaceAll(stack.docs.origin + '/datastore', prod).replace('connect-src ' + prod + '/api/', 'connect-src https://evil.example ' + prod + '/api/'));
  const bad = run(wide);
  expect(bad.status).toBe(1);
  expect(bad.stdout).toContain('Content Security Policy | **FAIL**');
});

test('wds-verify scope check against the local stack: a known scope is reported, an unknown one fails', async ({ browserName, stack }) => {
  test.skip(browserName !== 'chromium', 'the same for every browser');
  const prod = 'https://wiai.uni-bamberg.de/datastore';
  const { html } = await exampleRaw(stack);
  const page = html.replaceAll(stack.docs.origin + '/datastore', prod);
  const env = { ...process.env, WDS_VERIFY_SERVICE: stack.docs.origin + '/datastore' };
  delete env.WDS_VERIFY_OFFLINE;
  const run = (file) => spawnSync('node', [join(ROOT, 'tools', 'wds-verify.mjs'), file, '--static-only', '--hashes', join(stack.bundleDir, 'hashes.json')], { encoding: 'utf8', env });
  const known = run(writeTemp(stack, 'verify-scope/index.html', page.replaceAll('myapp-k7m2a9', stack.scope)));
  expect(known.status, known.stdout + known.stderr).toBe(0);
  expect(known.stdout).toContain('Current scope settings');
  expect(known.stdout).not.toContain('Scope exists | **FAIL**');
  const unknown = run(writeTemp(stack, 'verify-scope-unknown/index.html', page));
  expect(unknown.status).toBe(1);
  expect(unknown.stdout).toContain('Scope exists | **FAIL**');
});

test('negative control: without wasm-unsafe-eval the policy blocks key derivation, so the test above is meaningful', async ({ browser, stack }) => {
  const html = (await exampleApp(stack)).replace(" 'wasm-unsafe-eval'", '');
  expect(html).not.toContain('wasm-unsafe-eval');
  const url = 'file://' + writeTemp(stack, 'nowasm.html', html);
  const ctx = await newContext(browser);
  const page = await newPage(ctx);
  page.on('pageerror', () => {});
  await page.goto(url);
  const dlg = dialogOf(page);
  await dlg.getByRole('button', { name: 'Create a new vault' }).click();
  await dlg.getByLabel('Join code').fill(stack.joinCode);
  await dlg.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await dlg.getByLabel('Repeat passphrase').fill(PASS);
  await dlg.getByRole('button', { name: 'Create vault' }).click();
  await expect(dlg.getByRole('heading', { name: 'Save your access sheet' })).toHaveCount(0, { timeout: 15000 });
  await page.waitForTimeout(3000);
  await expect(dlg.getByRole('heading', { name: 'Save your access sheet' })).toHaveCount(0);
  await ctx.close();
});

test('onerror fallback: a library that cannot be loaded or whose hash does not match leaves a message, not a blank page', async ({ browser, stack }) => {
  const ctx = await newContext(browser);
  const good = await exampleApp(stack);
  const variants = {
    'wrong hash': good.replace(stack.sri, 'sha384-' + 'A'.repeat(64)),
    'missing file': good.replace('/client/wds-' + stack.version + '.js', '/client/wds-0.0.1.js'),
  };
  for (const [label, html] of Object.entries(variants)) {
    const page = await newPage(ctx);
    page.on('pageerror', () => {}); // the app script fails because WDS is missing; that is the point
    await page.goto('file://' + writeTemp(stack, 'broken.html', html));
    await expect(page.locator('body'), label).toHaveText(/Storage service unreachable/, { timeout: 15000 });
    expect(await page.evaluate(() => typeof WDS), label).toBe('undefined');
  }
  await ctx.close();
});

// ---- export page ----

// A vault with a JSON record and a binary file, created through the core client in a page that loads the bundle from disk.
async function makeVault(browser, stack) {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const file = writeTemp(stack, 'core.html', '<!doctype html><meta charset="utf-8"><script src="file://' + stack.bundleFile + '"></script><p>core</p>');
  await page.goto('file://' + file);
  const made = await page.evaluate(async ({ scope, service, joinCode, passphrase, canary }) => {
    const c = new WDSCore.Client({ scope, service });
    const v = await c.createVault({ passphrase, joinCode });
    await c.put('notes/' + canary, { text: canary, n: 1 });
    await c.put('files/data.bin', new Uint8Array([1, 2, 3, 250, 251, 252]), { mime: 'application/octet-stream' });
    return { accessId: v.accessId, keyFile: v.keyFile.text };
  }, { scope: stack.scope, service: stack.docs.service, joinCode: stack.joinCode, passphrase: PASS, canary: NOTE_CANARY });
  await ctx.close();
  return made;
}

async function checkExport(page, download) {
  const zip = readZip(readFileSync(await download.path()));
  expect(Object.keys(zip).sort()).toEqual(['README.txt', 'files/data.bin', 'notes/' + NOTE_CANARY + '.json', 'wds-export.json']);
  expect([...zip['files/data.bin']]).toEqual([1, 2, 3, 250, 251, 252]);
  expect(JSON.parse(zip['notes/' + NOTE_CANARY + '.json'].toString('utf8'))).toEqual({ text: NOTE_CANARY, n: 1 });
  await expect(page.locator('#msg')).toContainText('Done: 2 items', { timeout: 20000 });
}

test('export page, served by the server: typed app ID and access ID, passphrase in the library dialog, ZIP download', async ({ browser, stack }) => {
  const vault = await makeVault(browser, stack);
  const ctx = await newContext(browser);
  const page = await newPage(ctx);
  await page.goto(stack.docs.origin + '/datastore/export/');
  await expect(page.getByRole('heading', { name: 'Export a vault' })).toBeVisible();
  // the page names the library of this server with its hash
  const tag = await page.locator('script[src*="/client/wds-"]').first().evaluate((s) => ({ src: s.src, integrity: s.integrity, crossOrigin: s.crossOrigin }));
  expect(tag).toEqual({ src: stack.docs.origin + '/datastore/client/wds-' + stack.version + '.js', integrity: stack.sri, crossOrigin: 'anonymous' });

  await page.getByRole('button', { name: 'Unlock and export' }).click();
  await expect(page.locator('#msg')).toContainText('enter the app ID');
  await page.locator('#scope').fill('not a scope');
  await page.getByRole('button', { name: 'Unlock and export' }).click();
  await expect(page.locator('#msg')).toContainText('looks wrong');

  await page.locator('#scope').fill(stack.scope);
  await page.locator('#access').fill(vault.accessId.toLowerCase());
  await page.getByRole('button', { name: 'Unlock and export' }).click();
  const dlg = dialogOf(page);
  await expect(dlg.getByLabel('Access ID')).toHaveValue(vault.accessId.replace(/(.{4})(?=.)/g, '$1-')); // prefilled by the page
  await dlg.getByLabel('Passphrase', { exact: true }).fill('wrong passphrase that is long enough');
  await dlg.getByRole('button', { name: 'Unlock' }).click();
  await expect(dlg.getByRole('alert').filter({ hasText: 'does not match this access ID' })).toBeVisible();
  const dl = page.waitForEvent('download');
  await dlg.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await dlg.getByRole('button', { name: 'Unlock' }).click();
  await checkExport(page, await dl);
  expect(await page.evaluate(() => window.__violations)).toEqual([]);
  expect(page.problems).toEqual([]);

  // cancelling the dialog exports nothing and says so
  await page.getByRole('button', { name: 'Unlock and export' }).click();
  await dialogOf(page).getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('#msg')).toContainText('Cancelled');
  await ctx.close();
});

test('export page with a key file, in German', async ({ browser, stack }) => {
  const vault = await makeVault(browser, stack);
  const kfPath = writeTemp(stack, 'vault.wds.json', vault.keyFile);
  const ctx = await newContext(browser, { locale: 'de-DE' });
  const page = await newPage(ctx);
  await page.goto(stack.docs.origin + '/datastore/export/');
  await expect(page.getByRole('heading', { name: 'Tresor exportieren' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.locator('#keyfile').setInputFiles(kfPath);
  await expect(page.locator('#scope')).toHaveValue(stack.scope);
  await expect(page.locator('#access')).toHaveValue(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
  await expect(page.locator('#msg')).toContainText('Schlüsseldatei gelesen');
  await page.getByRole('button', { name: 'Entsperren und exportieren' }).click();
  const dlg = dialogOf(page);
  await dlg.getByLabel('Passphrase', { exact: true }).fill(PASS);
  const dl = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'Entsperren' }).click();
  const zip = readZip(readFileSync(await (await dl).path()));
  expect(Object.keys(zip)).toContain('wds-export.json');
  await expect(page.locator('#msg')).toContainText('Fertig: 2 Datensätze');
  // a key file of another service is refused
  const other = writeTemp(stack, 'other.wds.json', vault.keyFile.replace(stack.docs.service, 'https://elsewhere.example/datastore/'));
  await page.locator('#keyfile').setInputFiles(other);
  await expect(page.locator('#msg')).toContainText('anderen Dienst');
  await ctx.close();
});

test('the export page saved to disk and opened from file:// still works (absolute library URL, hash check, policy in the page)', async ({ browser, stack }) => {
  const vault = await makeVault(browser, stack);
  const dlRes = await fetch(stack.docs.origin + '/datastore/export/wds-export.html');
  expect(dlRes.headers.get('content-disposition')).toContain('attachment');
  const saved = await dlRes.text();
  expect(saved).toContain('src="' + stack.docs.origin + '/datastore/client/wds-' + stack.version + '.js"');
  expect(saved).not.toMatch(/(?:src|href)="\//);
  const url = 'file://' + writeTemp(stack, 'wds-export.html', saved);
  const ctx = await newContext(browser);
  const page = await newPage(ctx);
  await page.goto(url);
  await page.locator('#scope').fill(stack.scope);
  await page.locator('#access').fill(vault.accessId);
  await page.getByRole('button', { name: 'Unlock and export' }).click();
  const dlg = dialogOf(page);
  await dlg.getByLabel('Passphrase', { exact: true }).fill(PASS);
  const dl = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'Unlock' }).click();
  await checkExport(page, await dl);
  expect(await page.evaluate(() => window.__violations)).toEqual([]);
  expect(page.problems).toEqual([]);
  await ctx.close();
});

test('export page: a library that fails to load is reported instead of a dead button', async ({ browser, stack }) => {
  const html = (await fetchText(stack.docs.origin + '/datastore/export/')).text.replace(stack.sri, 'sha384-' + 'B'.repeat(64));
  const ctx = await newContext(browser);
  const page = await newPage(ctx);
  page.on('pageerror', () => {});
  await page.goto('file://' + writeTemp(stack, 'export-broken.html', html));
  await expect(page.locator('body')).toHaveText(/Storage service unreachable/, { timeout: 15000 });
  await ctx.close();
});
