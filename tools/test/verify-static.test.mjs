// wds-verify: static checks, CSP comparison, canary encodings, step parsing, command line. No browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staticChecks, cspBroaderThan, parseCsp, CSP_TEMPLATE, scanHtml, stripJsComments } from '../lib/static-checks.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Canaries, needlesFor, findIn } from '../lib/canary.mjs';
import { parseConfig } from '../lib/config.mjs';
import { parseArgs, scriptTag, renderReport } from '../wds-verify.mjs';
import { HASHES, VERSION, ROOT, readApp, variant, writeApp, run } from './helpers.mjs';

const good = () => readApp('good');
const level = (r, id) => (r.findings.find((f) => f.id === id) || {}).level;
const check = (html) => staticChecks(html, HASHES);
const SRI = HASHES[VERSION].sri;

test('the good example app passes the static checks', () => {
  const r = check(good());
  assert.deepEqual(r.findings.filter((f) => f.level === 'fail'), []);
  assert.equal(level(r, 'library-integrity'), 'pass');
  assert.equal(level(r, 'csp'), 'pass');
  assert.equal(level(r, 'external-scripts'), 'pass');
  assert.equal(level(r, 'datastore-direct'), 'pass');
  assert.equal(r.library.version, VERSION);
  assert.equal(r.scope, 'wds-verify-demo-k7m2a9');
});

test('script tag: integrity must match the published hash, crossorigin, version, host, exactly one tag', () => {
  const h = good();
  assert.equal(level(check(variant(h, SRI, 'sha384-AAAA')), 'library-integrity'), 'fail');
  assert.equal(level(check(variant(h, 'integrity="' + SRI + '" ', '')), 'library-integrity'), 'fail');
  assert.equal(level(check(variant(h, ' crossorigin="anonymous"', '')), 'library-crossorigin'), 'fail');
  assert.equal(level(check(variant(h, 'wds-' + VERSION + '.js', 'wds-9.9.9.js')), 'library-version'), 'fail');
  assert.equal(level(check(variant(h, 'https://wiai.uni-bamberg.de/datastore/client/wds', 'http://localhost:8000/datastore/client/wds')), 'library-tag'), 'fail');
  assert.equal(level(check(variant(h, '.js"\n', '.js?x=1"\n')), 'library-tag'), 'fail');
  assert.equal(level(check(h.replace(/<script src=[\s\S]*?<\/script>/, '')), 'library-tag'), 'fail');
  const twice = h.replace(/(<script src=[\s\S]*?<\/script>)/, '$1\n$1');
  assert.equal(level(check(twice), 'library-tag'), 'fail');
  // the failure names the expected hash
  assert.match(check(variant(h, SRI, 'sha384-AAAA')).findings.find((f) => f.id === 'library-integrity').detail, new RegExp(SRI.replace(/[+/]/g, '.')));
});

