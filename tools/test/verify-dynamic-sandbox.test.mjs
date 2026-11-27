// wds-verify against the sandbox target, with a local mock that has a [sandbox] section standing in for the public service
// (WDS_VERIFY_SERVICE and WDS_VERIFY_LIBRARY point at it; the production path differs only in letting the requests through).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { run, writeApp, readApp, variant } from './helpers.mjs';
import { startMock } from '../lib/wds-mock.mjs';
import { spawnSync } from 'node:child_process';

const envFor = (mock, extra = {}) => ({ WDS_VERIFY_SERVICE: mock.origin + '/datastore', WDS_VERIFY_LIBRARY: mock.bundle.file, ...extra });
async function sbVerify(mock, html, args = [], { env = {}, config } = {}) {
  const r = await run('wds-verify.mjs', [writeApp(html, config), '--json', '--target', 'sandbox', ...args], { env: envFor(mock, env) });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (e) { /* no report */ }
  return { ...r, parsed, find: (id) => (parsed ? parsed.findings.find((f) => f.id === id) : undefined),
    titles: (level) => (parsed ? parsed.findings.filter((f) => f.level === level).map((f) => f.title) : []) };
}

// The scope IDs of the vaults created in this mock (from its audit table).
function vaultScopes(m) {
  const code = 'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nprint("\\n".join(sorted({r[0] for r in c.execute("SELECT scope_id FROM audit WHERE action=\'vault_created\'")})))';
  const r = spawnSync(m.python, ['-I', '-c', code, m.db], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
}

let mock;
before(async () => { mock = await startMock({ bundle: true, sandbox: true }); });
after(async () => { if (mock) await mock.stop(); });

test('sandbox target: the app runs against the sandbox scope, the label is checked, the database is not inspected, nothing about the real scope is written', { timeout: 240000 }, async () => {
  const r = await sbVerify(mock, readApp('good'));
  assert.equal(r.code, 0, JSON.stringify(r.parsed && r.parsed.findings.filter((f) => f.level === 'fail')) + r.stderr);
  assert.equal(r.parsed.target.name, 'sandbox');
  assert.match(r.parsed.target.reason, /chosen with --target sandbox.*sandbox-000000/);
  for (const id of ['vault', 'saved', 'reload', 'sandbox-label', 'write-rate', 'leak-request body', 'leak-localStorage']) assert.equal(r.find(id).level, 'pass', id);
  assert.equal(r.find('database-not-inspected').level, 'info');
  assert.equal(r.find('leak-server database (mock)'), undefined);
  assert.match(r.find('vault').detail, /sandbox/);
  assert.ok(r.find('sandbox-cleanup'));
  // every scope ID of the page copy went to the sandbox scope
  assert.deepEqual(vaultScopes(mock), ['sandbox-000000']);
  assert.match(r.parsed.notTested.join('\n'), /second device/);
});

test('sandbox target: an app that hides the sandbox label at run time fails', { timeout: 240000 }, async () => {
  const hide = "  new MutationObserver(function () { document.querySelectorAll('[data-wds=\"sandbox-banner\"], [data-wds=\"sandbox-bar\"]').forEach(function (e) { e.style.setProperty('display', 'none', 'important'); }); })"
    + ".observe(document.documentElement, { childList: true, subtree: true });\n  start();";
  const r = await sbVerify(mock, variant(readApp('good'), '  start();', hide));
  assert.equal(r.code, 1);
  assert.ok(r.titles('fail').includes('Sandbox label visible'), r.titles('fail').join('|'));
  assert.match(r.find('sandbox-label').detail, /hides the sandbox label/);
});

test('sandbox target: a quota of the sandbox is "sandbox limit, not tested", not a finding', { timeout: 240000 }, async () => {
  const body = '<label>Note <input id="n" type="text"></label><button id="save" type="button">Save</button><button id="big" type="button" data-wds-verify="save">Store everything</button><span id="s"></span>';
  const script = "  $('save').addEventListener('click', function () { store.set('note', $('n').value); });\n"
    + "  $('big').addEventListener('click', function () { store.set('big', 'x'.repeat(700000)).catch(function (e) { $('s').textContent = e.name; }); });\n"
    + "  store.unlock().then(function () { return store.get('note'); }).then(function (v) { if (v) $('n').value = v; });";
  const { miniApp } = await import('./helpers.mjs');
  const r = await sbVerify(mock, miniApp({ body, script }));
  assert.equal(r.code, 0, JSON.stringify(r.parsed && r.parsed.findings.filter((f) => f.level === 'fail')) + r.stderr);
  assert.equal(r.find('sandbox-limit').level, 'info');
  assert.match(r.find('sandbox-limit').detail, /sandbox limit, not tested/);
});

test('--target auto without Python uses the sandbox when the service is reachable; the first report line says why', { timeout: 240000 }, async () => {
  mock.createScopeWithId('wds-verify-demo-k7m2a9');
  const r = await sbVerify(mock, readApp('good'), [], { env: { WDS_VERIFY_OFFLINE: '', WDS_VERIFY_HASHES_URL: 'off', WDS_PYTHON: '/nonexistent/python' } });
  assert.equal(r.parsed.target.name, 'sandbox');
  assert.equal(r.code, 0, JSON.stringify(r.parsed.findings.filter((f) => f.level === 'fail')));
  assert.equal(r.find('scope-settings').level, 'info');   // the real scope was checked on the service
  const md = await run('wds-verify.mjs', [writeApp(readApp('good')), '--target', 'auto'], { env: envFor(mock, { WDS_VERIFY_OFFLINE: '', WDS_VERIFY_HASHES_URL: 'off', WDS_PYTHON: '/nonexistent/python' }) });
  assert.match(md.stdout, /^# wds-verify report: index\.html\n\nTarget: \*\*sandbox\*\* \(auto: no mock \(/);
});

test('sandbox unavailable: switched off or rate limited is exit code 3 and says it is not an app finding', { timeout: 300000 }, async () => {
  const off = await startMock({ bundle: true, sandbox: { enabled: false } });
  try {
    const r = await run('wds-verify.mjs', [writeApp(readApp('good')), '--target', 'sandbox'], { env: envFor(off) });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /sandbox unavailable, not an app finding: the sandbox is switched off/);
  } finally { await off.stop(); }
  const one = await startMock({ bundle: true, sandbox: { create_per_ip: 1 } });
  try {
    const first = await sbVerify(one, readApp('good'));
    assert.equal(first.code, 0, JSON.stringify(first.parsed && first.parsed.findings.filter((f) => f.level === 'fail')) + first.stderr);
    const second = await sbVerify(one, readApp('good'));
    assert.equal(second.code, 3, second.stdout.slice(0, 600));
    assert.equal(second.find('sandbox-unavailable').level, 'info');
    assert.match(second.find('sandbox-unavailable').detail, /Sandbox unavailable, not an app finding: too many vaults/);
    assert.equal(second.find('vault'), undefined);
    const md = await run('wds-verify.mjs', [writeApp(readApp('good')), '--target', 'sandbox'], { env: envFor(one) });
    assert.equal(md.code, 3);
    assert.match(md.stdout, /NOT RUN, sandbox unavailable/);
  } finally { await one.stop(); }
});
