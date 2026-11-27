#!/usr/bin/env node
// wds-verify: smoke test for apps that use the WIAI Datastore. Not a proof: it looks for the usual mistakes.
//
//   node tools/wds-verify.mjs <app.html | app-directory> [--config wds-verify.json]
//
// Static checks: script tag and integrity hash, CSP, forbidden patterns, <html lang>, the real scope's settings. Dynamic checks (Chromium,
// file:// page, the public sandbox): the library's dialogs are driven, every field gets a canary string, save buttons are pressed (plus the steps
// of wds-verify.json), lock must reload the page, the page is reloaded and unlocked again, and the canaries are searched for in every request and
// every storage. An optional "seed" in wds-verify.json checks that the data of an older, local-only version arrives. Prints a Markdown report.
// Exit codes: 0 all checks passed, 1 a check failed, 2 the tool could not run, 3 the sandbox is unavailable (not an app finding: try again later).
//
// Internal options (repository tests and CI; not part of the documented use, see tools/README.md):
//   --target sandbox|mock|auto  sandbox (default): the public sandbox. mock: a local server (Python 3.13 with the server packages), skips the scope check.
//                       auto: mock when Python is found, else the sandbox
//   --config <file>     the wds-verify.json to use (default: next to the app)
//   --sandbox-copy <f>  write a copy of the app that stores into the sandbox scope (the file name must contain "sandbox") and exit
//   --static-only       skip the dynamic checks (no Python, no browser)
//   --out <file>        also write the report to a file          --json   print the findings as JSON
//   --strict            warnings fail too                         --headed show the browser
//   --locale <tag>      language of the browser (default: "locale" of wds-verify.json, else en-US)
//   --wait-ms <n>       time to wait for debounced saves at the end (default 2800)
//   --hashes <file>     published library hashes (default: <service>/client/hashes.json, then client/dist/hashes.json of the clone)
//   --heading-level <n> 1 to 5: the report's title gets n "#" and its sections n+1 (for pasting under a heading of the README)
//   --script-tag [ver]  print the complete script tag and the CSP meta tag for a version (default: newest) and exit
//   --scope-check off   do not ask the service for the scope's settings (a scope that is not registered yet)
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticChecks, scanHtml, CSP_TEMPLATE, ONERROR } from './lib/static-checks.mjs';
import { parseConfig } from './lib/config.mjs';
import { scopeCheck } from './lib/scope-check.mjs';
import { renderReport, notTested, headingLevel } from './lib/report.mjs';
import { UsageError, TargetUnavailable, REPO_URL, loadKnownHashes, sandboxInfo, serviceBase, offline, rewriteScopes } from './lib/targets.mjs';

export { UsageError };

export function parseArgs(argv) {
  const o = { positional: [], flags: {} };
  const withValue = new Set(['hashes', 'out', 'wait-ms', 'target', 'locale', 'sandbox-copy', 'scope-check', 'heading-level', 'config']);
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
  return '<script src="https://wiai.uni-bamberg.de/datastore/client/wds-' + v + '.js"\n        integrity="' + known[v].sri + '" crossorigin="anonymous"\n        onerror="' + ONERROR + '"></script>';
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
  const want = flags.target === undefined || flags.target === true ? 'sandbox' : String(flags.target);
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
    if (s.error) throw new TargetUnavailable('sandbox unavailable, not an app finding: ' + s.error + '. Try again later.');
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

export { renderReport, notTested, headingLevel } from './lib/report.mjs';

export async function verify(target, flags = {}) {
  const level = headingLevel(flags['heading-level']);   // checked before anything runs
  const hashes = await loadKnownHashes(flags);
  const appPath = findApp(target);
  const html = readFileSync(appPath, 'utf8');
  let config = { locale: null, steps: [], afterReload: [], seed: null };
  const cfgFile = flags.config === undefined ? join(dirname(appPath), 'wds-verify.json') : resolve(String(flags.config));
  if (flags.config !== undefined && !existsSync(cfgFile)) throw new UsageError('--config names ' + flags.config + ', which does not exist');
  if (existsSync(cfgFile)) { try { config = parseConfig(readFileSync(cfgFile, 'utf8')); } catch (e) { throw new UsageError(e.message); } }
  if (config.seed) {
    const old = resolve(dirname(appPath), config.seed.page);
    if (!existsSync(old) || !statSync(old).isFile()) throw new UsageError('wds-verify.json "seed.page" names ' + config.seed.page + ', which is not a file (the path is relative to wds-verify.json: ' + old + ')');
  }
  if (flags.locale !== undefined) {
    let ok = null;
    try { ok = typeof flags.locale === 'string' ? Intl.getCanonicalLocales(flags.locale)[0] : null; } catch (e) { ok = null; }
    if (!ok) throw new UsageError('--locale needs a BCP 47 language tag such as de-DE or en-US');
    flags = { ...flags, locale: ok };
  }
  const readmeFile = ['README.md', 'readme.md', 'README.txt', 'README'].map((f) => join(dirname(appPath), f)).find((f) => existsSync(f));
  const readme = readmeFile ? readFileSync(readmeFile, 'utf8') : '';
  const st = staticChecks(html, hashes.known, { readme });
  const tg = await resolveTarget(flags);
  const add = (id, level, title, detail) => ({ id, level, title, detail: detail || '' });
  let findings = [add('hashes', hashes.differs ? 'warn' : 'info', 'Library hashes', 'Published hashes from ' + hashes.source + '.' + (hashes.note ? ' ' + hashes.note : ''))].concat(st.findings);
  if (flags['scope-check'] === 'off' || tg.name === 'mock') findings.push(add('scope-settings', 'info', 'Current scope settings', tg.name === 'mock' ? 'Scope settings not checked: the mock creates the scope it needs; the production service knows nothing of this run.' : 'Scope settings not checked (--scope-check off): neither whether the scope exists nor its breach check, enrollment and limits.'));
  else findings = findings.concat(await scopeCheck(st.scope, st.csp, st.baseUrl, { html, readme }));
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
    report: renderReport({ appPath, findings, info, strict: !!flags.strict, target: tg, notTestedLines, headingLevel: level }) };
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
      console.log('\nCSP meta tag (in the head, right after <meta charset>, before any script):\n<meta http-equiv="Content-Security-Policy" content="' + CSP_TEMPLATE + '">');
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
