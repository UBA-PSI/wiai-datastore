#!/usr/bin/env node
// wds-verify: smoke test for apps that use the WIAI Datastore (PLAN 9.6). Not a proof: it looks for the usual mistakes.
//
//   node tools/wds-verify.mjs <app.html | app-directory> [options]
//
// Static checks: the script tag (published version, integrity hash from the service's hashes.json, or the local clone), the CSP (not
// broader than the recommended one), no other scripts, no direct access to the datastore host, no sandbox scope ID or label-hiding CSS
// in the app, and the real scope's settings (breach check against the CSP). Dynamic checks: the app runs in Chromium from a file://
// URL against a local copy of the real server (target mock) or the public sandbox (target sandbox); every field is filled with
// canary strings, save buttons are pressed (plus the steps in wds-verify.json next to the app), the page is reloaded and unlocked
// again, and the canaries are searched for in every request, in the browser storage, the console, downloads and (mock) the database.
// Prints a Markdown report and exits 1 if a check failed.
//
// Setup: a clone of the public repository (https://github.com/UBA-PSI/wiai-datastore); see tools/README.md. Without Python and without a clone's client
// build the sandbox target and the static checks still work.
//
// Options:
//   --target <t>        auto (default), mock or sandbox. auto: mock when Python 3.13 with the server packages is found, else the
//                       public sandbox if it is reachable, else static checks only. mock needs Python and the clone; sandbox needs
//                       neither (it opens the app against the real service, in the sandbox scope; data is deleted every night)
//   --locale <tag>      language of the browser, e.g. de-DE (default: "locale" of wds-verify.json, else en-US)
//   --sandbox-copy <f>  write a copy of the app that stores into the sandbox scope (for a person to open in a browser) and exit;
//                       the file name must contain "sandbox"
//   --static-only       skip the dynamic checks (no Python, no browser needed)
//   --hashes <file>     published library hashes (default: <service>/client/hashes.json, then client/dist/hashes.json of the clone)
//   --out <file>        also write the report to a file
//   --strict            warnings fail too
//   --headed            show the browser
//   --wait-ms <n>       time to wait for debounced saves at the end (default 2800)
//   --script-tag [ver]  print the script tag for a version (default: newest) and exit
//   --json              print the findings as JSON instead of Markdown
// Exit codes: 0 all checks passed, 1 a check failed, 2 the tool could not run (usage, missing Python or browser),
// 3 the sandbox is unavailable (full, rate limited, switched off): not an app finding, try again later.
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticChecks, scanHtml, CSP_TEMPLATE } from './lib/static-checks.mjs';
import { parseConfig } from './lib/config.mjs';
import { scopeCheck } from './lib/scope-check.mjs';
import { UsageError, TargetUnavailable, REPO_URL, loadKnownHashes, sandboxInfo, serviceBase, offline, rewriteScopes } from './lib/targets.mjs';

export { UsageError };

export function parseArgs(argv) {
  const o = { positional: [], flags: {} };
  const withValue = new Set(['hashes', 'out', 'wait-ms', 'target', 'locale', 'sandbox-copy']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (eq >= 0) o.flags[key] = a.slice(eq + 1);
      else if (withValue.has(key)) { if (i + 1 >= argv.length) throw new UsageError('--' + key + ' needs a value'); o.flags[key] = argv[++i]; }
      else if (key === 'script-tag' && argv[i + 1] && /^\d+\.\d+\.\d+$/.test(argv[i + 1])) o.flags[key] = argv[++i];
      else o.flags[key] = true;
    } else o.positional.push(a);
  }
  return o;
}

function semver(v) { return v.split('.').map((n) => String(Number(n)).padStart(6, '0')).join('.'); }
export function scriptTag(known, version) {
  const v = version || Object.keys(known).sort((a, b) => (semver(a) < semver(b) ? 1 : -1))[0];
  if (!known[v]) throw new UsageError('unknown library version ' + v + ' (known: ' + Object.keys(known).join(', ') + ')');
  return '<script src="https://wiai.uni-bamberg.de/datastore/client/wds-' + v + '.js"\n        integrity="' + known[v].sri + '" crossorigin="anonymous"></script>';
}

function findApp(p) {
  const abs = resolve(p);
  if (!existsSync(abs)) throw new UsageError('no such file or directory: ' + p);
  if (statSync(abs).isFile()) return abs;
  const index = join(abs, 'index.html');
  if (existsSync(index)) return index;
  const htmls = readdirSync(abs).filter((f) => /\.html?$/i.test(f));
  if (htmls.length === 1) return join(abs, htmls[0]);
  throw new UsageError(abs + ' has no index.html and ' + htmls.length + ' other HTML files; name the file');
}

