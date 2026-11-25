// Dynamic checks of wds-verify (PLAN 9.6, second group): run the app in Chromium against a local mock (the real server) or the public
// sandbox, type canary strings into every field, press the save buttons, reload, and look for the canaries everywhere they could have gone.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { ROOT, MockUnavailable } from './python.mjs';
import { Canaries, findIn } from './canary.mjs';
import { DATASTORE_HOST, scanHtml } from './static-checks.mjs';
import { instrument } from './page-instrument.mjs';
import { RE_SCOPE, sriOfFile, rewriteScopes } from './targets.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = '(?<![\\p{L}\\p{N}])', R_ = '(?![\\p{L}\\p{N}])';
const SAVE_RE = new RegExp(L + '(save|speichern|sichern|add|hinzufügen|hinzufuegen|ok|submit|senden|apply|übernehmen|anlegen|create|erstellen)' + R_, 'iu');
const NOT_SAVE_RE = new RegExp(L + '(delete|remove|clear|reset|cancel|close|löschen|entfernen|abbrechen|export|download|import|lock|sperren)' + R_, 'iu');

// A 1x1 PNG; the generated upload appends a canary after its end (decoders ignore trailing bytes).
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export class PlaywrightMissing extends Error {}
class RunAbort extends Error {}   // the run cannot go on (the vault could not be created)
async function loadPlaywright() {
  try { return (await import('playwright')).default || (await import('playwright')); } catch (e) { /* try the client's copy */ }
  try { return createRequire(join(ROOT, 'client', 'package.json'))('playwright'); } catch (e) { /* none */ }
  throw new PlaywrightMissing('Playwright is not installed. Run "npm install" in tools/ and "npx playwright install chromium".');
}

function hostOf(url) { try { return new URL(url).host; } catch (e) { return ''; } }

// Search every collected place for canaries. sinks: [{sink, where, data}] -> Map(sink -> hits)
function leakFindings(sinks, canaries) {
  const bySink = new Map();
  for (const s of sinks) {
    const hit = canaries.scan(s.data);
    if (!hit) continue;
    if (!bySink.has(s.sink)) bySink.set(s.sink, []);
    bySink.get(s.sink).push({ where: s.where, canary: hit.item, enc: hit.needle.enc });
  }
  return bySink;
}

// Why is this element not visible to a person? null when it is (a box, not display:none / visibility:hidden / transparent up the
// tree, not covered by other content). Runs in the page.
const whyHidden = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 6) return 'it has no box (' + Math.round(r.width) + 'x' + Math.round(r.height) + ')';
  let opacity = 1;
  for (let n = el; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none') return 'display:none on ' + (n === el ? 'itself' : n.tagName.toLowerCase() + (n.className && n.className.baseVal === undefined ? '.' + String(n.className).split(' ')[0] : ''));
    opacity *= parseFloat(cs.opacity);
  }
  if (getComputedStyle(el).visibility !== 'visible') return 'visibility:' + getComputedStyle(el).visibility;
  if (opacity < 0.2) return 'opacity ' + opacity.toFixed(2);
  if (getComputedStyle(el).pointerEvents === 'none') return null;   // the browser cannot tell what covers it (the library's bar lets clicks through)
  const top = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1));
  if (!top || !(top === el || el.contains(top))) return 'it is covered by <' + (top ? top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') : 'nothing') + '>';
  return null;
};