test('onerror fallback: the text of the documentation and a message in the language of the app are accepted, no handler or other code warns', async () => {
  const { onerrorState, ONERROR } = await import('../lib/static-checks.mjs');
  const h = good();
  assert.match(h, /onerror="document\.body\.textContent='Storage service unreachable\. Check your connection and reload this page\.'"/);
  assert.equal(level(check(h), 'library-onerror'), 'pass', 'the documented handler passes');
  const german = h.replace(/onerror="[^"]*"/, 'onerror="document.body.textContent=\'Der Speicherdienst ist nicht erreichbar. Bitte prüfen Sie die Verbindung und laden Sie die Seite neu.\'"');
  const r = check(german);
  assert.equal(level(r, 'library-onerror'), 'info');
  assert.match(r.findings.find((f) => f.id === 'library-onerror').detail, /Speicherdienst/);
  assert.deepEqual(r.findings.filter((f) => f.level === 'fail' || f.level === 'warn'), [], 'a translated message is no warning');
  assert.equal(level(check(h.replace(/\n\s*onerror="[^"]*"/, '')), 'library-onerror'), 'warn');
  for (const code of ["document.title = 'x'", "document.body.innerHTML='<b>x</b>'", "document.body.textContent=message", "document.body.textContent='it\\'s'", "alert(1)", "document.body.textContent=''"])
    assert.equal(level(check(h.replace(/onerror="[^"]*"/, 'onerror="' + code.replace(/"/g, '&quot;') + '"')), 'library-onerror'), 'warn', code);
  assert.equal(onerrorState(ONERROR).state, 'exact');
  assert.equal(onerrorState("document.body.textContent = 'Kein Dienst';").state, 'translated');
  assert.equal(onerrorState('').state, 'missing');
});

test('--heading-level moves the headings of the report so that it can be pasted under a heading of a README', async () => {
  const findings = [{ id: 'a', level: 'pass', title: 'Fine', detail: '' }, { id: 'w', level: 'warn', title: 'Some warning', detail: 'not good' }, { id: 'f', level: 'fail', title: 'Broken', detail: 'x' }];
  const headings = (text) => text.split('\n').filter((l) => /^#{1,6} /.test(l));
  const plain = renderReport({ appPath: '/x/app.html', findings, info: {}, strict: false, notTestedLines: ['a thing'] });
  assert.deepEqual(headings(plain), ['# wds-verify report: app.html', '## Failures', '## Warnings', '## All checks', '## Not tested']);
  const three = renderReport({ appPath: '/x/app.html', findings, info: {}, strict: false, notTestedLines: ['a thing'], headingLevel: 3 });
  assert.deepEqual(headings(three), ['### wds-verify report: app.html', '#### Failures', '#### Warnings', '#### All checks', '#### Not tested']);
  assert.equal(three.replace(/^#+ /gm, ''), plain.replace(/^#+ /gm, ''), 'only the heading marks differ');
  const dir = writeApp(good());
  const out = join(tmpDir(), 'report.md');
  const r = await run('wds-verify.mjs', [dir, '--static-only', '--heading-level', '3', '--out', out], { env: { WDS_VERIFY_HASHES_URL: 'off' } });
  assert.match(r.stdout, /^### wds-verify report: /m);
  assert.doesNotMatch(r.stdout, /^#{1,2} /m);
  assert.equal(readFileSync(out, 'utf8'), r.stdout);
  for (const bad of ['0', '6', 'x', '2.5']) {
    const u = await run('wds-verify.mjs', [dir, '--static-only', '--heading-level', bad]);
    assert.equal(u.code, 2, bad);
    assert.match(u.stderr, /--heading-level needs a number from 1 to 5/);
  }
  assert.equal((await run('wds-verify.mjs', [dir, '--static-only', '--heading-level'])).code, 2);
});

test('CSP: the recommended policy and stricter ones pass, broader ones fail', () => {
  const tpl = CSP_TEMPLATE;
  assert.deepEqual(cspBroaderThan(parseCsp(tpl), tpl), []);
  const stricter = [
    tpl + "; form-action 'none'; base-uri 'none'",
    tpl.replace("'unsafe-inline' 'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'sha256-abc='"),
    tpl.replace('https://wiai.uni-bamberg.de/datastore/client/;', 'https://wiai.uni-bamberg.de/datastore/client/wds-1.0.0.js;'),
    tpl.replace("style-src 'unsafe-inline'; ", ''),
  ];
  for (const p of stricter) assert.deepEqual(cspBroaderThan(parseCsp(p), tpl), [], p);
  const broader = [
    ["default-src 'self'", /default-src/],
    ["default-src *", /default-src/],
    [tpl.replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'"), /unsafe-eval/],
    [tpl.replace('connect-src https://wiai', 'connect-src https: https://wiai'), /connect-src/],
    [tpl.replace('https://wiai.uni-bamberg.de/datastore/api/', 'https://wiai.uni-bamberg.de/'), /connect-src/],
    [tpl.replace("script-src 'unsafe-inline'", "script-src * 'unsafe-inline'"), /script-src/],
    [tpl.replace("script-src 'unsafe-inline'", "script-src 'self' 'unsafe-inline'"), /script-src: 'self'/],
    [tpl.replace("default-src 'none'", "default-src 'self'"), /default-src: 'self'/],
    [tpl.replace("base-uri 'none'; ", ''), /base-uri: missing/],
    [tpl.replace("; form-action 'none'", ''), /form-action: missing/],
    [tpl.replace("form-action 'none'", "form-action 'self'"), /form-action/],
    [tpl.replace("base-uri 'none'", "base-uri https://wiai.uni-bamberg.de"), /base-uri/],
    [tpl.replace('img-src data: blob:', 'img-src *'), /img-src/],
    [tpl.replace('img-src data: blob:', 'img-src data: blob: https:'), /img-src/],
    [tpl.replace("default-src 'none'; ", ''), /default-src|font-src|media-src/],
    [tpl + '; font-src https://fonts.example', /font-src/],
    [tpl + '; font-src data: https://fonts.example', /font-src/],
    [tpl + '; media-src https://cdn.example', /media-src/],
    [tpl.replace('img-src data: blob:', 'img-src data: blob: https://*.example.org'), /img-src/],
    [tpl + '; frame-src https://evil.example', /frame-src/],
    [tpl.replace("'unsafe-inline' 'wasm", "'unsafe-inline' 'strict-dynamic' 'wasm"), /strict-dynamic/],
  ];
  for (const [p, re] of broader) { const problems = cspBroaderThan(parseCsp(p), tpl); assert.ok(problems.length, 'should be broader: ' + p); assert.match(problems.join('\n'), re, p); }
});

test('CSP in the page: missing, wide, after the first script, in an entity-escaped attribute', () => {
  const h = good();
  const meta = h.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)[0];
  assert.equal(level(check(h.replace(meta, '')), 'csp'), 'fail');
  assert.equal(level(check(variant(h, "default-src 'none'", "default-src *")), 'csp'), 'fail');
  const moved = h.replace(meta, '').replace('</head>', meta + '</head>');
  assert.equal(level(check(moved), 'csp-position'), 'fail');
  assert.equal(level(check(h.replace("'none'", '&#39;none&#39;')), 'csp'), 'pass');
});

test('CSP: the additions that integration.md allows (font-src data:, media-src blob: data:, img-src https://host) do not fail', () => {
  const h = good();
  const meta = h.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)[1];
  for (const add of ['; font-src data:', '; media-src blob: data:', '; font-src data:; media-src blob: data:']) {
    const r = check(h.replace(meta, meta + add));
    assert.equal(level(r, 'csp'), 'pass', add);
    assert.deepEqual(r.findings.filter((f) => f.level === 'fail'), [], add);
  }
  const img = check(h.replace('img-src data: blob:', 'img-src data: blob: https://covers.openlibrary.org'));
  assert.equal(level(img, 'csp'), 'pass');
  assert.equal(level(img, 'csp-additions'), 'info');
  assert.match(img.findings.find((f) => f.id === 'csp-additions').detail, /covers\.openlibrary\.org/);
  assert.deepEqual(img.findings.filter((f) => f.level === 'fail'), []);
  assert.equal(level(check(good()), 'csp-additions'), undefined);
  // what stays forbidden: 'self' for scripts, a policy without base-uri or form-action, a host for scripts or connections
  assert.equal(level(check(h.replace("script-src 'unsafe-inline'", "script-src 'self' 'unsafe-inline'")), 'csp'), 'fail');
  assert.equal(level(check(h.replace("; base-uri 'none'; form-action 'none'", '')), 'csp'), 'fail');
  assert.equal(level(check(h.replace('img-src data: blob:', 'img-src data: blob: https:')), 'csp'), 'fail');
  assert.equal(level(check(h.replace('connect-src ', 'connect-src https://covers.openlibrary.org ')), 'csp'), 'fail');
});

test('the tool\'s policy is the policy that the documentation prints (docs.csp_policy)', { skip: !existsSync(join(ROOT, '.venv', 'bin', 'python')) && 'no project venv' }, () => {
  const r = spawnSync(join(ROOT, '.venv', 'bin', 'python'), ['-c', 'from wds_server.docs import csp_policy; print(csp_policy("https://wiai.uni-bamberg.de/datastore"), end="")'],
    { cwd: join(ROOT, 'server'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(CSP_TEMPLATE, r.stdout);
});

test('the report names the policy of the documentation when the CSP is missing', () => {
  const h = good();
  const meta = h.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)[0];
  const f = check(h.replace(meta, '')).findings.find((x) => x.id === 'csp');
  assert.equal(f.level, 'fail');
  assert.ok(f.detail.includes(CSP_TEMPLATE));
  assert.ok(!f.detail.includes("'self'"));
});

test('no other scripts, no direct access to the datastore', () => {
  const h = good();
  assert.equal(level(check(variant(h, '</head>', '<script src="https://cdn.example/x.js"></script></head>')), 'external-scripts'), 'fail');
  assert.equal(level(check(variant(h, '</head>', '<script src="x.js"></script></head>')), 'external-scripts'), 'fail');
  assert.equal(level(check(variant(h, '</head>', '<link rel="modulepreload" href="https://cdn.example/m.js"></head>')), 'external-scripts'), 'fail');
  assert.equal(level(check(variant(h, "  start();", "  import('https://cdn.example/m.js'); start();")), 'external-scripts'), 'fail');
  assert.equal(level(check(variant(h, "  start();", "  fetch('https://wiai.uni-bamberg.de/datastore/api/v1/scopes/x'); start();")), 'datastore-direct'), 'fail');
  assert.equal(level(check(variant(h, "  start();", "  new XMLHttpRequest().open('GET', '/datastore/api/v1/healthz'); start();")), 'datastore-direct'), 'fail');
  assert.equal(level(check(variant(h, '<ul id="items">', '<form action="https://wiai.uni-bamberg.de/datastore/api/v1/x" method="post"></form><ul id="items">')), 'datastore-direct'), 'fail');
  assert.equal(level(check(variant(h, '<ul id="items">', '<button formaction="/datastore/api/v1/x">x</button><ul id="items">')), 'datastore-direct'), 'fail');
  // another host is a warning (the CSP blocks it), not a failure
  const other = check(variant(h, "  start();", "  navigator.sendBeacon('https://stats.example/b', 'x'); start();"));
  assert.equal(level(other, 'network-apis'), 'warn');
  assert.equal(level(other, 'datastore-direct'), 'pass');
  // a comment or a string in a comment does not count
  assert.equal(level(check(variant(h, "  start();", "  // fetch('https://wiai.uni-bamberg.de/datastore/api/') is forbidden\n  start();")), 'datastore-direct'), 'pass');
});

test('the scanner: comments, attributes, script content', () => {
  const s = scanHtml('<!-- <script src="a.js"></script> --><script src=b.js></script><SCRIPT>var a = "</p>";</SCRIPT><meta http-equiv=X content=\'y z\'>');
  assert.deepEqual(s.scripts.map((t) => t.attrs.src), ['b.js', undefined]);
  assert.equal(s.scripts[1].content, 'var a = "</p>";');
  assert.equal(s.tags.find((t) => t.name === 'meta').attrs.content, 'y z');
  assert.equal(stripJsComments("a // x\n'//not' /* y */ b"), "a \n'//not'  b");
});

test('canaries are found in every encoding and not in unrelated data', () => {
  const c = new Canaries();
  const t = c.make('text', 'text'), n = c.make('number', 'number'), e = c.make('mail', 'email');
  assert.match(t.value, /^WDSCANARY /);
  assert.match(n.value, /^\d{11}$/);
  assert.match(e.value, /@canary\.example$/);
  const u = new Set([t.value, n.value, e.value, c.nonce]);
  assert.equal(u.size, 4);
  const v = t.value;
  const forms = {
    raw: 'xx' + v + 'yy',
    'url-encoded': '?note=' + encodeURIComponent(v),
    form: 'note=' + encodeURIComponent(v).replace(/%20/g, '+'),
    base64: Buffer.from('some text before' + v + 'and after').toString('base64'),
    'base64 offset 1': Buffer.from('s' + v).toString('base64'),
    'base64 offset 2': Buffer.from('ab' + v + 'c').toString('base64'),
    base64url: Buffer.from('}}~~' + v + '??').toString('base64url'),
    hex: Buffer.from(v).toString('hex'),
    'HEX upper': Buffer.from(v).toString('hex').toUpperCase(),
    utf16: Buffer.from('  ' + v, 'utf16le'),
    'utf16 hex': Buffer.from(v, 'utf16le').toString('hex'),
    'utf16 base64': Buffer.from('q' + v, 'utf16le').toString('base64'),
    'json in base64': Buffer.from(JSON.stringify({ a: { b: v } })).toString('base64'),
    bytes: Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(v), Buffer.from([9, 9])]),
  };
  for (const [name, data] of Object.entries(forms)) assert.ok(c.scan(data), 'not found: ' + name);
  assert.ok(c.scan(Buffer.from('x' + n.value + 'y')));
  assert.ok(c.scan(Buffer.from(e.value).toString('base64')));
  for (const clean of ['', 'hello world', Buffer.alloc(100000, 7), JSON.stringify({ tokens: 'abcdef0123456789'.repeat(50) }), Buffer.from('WDSCANARY other').toString('base64')]) assert.equal(c.scan(clean), null);
  assert.equal(findIn('abc', needlesFor('abcdef')), null);
});

test('wds-verify.json: an object with locale, steps and afterReload; steps are validated', () => {
  const c = parseConfig('{"locale":"de-DE","steps":[{"click":"#a"},{"fill":["#b","some text"]},{"select":["#s","x"]},{"press":["#b","Enter"]},{"upload":["#f"]},{"upload":["#f","a.png"]},{"download":"#csv"},{"wait":10}],"afterReload":[{"click":"#tab"}]}');
  assert.equal(c.locale, 'de-DE');
  assert.equal(c.steps.length, 8);
  assert.equal(c.afterReload.length, 1);
  assert.deepEqual(parseConfig('{}'), { locale: null, steps: [], afterReload: [], seed: null });
  assert.equal(parseConfig('{"steps":[{"wait":1}]}').steps.length, 1);
  assert.equal(parseConfig('{"locale":"de"}').locale, 'de');
  // a bare array is no longer accepted and the message shows the object form
  assert.throws(() => parseConfig('[{"click":"#a"}]'), (e) => /must be an object, not a bare array/.test(e.message) && /"steps": \[/.test(e.message));
  for (const bad of ['[1]', 'nope', '5', 'null', '{"stepz":[]}', '{"steps":{}}', '{"steps":[{"click":1}]}', '{"steps":[{"fill":["#a"]}]}', '{"steps":[{"wait":-1}]}', '{"steps":[{"click":"#a","wait":1}]}',
    '{"steps":[{"hover":"#a"}]}', '{"steps":[1]}', '{"steps":[{"select":["#a"]}]}', '{"steps":[{"press":["#a",1]}]}', '{"steps":[{"download":""}]}', '{"afterReload":[{"nope":1}]}', '{"locale":"not a tag!"}', '{"locale":5}'])
    assert.throws(() => parseConfig(bad), /wds-verify\.json/, bad);
  // errors name the step and the allowed forms
  assert.throws(() => parseConfig('{"steps":[{"wait":1},{"hover":"#a"}]}'), (e) => /step 2 is not one of/.test(e.message) && /\{"select": \[selector, value\]\}/.test(e.message) && /\{"download": selector\}/.test(e.message));
  assert.throws(() => parseConfig('{"afterReload":[{"nope":1}]}'), /afterReload step 1/);
});

test('command line: static-only report, exit codes, script tag, usage', async () => {
  assert.deepEqual(parseArgs(['a', '--static-only', '--hashes', 'x', '--out=y']), { positional: ['a'], flags: { 'static-only': true, hashes: 'x', out: 'y' } });
  const ok = await run('wds-verify.mjs', [writeApp(good()), '--static-only']);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^# wds-verify report: index\.html/);
  assert.match(ok.stdout, /\*\*Result: passed\*\*/);
  const strict = await run('wds-verify.mjs', [writeApp(good()), '--static-only', '--strict']); // "library version released" is about the library, not the app: info, even with --strict
  assert.equal(strict.code, 0, strict.stdout);
  assert.doesNotMatch(strict.stdout, /## Warnings/);
  if (!HASHES[VERSION].frozen) assert.match(strict.stdout, /\| Library version released \| info \|/);
  const bad = await run('wds-verify.mjs', [writeApp(variant(good(), SRI, 'sha384-AAAA')), '--static-only', '--json']);
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stdout).failed, true);
  assert.equal((await run('wds-verify.mjs', ['/no/such/app.html', '--static-only'])).code, 2);
  assert.equal((await run('wds-verify.mjs', [])).code, 2);
  const tag = await run('wds-verify.mjs', ['--script-tag']);
  assert.equal(tag.code, 0);
  assert.ok(tag.stdout.includes('integrity="' + SRI + '"') || tag.stdout.includes('wds-'));
  assert.equal(scriptTag(HASHES, VERSION).includes(SRI), true);
  assert.throws(() => scriptTag(HASHES, '0.0.1'), /unknown library version/);
});

test('without a usable Python the dynamic checks fail with a clear message (exit 2), the static ones still work', async () => {
  const r = await run('wds-verify.mjs', [writeApp(good()), '--target', 'mock'], { env: { WDS_PYTHON: '/nonexistent/python' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot start the local mock server/);
  assert.match(r.stderr, /Python 3\.13/);
  assert.match(r.stderr, /WDS_PYTHON/);
});

test('--strict: a promoted warning is listed under Failures and counted as failed, never under Warnings', () => {
  const findings = [{ id: 'a', level: 'pass', title: 'Fine', detail: '' }, { id: 'some-warning', level: 'warn', title: 'Some warning', detail: 'not good' }];
  const normal = renderReport({ appPath: '/x/app.html', findings, info: {}, strict: false });
  assert.match(normal, /Result: passed\*\* \(1 checks passed, 0 failed, 1 warning\)/);
  assert.match(normal, /## Warnings\n\n- \*\*Some warning\*\* \(warn\)/);
  const strict = renderReport({ appPath: '/x/app.html', findings, info: {}, strict: true });
  assert.match(strict, /Result: FAILED\*\* \(1 checks passed, 1 failed, 0 warnings\)/);
  assert.match(strict, /## Failures\n\n- \*\*Some warning\*\* \(\*\*FAIL\*\* \(warn, fails with --strict\)\)/);
  assert.doesNotMatch(strict, /## Warnings/);
  assert.match(strict, /\| Some warning \| \*\*FAIL\*\* \(warn, fails with --strict\) \|/);
});

// ---- round D: sandbox checks, local deletion, scope check, hashes, targets, report ----
import { rewriteScopes } from '../lib/targets.mjs';
import { hidingRules, handStorage } from '../lib/static-checks.mjs';
import { notTested } from '../wds-verify.mjs';
import { startStub, sandboxDoc, scopeDoc, verify } from './helpers.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const withScript = (code) => variant(good(), "  start();", code + "\n  start();");

test('static: the sandbox scope ID in the app is a failure, naming the way out', () => {
  const r = check(variant(good(), 'wds-verify-demo-k7m2a9', 'sandbox-000000'));
  const f = r.findings.find((x) => x.id === 'sandbox-id');
  assert.equal(f.level, 'fail');
  assert.match(f.detail, /deleted every night/);
  assert.match(f.detail, /--target sandbox/);
  assert.equal(level(check(good()), 'sandbox-id'), 'pass');
  // also in a comment or a data attribute: the file must not carry the ID anywhere
  assert.equal(level(check(variant(good(), '<h1>Shopping notes</h1>', '<!-- sandbox-000000 --><h1>Shopping notes</h1>')), 'sandbox-id'), 'fail');
});

test('static: CSS that hides the library (display, visibility, opacity on .wds- classes or [data-wds...]) fails; other CSS does not', () => {
  const css = (rule) => check(variant(good(), '</style>', rule + '\n</style>'));
  for (const rule of ['[data-wds="sandbox-banner"] { display: none }', '.wds-root { visibility: hidden !important }', '.wds-dialog > h2 { opacity: 0 }', '@media print { .wds-toast { display:none } }',
    '.a, [data-wds^="sandbox"] { color: red; display: none }', '/* x */ .wds-root{opacity:.01}']) {
    assert.equal(level(css(rule), 'sandbox-label-css'), 'fail', rule);
  }
  for (const rule of ['.wds-root { color: red }', '.note { display: none }', '[data-wds-verify="save"] { display: block }', '.mywds { display: none }', '/* .wds-root { display:none } */ .x { color: red }']) {
    assert.equal(level(css(rule), 'sandbox-label-css'), undefined, rule);
  }
  assert.deepEqual(hidingRules(['.wds-root{display:none}.b{color:red}']), ['.wds-root']);
  assert.deepEqual(hidingRules(['[data-wds-role="read"] .edit { display: none }']), []);   // the documented way to hide edit controls for read members
  assert.deepEqual(hidingRules(['[data-wds-role="read"] .wds-dialog { display: none }']), ['[data-wds-role="read"] .wds-dialog']);
});

test('static: indexedDB and deleting from localStorage in the app warn; a preference in localStorage and the options of migrateLocal do not', () => {
  const warn = (code) => level(check(withScript(code)), 'hand-storage');
  assert.equal(warn("function m() { indexedDB.deleteDatabase('old'); }"), 'warn');
  assert.equal(warn("function m() { return window.indexedDB.open('old'); }"), 'warn');
  assert.equal(warn("function m() { localStorage.removeItem('old'); }"), 'warn');
  assert.equal(warn("function m() { localStorage.clear(); }"), 'warn');
  assert.match(check(withScript("function m() { localStorage.clear(); }")).findings.find((f) => f.id === 'hand-storage').detail, /localStorage\.clear/);
  // a personal preference under the app's own key, the options of store.migrateLocal, strings and comments: no finding
  assert.equal(warn("var t = localStorage.getItem('theme'); localStorage.setItem('theme', 'dark');"), undefined);
  assert.equal(warn("store.migrateLocal({ id: 'a', indexedDB: { old: ['rows'] }, localStorage: ['k'], map() {} });"), undefined);
  assert.equal(warn("var s = \"localStorage.clear()\"; // localStorage.removeItem('x') and indexedDB"), undefined);
  assert.deepEqual(handStorage("function f() { indexedDB.open('d'); localStorage.removeItem('k'); localStorage.clear(); }"), ['indexedDB', 'localStorage.removeItem', 'localStorage.clear']);
  assert.equal(level(check(good()), 'hand-storage'), undefined);
});

test('static: the official privacy sentence is looked for (information); a missing <html lang> warns', () => {
  assert.equal(level(check(good()), 'html-lang'), undefined);
  assert.equal(level(check(variant(good(), /<html[^>]*>/.exec(good())[0], '<html>')), 'html-lang'), 'warn');
  // the privacy sentence: information only; found in the page (entities and line breaks allowed) or in the README
  const en = 'Data is end-to-end encrypted; the faculty holds a recovery key for emergencies.';
  const de = 'Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel.';
  assert.equal(level(check(good()), 'privacy-sentence'), 'info');
  assert.equal(level(check(variant(good(), '<body>', '<body><p>' + en.replace(' the faculty', '\n   the faculty') + '</p>')), 'privacy-sentence'), undefined);
  assert.equal(level(check(variant(good(), '<body>', '<body><p>' + de.replace('ü', '&uuml;') + '</p>')), 'privacy-sentence'), undefined);
  assert.equal(level(staticChecks(good(), HASHES, { readme: '# App\n\n' + de + '\n' }), 'privacy-sentence'), undefined);
  assert.equal(level(check(variant(good(), '<body>', '<body><p>Data is end-to-end encrypted.</p>')), 'privacy-sentence'), 'info');
  // the sentences are the ones of the guide the service serves
  const llms = readFileSync(join(ROOT, 'docs', 'site', 'llms.txt'), 'utf8');
  assert.ok(llms.includes(en) && llms.includes(de));
});

test('rewriteScopes: only the scope that WDS.connect uses is replaced; ordinary strings of the same shape stay', () => {
  const html = '<p>wds-verify-demo-k7m2a9</p><script>var a = WDS.connect({ scope: "wds-verify-demo-k7m2a9" }); var b = \'other-app-abcdef\'; var c = "not-a-scope"; document.getElementById("note-search").classList.add("text-center", "btn-danger");</script><script>var e = `x-iiiiii`;</script>';
  const { html: out, replaced, sites } = rewriteScopes(html, scanHtml(html).scripts, 'sandbox-000000');
  assert.deepEqual(replaced, ['wds-verify-demo-k7m2a9']);
  assert.equal(sites, 1);
  assert.equal(out, '<p>wds-verify-demo-k7m2a9</p><script>var a = WDS.connect({ scope: "sandbox-000000" }); var b = \'other-app-abcdef\'; var c = "not-a-scope"; document.getElementById("note-search").classList.add("text-center", "btn-danger");</script><script>var e = `x-iiiiii`;</script>');
});

test('rewriteScopes: a constant that holds the scope, the shorthand, several scripts; no connect call means no sites', () => {
  const html = '<script>const SCOPE = "myapp-k7m2a9"; const q = "page-header"; var s = WDS.connect({ scope: SCOPE, locale: f("btn-danger") });</script><script>const scope = \'second-abcdef\'; WDS.connect({ scope });</script>';
  const r = rewriteScopes(html, scanHtml(html).scripts, 'sandbox-000000');
  assert.deepEqual(r.replaced.sort(), ['myapp-k7m2a9', 'second-abcdef']);
  assert.equal(r.sites, 2);
  assert.ok(r.html.includes('"page-header"') && r.html.includes('f("btn-danger")'));
  const none = '<script>var a = "note-search"; WDS.connect({ scope: pickScope() });</script>';
  const r2 = rewriteScopes(none, scanHtml(none).scripts, 'sandbox-000000');
  assert.equal(r2.sites, 0);
  assert.equal(r2.html, none);
});

test('the engines floor is Node 22', () => {
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'tools', 'package.json'), 'utf8')).engines.node, '>=22');
});

test('command line: new flags are parsed; --target and --locale are validated', async () => {
  assert.deepEqual(parseArgs(['a', '--target', 'sandbox', '--locale=de-DE', '--sandbox-copy', 'x-sandbox.html']), { positional: ['a'], flags: { target: 'sandbox', locale: 'de-DE', 'sandbox-copy': 'x-sandbox.html' } });
  const dir = writeApp(good());
  assert.equal((await run('wds-verify.mjs', [dir, '--target', 'nope'])).code, 2);
  const loc = await run('wds-verify.mjs', [dir, '--static-only', '--locale', 'not a tag']);
  assert.equal(loc.code, 2);
  assert.match(loc.stderr, /BCP 47/);
  assert.equal((await run('wds-verify.mjs', [dir, '--static-only', '--locale', 'de-DE'])).code, 0);
  // wds-verify.json as a bare array: a usage error with the object form
  const bare = [{ click: '#a' }];
  bare.rawArray = true;   // written as it is, not wrapped into {steps}
  const arr = writeApp(good(), bare);
  const r = await run('wds-verify.mjs', [arr, '--static-only']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not a bare array/);
});

test('report: target line, and a "Not tested" section after "All checks" (also with --static-only), in JSON as well', async () => {
  const r = await run('wds-verify.mjs', [writeApp(good()), '--static-only']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /\nTarget: \*\*static\*\* \(chosen with --static-only\)\n/);
  const all = r.stdout.indexOf('## All checks'), nt = r.stdout.indexOf('## Not tested');
  assert.ok(all > 0 && nt > all);
  const section = r.stdout.slice(nt);
  for (const re of [/Everything the dynamic part checks was not run/, /second device and conflicts/i, /read-only member/, /Buttons the tool does not press/, /Fields in views no step opens/]) assert.match(section, re);
  const j = JSON.parse((await run('wds-verify.mjs', [writeApp(good()), '--static-only', '--json'])).stdout);
  assert.ok(j.notTested.length >= 5);
  assert.equal(j.target.name, 'static');
  // what the dynamic run saw is named
  const lines = notTested({ info: { unpressed: ['Delete all', 'Export'], fileInputs: 2, stepCount: { upload: 0 }, hiddenFields: 3, appDialogs: 1 }, config: { steps: [] }, html: '', target: { name: 'mock' } }).join('\n');
  assert.match(lines, /"Delete all", "Export"/);
  assert.match(lines, /File inputs \(2\) without an upload step/);
  assert.match(lines, /3 hidden field\(s\)/);
  assert.match(lines, /dialogs of its own/);
  assert.doesNotMatch(lines, /dynamic part checks was not run/);
});

test('hashes: from the service first, then the local clone; a difference is a warning; --hashes overrides; none at all is a usage error', async () => {
  const svc = await startStub({ '/client/hashes.json': HASHES, '/api/v1/scopes/wds-verify-demo-k7m2a9': scopeDoc() });
  try {
    const env = { WDS_VERIFY_OFFLINE: '', WDS_VERIFY_SERVICE: svc.url };
    const same = await verify(writeApp(good()), ['--static-only'].concat([]));   // offline default: local
    assert.match(same.find('hashes').detail, /the local clone/);
    assert.match(same.find('hashes').detail, /online lookup switched off/);
    const r = await run('wds-verify.mjs', [writeApp(good()), '--static-only', '--json'], { env });
    const f = JSON.parse(r.stdout).findings.find((x) => x.id === 'hashes');
    assert.equal(r.code, 0, r.stdout);
    assert.equal(f.level, 'info');
    assert.ok(f.detail.includes(svc.url + '/client/hashes.json'));
    assert.ok(svc.hits.includes('/client/hashes.json'));
  } finally { await svc.close(); }
  // the service has other hashes: they are used (the app's hash no longer matches), and the clone is called outdated
  const other = await startStub({ '/client/hashes.json': { [VERSION]: { sri: 'sha384-ZZZZ', frozen: true } } });
  try {
    const r = await run('wds-verify.mjs', [writeApp(good()), '--static-only', '--json'], { env: { WDS_VERIFY_OFFLINE: '', WDS_VERIFY_SERVICE: other.url } });
    const j = JSON.parse(r.stdout);
    assert.equal(r.code, 1);
    assert.equal(j.findings.find((x) => x.id === 'hashes').level, 'warn');
    assert.match(j.findings.find((x) => x.id === 'hashes').detail, /outdated/);
    assert.equal(j.findings.find((x) => x.id === 'library-integrity').level, 'fail');
  } finally { await other.close(); }
  // unreachable service: fall back to the clone without a failure
  const down = await run('wds-verify.mjs', [writeApp(good()), '--static-only', '--json'], { env: { WDS_VERIFY_OFFLINE: '', WDS_VERIFY_SERVICE: 'http://127.0.0.1:1/datastore' } });
  assert.equal(down.code, 0, down.stdout);
  assert.match(JSON.parse(down.stdout).findings.find((x) => x.id === 'hashes').detail, /local clone.*not reachable/);
  // a service without hashes.json answers a JSON error document: that is not a list of hashes, the clone is used
  const noHashes = await startStub({ '/client/hashes.json': () => [404, { error: 'not_found', message: 'Not found.' }], '/api/v1/scopes/wds-verify-demo-k7m2a9': scopeDoc() });
  try {
    const r = await run('wds-verify.mjs', [writeApp(good()), '--static-only', '--json'], { env: { WDS_VERIFY_OFFLINE: '', WDS_VERIFY_SERVICE: noHashes.url } });
    assert.equal(r.code, 0, r.stdout);
    const f = JSON.parse(r.stdout).findings;
    assert.match(f.find((x) => x.id === 'hashes').detail, /local clone.*answered HTTP 404/);
    assert.equal(f.find((x) => x.id === 'library-version').level, 'pass');
  } finally { await noHashes.close(); }
  // --hashes wins over the service
  const dir = tmpDirWith('{ "' + VERSION + '": { "sri": "sha384-QQ" } }');
  const forced = await run('wds-verify.mjs', [writeApp(good()), '--static-only', '--json', '--hashes', dir], {});
  assert.match(JSON.parse(forced.stdout).findings.find((x) => x.id === 'hashes').detail, /--hashes/);
  assert.equal(forced.code, 1);
  assert.equal((await run('wds-verify.mjs', [writeApp(good()), '--static-only', '--hashes', '/no/such/hashes.json'])).code, 2);
});
import { tmpDir } from './helpers.mjs';
function tmpDirWith(text) { const f = join(tmpDir(), 'hashes.json'); writeFileSync(f, text); return f; }

test('scope check: the real scope document: unknown scopes fail, limits and a paused scope are reported', async () => {
  const run1 = async (doc, html = good()) => {
    const svc = await startStub({ ['/api/v1/scopes/wds-verify-demo-k7m2a9']: doc === 404 ? () => [404, { error: 'not_found' }] : doc });
    try {
      const r = await run('wds-verify.mjs', [writeApp(html), '--static-only', '--json'], { env: { WDS_VERIFY_OFFLINE: '', WDS_VERIFY_SERVICE: svc.url, WDS_VERIFY_HASHES_URL: 'off' } });
      const j = JSON.parse(r.stdout);
      return { code: r.code, by: (id) => j.findings.find((x) => x.id === id) };
    } finally { await svc.close(); }
  };
  // the limits are reported; nothing else of the scope is judged (one fixed CSP, no breach-check setting, no enrollment mode)
  const ok = await run1(scopeDoc());
  assert.equal(ok.code, 0);
  assert.match(ok.by('scope-settings').detail, /limits.*1 MB per record, 50 MB per vault, 20 versions per record/);
  assert.doesNotMatch(ok.by('scope-settings').detail, /enrollment|breach/);
  assert.equal(ok.by('scope-hibp'), undefined);
  // unknown scope: FAIL
  const unknown = await run1(404);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.by('scope-unknown').level, 'fail');
  // a suspended scope: warning
  assert.equal((await run1(scopeDoc({ status: 'suspended' }))).by('scope-status').level, 'warn');
  // offline: an info line only
  const off = JSON.parse((await run('wds-verify.mjs', [writeApp(good()), '--static-only', '--json'])).stdout);
  assert.equal(off.findings.find((x) => x.id === 'scope-settings').level, 'info');
  assert.match(off.findings.find((x) => x.id === 'scope-settings').detail, /not checked/);
  const down = JSON.parse((await run('wds-verify.mjs', [writeApp(good()), '--static-only', '--json'], { env: { WDS_VERIFY_OFFLINE: '', WDS_VERIFY_SERVICE: 'http://127.0.0.1:1/datastore', WDS_VERIFY_HASHES_URL: 'off' } })).stdout);
  assert.match(down.findings.find((x) => x.id === 'scope-settings').detail, /not reachable/);
});

test('targets: --target auto without Python falls back to static checks with a warning; sandbox asked for but unavailable is exit 3', async () => {
  const dir = writeApp(good());
  const noPy = { WDS_PYTHON: '/nonexistent/python' };
  const auto = JSON.parse((await run('wds-verify.mjs', [dir, '--json', '--target', 'auto'], { env: noPy })).stdout);
  assert.equal(auto.target.name, 'static');
  assert.match(auto.target.reason, /^auto: no mock/);
  assert.equal(auto.findings.find((x) => x.id === 'dynamic-skipped').level, 'warn');
  // sandbox not reachable
  const down = { WDS_VERIFY_SERVICE: 'http://127.0.0.1:1/datastore' };
  const sb = await run('wds-verify.mjs', [dir, '--target', 'sandbox'], { env: down });
  assert.equal(sb.code, 3);
  assert.match(sb.stderr, /sandbox unavailable, not an app finding.*not reachable/);
  assert.equal((await run('wds-verify.mjs', [dir], { env: down })).code, 3);   // no --target: the sandbox is the default
  // auto with a reachable service but sandbox switched off: static, and the reason says why
  const off = await startStub({ '/api/v1/scopes/sandbox-000000': sandboxDoc({ sandbox: { enabled: false } }) });
  try {
    const r = JSON.parse((await run('wds-verify.mjs', [dir, '--json', '--target', 'auto'], { env: { ...noPy, WDS_VERIFY_OFFLINE: '', WDS_VERIFY_SERVICE: off.url, WDS_VERIFY_HASHES_URL: 'off' } })).stdout);
    assert.equal(r.target.name, 'static');
    assert.match(r.target.reason, /switched off/);
    const e = await run('wds-verify.mjs', [dir, '--target', 'sandbox'], { env: { WDS_VERIFY_SERVICE: off.url } });
    assert.equal(e.code, 3);
  } finally { await off.close(); }
  // --target mock without Python is a usage error (2), not a silent fallback
  assert.equal((await run('wds-verify.mjs', [dir, '--target', 'mock'], { env: noPy })).code, 2);
});

test('--sandbox-copy writes the app with the sandbox scope ID; the name must contain "sandbox"; nothing else changes', async () => {
  const svc = await startStub({ '/api/v1/scopes/sandbox-000000': sandboxDoc() });
  try {
    const dir = writeApp(good());
    const out = join(tmpDir(), 'shopping-sandbox.html');
    const env = { WDS_VERIFY_SERVICE: svc.url };
    const r = await run('wds-verify.mjs', [dir, '--sandbox-copy', out], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /wds-verify-demo-k7m2a9.*sandbox-000000/);
    const copy = readFileSync(out, 'utf8'), orig = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.equal(copy, orig.replace("scope: 'wds-verify-demo-k7m2a9'", "scope: 'sandbox-000000'"));
    // the static checks then fail the copy, as intended: it must never be shipped
    assert.equal(level(check(copy), 'sandbox-id'), 'fail');
    const bad = await run('wds-verify.mjs', [dir, '--sandbox-copy', join(tmpDir(), 'copy.html')], { env });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /must contain "sandbox"/);
    assert.equal((await run('wds-verify.mjs', [dir, '--sandbox-copy'], { env })).code, 2);
    const none = await run('wds-verify.mjs', [writeApp(variant(good(), "scope: 'wds-verify-demo-k7m2a9'", 'scope: scopeFromElsewhere')), '--sandbox-copy', join(tmpDir(), 'x-sandbox.html')], { env });
    assert.equal(none.code, 2);
    assert.match(none.stderr, /found no WDS\.connect\(\{ scope: "\.\.\." \}\) with a literal scope ID/);
    // ordinary strings with the shape of a scope ID (element IDs, class names) are not touched
    const decoy = writeApp(variant(good(), "scope: 'wds-verify-demo-k7m2a9'", "scope: 'wds-verify-demo-k7m2a9', note: 'page-header'"));
    const decoyOut = join(tmpDir(), 'decoy-sandbox.html');
    assert.equal((await run('wds-verify.mjs', [decoy, '--sandbox-copy', decoyOut], { env })).code, 0);
    assert.ok(readFileSync(decoyOut, 'utf8').includes("note: 'page-header'"));
  } finally { await svc.close(); }
  const down = await run('wds-verify.mjs', [writeApp(good()), '--sandbox-copy', join(tmpDir(), 'a-sandbox.html')], { env: { WDS_VERIFY_SERVICE: 'http://127.0.0.1:1/datastore' } });
  assert.equal(down.code, 3);
});

test('static-only runs from a copy of tools/ alone (no client directory, no node_modules, no Python): hashes come from the service', async () => {
  const { cpSync } = await import('node:fs');
  const dir = tmpDir('wds-tools-copy-');
  for (const f of ['wds-verify.mjs', 'lib']) cpSync(join(ROOT, 'tools', f), join(dir, f), { recursive: true });
  const svc = await startStub({ '/client/hashes.json': HASHES, '/api/v1/scopes/wds-verify-demo-k7m2a9': scopeDoc() });
  try {
    const { spawn } = await import('node:child_process');
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(dir, 'wds-verify.mjs'), writeApp(good()), '--static-only', '--json'],
        { env: { ...process.env, WDS_VERIFY_SERVICE: svc.url, WDS_VERIFY_OFFLINE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(out.code, 0, out.stdout + out.stderr);
    const j = JSON.parse(out.stdout);
    assert.match(j.findings.find((f) => f.id === 'hashes').detail, /client\/hashes\.json/);
    assert.equal(j.findings.find((f) => f.id === 'scope-settings').level, 'info');
  } finally { await svc.close(); }
});

// ---- round F: named functions, store.migrateLocal, hand-made migrations, app modals, the breach-check sentence ----
import { usesMigrateLocal, usesShowModal } from '../lib/static-checks.mjs';

test('static: store.migrateLocal is recognised; strings and comments do not count', () => {
  const MIG = "store.migrateLocal({ id: 'literatur', indexedDB: { literatur: ['refs'] }, map: function (old, ref) { return []; } });";
  const r = check(withScript(MIG));
  assert.equal(level(r, 'migrate-local'), 'info');
  assert.equal(level(r, 'hand-storage'), undefined);
  assert.deepEqual(r.findings.filter((f) => f.level === 'fail' || f.level === 'warn'), []);
  assert.ok(usesMigrateLocal(MIG));
  assert.ok(!usesMigrateLocal("var s = 'store.migrateLocal(x)';"));
  assert.ok(!usesMigrateLocal('/* store.migrateLocal(x) */ var a = 1;'));
  // a hand-made migration next to it still warns, and says where the library does the job
  const both = check(withScript(MIG + "\nfunction drop() { localStorage.removeItem('old'); }"));
  assert.equal(level(both, 'hand-storage'), 'warn');
  assert.match(both.findings.find((f) => f.id === 'hand-storage').detail, /store\.migrateLocal \(porting\.md\)/);
  const commented = check(withScript("// later: store.migrateLocal(opts)\nfunction readOld() { return indexedDB.open('old'); }"));
  assert.equal(level(commented, 'hand-storage'), 'warn');
  assert.equal(level(commented, 'migrate-local'), undefined);
  for (const id of ['hand-storage', 'migrate-local', 'app-modals']) assert.equal(level(check(good()), id), undefined, id);
});

test('static: an app that opens modal dialogs with showModal() gets the information about library dialogs above them', () => {
  const r = check(withScript("document.getElementById('d').showModal();"));
  assert.equal(level(r, 'app-modals'), 'info');
  assert.match(r.findings.find((f) => f.id === 'app-modals').detail, /Library dialogs open above your own modal dialogs.*dialog:not\(\.wds-dialog\)/);
  assert.equal(level(check(withScript("var s = 'x.showModal()'; // d.showModal()")), 'app-modals'), undefined);
  assert.ok(usesShowModal('dlg . showModal ( )'));
});

test('the breach check needs no sentence in the app: the policy has no second host and the report has no breach-check finding', async () => {
  assert.doesNotMatch(CSP_TEMPLATE, /pwnedpasswords/);
  const r = await run('wds-verify.mjs', [writeApp(good()), '--static-only', '--json'], { env: { WDS_VERIFY_OFFLINE: '1', WDS_VERIFY_HASHES_URL: 'off' } });
  const ids = JSON.parse(r.stdout).findings.map((f) => f.id);
  assert.ok(!ids.includes('breach-check-note') && !ids.includes('scope-hibp'), ids.join(','));
});

test('--script-tag prints the complete tag with the onerror handler of the documentation, the CSP and its place; --scope-check off skips the scope check', async () => {
  const { ONERROR } = await import('../lib/static-checks.mjs');
  const py = readFileSync(join(ROOT, 'server', 'wds_server', 'docs.py'), 'utf8');
  assert.equal(/^ONERROR = "(.*)"$/m.exec(py)[1], ONERROR, 'the tool prints the onerror text of docs.py');
  const r = await run('wds-verify.mjs', ['--script-tag', '--hashes', join(ROOT, 'client', 'dist', 'hashes.json')]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('onerror="' + ONERROR + '"></script>'), r.stdout);
  assert.match(r.stdout, /right after <meta charset>, before any script/);
  const dir = writeApp(good());
  const off = await run('wds-verify.mjs', [dir, '--static-only', '--json', '--scope-check', 'off'], { env: { WDS_VERIFY_OFFLINE: '' , WDS_VERIFY_HASHES_URL: 'off' } });
  const j = JSON.parse(off.stdout);
  assert.match(j.findings.find((f) => f.id === 'scope-settings').detail, /--scope-check off/);
});