// ---- the target ----
// Returns {name: 'mock' | 'sandbox' | 'static', reason, ...}; throws UsageError (mock impossible) or TargetUnavailable (sandbox asked for, not usable).
async function resolveTarget(flags) {
  const want = flags.target === undefined || flags.target === true ? 'auto' : String(flags.target);
  if (!['auto', 'mock', 'sandbox'].includes(want)) throw new UsageError('--target must be auto, mock or sandbox, not "' + want + '"');
  if (flags['static-only']) return { name: 'static', reason: 'chosen with --static-only', chosen: true };
  const mockTarget = async () => {
    try {
      const { findPython } = await import('./lib/python.mjs');
      return { name: 'mock', reason: 'Python 3.13 with the server packages found (' + findPython() + ')' };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  };
  const sandboxTarget = async () => {
    const s = await sandboxInfo();
    if (!s.ok) return { error: s.reason };
    const svc = serviceBase();
    return { name: 'sandbox', reason: 'the sandbox scope ' + s.scopeId + ' of ' + svc + ' is reachable and enabled', scopeId: s.scopeId, service: svc,
      serviceOrigin: process.env.WDS_VERIFY_SERVICE ? new URL(svc).origin : null, libraryFile: process.env.WDS_VERIFY_LIBRARY || null, doc: s.doc };
  };
  if (want === 'mock') {
    const m = await mockTarget();
    if (m.error) throw new UsageError(m.error);
    return { ...m, reason: 'chosen with --target mock; ' + m.reason };
  }
  if (want === 'sandbox') {
    const s = await sandboxTarget();
    if (s.error) throw new TargetUnavailable('sandbox unavailable, not an app finding: ' + s.error + '. Try again later, or use --target mock (needs Python 3.13, see tools/README.md).');
    return { ...s, reason: 'chosen with --target sandbox; ' + s.reason };
  }
  const m = await mockTarget();
  if (!m.error) return { ...m, reason: 'auto: ' + m.reason };
  if (offline()) return { name: 'static', reason: 'auto: no mock (' + firstLine(m.error) + ') and the sandbox is not tried (WDS_VERIFY_OFFLINE)', degraded: true };
  const s = await sandboxTarget();
  if (!s.error) return { ...s, reason: 'auto: no mock (' + firstLine(m.error) + '); ' + s.reason };
  return { name: 'static', reason: 'auto: no mock (' + firstLine(m.error) + ') and no sandbox (' + s.error + ')', degraded: true };
}
const firstLine = (s) => String(s).split('\n')[0].replace(/^cannot start the local mock server: /, '');

// ---- the report ----
const ICON = { pass: 'pass', fail: '**FAIL**', warn: 'warn', info: 'info' };

// What this run cannot know: one line each, phrased as what the developer's Claude has to try by hand.
export function notTested({ info = {}, config = {}, html = '', target = {} }) {
  const out = [];
  if (target.name === 'static') out.push('Everything the dynamic part checks was not run (no browser): the canary search in requests, storage and console, saving, and the reload. Run wds-verify without --static-only (or with --target sandbox) before you finish.');
  out.push('A second device and conflicts: open the app in two browsers with the same vault, change the same record in both, and look at what a person sees (the conflict dialog or your onConflict handler; no entry may get lost).');
  out.push('A read-only member: invite a member with the role "read", and check that every control that writes is disabled or hidden for them and that no error shows.');
  out.push('Lock and unlock again in one page: lock the vault (store.lock(), or wait for the timeout) and unlock without reloading; the screen must be empty on lock and filled again on unlock, and nothing may be registered twice (register onLock and onUnlock once, outside start).');
  const unpressed = info.unpressed && info.unpressed.length ? ' This run saw: ' + info.unpressed.map((t) => '"' + t + '"').join(', ') + '.' : '';
  out.push('Buttons the tool does not press: delete, export, download, import, lock, and everything that the save word list, data-wds-verify="save" or a click step does not match. Press each by hand.' + unpressed);
  if (info.fileInputs && !(info.stepCount && info.stepCount.upload)) out.push('File inputs (' + info.fileInputs + ') without an upload step were not used: add {"upload": [selector]} steps, or try the upload by hand.');
  if (!info.stepCount || info.hiddenFields) out.push('Fields in views no step opens (tabs, panels, dialogs of the app)' + (info.hiddenFields ? ': ' + info.hiddenFields + ' hidden field(s) were seen but not filled' : '') + '. Fill them by hand, or add steps (click the tab, fill the field, click save) and afterReload steps.');
  if ((info.appDialogs || /<dialog\b|role\s*=\s*["']dialog|aria-modal/i.test(html)) && !(config.steps && config.steps.length)) out.push('The app has dialogs of its own and wds-verify.json has no steps for them: the tool finds no stable selectors in them. Add steps that open them and fill their fields, or test them by hand.');
  return out;
}

// With --strict a warning counts as a failure and is shown as one (under "Failures", marked "(warn, fails with --strict)").
export function renderReport({ appPath, findings, info, strict, target, notTestedLines }) {
  const failed = findings.filter((f) => f.level === 'fail' || (strict && f.level === 'warn'));
  const warned = strict ? [] : findings.filter((f) => f.level === 'warn');
  const mark = (f) => (strict && f.level === 'warn' ? '**FAIL** (warn, fails with --strict)' : ICON[f.level]);
  const out = [];
  out.push('# wds-verify report: ' + basename(appPath), '');
  if (target) out.push('Target: **' + target.name + '** (' + target.reason + ')', '');
  const unavailable = info && info.unavailable;
  out.push('**Result: ' + (unavailable ? 'NOT RUN, sandbox unavailable' : failed.length ? 'FAILED' : 'passed') + '** (' + findings.filter((f) => f.level === 'pass').length + ' checks passed, ' + failed.length + ' failed, '
    + warned.length + ' warning' + (warned.length === 1 ? '' : 's') + ')', '');
  out.push('This is a smoke test, not a proof. It catches the usual mistakes (plaintext in storage or requests, wrong script tag, wide CSP); it cannot see what it did not trigger.', '');
  const section = (title, items) => {
    if (!items.length) return;
    out.push('## ' + title, '');
    for (const f of items) {
      out.push('- **' + f.title + '** (' + mark(f) + ')' + (f.detail ? ': ' + f.detail.split('\n')[0] : ''));
      f.detail.split('\n').slice(1).forEach((l) => out.push('  ' + l));
    }
    out.push('');
  };
  section('Failures', failed);
  section('Warnings', warned);
  out.push('## All checks', '', '| Check | Result | Details |', '|---|---|---|');
  for (const f of findings) out.push('| ' + f.title + ' | ' + mark(f) + ' | ' + f.detail.replace(/\|/g, '\\|').replace(/\n/g, '<br>').slice(0, 300) + ' |');
  out.push('');
  if (info && info.durationMs) out.push('Dynamic run: ' + (info.durationMs / 1000).toFixed(1) + ' s, ' + (info.fields || 0) + ' canary field(s), ' + (info.recordWrites || 0) + ' record write(s).', '');
  if (notTestedLines) {
    out.push('## Not tested', '', 'This run cannot see the following. Test each by hand before you hand the app over:', '');
    for (const l of notTestedLines) out.push('- ' + l);
    out.push('');
  }
  return out.join('\n');
}

export async function verify(target, flags = {}) {
  const hashes = await loadKnownHashes(flags);
  const appPath = findApp(target);
  const html = readFileSync(appPath, 'utf8');
  let config = { locale: null, steps: [], afterReload: [] };
  const cfgFile = join(dirname(appPath), 'wds-verify.json');
  if (existsSync(cfgFile)) { try { config = parseConfig(readFileSync(cfgFile, 'utf8')); } catch (e) { throw new UsageError(e.message); } }
  if (flags.locale !== undefined) {
    let ok = null;
    try { ok = typeof flags.locale === 'string' ? Intl.getCanonicalLocales(flags.locale)[0] : null; } catch (e) { ok = null; }
    if (!ok) throw new UsageError('--locale needs a BCP 47 language tag such as de-DE or en-US');
    flags = { ...flags, locale: ok };
  }
  const st = staticChecks(html, hashes.known);
  const tg = await resolveTarget(flags);
  const add = (id, level, title, detail) => ({ id, level, title, detail: detail || '' });
  let findings = [add('hashes', hashes.differs ? 'warn' : 'info', 'Library hashes', 'Published hashes from ' + hashes.source + '.' + (hashes.note ? ' ' + hashes.note : ''))].concat(st.findings);
  findings = findings.concat(await scopeCheck(st.scope, st.csp, st.baseUrl));
  if (tg.degraded) findings.push(add('dynamic-skipped', 'warn', 'Dynamic checks did not run', 'Only the static checks ran: ' + tg.reason + '. Install Python 3.13 with the server packages (tools/README.md) to run the app against a local mock, or try again when the sandbox is reachable.'));
  let info = {};
  if (tg.name === 'mock' || tg.name === 'sandbox') {
    const { dynamicChecks, PlaywrightMissing } = await import('./lib/dynamic-checks.mjs');
    const { MockUnavailable } = await import('./lib/python.mjs');
    try {
      const dyn = await dynamicChecks({ appPath, html, config, library: st.library, target: tg, opts: { headed: !!flags.headed, waitMs: flags['wait-ms'] !== undefined ? Number(flags['wait-ms']) : undefined, locale: flags.locale } });
      findings = findings.concat(dyn.findings); info = dyn.info;
    } catch (e) {
      if (e instanceof MockUnavailable || e instanceof PlaywrightMissing) throw new UsageError(e.message);
      throw e;
    }
  }
  const failed = findings.some((f) => f.level === 'fail' || (flags.strict && f.level === 'warn'));
  const notTestedLines = notTested({ info, config, html, target: tg });
  const code = info.unavailable ? 3 : failed ? 1 : 0;
  return { appPath, findings, info, failed, code, target: tg, notTested: notTestedLines,
    report: renderReport({ appPath, findings, info, strict: !!flags.strict, target: tg, notTestedLines }) };
}

// --sandbox-copy: the app with every scope ID replaced by the sandbox ID, for a person to open in a browser.
async function sandboxCopy(appArg, outFile) {
  if (!/sandbox/i.test(basename(outFile))) throw new UsageError('the file name of a sandbox copy must contain "sandbox" (for example ' + basename(appArg).replace(/\.html?$/i, '') + '-sandbox.html), so nobody mistakes it for the app');
  const appPath = findApp(appArg);
  const html = readFileSync(appPath, 'utf8');
  const s = await sandboxInfo();
  if (!s.ok) throw new TargetUnavailable('sandbox unavailable, not an app finding: ' + s.reason + '. A sandbox copy needs the sandbox scope ID from the service.');
  const rw = rewriteScopes(html, scanHtml(html).scripts, s.scopeId);
  if (!rw.sites) throw new UsageError('found no WDS.connect({ scope: "..." }) with a literal scope ID in the scripts of ' + basename(appPath) + ' (a constant declared in the same script works too); nothing to replace');
  writeFileSync(outFile, rw.html);
  console.log('wrote ' + outFile + ': ' + (rw.replaced.length ? 'scope ' + rw.replaced.join(', ') + ' replaced' : 'already uses') + ' by the sandbox scope ' + s.scopeId + '.');
  console.log('Open it in a browser to test. The library shows a sandbox banner; vaults and data are deleted every night. Never ship this copy and never put the sandbox scope ID into the app itself.');
  return 0;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.flags.help || args.flags.h || (!args.positional.length && args.flags['script-tag'] === undefined)) {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
      return args.flags.help || args.flags.h ? 0 : 2;
    }
    if (args.flags['script-tag'] !== undefined) {
      const h = await loadKnownHashes(args.flags);
      console.log(scriptTag(h.known, args.flags['script-tag'] === true ? null : args.flags['script-tag']));
      console.log('\nCSP meta tag (first element of <head>):\n<meta http-equiv="Content-Security-Policy" content="' + CSP_TEMPLATE + '">');
      return 0;
    }
    if (args.positional.length !== 1) throw new UsageError('give exactly one app file or directory');
    if (args.flags['sandbox-copy'] !== undefined) {
      if (args.flags['sandbox-copy'] === true) throw new UsageError('--sandbox-copy needs an output file name');
      return await sandboxCopy(args.positional[0], args.flags['sandbox-copy']);
    }
    const r = await verify(args.positional[0], args.flags);
    if (args.flags.json) console.log(JSON.stringify({ app: r.appPath, failed: r.failed, target: { name: r.target.name, reason: r.target.reason }, unavailable: r.info.unavailable || null, findings: r.findings, notTested: r.notTested }, null, 2));
    else console.log(r.report);
    if (args.flags.out && args.flags.out !== true) writeFileSync(args.flags.out, r.report + '\n');
    return r.code;
  } catch (e) {
    if (e instanceof UsageError) { console.error('wds-verify: ' + e.message); return 2; }
    if (e instanceof TargetUnavailable) { console.error('wds-verify: ' + e.message); return 3; }
    console.error('wds-verify: unexpected error: ' + (e && e.stack || e));
    return 2;
  }
}

// Started as a program (also through a symlinked or temporary directory, where the paths differ until they are resolved).
const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch (e) { return false; } })();
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