// config: { locale, steps, afterReload } of wds-verify.json; target: { name: 'mock' } or { name: 'sandbox', scopeId, serviceOrigin?, libraryFile? }.
export async function dynamicChecks({ appPath, html, config = {}, library, target = { name: 'mock' }, opts = {} }) {
  const steps = config.steps || [], afterReload = config.afterReload || [];
  const sb = target.name === 'sandbox';
  const findings = [];
  const add = (id, level, title, detail) => findings.push({ id, level, title, detail: detail || '' });
  const info = { target: target.name };
  const tmp = mkdtempSync(join(tmpdir(), 'wds-verify-'));
  let mock = null, browser = null;
  const t0 = Date.now();
  try {
    const pw = await loadPlaywright();
    // What the datastore host is mapped to: the local mock (mock target), a service named by WDS_VERIFY_SERVICE (tests), or the real
    // service (sandbox target: requests pass through).
    let libFile = null, libSri = null, svcOrigin = null;
    if (!sb) {
      const { startMock } = await import('./wds-mock.mjs');   // loaded here: the sandbox target needs neither Python nor the client sources
      mock = await startMock({ bundle: true });
      info.mock = mock.service; info.python = mock.python;
      libFile = mock.bundle.file; libSri = mock.bundle.sri; svcOrigin = mock.origin;
    } else {
      if (target.libraryFile) { libFile = target.libraryFile; libSri = sriOfFile(libFile); }
      if (target.serviceOrigin) svcOrigin = target.serviceOrigin;
    }

    // The page under test is a copy. Mock: the library tag carries the integrity hash of the mock's bundle (the production hash cannot
    // match: the mock library pins the mock's escrow keys, not the faculty's). Sandbox: the production tag stays, every scope ID of
    // the app is replaced by the sandbox ID. Everything else stays as written.
    const libTag = library && library.tag;
    if (!libTag) { add('dynamic-run', 'fail', 'Dynamic checks', 'The page has no valid library script tag, so there is nothing to run.'); return { findings, info }; }
    let pageHtml = html;
    if (libSri) {
      const newTag = libTag.raw.replace(/\sintegrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, '').replace(/>$/, ' integrity="' + libSri + '">');
      pageHtml = html.slice(0, libTag.index) + newTag + html.slice(libTag.end);
    }
    if (sb) {
      const rw = rewriteScopes(pageHtml, scanHtml(pageHtml).scripts, target.scopeId);
      if (!rw.sites) {
        add('sandbox-scope', 'fail', 'Scope of the app', 'wds-verify found no WDS.connect({ scope: "..." }) with a literal scope ID (or a constant that holds one, declared in the same script), so it cannot point the app at the sandbox without guessing. Write the scope ID as a string literal in the WDS.connect call, or use --target mock.');
        return { findings, info };
      }
      pageHtml = rw.html; info.replacedScopes = rw.replaced;
      add('sandbox-scope', 'info', 'Scope of the app in this run', rw.replaced.length ? 'WDS.connect names ' + rw.replaced.join(', ') + '; for this run it is replaced by the sandbox scope ' + target.scopeId + ' (nothing else in the page is changed).' : 'WDS.connect already names the sandbox scope.');
    }
    const appDir = join(tmp, 'app');
    const pagePath = join(appDir, basename(appPath).replace(/[^A-Za-z0-9._-]/g, '_'));
    mkdirSync(appDir, { recursive: true });
    writeFileSync(pagePath, pageHtml);

    const canaries = new Canaries();
    const passphrase = 'wdsv-' + randomBytes(5).toString('hex') + '-' + randomBytes(5).toString('hex') + '-' + randomBytes(5).toString('hex');
    canaries.add('the vault passphrase', 'secret', passphrase);

    browser = await pw.chromium.launch({ headless: !opts.headed });
    const locale = opts.locale || config.locale || 'en-US';
    info.locale = locale;
    const context = await browser.newContext({ locale, acceptDownloads: true, viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();

    // ---- observation ----
    const requests = [], externals = [], navigations = [], consoleLines = [], pageErrors = [], downloads = [], sockets = [], apiErrors = [];
    const storeLog = [], netLog = [], exportWindows = [], storeErrors = [];
    const pending = new Set();
    const unexpected = [];
    const note = (msg) => { if (!unexpected.includes(msg)) unexpected.push(msg); };
    let lastActivity = Date.now();
    const touch = () => { lastActivity = Date.now(); };
    const knownScopes = new Set();
    const clickTimes = [];   // when the tool pressed a button: writes on either side of a click are not one burst
    let expectDownload = 0;  // > 0 while a "download" step waits for its file
    await context.exposeFunction('__wdsLog', (rec) => {
      touch();
      if (rec.kind === 'net') netLog.push(rec);
      else if (rec.kind === 'store') storeLog.push(rec);
      else if (rec.kind === 'export') exportWindows.push(rec);
      else if (rec.kind === 'error') storeErrors.push(rec);
    });
    await context.addInitScript(instrument);
    context.on('request', (r) => {
      pending.add(r); touch();
      let body = null; try { body = r.postDataBuffer(); } catch (e) { /* none */ }
      requests.push({ t: Date.now(), method: r.method(), url: r.url(), headers: r.headers(), body: body ? Buffer.from(body) : null, nav: r.isNavigationRequest() });
    });
    context.on('requestfinished', (r) => { pending.delete(r); touch(); });
    context.on('requestfailed', (r) => { pending.delete(r); touch(); });
    context.on('response', async (resp) => {
      try {
        const u = new URL(resp.url());
        if (u.host !== DATASTORE_HOST || !u.pathname.startsWith('/datastore/api/') || resp.status() < 400) return;
        let code = '';
        try { const j = await resp.json(); code = j && j.error ? String(j.error) : ''; } catch (e) { /* no JSON */ }
        apiErrors.push({ t: Date.now(), status: resp.status(), code, method: resp.request().method(), path: u.pathname, retryAfter: Number(resp.headers()['retry-after']) || 0 });
      } catch (e) { /* observing only */ }
    });
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
    page.on('console', (m) => { consoleLines.push(m.type() + ': ' + m.text()); });
    page.on('pageerror', (e) => { pageErrors.push(String((e && e.message) || e)); consoleLines.push('pageerror: ' + String((e && e.stack) || e)); });
    page.on('dialog', (d) => { consoleLines.push('browser dialog (' + d.type() + '): ' + d.message()); d.accept().catch(() => {}); });
    page.on('websocket', (ws) => {
      const s = { url: ws.url(), frames: [] };
      sockets.push(s);
      ws.on('framesent', (f) => s.frames.push(f.payload));
    });
    page.on('popup', (p) => { p.close().catch(() => {}); });
    page.on('download', (d) => {
      const rec = { filename: d.suggestedFilename(), t: Date.now(), bytes: null, requested: expectDownload > 0 };
      downloads.push(rec);
      rec.done = d.path().then((p) => { rec.bytes = p ? readFileSync(p) : Buffer.alloc(0); }).catch(() => { rec.bytes = Buffer.alloc(0); });
    });

    // The datastore host is mapped to the mock (or passes through to the real service in the sandbox target); the library URL serves
    // the mock's bundle; everything else is cut off.
    await context.route('**/*', async (route, request) => {
      const url = new URL(request.url());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return route.continue();
      if (url.host === DATASTORE_HOST && url.pathname.startsWith('/datastore/')) {
        const client = /^\/datastore\/client\/(wds-[^/]+\.js)$/.exec(url.pathname);
        if (client && libFile) {
          return route.fulfill({ status: 200, body: readFileSync(libFile), headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' } });
        }
        if (!svcOrigin) return route.continue();
        const sc = /^\/datastore\/api\/v1\/scopes\/([^/]+)/.exec(url.pathname);
        if (mock && sc && !knownScopes.has(sc[1]) && RE_SCOPE.test(sc[1])) {
          knownScopes.add(sc[1]);
          try { mock.createScopeWithId(sc[1]); } catch (e) { consoleLines.push('wds-verify: ' + e.message); }
        }
        try {
          const response = await route.fetch({ url: svcOrigin + url.pathname + url.search });
          return await route.fulfill({ response });
        } catch (e) {
          note('the ' + (mock ? 'mock' : 'service') + ' did not answer ' + request.method() + ' ' + url.pathname.slice(0, 60) + ': ' + String(e.message).split('\n')[0]);
          return route.abort('failed').catch(() => {});
        }
      }
      externals.push({ t: Date.now(), method: request.method(), url: request.url(), body: (() => { try { return request.postDataBuffer(); } catch (e) { return null; } })() });
      return route.abort('blockedbyclient');
    });

    // ---- helpers that drive the page ----
    // The library's dialogs are driven by their stable attributes (data-wds-view on the dialog, data-wds on every control), so the
    // run works in every language. Only the app's own buttons are found by their text (and by data-wds-verify="save").
    const dlg = () => page.locator('[data-wds-view]').last();
    const ctl = (d, name) => d.locator('[data-wds="' + name + '"]');
    const present = async (d, name) => (await ctl(d, name).first().isVisible().catch(() => false));
    const label = { banner: undefined, bar: undefined };   // the sandbox label: undefined (not looked at), 'visible', 'hidden', 'absent'
    let createFailures = 0;
    const unavailableError = (e) => e.status === 429 || e.code === 'sandbox_disabled' || e.code === 'vault_limit_reached';
    const labelWhy = {};
    async function probeLabel(name) {
      const loc = page.locator('[data-wds="' + name + '"]').first();
      if (!(await loc.count().catch(() => 0))) return 'absent';
      const why = await loc.evaluate(whyHidden).catch((e) => 'not readable');
      if (why) labelWhy[name] = why;
      return why ? 'hidden' : 'visible';
    }
    async function handleDialog() {
      const d = dlg();
      if (!(await d.isVisible().catch(() => false))) return false;
      const view = (await d.getAttribute('data-wds-view', { timeout: 2000 }).catch(() => '')) || '';
      if (sb && label.banner === undefined && view !== 'loading' && view !== 'progress') label.banner = await probeLabel('sandbox-banner');
      switch (view) {
        case 'loading': case 'progress': return false;   // wait
        case 'unlock': {
          if (info.vaultCreated) {
            // a second visit (after the reload): the vault exists, unlock it with the passphrase
            const id = ctl(d, 'access-id-input');
            if (info.accessId && !(await id.inputValue().catch(() => '')).trim()) await id.fill(info.accessId).catch(() => {});
            await ctl(d, 'passphrase').fill(passphrase, { timeout: 5000 });
            await ctl(d, 'unlock-submit').click({ timeout: 5000 });
            await sleep(300);
            return true;
          }
          await ctl(d, 'to-create').click({ timeout: 5000 });
          return true;
        }
        case 'create': {
          if (await present(d, 'join-code')) {
            note('the scope needs a join code to create a vault, which the tool cannot know; use a scope with open enrollment (the sandbox, or --target mock)');
            await ctl(d, 'close').click({ timeout: 3000 }).catch(() => {});
            return true;
          }
          await ctl(d, 'passphrase').fill(passphrase, { timeout: 5000 });
          await ctl(d, 'passphrase-repeat').fill(passphrase, { timeout: 5000 });
          await ctl(d, 'create-submit').click({ timeout: 5000 });
          const waitStart = Date.now();
          for (;;) {
            const v = await d.getAttribute('data-wds-view', { timeout: 2000 }).catch(() => null);
            if (v === 'sheet') break;
            const err = ((await ctl(d, 'form-error').first().innerText().catch(() => '')) || '').trim()
              || (await d.locator('[aria-invalid="true"]').count().catch(() => 0) ? 'a field was marked invalid' : '');
            if (err) {
              note('creating the vault failed: ' + err);
              createFailures++;
              await sleep(300);   // the response event of the failed request
              if (createFailures >= 2 || apiErrors.some(unavailableError)) { await ctl(d, 'close').click({ timeout: 2000 }).catch(() => {}); throw new RunAbort('vault creation failed'); }
              return false;
            }
            if (v === null) { note('creating the vault failed: the dialog closed without an access sheet'); return false; }
            if (Date.now() - waitStart > 60000) { note('creating the vault failed: timeout'); return false; }
            await sleep(150);
          }
          info.vaultCreated = true;
          return true;
        }
        case 'sheet': {
          info.accessId = ((await ctl(d, 'access-id').first().innerText().catch(() => '')) || '').trim() || info.accessId;
          await ctl(d, 'sheet-confirm').check({ timeout: 5000 }).catch(() => {});
          await ctl(d, 'sheet-continue').click({ timeout: 5000 });
          await d.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
          return true;
        }
        case 'notice': {
          const ack = (await present(d, 'recovered-ack')) ? 'recovered-ack' : (await present(d, 'recovery-keep')) ? 'recovery-keep' : 'close';
          note('the library showed a notice dialog; the tool acknowledged it (' + ack + ')');
          await ctl(d, ack).click({ timeout: 3000 }).catch(() => {});
          return true;
        }
        case 'conflict':
          note('a conflict dialog of the library appeared; the tool kept its own version (conflict-mine)');
          await ctl(d, 'conflict-mine').click({ timeout: 3000 }).catch(() => {});
          return true;
        default: {
          note('unexpected dialog of the library: view "' + view + '"');
          if (await present(d, 'close')) { await ctl(d, 'close').click({ timeout: 3000 }).catch(() => {}); return true; }
          return false;
        }
      }
    }
    // Wait until the network has been quiet for a moment; handle library dialogs that show up meanwhile.
    async function settle(quietMs = 700, maxMs = 60000) {
      const start = Date.now();
      for (;;) {
        if (Date.now() - start > maxMs) { note('the page did not settle within ' + Math.round(maxMs / 1000) + ' s'); return; }
        if (await handleDialog().catch((e) => { if (e instanceof RunAbort) throw e; note('dialog handling failed: ' + String(e.message).split('\n').slice(0, 2).join(' ').slice(0, 200)); return false; })) { touch(); continue; }
        if (unexpected.length > 6) return;
        // A request that never reports its end (a fetch whose body the app never reads) must not keep the run waiting.
        const busy = pending.size > 0 && Date.now() - lastActivity < 2500;
        if (process.env.WDS_VERIFY_DEBUG && pending.size) console.error('pending: ' + [...pending].map((r) => r.method() + ' ' + r.url()).join(' | '));
        if (!busy && Date.now() - lastActivity >= quietMs) {
          if (!(await dlg().isVisible().catch(() => false))) return;
          // a dialog without an action of the tool (loading, progress) is waited for; one that stays for long is a note
          if (Date.now() - lastActivity > 15000) { note('a library dialog stayed open: view "' + ((await dlg().getAttribute('data-wds-view', { timeout: 2000 }).catch(() => '')) || '?') + '"'); return; }
        }
        await sleep(100);
      }
    }
    async function fillFields(round) {
      const handles = await page.$$('input, textarea, [contenteditable=""], [contenteditable="true"]');
      let typed = 0, count = 0, hidden = 0;
      for (const h of handles) {
        const d = await h.evaluate((el) => {
          if (el.closest('.wds-root')) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
          const type = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : el.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable';
          const value = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : el.textContent;
          const label = (el.getAttribute('aria-label') || el.id || el.getAttribute('name') || el.getAttribute('placeholder') || el.tagName.toLowerCase());
          return { visible, type, disabled: !!el.disabled || !!el.readOnly || el.closest('[inert]') !== null, label: label.slice(0, 40), empty: !String(value || '').trim() };
        }).catch(() => null);
        if (!d) continue;
        if (!d.visible) { if (!['hidden', 'file'].includes(d.type)) hidden++; continue; }
        if (d.disabled) continue;
        const kind = { email: 'email', url: 'url', tel: 'tel', number: 'number' }[d.type];
        const textLike = !kind && ['text', 'search', 'password', 'textarea', 'contenteditable'].includes(d.type);
        if (!kind && !textLike) {
          // inputs without free text: give them a valid value so a form can be submitted, no canary
          const fixed = { date: '2031-07-19', time: '13:37', 'datetime-local': '2031-07-19T13:37', month: '2031-07', week: '2031-W29' }[d.type];
          if (fixed && d.empty) await h.fill(fixed).catch(() => {});
          continue;
        }
        if (round > 1 && !d.empty) continue; // second round: only fields the app emptied again (e.g. after "Add")
        const c = canaries.make(d.type + ' "' + d.label + '"', kind || 'text');
        c.round = round;   // round 2 fills fields that the app emptied again: a second item
        try {
          // the first free-text field is typed key by key: apps that save on every key stroke show up
          if (textLike && typed === 0 && round === 1) { await h.fill('', { timeout: 3000 }); await h.focus(); await page.keyboard.type(c.value, { delay: 12 }); typed++; }
          else await h.fill(c.value, { timeout: 4000 });
          await h.evaluate((el) => { el.dispatchEvent(new Event('change', { bubbles: true })); if (el.blur) el.blur(); }).catch(() => {});
          count++;
        } catch (e) { note('could not type into ' + d.type + ' "' + d.label + '": ' + String(e.message).split('\n')[0]); }
      }
      if (round === 1) info.hiddenFields = hidden;
      return count;
    }
    // The buttons the tool presses: the app's own (not the library's), recognised by data-wds-verify="save" or by the word list.
    const BUTTONS = 'button, input[type=submit], input[type=button], [role=button], a[href="#"], a[onclick], [data-wds-verify="save"]';
    async function appButtons() {
      const handles = await page.$$(BUTTONS);
      const out = [];
      for (const h of handles) {
        const d = await h.evaluate((el) => {
          if (el.closest('.wds-root')) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const text = ((el.tagName === 'INPUT' ? el.value : el.innerText || el.textContent) || el.getAttribute('aria-label') || el.title || '').trim().replace(/\s+/g, ' ');
          return { text, visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none', disabled: !!el.disabled || el.closest('[inert]') !== null, id: el.id || '', hinted: el.getAttribute('data-wds-verify') === 'save' };
        }).catch(() => null);
        if (d) out.push({ h, ...d });
      }
      return out;
    }
    const pressed = new Set();   // the text of every button pressed over the whole run (by the tool or by a click step)
    async function clickSaves(clicked) {
      for (let guard = 0; guard < 12; guard++) {
        let target = null;
        for (const b of await appButtons()) {
          if (!b.visible || b.disabled || (!b.text && !b.hinted)) continue;
          if (!b.hinted && (!SAVE_RE.test(b.text) || NOT_SAVE_RE.test(b.text))) continue;
          const key = b.id + '|' + b.text;
          if (clicked.has(key)) continue;
          clicked.add(key); pressed.add(b.text); target = b; break;
        }
        if (!target) return;
        info.clicks.push(target.text || '(data-wds-verify="save")');
        clickTimes.push(Date.now());
        await target.h.click({ timeout: 4000, noWaitAfter: true }).catch((e) => note('could not click "' + target.text + '": ' + String(e.message).split('\n')[0]));
        await settle();
      }
    }

    // The steps of wds-verify.json (steps, afterReload). Failures become findings; ids/titles say which list the step is in.
    const stepCount = { click: 0, fill: 0, upload: 0, wait: 0, select: 0, press: 0, download: 0 };
    let uploads = 0;
    const requestedDownloads = [];
    async function runSteps(list, listName) {
      const tag = listName === 'steps' ? '' : listName + ' ';
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const id = (listName === 'steps' ? 'step-' : listName + '-step-') + (i + 1), title = 'wds-verify.json ' + tag + 'step ' + (i + 1);
        try {
          if (s.click) {
            stepCount.click++; clickTimes.push(Date.now());
            const loc = page.locator(s.click).first();
            const txt = await loc.evaluate((el) => ((el.tagName === 'INPUT' ? el.value : el.innerText || el.textContent) || '').trim().replace(/\s+/g, ' '), undefined, { timeout: 5000 }).catch(() => '');
            if (txt) pressed.add(txt);
            await loc.click({ timeout: 5000 }); await settle();
          }
          else if (s.upload) {
            stepCount.upload++;
            let payload;
            if (s.upload.length === 2) {
              payload = resolve(dirname(appPath), s.upload[1]);
              if (!existsSync(payload)) throw new Error('no such file: ' + s.upload[1]);
              const fname = basename(payload);
              if (fname.length >= 8) canaries.add('wds-verify.json upload file name ' + fname, 'text', fname);
            } else {
              const tg = canaries.nonce + 'u' + (++uploads);
              const name = 'wdsfile-' + tg + '.png', marker = 'WDSCANARY-FILE-' + tg;
              canaries.add('the name of the generated upload file', 'text', name);
              canaries.add('the bytes of the generated upload file', 'text', marker);
              payload = { name, mimeType: 'image/png', buffer: Buffer.concat([PNG_1X1, Buffer.from(marker)]) };
            }
            clickTimes.push(Date.now());
            await page.locator(s.upload[0]).first().setInputFiles(payload, { timeout: 5000 });
            await settle();
          }
          else if (s.fill) {
            stepCount.fill++; if (listName === 'steps') info.stepFills++;
            await page.locator(s.fill[0]).first().fill(s.fill[1], { timeout: 5000 });
            await page.locator(s.fill[0]).first().evaluate((el) => { el.dispatchEvent(new Event('change', { bubbles: true })); }).catch(() => {});
            if (s.fill[1].length >= 6) { const c = canaries.add('wds-verify.json fill ' + s.fill[0], 'text', s.fill[1]); c.round = listName === 'steps' ? 'steps' : 'afterReload'; }
            else add(id, 'warn', title, 'The text "' + s.fill[1] + '" is shorter than 6 characters; it cannot be searched for. Use a longer unique text.');
            await settle();
          }
          else if (s.select) { stepCount.select++; clickTimes.push(Date.now()); await page.locator(s.select[0]).first().selectOption(s.select[1], { timeout: 5000 }); await settle(); }
          else if (s.press) { stepCount.press++; clickTimes.push(Date.now()); await page.locator(s.press[0]).first().press(s.press[1], { timeout: 5000 }); await settle(); }
          else if (s.download) {
            stepCount.download++; clickTimes.push(Date.now());
            expectDownload++;
            try {
              const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.locator(s.download).first().click({ timeout: 5000, noWaitAfter: true })]);
              requestedDownloads.push(dl.suggestedFilename());
            } finally { expectDownload--; }
            await settle();
          }
          else if (s.wait !== undefined) { stepCount.wait++; await sleep(s.wait); }
        } catch (e) { add(id, 'fail', title, JSON.stringify(s) + ' failed: ' + String(e.message).split('\n')[0]); }
      }
    }
    // Everything of the page that a person can read after a reload: the rendered text (a tab that is not open shows nothing) and the
    // values of the inputs that are on screen.
    const pageText = () => page.evaluate(() => {
      const parts = [document.body ? document.body.innerText : ''];
      document.querySelectorAll('input, textarea, select').forEach((el) => { if (!el.closest('.wds-root') && el.getClientRects().length) parts.push(el.value || ''); });
      return parts.join('\n');
    }).catch(() => '');

    // ---- run ----
    let libLoaded = false, reload = null;
    try {
    info.clicks = []; info.fields = 0; info.steps = steps.length; info.stepFills = 0; info.stepCount = null;
    const fileUrl = pathToFileURL(pagePath).href;
    await page.goto(fileUrl, { waitUntil: 'load', timeout: 30000 });
    libLoaded = await page.evaluate(() => typeof WDS === 'object' && typeof WDS.connect === 'function').catch(() => false);
    if (!libLoaded) {
      add('library-loaded', 'fail', 'Library loads', 'WDS is not defined after loading the page. Console output:\n' + consoleLines.slice(0, 8).map((l) => '    ' + l).join('\n'));
    } else {
      add('library-loaded', 'pass', 'Library loads', 'The library of the page loaded in Chromium from a file:// URL (' + (sb ? 'the sandbox of the service' : 'the mock serves it') + ').');
      await sleep(400);
      await settle();                                   // an app that unlocks at start shows the dialog now
      info.fileInputs = await page.locator('input[type=file]').count().catch(() => 0);
      info.appDialogs = await page.locator('dialog, [role=dialog], [aria-modal="true"]').evaluateAll((els) => els.filter((e) => !e.closest('.wds-root')).length).catch(() => 0);
      info.fields += await fillFields(1);
      const clicked = new Set();
      await clickSaves(clicked);
      await runSteps(steps, 'steps');
      info.stepCount = stepCount;
      // second round: fields that the app emptied (e.g. after "Add") and fields that appeared, then the buttons again
      await sleep(1100);
      const more = await fillFields(2);
      info.fields += more;
      if (more) { await clickSaves(new Set()); }
      await sleep(opts.waitMs !== undefined ? opts.waitMs : 2800);       // debounced autosave
      await settle(900);
      // what the tool did not press
      const rest = [];
      for (const b of await appButtons()) if (b.visible && b.text && !pressed.has(b.text) && !rest.includes(b.text)) rest.push(b.text);
      info.unpressed = rest.slice(0, 12);
      if (sb) label.bar = await probeLabel('sandbox-bar');

      // reload: the data must come back (the page's own screen, after unlocking with the passphrase)
      const writtenBefore = requests.filter((r) => r.method === 'PUT' && /\/vaults\/[^/]+\/records\/[^/]+$/.test(new URL(r.url).pathname)).length;
      if (info.vaultCreated && writtenBefore) {
        await page.reload({ waitUntil: 'load', timeout: 30000 }).catch((e) => note('reload failed: ' + String(e.message).split('\n')[0]));
        await sleep(400);
        await settle(900);
        await runSteps(afterReload, 'afterReload');
        await sleep(300);
        await settle(900);
        const text = await pageText();
        const groups = new Map();
        for (const c of canaries.items.filter((x) => x.round !== undefined && x.round !== 'afterReload')) {
          const g = groups.get(c.round) || { total: 0, shown: 0 };
          g.total++; if (text.includes(c.value)) g.shown++;
          groups.set(c.round, g);
        }
        const total = [...groups.values()].reduce((n, g) => n + g.total, 0), shown = [...groups.values()].reduce((n, g) => n + g.shown, 0);
        reload = { total, shown, everyRound: [...groups.values()].every((g) => g.shown > 0), hasAfter: afterReload.length > 0 };
      }
    }
    } catch (e) {
      if (!(e instanceof RunAbort)) throw e;   // creating the vault failed for good: evaluate what there is
    }

    // ---- collect ----
    const finalUrl = page.url();
    const state = await page.evaluate(async () => {
      const out = { local: [], session: [], idb: [], caches: [], cookie: '', name: window.name };
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.local.push([k, localStorage.getItem(k)]); } } catch (e) { /* denied */ }
      try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); out.session.push([k, sessionStorage.getItem(k)]); } } catch (e) { /* denied */ }
      try { out.cookie = document.cookie; } catch (e) { /* denied */ }
      // Flatten without JSON escaping, so that bytes stay bytes (JSON would write the NUL bytes of a UTF-16 text as an escape sequence).
      const ser = (v, depth = 0) => {
        if (v === null || v === undefined || depth > 8) return '';
        if (v instanceof ArrayBuffer) v = new Uint8Array(v);
        if (ArrayBuffer.isView(v)) { const u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return s; }
        if (typeof v === 'object') return Object.keys(v).map((k) => k + '\n' + ser(v[k], depth + 1)).join('\n');
        return String(v);
      };
      try {
        const dbs = indexedDB.databases ? await indexedDB.databases() : [];
        for (const d of dbs) {
          const db = await new Promise((res, rej) => { const q = indexedDB.open(d.name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
          for (const name of Array.from(db.objectStoreNames)) {
            const store = db.transaction(name, 'readonly').objectStore(name);
            const rows = await new Promise((res, rej) => { const q = store.getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
            const keys = await new Promise((res, rej) => { const q = store.getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
            out.idb.push([d.name + '/' + name, ser({ keys, rows })]);
          }
          db.close();
        }
      } catch (e) { /* no IndexedDB */ }
      try { if (self.caches) for (const n of await caches.keys()) { const c = await caches.open(n); out.caches.push([n, (await c.keys()).map((r) => r.url).join('\n')]); } } catch (e) { /* none */ }
      return out;
    }).catch(() => ({ local: [], session: [], idb: [], caches: [], cookie: '', name: '' }));
    const cookies = await context.cookies().catch(() => []);
    await Promise.all(downloads.map((d) => d.done));
    // server side: the database of the mock after a checkpoint (the write-ahead log holds the latest pages)
    const dbFiles = !mock ? [] : readdirSync(mock.tmp).filter((f) => f.startsWith('wds.db')).map((f) => ({ f, data: readFileSync(join(mock.tmp, f)) }));
    // sandbox: delete the vault again, best effort, through the owner API of the library if the page can reach one
    if (sb && info.vaultCreated) {
      const res = await page.evaluate(async () => {
        const st = (window.__wdsStores || []).find((s) => s && typeof s.deleteVault === 'function');
        if (!st) return 'none';
        try { await st.deleteVault(); return 'deleted'; } catch (e) { return 'failed: ' + String((e && e.message) || e).slice(0, 100); }
      }).catch(() => 'none');
      info.sandboxCleanup = res;
    }
    await page.close({ runBeforeUnload: false }).catch(() => {});

    // ---- evaluate ----
    const sinks = [];
    for (const r0 of requests) {
      // a browser never sends the fragment of a page URL; the tool's own reload shows it in the request object, so cut it off
      const r = r0.nav ? { ...r0, url: r0.url.split('#')[0] } : r0;
      let decoded = r.url; try { decoded = decodeURIComponent(r.url); } catch (e) { /* keep */ }
      sinks.push({ sink: 'request URL', where: r.method + ' ' + r.url.slice(0, 100), data: r.url });
      sinks.push({ sink: 'request URL', where: r.method + ' ' + r.url.slice(0, 100), data: decoded });
      sinks.push({ sink: 'request header', where: r.method + ' ' + r.url.slice(0, 100), data: JSON.stringify(r.headers) });
      if (r.body) sinks.push({ sink: 'request body', where: r.method + ' ' + r.url.slice(0, 100), data: r.body });
    }
    for (const e of externals) {
      sinks.push({ sink: 'request URL', where: e.method + ' ' + e.url.slice(0, 100) + ' (blocked)', data: e.url });
      sinks.push({ sink: 'request URL', where: e.method + ' ' + e.url.slice(0, 100) + ' (blocked)', data: decodeURIComponentSafe(e.url) });
      if (e.body) sinks.push({ sink: 'request body', where: e.method + ' ' + e.url.slice(0, 100) + ' (blocked)', data: Buffer.from(e.body) });
    }
    for (const n of netLog.filter((x) => x.from === 'app')) {
      sinks.push({ sink: 'request URL', where: n.api + ' ' + n.url.slice(0, 100) + ' (call by the app)', data: n.url });
      sinks.push({ sink: 'request URL', where: n.api + ' ' + n.url.slice(0, 100) + ' (call by the app)', data: decodeURIComponentSafe(n.url) });
      if (n.body) sinks.push({ sink: 'request body', where: n.api + ' ' + n.url.slice(0, 100) + ' (call by the app)', data: n.body });
    }
    for (const u of [...navigations, finalUrl]) { sinks.push({ sink: 'page URL', where: u.slice(0, 120), data: u }); sinks.push({ sink: 'page URL', where: u.slice(0, 120), data: decodeURIComponentSafe(u) }); }
    for (const s of sockets) for (const f of s.frames) sinks.push({ sink: 'WebSocket frame', where: s.url, data: typeof f === 'string' ? f : Buffer.from(f) });
    for (const [k, v] of state.local) sinks.push({ sink: 'localStorage', where: 'key ' + k.slice(0, 60), data: k + '\n' + v });
    for (const [k, v] of state.session) sinks.push({ sink: 'sessionStorage', where: 'key ' + k.slice(0, 60), data: k + '\n' + v });
    for (const [k, v] of state.idb) sinks.push({ sink: 'IndexedDB', where: k, data: v });
    for (const [k, v] of state.caches) sinks.push({ sink: 'Cache Storage', where: k, data: v });
    sinks.push({ sink: 'cookie', where: 'document.cookie', data: state.cookie });
    for (const c of cookies) sinks.push({ sink: 'cookie', where: c.name, data: c.name + '=' + c.value });
    sinks.push({ sink: 'window.name', where: 'window.name', data: state.name || '' });
    for (const l of consoleLines) sinks.push({ sink: 'console output', where: l.slice(0, 80), data: l });
    const inExport = (t) => exportWindows.some((w) => t >= w.start - 500 && t <= w.end + 4000);
    const dlOutside = downloads.filter((d) => !inExport(d.t) && !d.requested);
    for (const d of dlOutside) sinks.push({ sink: 'download', where: d.filename, data: Buffer.concat([Buffer.from(d.filename + '\n'), d.bytes || Buffer.alloc(0)]) });
    for (const f of dbFiles) sinks.push({ sink: 'server database (mock)', where: f.f, data: f.data });
    const leaks = leakFindings(sinks, canaries);
    const SINK_ORDER = ['request URL', 'request header', 'request body', 'page URL', 'WebSocket frame', 'localStorage', 'sessionStorage', 'IndexedDB', 'Cache Storage', 'cookie', 'window.name', 'console output', 'download', 'server database (mock)'];
    for (const sink of SINK_ORDER.filter((s) => !(sb && s === 'server database (mock)'))) {
      const hits = leaks.get(sink);
      if (!hits) { add('leak-' + sink, 'pass', 'No canary in ' + sink, ''); continue; }
      const seen = new Set(), lines = [];
      for (const h of hits) {
        const k = h.where + '|' + h.canary.index;
        if (seen.has(k)) continue; seen.add(k);
        const secret = h.canary.kind === 'secret';
        lines.push('- ' + (secret ? 'the passphrase' : 'canary from ' + h.canary.label) + ' appears (' + h.enc + ') in ' + h.where);
      }
      add('leak-' + sink, 'fail', 'Canary found in ' + sink, lines.slice(0, 6).join('\n') + (lines.length > 6 ? '\n- ... and ' + (lines.length - 6) + ' more' : ''));
    }
    if (downloads.length) {
      const names = downloads.map((d) => d.filename + (inExport(d.t) ? ' (exportAll, not checked)' : d.requested ? ' (user-requested download, contains canaries: ' + (canaries.scan(d.bytes || Buffer.alloc(0)) ? 'yes' : 'no') + ')' : ''));
      add('downloads', 'info', 'Downloads', names.join(', '));
    }

    if (sb) add('database-not-inspected', 'info', 'Server database', 'Server database not inspected (sandbox target); the requests the app and the library sent were still searched for canaries.');

    // vault and saves
    if (libLoaded) {
      if (info.vaultCreated) add('vault', 'pass', 'Vault created', sb ? 'The library dialog created a vault in the sandbox (open enrollment, passphrase checked by the library).' : 'The library dialog created a vault in the mock (open enrollment, passphrase checked by the library).');
      else add('vault', 'fail', 'Vault created', 'The app never opened the unlock dialog, so no vault was created and nothing could be stored. ' + (unexpected.length ? unexpected.join('; ') : 'Does the app call store.unlock() or a store method?'));
      const puts = requests.filter((r) => r.method === 'PUT' && /\/vaults\/[^/]+\/records\/[^/]+$/.test(new URL(r.url).pathname));
      info.recordWrites = puts.length;
      if (info.vaultCreated && !puts.length) add('saved', 'fail', 'Data was saved', 'The test could not make the app store anything (no record write reached the datastore), so the leak checks prove little. Add steps in wds-verify.json next to the app, e.g. {"steps": [{"fill": ["#name", "some unique text"]}, {"click": "#save"}]}, or mark the app\'s save button with data-wds-verify="save".');
      else if (puts.length) add('saved', 'pass', 'Data was saved', puts.length + ' encrypted record write(s) reached the mock; the canaries were searched for in all of them.');
      if (info.fields === 0 && info.stepFills === 0) add('fields', 'warn', 'Input fields', 'No visible input, textarea or contenteditable element was found to type into.');
      else add('fields', 'info', 'Input fields', (info.fields + info.stepFills) + ' field(s) filled with canaries (' + info.fields + ' found by the tool, ' + info.stepFills + ' by wds-verify.json steps); buttons pressed by the tool: '
        + (info.clicks.length ? info.clicks.map((c) => '"' + c + '"').join(', ') : 'none') + '.');
      if (steps.length && info.stepCount) {
        const c = info.stepCount;
        const extra = ['select', 'press', 'download'].filter((k) => c[k]).map((k) => ', ' + c[k] + ' ' + k).join('');
        add('steps', 'info', 'wds-verify.json steps', steps.length + ' step(s) run (' + c.fill + ' fill, ' + c.click + ' click, ' + c.upload + ' upload, ' + c.wait + ' wait' + extra + ').');
      }
      if (info.fileInputs && !(info.stepCount && info.stepCount.upload)) add('file-inputs', 'info', 'File inputs', 'The page has ' + info.fileInputs + ' file input(s) that the tool does not use. Add an {"upload": ["selector"]} step to wds-verify.json to test the upload path (a generated image whose name and bytes are searched for like canaries).');
    }
    const notes = sb ? unexpected.filter((u) => !/pw\.hibp\.unavailable/.test(u)) : unexpected;
    if (notes.length) add('driver', 'warn', 'Test run notes', notes.slice(0, 6).join('\n'));
    if (info.locale !== 'en-US') add('locale', 'info', 'Browser language', 'The browser ran with the locale ' + info.locale + ' (the library dialogs follow it unless the app sets one).');

    // data after a reload: the page must read its data back after unlocking
    if (reload && reload.total) {
      const { total, shown, everyRound, hasAfter } = reload;
      if (shown > 0 && everyRound) add('reload', 'pass', 'Data after reload', shown + ' of ' + total + ' typed value(s) are visible again after reloading and unlocking (at least one of every round).');
      else if (shown === 0 && !hasAfter) add('reload', 'fail', 'Data after reload', 'Records were written, but after reloading the page and unlocking the vault none of the ' + total + ' typed values is visible. The app does not read its data back when it starts (call store.get / list after unlock and show the values), or it shows the data only in a view that the tool does not open: then add "afterReload" steps to wds-verify.json, for example {"afterReload": [{"click": "#tab-notes"}]}.');
      else add('reload', 'warn', 'Data after reload', shown + ' of ' + total + ' typed values are visible after reload; an app with tabs needs afterReload steps in wds-verify.json (they open the views that show the data).');
    }
    info.reload = reload;

    // the sandbox label must stay visible (the app must not hide it) and the sandbox may be unavailable or full
    if (sb) {
      const problems = [];
      const names = { banner: 'the banner in the library dialogs', bar: 'the bar at the top of the page' };
      for (const k of ['banner', 'bar']) {
        if (k === 'bar' && !info.vaultCreated) continue;
        if (label[k] === 'hidden') problems.push(names[k] + ' is hidden (' + (labelWhy['sandbox-' + k] || 'the app hides the sandbox label') + '); the app hides the sandbox label');
        else if (label[k] === 'absent') problems.push(names[k] + ' is missing (is the library tag the current one?)');
      }
      if (label.banner === undefined && label.bar === undefined) { /* no library dialog was seen: nothing to judge */ }
      else if (problems.length) add('sandbox-label', 'fail', 'Sandbox label visible', 'The run was against the sandbox, which must label itself: ' + problems.join('; ') + '. People must be able to see that they are in a test environment; remove CSS or script that hides the library\'s elements.');
      else add('sandbox-label', 'pass', 'Sandbox label visible', 'The sandbox banner' + (info.vaultCreated ? ' and the bar at the top' : '') + ' were visible to a person.');
      const quota = apiErrors.filter((e) => e.status === 413 || /quota/i.test(e.code)).length + storeErrors.filter((e) => e.name === 'QuotaError').length + consoleLines.filter((l) => /QuotaError/.test(l)).length;
      if (quota) add('sandbox-limit', 'info', 'Sandbox limit', 'A save hit a quota of the sandbox (smaller than the real scope\'s); that part is a sandbox limit, not tested.');
      const unav = apiErrors.find(unavailableError);
      if (unav && !info.vaultCreated) {
        const why = unav.status === 429 ? 'too many vaults were created from this network recently' + (unav.retryAfter ? '; try again in about ' + Math.ceil(unav.retryAfter / 60) + ' minute(s)' : '')
          : unav.code === 'sandbox_disabled' ? 'the sandbox is switched off on the service at the moment' : 'the sandbox is full (vault limit reached; it is emptied every night)';
        info.unavailable = { reason: why, retryAfter: unav.retryAfter, code: unav.code || String(unav.status) };
        return { findings: findings.filter((f) => f.id === 'library-loaded').concat([{ id: 'sandbox-unavailable', level: 'info', title: 'Sandbox unavailable', detail: 'Sandbox unavailable, not an app finding: ' + why + '. The dynamic checks did not run.' }]), info };
      }
      if (info.sandboxCleanup === 'deleted') add('sandbox-cleanup', 'info', 'Sandbox vault', 'The vault of this run was deleted again.');
      else add('sandbox-cleanup', 'info', 'Sandbox vault', 'The vault of this run is left for the nightly wipe' + (info.sandboxCleanup && info.sandboxCleanup !== 'none' ? ' (deleting it failed: ' + info.sandboxCleanup + ')' : '') + '.');
    }

    // other hosts, calls by the app itself
    const appCalls = netLog.filter((n) => n.from === 'app' && n.api !== 'form');
    const appToDatastore = appCalls.filter((n) => hostOf(new URL(n.url, 'file:///').href) === DATASTORE_HOST);
    if (appToDatastore.length) add('app-direct', 'fail', 'No direct access to the datastore', 'Code of the app (not the library) called ' + [...new Set(appToDatastore.map((n) => n.api + ' ' + n.method + ' ' + n.url.slice(0, 90)))].slice(0, 5).join('; ') + '. Only the library may talk to the datastore.');
    const forms = netLog.filter((n) => n.api === 'form');
    if (forms.some((n) => hostOf(new URL(n.url, 'file:///').href) === DATASTORE_HOST)) add('form-direct', 'fail', 'No form to the datastore', 'A form was submitted to the datastore host.');
    const appElsewhere = appCalls.filter((n) => !appToDatastore.includes(n));
    if (appElsewhere.length) add('app-network', 'warn', 'Network calls by the app', 'The app tried ' + [...new Set(appElsewhere.map((n) => n.api + ' ' + (n.url || '').slice(0, 80)))].slice(0, 5).join('; ') + '. They are blocked in this test (and by the recommended CSP).');
    const strange = requests.filter((r) => { const u = new URL(r.url); return u.host === DATASTORE_HOST && !/^\/datastore\/(client\/wds-[^/]+\.js|api\/v1\/.*)$/.test(u.pathname); });
    if (strange.length) add('datastore-urls', 'fail', 'Datastore URLs', 'Requests to the datastore host outside the library and the API: ' + [...new Set(strange.map((r) => r.method + ' ' + r.url.slice(0, 90)))].slice(0, 5).join('; '));
    const hosts = [...new Set(externals.map((e) => hostOf(e.url)))].filter(Boolean);
    if (hosts.length) add('external-requests', 'warn', 'Requests to other hosts', 'The page tried to reach ' + hosts.join(', ') + ' (blocked in this test).');
    const realErrors = sb ? pageErrors.filter((e) => !/pw\.hibp\.unavailable/.test(e)) : pageErrors;   // the sandbox has no breach check; a blocked one is no finding
    if (realErrors.length) add('page-errors', 'warn', 'JavaScript errors', realErrors.slice(0, 4).map((e) => '- ' + e.split('\n')[0].slice(0, 160)).join('\n'));

    // write frequency and record layout
    // A burst: writes less than a second apart with no button press in between (the tool presses buttons faster than a person does).
    const worstBurst = (ts) => {
      const separated = (a, b) => clickTimes.some((c) => c > a && c <= b);
      let burst = 1, worst = 1;
      for (let i = 1; i < ts.length; i++) { burst = ts[i] - ts[i - 1] < 1000 && !separated(ts[i - 1], ts[i]) ? burst + 1 : 1; worst = Math.max(worst, burst); }
      return worst;
    };
    const writes = storeLog.filter((s) => s.op === 'set' || s.op === 'autosave');
    const fast = [];
    const perName = new Map();
    for (const w of writes) { if (!perName.has(w.name)) perName.set(w.name, []); perName.get(w.name).push(w); }
    for (const [name, list] of perName) {
      list.sort((a, b) => a.t - b.t);
      const worst = worstBurst(list.map((w) => w.t));
      if (worst >= 3) fast.push('"' + name + '" written ' + worst + ' times within a second');
    }
    if (!writes.length) {
      const byRid = new Map();
      for (const r of requests.filter((r) => r.method === 'PUT' && /\/records\/[^/]+$/.test(new URL(r.url).pathname))) { const rid = new URL(r.url).pathname.split('/').pop(); if (!byRid.has(rid)) byRid.set(rid, []); byRid.get(rid).push(r.t); }
      for (const [rid, ts] of byRid) { const worst = worstBurst(ts); if (worst >= 3) fast.push('record ' + rid.slice(0, 8) + '... written ' + worst + ' times within a second'); }
    }
    if (fast.length) add('write-rate', 'warn', 'Write frequency', fast.slice(0, 5).join('; ') + '. Every set() is a network request and a history version; use store.autosave(name, getValue) for values that change while the user types.');
    else if (libLoaded && info.vaultCreated) add('write-rate', 'pass', 'Write frequency', 'No record was written three or more times within a second.');
    const names = [...perName.keys()].filter((n) => !n.startsWith('.wds/'));
    const typed = canaries.items.filter((c) => c.kind !== 'secret');
    // One record for everything: the canaries of two different items (the same fields typed again after the app emptied them) end
    // up in one record, or the only record has a name without a folder and holds all fields. One record per item
    // ("books/<id>") that is edited by later steps is the recommended design and does not count.
    const lastValue = (n) => perName.get(n).slice(-1)[0].value;
    const roundOf = (r) => typed.filter((c) => c.round === r);
    const shared = names.find((n) => roundOf(1).some((c) => findIn(lastValue(n), c.needles)) && roundOf(2).some((c) => findIn(lastValue(n), c.needles)));
    const only = names.length === 1 && !names[0].includes('/') ? names[0] : null;
    const onlyHeld = only ? typed.filter((c) => findIn(lastValue(only), c.needles)).length : 0;
    if (shared) add('one-record', 'warn', 'One record for everything', 'The values of two different items (typed one after the other into the same fields) end up in the single record "' + shared + '". Every change rewrites everything and two people editing different items conflict. Split it: one record per item (e.g. "items/<id>") and one for settings.');
    else if (only && typed.length >= 3 && onlyHeld >= 3) add('one-record', 'warn', 'One record for everything', 'All values (' + onlyHeld + ' of ' + typed.length + ' fields) end up in the single record "' + only + '". Every change rewrites everything and two people editing different parts conflict. Split it: one record per item or per topic (e.g. "settings", "items/<id>").');
    if (mock && mock.exited()) add('mock-server', 'fail', 'Local mock server', 'The mock server stopped during the run, so the results above are incomplete. Server output:\n' + mock.log().split('\n').slice(-8).join('\n'));
    info.durationMs = Date.now() - t0;
    return { findings, info };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (mock) await mock.stop().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}

function decodeURIComponentSafe(u) { try { return decodeURIComponent(u); } catch (e) { return u; } }
export { MockUnavailable };
