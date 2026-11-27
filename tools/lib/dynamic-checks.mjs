// Dynamic checks of wds-verify (PLAN 9.6, second group): run the app in Chromium against a local mock (the real server) or the public
// sandbox, type canary strings into every field, press the save buttons, reload, and look for the canaries everywhere they could have gone.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { ROOT, MockUnavailable } from './python.mjs';
import { MOCK_JOIN_CODE } from './wds-mock.mjs';
import { Canaries, findIn } from './canary.mjs';
import { DATASTORE_HOST, scanHtml } from './static-checks.mjs';
import { instrument } from './page-instrument.mjs';
import { RE_SCOPE, sriOfFile, rewriteScopes } from './targets.mjs';
import { CANARY_PLACEHOLDER } from './config.mjs';
import { dialog, dialogState, dialogSummary, briefError, chooseCreate, submitCreate, submitUnlock, formError, newPassphrase, viewOf, confirmSheet } from './dialog-internals.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOCP = ' (tools/README.md)';   // where a finding text points for more
const L = '(?<![\\p{L}\\p{N}])', R_ = '(?![\\p{L}\\p{N}])';
const SAVE_RE = new RegExp(L + '(save|speichern|sichern|add|hinzufügen|hinzufuegen|ok|submit|senden|apply|übernehmen|anlegen|create|erstellen|buchen|book|reservieren)' + R_, 'iu');
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

// Search every collected place for canaries. sinks: [{sink, where, data, place?, backup?}] -> Map(sink -> hits). The values of a seed are in the
// old app's storage by design (seedPlaces: place -> its size in bytes after the seed steps; a place that grew holds something new, so it is
// searched). A download that the tool started with a button of the library's migration dialog (s.library: the backup, a file that is too large)
// holds the old data by design, whatever the old data contains. Anywhere else (a new key, a request, any other download, also a JSON file that the
// app offers on its own) they are a finding like every other canary.
function leakFindings(sinks, canaries, seedPlaces = new Map()) {
  const bySink = new Map();
  for (const s of sinks) {
    const size = typeof s.data === 'string' ? Buffer.byteLength(s.data) : s.data.length;
    const only = (c) => !((s.sink === 'download' && s.library) || (c.seed && s.place && seedPlaces.has(s.place) && size <= seedPlaces.get(s.place)));
    const hit = canaries.scan(s.data, only);
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
  if (getComputedStyle(el).pointerEvents === 'none') return null;   // the browser cannot tell what covers it (the library's badge lets clicks through)
  const top = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1));
  if (!top || !(top === el || el.contains(top))) return 'it is covered by <' + (top ? top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') : 'nothing') + '>';
  return null;
};

// config: { locale, steps, afterReload, seed } of wds-verify.json; target: { name: 'mock' } or { name: 'sandbox', scopeId, serviceOrigin?, libraryFile? };
// opts: { headed, waitMs, locale }.
export async function dynamicChecks({ appPath, html, config = {}, library, target = { name: 'mock' }, opts = {} }) {
  const steps = config.steps || [], afterReload = config.afterReload || [], seed = config.seed || null;
  const seedPath = seed ? resolve(dirname(appPath), seed.page) : null;
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
        add('sandbox-scope', 'fail', 'Scope of the app', 'wds-verify found no WDS.connect({ scope: "..." }) with a literal scope ID, so it cannot point the app at the sandbox. Write the scope ID as a string literal.');
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
    const passphrase = newPassphrase();
    canaries.add('the vault passphrase', 'secret', passphrase);

    browser = await pw.chromium.launch({ headless: !opts.headed });
    const locale = opts.locale || config.locale || 'en-US';
    info.locale = locale;
    const context = await browser.newContext({ locale, acceptDownloads: true, viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();

    // ---- observation ----
    const requests = [], externals = [], navigations = [], consoleLines = [], pageErrors = [], downloads = [], sockets = [], apiErrors = [];
    const storeLog = [], netLog = [], storeErrors = [];
    const pending = new Set();
    const unexpected = [];
    const note = (msg) => { if (!unexpected.includes(msg)) unexpected.push(msg); };
    let lastActivity = Date.now();
    const touch = () => { lastActivity = Date.now(); };
    const knownScopes = new Set();
    const clickTimes = [];   // when the tool pressed a button: writes on either side of a click are not one burst
    let expectDownload = 0;  // > 0 while a "download" step waits for its file
    let libraryDownload = 0; // > 0 while the tool presses a download button of the library's migration dialog (the backup, a file that is too large for the vault)
    await context.exposeFunction('__wdsLog', (rec) => {
      touch();
      if (rec.kind === 'net') netLog.push(rec);
      else if (rec.kind === 'store') storeLog.push(rec);
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
      const rec = { filename: d.suggestedFilename(), t: Date.now(), bytes: null, requested: expectDownload > 0, library: libraryDownload > 0 };
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
    const dlg = () => dialog(page);
    const ctl = (d, name) => d.locator('[data-wds="' + name + '"]');
    const present = async (d, name) => (await ctl(d, name).first().isVisible().catch(() => false));
    const label = { banner: undefined, badge: undefined };   // the sandbox label: undefined (not looked at), 'visible', 'hidden', 'absent'
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
    // An error that comes from the page changing under the call (a navigation, a dialog rebuilt): the dialog is not ready, try again.
    const transient = (e) => /Execution context was destroyed|Target (page, context or browser )?has been closed|Frame was detached|frame was detached|navigat(ed|ion) /i.test(String((e && e.message) || e));
    // Press a button of the library that starts a download (the backup of the migration dialog, a file that is too large for the vault) and
    // wait for the file. The download is searched for canaries like any other, but the seeded values in it are expected (it is the old data).
    async function libraryDownloadClick(locator) {
      libraryDownload++;
      try {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), locator.click({ timeout: 5000, noWaitAfter: true })]);
        return dl.suggestedFilename();
      } finally { libraryDownload--; }
    }
    // One look at the library's topmost dialog and, if the tool has to act, the action. true: acted (look again); false: nothing to do (no dialog, or
    // it is not ready: no view yet, aria-busy while a submit runs, loading, progress; wait).
    // A dialog that stays "not ready" (no view, aria-busy, loading, progress) for long is reported with what it looks like, once.
    let notReadySince = 0, notReadyNoted = false;
    async function handleDialogOnce() {
      const d = dlg();
      if (!(await d.isVisible().catch(() => false))) { notReadySince = 0; return false; }
      const st = await dialogState(d);
      if (!st || !st.ready || st.view === 'loading' || st.view === 'progress') {
        if (!notReadySince) notReadySince = Date.now();
        if (!notReadyNoted && Date.now() - notReadySince > 20000) { notReadyNoted = true; note('a library dialog was not ready after 20 s: ' + await dialogSummary(page)); }
        return false;
      }
      notReadySince = 0;
      const view = st.view;
      if (sb && label.banner === undefined && view !== 'loading' && view !== 'progress') label.banner = await probeLabel('sandbox-banner');
      switch (view) {
        case 'loading': case 'progress': return false;   // wait
        case 'unlock': {
          if (info.vaultCreated) {
            // a second visit (after the reload): the vault exists, unlock it with the passphrase
            await submitUnlock(d, { accessId: info.accessId, passphrase });
            await sleep(300);
            return true;
          }
          await chooseCreate(d);
          return true;
        }
        case 'create': {
          if (!mock && await present(d, 'join-code')) {   // the sandbox is open; the mock's scopes have the join code of MOCK_JOIN_CODE
            note('the scope needs a join code to create a vault, which the tool cannot know; the sandbox and --target mock need none');
            await ctl(d, 'close').click({ timeout: 3000 }).catch(() => {});
            return true;
          }
          await submitCreate(d, { passphrase, joinCode: MOCK_JOIN_CODE });
          const waitStart = Date.now();
          for (;;) {
            const v = await viewOf(page);   // null only when the page answered and shows no dialog; '' while it is busy (Argon2id) or reloading
            if (v === 'sheet') break;
            const err = v === '' ? '' : await formError(d);
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
          info.accessId = (await confirmSheet(page)) || info.accessId;
          return true;
        }
        case 'migrate': {
          // store.migrateLocal asks whether to take over the data of the earlier version: save the (unencrypted) copy, then take over
          const m = info.migrateDialog = info.migrateDialog || { asked: 0, backup: null };
          m.asked++;
          try { m.backup = await libraryDownloadClick(ctl(d, 'migrate-backup')); }
          catch (e) { note('the migration dialog: the copy of the old data did not download: ' + briefError(e, 3, 300)); }
          await ctl(d, 'migrate-yes').click({ timeout: 5000 });
          await sleep(200);
          return true;
        }
        case 'migrate-delete': {   // the second start after a copy (never in the sandbox): the person has seen the copy in the app and confirms the deletion
          await ctl(d, 'migrate-delete-yes').click({ timeout: 5000 });
          await sleep(200);
          return true;
        }
        case 'migrate-failed': {
          note('the library reported that taking over the old data failed (view migrate-failed); the tool closed the dialog');
          await ctl(d, 'migrate-close').click({ timeout: 3000 }).catch(() => {});
          return true;
        }
        case 'revoked': case 'lock-unsaved': case 'offline': {
          note('the library showed its "' + view + '" dialog; the tool answered it');
          await ctl(d, (await present(d, 'end-ok')) ? 'end-ok' : 'close').click({ timeout: 3000 }).catch(() => {});
          return true;
        }
        case 'notice': {
          const ack = (await present(d, 'recovered-ack')) ? 'recovered-ack' : (await present(d, 'recovery-keep')) ? 'recovery-keep' : 'close';
          note('the library showed a notice dialog; the tool acknowledged it (' + ack + ')');
          await ctl(d, ack).click({ timeout: 3000 }).catch(() => {});
          return true;
        }
        case 'error': {
          // The dialog could not go on (a request failed or did not answer in time): it offers a retry, and so does the tool, three times at most.
          info.dialogRetries = (info.dialogRetries || 0) + 1;
          const said = await formError(d);
          if (info.dialogRetries > 3) { if (info.dialogRetries === 4) { info.stuckError = said || '(no text)'; note('a library dialog stayed in its error view after 3 retries: "' + said + '"'); } return false; }
          note('a library dialog showed its error view ("' + said + '"); the tool pressed retry (' + info.dialogRetries + ')');
          await ctl(d, 'retry').click({ timeout: 3000 }).catch(() => {});
          await sleep(300);
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
    async function handleDialog() {
      try { return await handleDialogOnce(); }
      catch (e) { if (e instanceof RunAbort || !transient(e)) throw e; return false; }
    }
    // Library dialogs that are open now must be answered before the tool touches the app: the page behind a modal dialog is inert.
    async function drainDialogs(maxMs = 15000) {
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        if (!(await dlg().isVisible().catch(() => false))) return;
        const handled = await handleDialog().catch((e) => { if (e instanceof RunAbort) throw e; note('dialog handling failed: ' + briefError(e)); return false; });
        if (handled) touch(); else await sleep(100);
      }
      if (await dlg().isVisible().catch(() => false)) note('a library dialog was still open after ' + Math.round(maxMs / 1000) + ' s and the tool had nothing to answer: ' + await dialogSummary(page));
    }
    // Wait until the network has been quiet for a moment; handle library dialogs that show up meanwhile.
    async function settle(quietMs = 700, maxMs = 60000) {
      const start = Date.now();
      for (;;) {
        if (Date.now() - start > maxMs) { note('the page did not settle within ' + Math.round(maxMs / 1000) + ' s'); return; }
        if (await handleDialog().catch((e) => { if (e instanceof RunAbort) throw e; note('dialog handling failed: ' + briefError(e)); return false; })) { touch(); continue; }
        if (unexpected.length > 6) return;
        // A request that never reports its end (a fetch whose body the app never reads) must not keep the run waiting.
        const busy = pending.size > 0 && Date.now() - lastActivity < 2500;
        if (process.env.WDS_VERIFY_DEBUG && pending.size) console.error('pending: ' + [...pending].map((r) => r.method() + ' ' + r.url()).join(' | '));
        if (!busy && Date.now() - lastActivity >= quietMs) {
          if (!(await dlg().isVisible().catch(() => false))) return;
          // a dialog without an action of the tool (loading, progress) is waited for; one that stays for long is a note
          if (Date.now() - lastActivity > 15000) { const s = await dialogState(dlg()); note('a library dialog stayed open: view "' + ((s && s.view) || '?') + '"' + (s && s.busy ? ' (busy)' : '') + '; ' + await dialogSummary(page)); return; }
        }
        await sleep(100);
      }
    }
    let lastFilled = null;   // the last text field the tool typed into (Enter goes there when no button matches)
    // A generated PNG whose name and bytes carry a canary (the upload step and a file input without a step); flagged: the values are the seed's.
    let uploads = 0;
    function makeUpload(flagged) {
      const tg = canaries.nonce + 'u' + (++uploads);
      const name = 'wdsfile-' + tg + '.png', marker = 'WDSCANARY-FILE-' + tg;
      const mark = (c) => { if (flagged) c.seed = true; return c; };
      mark(canaries.add('the name of the generated upload file', 'text', name));
      mark(canaries.add('the bytes of the generated upload file', 'text', marker));
      return { name, mimeType: 'image/png', buffer: Buffer.concat([PNG_1X1, Buffer.from(marker)]) };
    }
    async function fillFields(round, onlyEmpty = false) {
      await drainDialogs();
      const handles = await page.$$('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
      let typed = 0, count = 0, hidden = 0;
      for (const h of handles) {
        const d = await h.evaluate((el) => {
          if (el.closest('.wds-root')) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
          const type = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : 'contenteditable';
          const value = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ? (el.type === 'file' ? (el.files.length ? 'file' : '') : el.value) : el.textContent;
          const label = (el.getAttribute('aria-label') || el.id || el.getAttribute('name') || el.getAttribute('placeholder') || el.tagName.toLowerCase());
          // a modal dialog of the app (not the library's) that is open makes everything outside it inert: the tool cannot type there
          let modal = null;
          try { const ms = Array.from(document.querySelectorAll('dialog:modal')).filter((m) => !m.classList.contains('wds-root')); modal = ms.length ? ms[ms.length - 1] : null; } catch (e) { /* :modal is not supported */ }
          const behindModal = !!modal && !modal.contains(el);
          const sel = el.id ? '#' + el.id : el.getAttribute('name') ? el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]' : label;
          return { visible, type, min: el.min || '', max: el.max || '', disabled: !!el.disabled || !!el.readOnly || el.closest('[inert]') !== null || behindModal, behindModal, label: label.slice(0, 40), sel: sel.slice(0, 60), empty: !String(value || '').trim() };
        }).catch(() => null);
        if (!d) continue;
        if (!d.visible && d.type !== 'file') { if (d.type !== 'hidden') hidden++; continue; }   // a file input is often hidden behind a styled label: it can be filled all the same
        if (d.behindModal) { info.behindModal = (info.behindModal || 0) + 1; continue; }
        if (d.disabled) continue;
        const kind = { email: 'email', url: 'url', tel: 'tel' }[d.type];
        const textLike = !kind && ['text', 'search', 'password', 'textarea', 'contenteditable'].includes(d.type);
        if (!kind && !textLike) {
          // inputs without free text: a valid generated value so that a form can be submitted; a canary only goes into text fields
          if (!d.empty) continue;
          const fixed = { date: '2031-07-19', time: '13:37', 'datetime-local': '2031-07-19T13:37', month: '2031-07', week: '2031-W29' }[d.type];
          if (fixed) await h.fill(fixed).catch(() => {});
          else if (d.type === 'number') await h.fill(d.min !== '' ? d.min : d.max !== '' && Number(d.max) < 7 ? d.max : '7').catch(() => {});
          else if (d.type === 'select') await h.evaluate((el) => { const o = Array.from(el.options).find((x) => x.value && !x.disabled); if (o) { el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } }).catch(() => {});
          else if (d.type === 'file') await h.setInputFiles(makeUpload(false), { timeout: 4000 }).catch((e) => note('could not fill a file input: ' + briefError(e, 2, 200)));
          continue;
        }
        if ((round > 1 || onlyEmpty) && !d.empty) continue; // second round: only fields the app emptied again (e.g. after "Add")
        const c = canaries.make(d.type + ' "' + d.label + '"', kind || 'text');
        c.round = round;   // round 2 fills fields that the app emptied again: a second item
        c.field = d.sel;   // how to name the field in a report
        try {
          // the first free-text field is typed key by key: apps that save on every key stroke show up
          if (textLike && typed === 0 && round === 1) { await h.fill('', { timeout: 3000 }); await h.focus(); await page.keyboard.type(c.value, { delay: 12 }); typed++; }
          else await h.fill(c.value, { timeout: 4000 });
          await h.evaluate((el) => { el.dispatchEvent(new Event('change', { bubbles: true })); if (el.blur) el.blur(); }).catch(() => {});
          lastFilled = h;
          count++;
        } catch (e) { note('could not type into ' + d.type + ' "' + d.label + '": ' + briefError(e, 3, 300)); }
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
          let modal = null;
          try { const ms = Array.from(document.querySelectorAll('dialog:modal')).filter((m) => !m.classList.contains('wds-root')); modal = ms.length ? ms[ms.length - 1] : null; } catch (e) { /* :modal is not supported */ }
          return { text, visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none', disabled: !!el.disabled || el.closest('[inert]') !== null || (!!modal && !modal.contains(el)), id: el.id || '', hinted: el.getAttribute('data-wds-verify') === 'save' };
        }).catch(() => null);
        if (d) out.push({ h, ...d });
      }
      return out;
    }
    const pressed = new Set();   // the text of every button pressed over the whole run (by the tool or by a click step)
    // No button matched the word list: a submit button of the app (never one with a delete word), else Enter in the last field that was typed into.
    async function submitFallback() {
      await drainDialogs();
      for (const h of await page.$$('button[type=submit], input[type=submit]')) {
        const d = await h.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { text: ((el.tagName === 'INPUT' ? el.value : el.innerText || el.textContent) || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '), ok: !el.closest('.wds-root') && !el.disabled && r.width > 0 && r.height > 0 && el.closest('[inert]') === null };
        }).catch(() => null);
        if (!d || !d.ok || NOT_SAVE_RE.test(d.text)) continue;
        info.clicks.push(d.text || '(submit button)'); pressed.add(d.text); clickTimes.push(Date.now());
        await h.click({ timeout: 4000, noWaitAfter: true }).catch((e) => note('could not click "' + d.text + '": ' + briefError(e, 4, 400)));
        await settle();
        return;
      }
      if (lastFilled) {
        info.clicks.push('(Enter)'); clickTimes.push(Date.now());
        await lastFilled.press('Enter', { timeout: 3000 }).catch(() => {});
        await settle();
      }
    }
    async function clickSaves(clicked) {
      for (let guard = 0; guard < 12; guard++) {
        await drainDialogs();
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
        await target.h.click({ timeout: 4000, noWaitAfter: true }).catch((e) => note('could not click "' + target.text + '": ' + briefError(e, 4, 400)));
        await settle();
      }
    }

    // A click of a step. Notices of the library take no click (pointer-events: none), so a plain click is what a person does.
    const clickStep = (loc) => loc.click({ timeout: 5000 });

    // The steps of wds-verify.json (steps, afterReload). Failures become findings; ids/titles say which list the step is in.
    const stepCount = { click: 0, fill: 0, upload: 0, wait: 0, select: 0, press: 0, download: 0 };
    const seedCount = { click: 0, fill: 0, upload: 0, wait: 0, select: 0, press: 0, download: 0 };
    const requestedDownloads = [];
    async function runSteps(list, listName, afterEach, quiet = false) {
      const tag = listName === 'steps' ? '' : listName + ' ';
      const cnt = listName === 'seed' ? seedCount : stepCount;
      const round = listName === 'steps' ? 'steps' : listName === 'seed' ? 'seed' : 'afterReload';
      const flag = (c) => { if (listName === 'seed') c.seed = true; return c; };   // the seed's values are searched for like all others, but they live in the old app's storage by design
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const id = (listName === 'steps' ? 'step-' : listName + '-step-') + (i + 1), title = 'wds-verify.json ' + tag + 'step ' + (i + 1);
        try {
          await drainDialogs(8000);
          if (s.click) {
            cnt.click++; clickTimes.push(Date.now());
            const loc = page.locator(s.click).first();
            const txt = await loc.evaluate((el) => ((el.tagName === 'INPUT' ? el.value : el.innerText || el.textContent) || '').trim().replace(/\s+/g, ' '), undefined, { timeout: 5000 }).catch(() => '');
            if (txt && listName !== 'seed') pressed.add(txt);
            await clickStep(loc); await settle();
          }
          else if (s.upload) {
            cnt.upload++;
            let payload;
            if (s.upload.length === 2) {
              payload = resolve(dirname(appPath), s.upload[1]);
              if (!existsSync(payload)) throw new Error('no such file: ' + s.upload[1]);
              const fname = basename(payload);
              if (fname.length >= 8) flag(canaries.add('wds-verify.json upload file name ' + fname, 'text', fname));
            } else {
              payload = makeUpload(listName === 'seed');
            }
            clickTimes.push(Date.now());
            await page.locator(s.upload[0]).first().setInputFiles(payload, { timeout: 5000 });
            await settle();
          }
          else if (s.fill) {
            cnt.fill++; if (listName === 'steps') info.stepFills++;
            // {canary} in the text becomes a generated unique token (so that a seed or a repeated run never meets an old value by chance)
            let text = s.fill[1], token = null;
            if (text.includes(CANARY_PLACEHOLDER)) { token = canaries.token(); text = text.split(CANARY_PLACEHOLDER).join(token); }
            if (listName === 'afterReload') {
              // The tool also reads the values of input fields after the reload: a text that was typed before the reload would be "visible again" because the tool typed it again.
              const clash = canaries.items.find((c) => c.kind !== 'secret' && c.round !== undefined && c.round !== 'afterReload' && text.includes(c.find || c.value));
              if (clash) throw new Error('its text contains a value that was typed before the reload (' + (clash.selector || clash.label) + '), so the tool would see it again without the app reading anything back. Use another text or the {canary} placeholder');
            }
            await page.locator(s.fill[0]).first().fill(text, { timeout: 5000 });
            const itype = await page.locator(s.fill[0]).first().evaluate((el) => { el.dispatchEvent(new Event('change', { bubbles: true })); return el.tagName === 'INPUT' ? el.type : ''; }).catch(() => '');
            if (text === '' || ['date', 'time', 'datetime-local', 'month', 'week', 'number', 'range', 'color'].includes(itype)) { /* an empty text, or a field that holds no free text: nothing to search for */ }
            else if (text.length >= 6) { const c = flag(canaries.add('wds-verify.json ' + tag + 'fill ' + s.fill[0], 'text', text, token)); c.round = round; c.selector = s.fill[0]; c.find = token || text; }
            else add(id, 'warn', title, 'The text "' + text + '" is shorter than 6 characters; it cannot be searched for. Use a longer unique text.');
            await settle();
          }
          else if (s.select) { cnt.select++; clickTimes.push(Date.now()); await page.locator(s.select[0]).first().selectOption(s.select[1], { timeout: 5000 }); await settle(); }
          else if (s.press) { cnt.press++; clickTimes.push(Date.now()); await page.locator(s.press[0]).first().press(s.press[1], { timeout: 5000 }); await settle(); }
          else if (s.download) {
            cnt.download++; clickTimes.push(Date.now());
            expectDownload++;
            try {
              const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.locator(s.download).first().click({ timeout: 5000, noWaitAfter: true })]);
              requestedDownloads.push(dl.suggestedFilename());
            } finally { expectDownload--; }
            await settle();
          }
          else if (s.wait !== undefined) { cnt.wait++; await sleep(s.wait); }
        } catch (e) { if (!quiet) add(id, 'fail', title, JSON.stringify(s) + ' failed: ' + briefError(e, 6, 600)); }
        if (afterEach) await afterEach();
      }
    }
    // Everything of the page that a person can read after a reload: the rendered text (a tab that is not open shows nothing) and the
    // values of the inputs that are on screen.
    const pageText = () => page.evaluate(() => {
      const parts = [document.body ? document.body.innerText : ''];
      document.querySelectorAll('input, textarea, select').forEach((el) => { if (!el.closest('.wds-root') && el.getClientRects().length) parts.push(el.value || ''); });
      return parts.join('\n');
    }).catch(() => '');

    // The browser storage of the page's origin (file:// pages share it): localStorage, sessionStorage, cookie, IndexedDB (flattened to text), Cache Storage.
    const readState = () => page.evaluate(async () => {
      const out = { local: [], session: [], idb: [], idbCount: [], caches: [], cookie: '', name: window.name };
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.local.push([k, localStorage.getItem(k)]); } } catch (e) { /* denied */ }
      try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); out.session.push([k, sessionStorage.getItem(k)]); } } catch (e) { /* denied */ }
      try { out.cookie = document.cookie; } catch (e) { /* denied */ }
      // Flatten without JSON escaping, so that bytes stay bytes (JSON would write the NUL bytes of a UTF-16 text as an escape sequence).
      // Blobs and Files are read too (IndexedDB keeps what an app stored as a Blob).
      const ser = async (v, depth = 0) => {
        if (v === null || v === undefined || depth > 8) return '';
        if (typeof Blob !== 'undefined' && v instanceof Blob) v = await v.arrayBuffer();
        if (v instanceof ArrayBuffer) v = new Uint8Array(v);
        if (ArrayBuffer.isView(v)) { const u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return s; }
        if (typeof v === 'object') return (await Promise.all(Object.keys(v).map(async (k) => k + '\n' + await ser(v[k], depth + 1)))).join('\n');
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
            out.idb.push([d.name + '/' + name, await ser({ keys, rows })]);
            out.idbCount.push([d.name + '/' + name, rows.length]);
          }
          db.close();
        }
      } catch (e) { /* no IndexedDB */ }
      try { if (self.caches) for (const n of await caches.keys()) { const c = await caches.open(n); out.caches.push([n, (await c.keys()).map((r) => r.url).join('\n')]); } } catch (e) { /* none */ }
      return out;
    }).catch(() => ({ local: [], session: [], idb: [], idbCount: [], caches: [], cookie: '', name: '' }));

    // ---- run ----
    let libLoaded = false, reload = null;
    const texts = [];   // what a person can read at several points of the run; every check of "is it visible" takes the union (an app with tabs shows one view at a time)
    const snapshot = async () => { texts.push(await pageText()); };
    // What the app SHOWED as text (not in a field) before the reload, at several points: after the tool's first round and after every step. A value that the app never showed
    // (an invalid duration, an entry without a project: the app rightly rejected it) is not expected back after the reload.
    const shownBefore = [];
    const snapshotBefore = async () => { shownBefore.push(await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '')); };
    let reloadMark = null;   // index in texts of the first screen after the reload and the unlock (null: the page was not reloaded)
    // Is this value of the seed on a screen after the reload? Then it came out of the vault: nothing before the reload counts (a prompt that lists the old titles, the old storage shown directly).
    const shownAfter = (c) => reloadMark !== null && texts.slice(reloadMark).some((t) => t.includes(c.find || c.value));
    // Where the values of the seed are in a browser storage state: [{place, canary}]; place is "sink|where", as in the leak search below.
    const seedPlaces = new Map();   // the places the old app's data was in after the seed steps (its storage, by design): place -> size in bytes
    let oldBaseline = null;         // everything the old app had stored after the seed steps: { local: [keys], idb: ["db/store" with rows] }; the migration must leave none of it
    const seedHolders = (st) => {
      const out = [];
      const look = (sink, where, data) => { const buf = Buffer.from(data, 'utf8'); for (const c of canaries.items) if (c.seed && findIn(buf, c.needles)) out.push({ place: sink + '|' + where, canary: c, size: buf.length }); };
      for (const [k, v] of st.local) look('localStorage', 'key ' + k.slice(0, 60), k + '\n' + v);
      for (const [k, v] of st.session) look('sessionStorage', 'key ' + k.slice(0, 60), k + '\n' + v);
      for (const [k, v] of st.idb) look('IndexedDB', k, v);
      return out;
    };
    // Open the old app (a local-only version of the page, or any page that fills the old storage), run the seed steps, and leave. The same
    // browser context then opens the app: file:// pages share localStorage and IndexedDB, so the app finds the old data like a returning user would.
    async function runSeed() {
      try {
        await page.goto(pathToFileURL(seedPath).href, { waitUntil: 'load', timeout: 30000 });
        await sleep(300);
        await settle();
        await runSteps(seed.steps, 'seed');
        await sleep(1200);   // a debounced save of the old app
        await settle();
      } catch (e) {
        add('seed', 'fail', 'Seed: the old app', 'The old app (' + seed.page + ') could not be opened or driven: ' + String(e.message).split('\n')[0]);
        return;
      }
      const state0 = await readState();
      const holders = seedHolders(state0);
      holders.forEach((h) => seedPlaces.set(h.place, h.size));
      oldBaseline = { local: state0.local.map(([k]) => k), idb: state0.idbCount.filter(([, n]) => n > 0).map(([k]) => k) };
      const stored = [...new Set(holders.map((h) => h.canary))];
      info.seed = { page: seed.page, steps: seed.steps.length, stored: stored.length, typed: canaries.items.filter((c) => c.seed).length };
      if (!stored.length) add('seed', 'fail', 'Seed: the old app', 'After the seed steps the browser storage holds none of the ' + info.seed.typed + ' typed value(s) of ' + seed.page + ', so there is nothing to migrate: do the steps save the entry?');
      else add('seed', 'pass', 'Seed: the old app', seed.page + ' stored ' + stored.length + ' of ' + info.seed.typed + ' typed value(s) in the browser storage (' + seed.steps.length + ' step(s)).');
      // what the old page did (requests, console, downloads) is not the app's business
      for (const list of [requests, externals, navigations, consoleLines, pageErrors, downloads, sockets, apiErrors, netLog, storeLog, storeErrors]) list.length = 0;
      pending.clear(); touch();
    }
    try {
    info.clicks = []; info.fields = 0; info.steps = steps.length; info.stepFills = 0; info.stepCount = null;
    if (seed) await runSeed();
    const fileUrl = pathToFileURL(pagePath).href;
    await page.goto(fileUrl, { waitUntil: 'load', timeout: 30000 });
    libLoaded = await page.evaluate(() => typeof WDS === 'object' && typeof WDS.connect === 'function').catch(() => false);
    if (!libLoaded) {
      add('library-loaded', 'fail', 'Library loads', 'WDS is not defined after loading the page. Console output:\n' + consoleLines.slice(0, 8).map((l) => '    ' + l).join('\n'));
    } else {
      add('library-loaded', 'pass', 'Library loads', 'The library of the page loaded in Chromium from a file:// URL (' + (sb ? 'the sandbox of the service' : 'the mock serves it') + ').');
      await sleep(400);
      await settle();                                   // an app that unlocks at start shows the dialog now
      // an app with store.migrateLocal asks right after the unlock: give the library's question a moment to appear, and answer it
      if (seed && info.vaultCreated && !info.migrateDialog) {
        for (let i = 0; i < 40 && !(await dlg().isVisible().catch(() => false)); i++) await sleep(100);
        await settle();
      }
      info.fileInputs = await page.locator('input[type=file]').count().catch(() => 0);
      info.appDialogs = await page.locator('dialog, [role=dialog], [aria-modal="true"]').evaluateAll((els) => els.filter((e) => !e.closest('.wds-root')).length).catch(() => 0);
      // With a seed the steps come first: the migration prompt of the app is open right after unlocking, and the first steps answer it. The
      // tool then types only into fields that are still empty (it would overwrite what the steps typed).
      if (seed) { await runSteps(steps, 'steps', async () => { await sleep(120); await snapshotBefore(); }); await snapshot(); }
      info.fields += await fillFields(1, !!seed);
      const clicked = new Set();
      await clickSaves(clicked);
      if (!clicked.size && info.fields) await submitFallback();
      await sleep(300); await snapshotBefore();
      if (!seed) await runSteps(steps, 'steps', async () => { await sleep(120); await snapshotBefore(); });
      info.stepCount = stepCount;
      // second round: fields that the app emptied (e.g. after "Add") and fields that appeared, then the buttons again
      await sleep(1100);
      const more = await fillFields(2);
      info.fields += more;
      if (more) { const again = new Set(); await clickSaves(again); if (!again.size) await submitFallback(); }
      await sleep(opts.waitMs !== undefined ? opts.waitMs : 2800);       // debounced autosave
      await settle(900);
      await snapshotBefore();
      // what the tool did not press
      const rest = [];
      for (const b of await appButtons()) if (b.visible && b.text && !pressed.has(b.text) && !rest.includes(b.text)) rest.push(b.text);
      info.unpressed = rest.slice(0, 12);
      if (sb) label.badge = await probeLabel('sandbox-badge');
      await snapshot();

      // reload: the data must come back (the page's own screen, after unlocking with the passphrase)
      const writtenBefore = requests.filter((r) => r.method === 'PUT' && /\/vaults\/[^/]+\/records\/[^/]+$/.test(new URL(r.url).pathname)).length;
      if (info.vaultCreated && writtenBefore) {
        // store.lock() saves what is pending and reloads the page; until the person unlocks, the page shows no vault data
        const navigated = page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).then(() => true, () => false);
        const called = await page.evaluate(() => { const s = (window.__wdsStores || [])[0]; if (!s || typeof s.lock !== 'function') return false; void s.lock(); return true; }).catch(() => false);
        if (!called) { await page.reload({ waitUntil: 'load', timeout: 30000 }).catch((e) => note('reload failed: ' + String(e.message).split('\n')[0])); }
        const reloadedByLock = called ? await navigated : null;
        await sleep(400);
        const lockedText = await pageText();   // the unlock dialog is not answered yet
        const typedBefore = canaries.items.filter((x) => x.round !== undefined && x.round !== 'afterReload' && x.round !== 'seed');
        const stillThere = typedBefore.filter((c) => lockedText.includes(c.find || c.value));
        if (reloadedByLock === false) add('lock-reload', 'fail', 'store.lock() reloads the page', 'The page was not reloaded within 30 s after store.lock(); the library reloads it once pending saves are done (docs/site/integration.md).');
        else if (called) add('lock-reload', 'pass', 'store.lock() reloads the page', 'store.lock() reloaded the page.' + (stillThere.length ? '' : ' It showed no typed value before the unlock.'));
        if (called && reloadedByLock && stillThere.length) add('lock-clean', 'fail', 'Data visible before the unlock', 'After store.lock() and the reload the page showed ' + stillThere.slice(0, 3).map((c) => '"' + (c.find || c.value).slice(0, 30) + '"').join(', ') + ' before the unlock. Render vault data only after await store.unlock().');
        await settle(900);
        const mark = reloadMark = texts.length;   // from here on: what is visible after the reload
        await snapshot();
        await runSteps(afterReload, 'afterReload', async () => { await sleep(150); await snapshot(); });   // after every step: one view after the other
        await sleep(300);
        await settle(900);
        await snapshot();
        // Expected back: the values the app showed as text before the reload and the values it wrote to the store (the page instrumentation sees what set, autosave and the
        // collections are given, so a value that only ever sat in an autosaved field counts). A value that the app neither showed nor wrote (it rejected it: an invalid duration,
        // an entry without a project) has nothing to come back and is left out. When there is no such value at all, every value counts.
        const typedValues = canaries.items.filter((x) => x.round !== undefined && x.round !== 'afterReload' && x.round !== 'seed');
        const wasShown = (c) => shownBefore.some((t) => t.includes(c.find || c.value));
        const wasWritten = (c) => storeLog.some((w) => (w.op === 'set' || w.op === 'autosave' || w.op === 'cwrite') && findIn(w.value || '', c.needles));
        const expectedBack = (c) => wasShown(c) || wasWritten(c);
        const expected = typedValues.some(expectedBack) ? typedValues.filter(expectedBack) : typedValues;
        if (process.env.WDS_VERIFY_DEBUG) console.error('not expected back after the reload: ' + typedValues.filter((c) => !expected.includes(c)).map((c) => c.label + ' = ' + (c.find || c.value)).join(' | '));
        const dropped = typedValues.filter((c) => !expected.includes(c));
        const short = (s) => { const t = String(s).replace(/\s+/g, ' '); return t.length > 40 ? t.slice(0, 37) + '...' : t; };
        const droppedNames = dropped.map((c) => (c.selector || c.field || c.label) + ' ("' + short(c.value) + '")');
        const evalReload = () => {
          const groups = new Map();
          for (const c of expected) {
            const g = groups.get(c.round) || { total: 0, shown: 0 };
            g.total++; if (texts.slice(mark).some((t) => t.includes(c.find || c.value))) g.shown++;
            groups.set(c.round, g);
          }
          const total = [...groups.values()].reduce((n, g) => n + g.total, 0), shown = [...groups.values()].reduce((n, g) => n + g.shown, 0);
          return { total, shown, notShown: dropped.length, notShownNames: droppedNames, everyRound: [...groups.values()].every((g) => g.shown > 0), hasAfter: afterReload.length > 0 };
        };
        reload = evalReload();
      }
    }
    } catch (e) {
      if (!(e instanceof RunAbort)) throw e;   // creating the vault failed for good: evaluate what there is
    }

    // ---- collect ----
    const finalUrl = page.url();
    const state = await readState();
    const seedLeft = seed ? [...new Set(seedHolders(state).filter((h) => seedPlaces.has(h.place)).map((h) => h.canary))] : [];   // what of the old app's data is still where it was
    // everything the old app had filled after the seed steps (not only the places that hold a typed value) that is still there; seed.keep names what may stay
    const keepNames = new Set((seed && seed.keep) || []);
    const leftover = seed && oldBaseline ? [
      ...state.local.map(([k]) => k).filter((k) => oldBaseline.local.includes(k) && !keepNames.has(k)).map((k) => 'localStorage key "' + k.slice(0, 60) + '"'),
      ...state.idbCount.filter(([k, n]) => n > 0 && oldBaseline.idb.includes(k) && !keepNames.has(k)).map(([k, n]) => 'IndexedDB store ' + k + ' (' + n + ' row' + (n === 1 ? '' : 's') + ')'),
    ] : [];
    const cookies = await context.cookies().catch(() => []);
    await Promise.all(downloads.map((d) => d.done));
    // server side: the database of the mock after a checkpoint (the write-ahead log holds the latest pages)
    const dbFiles = !mock ? [] : readdirSync(mock.tmp).filter((f) => f.startsWith('wds.db')).map((f) => ({ f, data: readFileSync(join(mock.tmp, f)) }));
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
    for (const [k, v] of state.local) sinks.push({ sink: 'localStorage', where: 'key ' + k.slice(0, 60), place: 'localStorage|key ' + k.slice(0, 60), data: k + '\n' + v });
    for (const [k, v] of state.session) sinks.push({ sink: 'sessionStorage', where: 'key ' + k.slice(0, 60), place: 'sessionStorage|key ' + k.slice(0, 60), data: k + '\n' + v });
    for (const [k, v] of state.idb) sinks.push({ sink: 'IndexedDB', where: k, place: 'IndexedDB|' + k, data: v });
    for (const [k, v] of state.caches) sinks.push({ sink: 'Cache Storage', where: k, data: v });
    sinks.push({ sink: 'cookie', where: 'document.cookie', data: state.cookie });
    for (const c of cookies) sinks.push({ sink: 'cookie', where: c.name, data: c.name + '=' + c.value });
    sinks.push({ sink: 'window.name', where: 'window.name', data: state.name || '' });
    for (const l of consoleLines) sinks.push({ sink: 'console output', where: l.slice(0, 80), data: l });
    const dlOutside = downloads.filter((d) => !d.requested);
    for (const d of dlOutside) sinks.push({ sink: 'download', where: d.filename, library: !!d.library, data: Buffer.concat([Buffer.from(d.filename + '\n'), d.bytes || Buffer.alloc(0)]) });
    for (const f of dbFiles) sinks.push({ sink: 'server database (mock)', where: f.f, data: f.data });
    const leaks = leakFindings(sinks, canaries, seedPlaces);
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
      add('leak-' + sink, 'fail', 'Canary found in ' + sink, lines.slice(0, 6).join('\n') + (lines.length > 6 ? '\n- ... and ' + (lines.length - 6) + ' more' : '') + (sink === 'download' ? '\nAn app never downloads data in the background; a button the person presses is a {"download": "#selector"} step' + DOCP + '.' : ''));
    }
    if (downloads.length) {
      const names = downloads.map((d) => d.filename + (d.library ? ' (offered by the library\'s migration dialog)' : d.requested ? ' (user-requested download, contains canaries: ' + (canaries.scan(d.bytes || Buffer.alloc(0)) ? 'yes' : 'no') + ')' : ''));
      add('downloads', 'info', 'Downloads', names.join(', ') + (seed && downloads.some((d) => d.library && canaries.scan(d.bytes || Buffer.alloc(0), (c) => c.seed)) ? ' (the copy of the old data that the library\'s migration dialog offers; not a leak)' : ''));
    }

    if (sb) add('database-not-inspected', 'info', 'Server database', 'Server database not inspected (sandbox target); the requests the app and the library sent were still searched for canaries.');

    // vault and saves
    if (libLoaded) {
      if (info.vaultCreated) add('vault', 'pass', 'Vault created', sb ? 'The library dialog created a vault in the sandbox (passphrase checked by the library).' : 'The library dialog created a vault in the mock (passphrase checked by the library).');
      else add('vault', 'fail', 'Vault created', 'The app never opened the unlock dialog, so no vault was created and nothing could be stored. ' + (unexpected.length ? unexpected.join('; ') : 'Does the app call store.unlock() or a store method?'));
      const puts = requests.filter((r) => r.method === 'PUT' && /\/vaults\/[^/]+\/records\/[^/]+$/.test(new URL(r.url).pathname));
      info.recordWrites = puts.length;
      if (info.vaultCreated && !puts.length) add('saved', 'fail', 'Data was saved', 'No record write reached the datastore, so the leak checks prove little: add steps to wds-verify.json or mark the save button with data-wds-verify="save"' + DOCP + '.');
      else if (puts.length) add('saved', 'pass', 'Data was saved', puts.length + ' encrypted record write(s) reached the ' + (sb ? 'service' : 'mock') + '; the canaries were searched for in all of them.');
      if (info.fields === 0 && info.stepFills === 0) add('fields', 'warn', 'Input fields', 'No visible input, textarea or contenteditable element was found to type into.'
        + (info.behindModal ? ' ' + info.behindModal + ' field(s) sat behind a modal dialog of the app, which makes the page behind it inert while it is open: add a first step that closes it (for example {"click": "#welcome-ok"}), and the same step to afterReload if the app opens it at every start.' : ''));
      else add('fields', 'info', 'Input fields', (info.fields + info.stepFills) + ' field(s) filled with canaries (' + info.fields + ' found by the tool, ' + info.stepFills + ' by wds-verify.json steps); buttons pressed by the tool: '
        + (info.clicks.length ? info.clicks.map((c) => '"' + c + '"').join(', ') : 'none') + '.');
      if (seed && info.seed) {
        const fills = canaries.items.filter((c) => c.seed && c.round === 'seed');
        const shown = fills.filter(shownAfter), missing = fills.filter((c) => !shownAfter(c));
        // Only what a person sees after the lock and the unlock counts: it was read from the vault then (a prompt that names the old values proves nothing).
        const looked = 'the start view after the unlock and every view an afterReload step opens were looked at';
        const failedLine = consoleLines.find((l) => /migrateLocal ".*" stopped/.test(l));   // the library says why in the console; the dialog says only that it failed
        const asked = failedLine ? 'The library reported: ' + failedLine.replace(/^error: wds: /, '') : info.migrateDialog ? 'The library asked and the tool took over the data, so check the map function of store.migrateLocal.' : 'The library\'s question did not appear: does the app call await store.migrateLocal({ ... }) after the unlock (porting.md)?';
        let ran = true;   // did the migration visibly run? (the old data is judged hard only then)
        if (!fills.length) add('migration-visible', 'info', 'Migration: old data visible', 'The seed has no fill step, so there is no text to look for in the app.');
        else if (!info.vaultCreated) { ran = false; add('migration-visible', 'fail', 'Migration: old data visible', 'No vault was created, so nothing could be migrated.'); }
        else if (reloadMark === null) { ran = false; add('migration-visible', 'fail', 'Migration: old data visible', 'The app wrote no record to the vault, so nothing typed into the old app can have come from it. ' + asked); }
        else if (!shown.length) { ran = false; add('migration-visible', 'fail', 'Migration: old data visible', 'None of the ' + fills.length + ' value(s) typed into the old app is visible after the migration, the lock and the unlock (' + looked + '). ' + asked); }
        else if (missing.length) { ran = true; add('migration-visible', 'warn', 'Migration: old data visible', shown.length + ' of ' + fills.length + ' value(s) typed into the old app are visible; missing: ' + missing.map((c) => c.selector).join(', ') + ' (' + looked + ').'); }
        else add('migration-visible', 'pass', 'Migration: old data visible', 'All ' + fills.length + ' value(s) typed into the old app are visible after the migration, the lock and the unlock (' + looked + ').');
        const seedHits = [...leaks.values()].flat().filter((h) => h.canary.seed);
        if (seedHits.length) add('migration-encrypted', 'fail', 'Migration: old data only encrypted', seedHits.slice(0, 5).map((h) => '- ' + h.canary.label + ' appears (' + h.enc + ') in ' + h.where).join('\n'));
        else if (info.recordWrites) add('migration-encrypted', 'pass', 'Migration: old data only encrypted', 'None of the seeded values appears in a request, a URL, the console or a ' + (sb ? 'cookie' : 'cookie or the server\'s database') + '; the ' + info.recordWrites + ' record write(s) carry them encrypted.');
        const baseline = info.seed.stored, left = seedLeft.length;
        const wasDeleted = baseline > 0 && left === 0 && !leftover.length;
        if (!baseline) { /* nothing was seeded: the seed finding says so */ }
        else if (sb) {   // the library never deletes in the sandbox: the copy there is gone tonight
          if (left === baseline) add('migration-old-data', 'pass', 'Migration: old data kept in the sandbox', 'The old data is still in the old app\'s storage, as it must be while the vault is the sandbox.');
          else add('migration-old-data', 'fail', 'Migration: old data kept in the sandbox', 'The old data was (partly) deleted although the vault is the sandbox: it would be lost tonight. Only store.migrateLocal may move old data, and it never deletes there.');
        } else if (wasDeleted) add('migration-old-data', 'pass', 'Migration: old data deleted', 'The old data is gone from the old app\'s storage after the migration (' + (oldBaseline.local.length + oldBaseline.idb.length) + ' key(s) and store(s) that the old app had filled).');
        else add('migration-old-data', ran ? 'fail' : 'warn', 'Migration: old data deleted', (leftover.length ? 'Still in the browser after the migration: ' + leftover.slice(0, 8).join('; ') + (leftover.length > 8 ? '; ...' : '') + '. ' : '')
          + (left ? left + ' of ' + baseline + ' value(s) typed into the old app are among them. ' : '') + (ran ? 'Rows that map leaves out stay by design; name what may stay in "seed": { "keep": [...] } of wds-verify.json.' : 'The migration did not visibly run, which is why.'));
      }
      if (steps.length && info.stepCount) {
        const c = info.stepCount;
        const extra = ['select', 'press', 'download'].filter((k) => c[k]).map((k) => ', ' + c[k] + ' ' + k).join('');
        add('steps', 'info', 'wds-verify.json steps', steps.length + ' step(s) run (' + c.fill + ' fill, ' + c.click + ' click, ' + c.upload + ' upload, ' + c.wait + ' wait' + extra + ').');
      }
      if (info.fileInputs && !(info.stepCount && info.stepCount.upload)) add('file-inputs', 'info', 'File inputs', 'The page has ' + info.fileInputs + ' file input(s); the tool fills them with a generated image, an {"upload": [selector]} step does it on demand' + DOCP + '.');
    }
    const notes = unexpected.filter((u) => !/pw\.hibp\.unavailable/.test(u));   // a breach check that cannot be reached is no finding
    if (info.stuckError) add('dialog-error', 'fail', 'A library dialog stayed in its error view', 'The dialog showed its error view again after three retries ("' + info.stuckError + '"): the service does not answer, or the dialog cannot be built (see the console).');
    if (notes.length) add('driver', 'warn', 'Test run notes', notes.slice(0, 6).join('\n'));
    if (info.locale !== 'en-US') add('locale', 'info', 'Browser language', 'The browser ran with the locale ' + info.locale + ' (the library dialogs follow <html lang>, else this).');

    // data after a reload: the page must read its data back after unlocking
    if (reload && reload.total) {
      const { total, shown, everyRound, hasAfter, notShown, notShownNames = [] } = reload;
      // the values that the app neither showed nor wrote are named (at most 5), so that the developer sees which field it was
      const nameList = notShownNames.slice(0, 5).join(', ') + (notShownNames.length > 5 ? ' and ' + (notShownNames.length - 5) + ' more' : '');
      const skipped = notShown === 1 ? ' 1 other typed value was neither shown as text nor written to the store before the reload and is not counted: ' + nameList + '.'
        : notShown ? ' ' + notShown + ' other typed values were neither shown as text nor written to the store before the reload and are not counted: ' + nameList + '.' : '';
      if (shown > 0 && everyRound) add('reload', 'pass', 'Data after reload', shown + ' of ' + total + ' typed value(s) are visible again after reloading and unlocking' + (hasAfter ? ' (the start view and every afterReload step looked at, together)' : '') + ' (at least one of every round).' + skipped);
      else if (shown === 0 && !hasAfter) add('reload', 'fail', 'Data after reload', 'After the lock, the reload and the unlock none of the ' + total + ' typed values is visible: the app does not show its data after await store.unlock(), or only in a view that no "afterReload" step opens' + DOCP + '.');
      else add('reload', 'warn', 'Data after reload', shown + ' of ' + total + ' typed value(s) are visible after the reload' + (hasAfter ? ' and the afterReload steps' : '') + '; the others are in views the tool does not open. '
        + (hasAfter ? 'Add afterReload steps that open the missing views (the tool looks after every step and takes all of them together).' : 'An app with tabs needs afterReload steps in wds-verify.json (they open the views that show the data; the tool looks after every step).') + skipped);
    }
    info.reload = reload;

    // the sandbox label must stay visible (the app must not hide it) and the sandbox may be unavailable or full
    if (sb) {
      const problems = [];
      const names = { banner: 'the banner in the library dialogs', badge: 'the badge in the corner of the page' };
      for (const k of ['banner', 'badge']) {
        if (k === 'badge' && !info.vaultCreated) continue;
        if (label[k] === 'hidden') problems.push(names[k] + ' is hidden (' + (labelWhy['sandbox-' + k] || 'the app hides the sandbox label') + '); the app hides the sandbox label');
        else if (label[k] === 'absent') problems.push(names[k] + ' is missing (is the library tag the current one?)');
      }
      if (label.banner === undefined && label.badge === undefined) { /* no library dialog was seen: nothing to judge */ }
      else if (problems.length) add('sandbox-label', 'fail', 'Sandbox label visible', 'The run was against the sandbox, which must label itself: ' + problems.join('; ') + '. People must be able to see that they are in a test environment; remove CSS or script that hides the library\'s elements.');
      else add('sandbox-label', 'pass', 'Sandbox label visible', 'The sandbox banner' + (info.vaultCreated ? ' and the corner badge' : '') + ' were visible to a person.');
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
    const realErrors = pageErrors.filter((e) => !/pw\.hibp\.unavailable/.test(e));   // a breach check that cannot be reached is no finding
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
    if (shared) add('one-record', 'warn', 'One record for everything', 'The values of two different items end up in the single record "' + shared + '": use one record per item (integration.md, Modelling).');
    else if (only && typed.length >= 3 && onlyHeld >= 3) add('one-record', 'warn', 'One record for everything', 'All values (' + onlyHeld + ' of ' + typed.length + ' fields) end up in the single record "' + only + '": use one record per item (integration.md, Modelling).');
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
