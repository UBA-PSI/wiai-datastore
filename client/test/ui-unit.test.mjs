// Unit tests of the pure parts of wds-ui.js (passphrase rules, ZIP writer, texts, access sheet) and of build.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { build } from '../build.mjs';

const require = createRequire(import.meta.url);
const WDS = require('../src/wds-ui.js');
const I = WDS.internals;
const uiSource = readFileSync(new URL('../src/wds-ui.js', import.meta.url), 'utf8');
const tempDirs = [];
const mkTemp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); tempDirs.push(d); return d; };
after(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('English and German texts have the same keys and the same placeholders', () => {
  const en = Object.keys(I.TEXT.en), de = Object.keys(I.TEXT.de);
  assert.deepEqual(en.filter((k) => !(k in I.TEXT.de)), []);
  assert.deepEqual(de.filter((k) => !(k in I.TEXT.en)), []);
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
  for (const k of en) assert.equal(ph(I.TEXT.en[k]), ph(I.TEXT.de[k]), k);
  for (const lang of ['en', 'de']) for (const k of Object.keys(I.TEXT[lang])) assert.ok(I.TEXT[lang][k].trim().length > 0, lang + ' ' + k);
});

test('the user documentation uses the names that the dialogs show', () => {
  const doc = (n) => readFileSync(new URL('../../docs/site/' + n, import.meta.url), 'utf8');
  for (const [lang, file] of [['de', 'users.de.md'], ['en', 'users.en.md']]) {
    const text = doc(file), T = I.TEXT[lang];
    for (const key of ['role.write', 'role.read', 'share.recovery.cancel', 'conflict.keepTheirs', 'conflict.keepMine', 'share.recovered.title']) {
      assert.ok(text.includes(T[key]), file + ' names "' + T[key] + '" (' + key + ')');
    }
    assert.ok(/Wiederherstellungsschlüssel|recovery key/.test(text), file);
    assert.ok(text.includes(T['sheet.recovery']), file + ' names the emergency code as the dialogs do');
    assert.ok(!/Wiederherstellungscode|recovery code|Schlüsseldatei|key file/i.test(text), file + ' still uses a removed or renamed word');
  }
  assert.ok(!/"/.test(doc('users.de.md').replace(/`[^`]*`/g, '')), 'German pages use „…“, not straight quotes');
});

test('language detection and text lookup', () => {
  // <html lang> decides; without it navigator.language
  const lang = (attr) => { globalThis.document = { documentElement: { getAttribute: () => attr } }; try { return I.detectLang(); } finally { delete globalThis.document; } };
  assert.equal(lang('de-AT'), 'de');
  assert.equal(lang('DE'), 'de');
  assert.equal(lang('en-US'), 'en');
  assert.equal(lang('fr'), 'en');
  assert.equal(lang('fr'), 'en', 'a lang attribute that is not German means English, whatever the browser speaks');
  assert.equal(typeof I.detectLang(), 'string');   // no document (Node): navigator.language
  assert.equal(I.makeT('de')('unlock.title'), 'Daten entsperren');
  assert.equal(I.makeT('en')('pw.tooShort', { n: 5 }), 'At least 12 characters are required (5 so far).');
  assert.equal(I.makeT('en')('no.such.key'), 'no.such.key');
});

test('passphrase rules: length, common passwords, estimate', () => {
  const bad = { short: 'abc', passwordpassword: 'passwordpassword', password1234: 'password1234', qwertz: 'qwertzuiop12', repeat: 'aaaaaaaaaaaa', seq: 'abcdefghijkl', summer: 'Sommer2024!!', leet: 'P@ssw0rd1234' };
  assert.equal(I.checkLocal(bad.short).code, 'short');
  assert.equal(I.checkLocal(bad.short).n, 3);
  assert.equal(I.checkLocal('').code, 'empty');
  for (const k of ['passwordpassword', 'password1234', 'qwertz', 'repeat', 'seq', 'summer', 'leet']) {
    const r = I.checkLocal(bad[k]);
    assert.equal(r.ok, false, k);
    assert.ok(r.code === 'common' || r.code === 'weak', k + ' ' + r.code);
  }
  for (const good of ['correct horse battery staple', 'purple-elephant-marching-slowly', 'Blau-Kuchen-Fahrrad-Wolke', 'k7Qm#x2Lp9vZ']) assert.equal(I.checkLocal(good).ok, true, good);
  assert.equal(I.checkLocal('correct horse battery staple').estimate.score, 4);
  assert.ok(I.estimate('x').bits < I.estimate('xK9#mQ2$vL7!').bits);
  assert.equal(I.checkLocal('twelve chars!').n, undefined);
  // unicode: 12 code points count, not UTF-16 units
  assert.equal(I.checkLocal('😀😀😀😀😀😀').code, 'short');
});

test('passphrase rules: well-known German passphrases are refused locally, and a missing breach check makes the rules stricter', async () => {
  // these passed the local check once and were stopped only by the online breach check (ichliebedich123: 17075 hits)
  for (const weak of ['ichliebedich123', 'IchLiebeDich2024', 'Fussball2024!!!!', 'hallo123456789', 'Sonnenschein99', 'mamaundpapa123', 'Passwort123456789', 'wirliebenunsere', 'Sommer2024!!']) {
    const r = I.checkLocal(weak);
    assert.equal(r.ok, false, weak);
    assert.ok(r.code === 'common' || r.code === 'weak', weak + ' ' + r.code);
  }
  assert.equal(I.checkLocal('Ich-Liebe-Dich-123!').ok, false);          // the usual decorations do not help
  // between the usual limit and the strict one: fine with a breach check, refused without
  const middling = 'meinhundheisstmax';
  assert.equal(I.checkLocal(middling).ok, true);
  const strict = I.checkLocal(middling, true);
  assert.equal(strict.ok, false);
  assert.equal(strict.code, 'weak');
  assert.equal(strict.strict, true);
  assert.equal(I.checkLocal('purple-elephant-marching-slowly', true).ok, true);
  assert.equal(I.checkLocal('Blau-Kuchen-Fahrrad-Wolke', true).ok, true);
  assert.ok(I.TEXT.de['pw.weak.noBreachCheck'] && I.TEXT.en['pw.weak.noBreachCheck']);
});

test('breach check: asks the service with a 5 character prefix, ignores padding rows, reports "unavailable" instead of failing', async () => {
  const pass = 'a-very-pwned-passphrase';
  const url = 'https://wiai.test/datastore/api/v1/pwned/';
  const sha1 = createHash('sha1').update(pass).digest('hex').toUpperCase();
  const calls = [];
  const fetchOk = async (u2, init) => {
    calls.push({ url: u2, init });
    const lines = ['0018A45C4D1DEF81644B54AB7F969B88D65:0', sha1.slice(5) + ':1234', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0'];
    return new Response(lines.join('\r\n'), { status: 200 });
  };
  const hit = await I.breachCheck(pass, { fetch: fetchOk, url });
  assert.deepEqual(hit, { status: 'pwned', count: 1234 });
  assert.equal(calls[0].url, url + sha1.slice(0, 5));
  assert.equal(calls[0].init.credentials, 'omit');
  assert.ok(!calls[0].url.includes(sha1.slice(5)));
  // a padding entry for our own suffix (count 0) is not a hit
  const padded = await I.breachCheck(pass, { url, fetch: async () => new Response(sha1.slice(5) + ':0\r\n', { status: 200 }) });
  assert.equal(padded.status, 'ok');
  assert.equal((await I.breachCheck('purple-elephant-marching-slowly', { url, fetch: async () => new Response('', { status: 200 }) })).status, 'ok');
  // the service cannot be reached, or answers 503 (its server has no outbound access): the caller falls back to the strict rules
  assert.equal((await I.breachCheck(pass, { url, fetch: async () => { throw new TypeError('offline'); } })).status, 'unavailable');
  assert.equal((await I.breachCheck(pass, { url, fetch: async () => new Response('no', { status: 503 }) })).status, 'unavailable');
  assert.equal((await I.breachCheck(pass, { fetch: fetchOk })).status, 'unavailable');   // no endpoint, no request
});

test('crc32 matches the standard check value', () => {
  assert.equal(I.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(I.crc32(new Uint8Array(0)), 0);
});

test('ZIP writer produces archives that unzip accepts (UTF-8 names, empty and binary entries)', async () => {
  const bin = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 255);
  const blob = I.makeZip([
    { name: 'a.txt', data: 'hello' }, { name: 'dir/ü ö.json', data: '{"k":1}' }, { name: 'empty', data: new Uint8Array(0) }, { name: 'bin/data.bin', data: bin },
  ], new Date(2026, 5, 7, 8, 9, 10));
  const dir = mkTemp('wds-zip-');
  const file = join(dir, 'x.zip');
  writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  assert.match(execFileSync('unzip', ['-t', file]).toString(), /No errors detected/);
  assert.equal(execFileSync('unzip', ['-p', file, 'a.txt']).toString(), 'hello');
  // unzip on macOS cannot match non-ASCII names on the command line; Python's zipfile checks the UTF-8 flag and names
  const py = execFileSync('python3', ['-I', '-c', 'import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps([z.namelist(),z.read(z.namelist()[1]).decode()],ensure_ascii=False))', file]).toString();
  assert.deepEqual(JSON.parse(py), [['a.txt', 'dir/ü ö.json', 'empty', 'bin/data.bin'], '{"k":1}']);
  assert.deepEqual([...execFileSync('unzip', ['-p', file, 'bin/data.bin'])], [...bin]);
  assert.match(execFileSync('unzip', ['-l', file]).toString(), /4 files/);
});

test('archive paths: folders kept, .json added, collisions and traversal handled', () => {
  const recs = [
    { name: 'a', kind: 'json' }, { name: 'a.json', kind: 'bytes' }, { name: 'files/x.pdf', kind: 'bytes' }, { name: '../../etc/passwd', kind: 'bytes' },
    { name: '/abs/path', kind: 'json' }, { name: 'README.txt', kind: 'bytes' }, { name: 'wds-export', kind: 'json' }, { name: 'a<b>:c', kind: 'bytes' },
  ];
  const p = I.archivePaths(recs, ['wds-export.json', 'README.txt']);
  assert.deepEqual(p, ['a.json', 'a (2).json', 'files/x.pdf', '_/_/etc/passwd', '_/abs/path.json', 'README (2).txt', 'wds-export (2).json', 'a_b__c']);
  assert.equal(new Set(p.map((x) => x.toLowerCase())).size, p.length);
  assert.equal(I.markedName('files/report.pdf', 'mine', 'bytes'), 'files/report.mine.pdf');
  assert.equal(I.markedName('note', 'theirs', 'json'), 'note.theirs.json');
  assert.equal(I.markedName('note.json', 'mine', 'json'), 'note.mine.json');
});

test('archive paths: a file without an ending gets one that matches its MIME type', () => {
  const recs = [
    { name: 'covers/af159a0f', kind: 'bytes', mime: 'image/jpeg' }, { name: 'covers/af159a0f.jpg', kind: 'bytes', mime: 'image/jpeg' },
    { name: 'doc', kind: 'bytes', mime: 'application/pdf; charset=binary' }, { name: 'blob', kind: 'bytes', mime: 'application/octet-stream' },
    { name: 'raw', kind: 'bytes' }, { name: 'notes/x', kind: 'bytes', mime: 'TEXT/Plain' }, { name: 'v1.2', kind: 'bytes', mime: 'image/png' },
    { name: 'dir.d/pic', kind: 'bytes', mime: 'image/png' }, { name: 'data', kind: 'json', mime: 'image/png' },
  ];
  assert.deepEqual(I.archivePaths(recs, []), ['covers/af159a0f.jpg', 'covers/af159a0f (2).jpg', 'doc.pdf', 'blob', 'raw', 'notes/x.txt', 'v1.2', 'dir.d/pic.png', 'data.json']);
  const arc = I.buildArchive([{ name: 'covers/af159a0f', kind: 'bytes', mime: 'image/jpeg', value: Uint8Array.of(255, 216), version: 1, time: 1 }],
    { scope: 's-k7m2a9', service: 'https://x/', exported: new Date(0).toISOString() });
  assert.equal(arc.manifest.records[0].name, 'covers/af159a0f');
  assert.equal(arc.manifest.records[0].file, 'covers/af159a0f.jpg');
});

test('export archive: manifest lists every record; the ZIP is valid', async () => {
  const when = new Date('2026-01-02T03:04:05Z').toISOString();
  const arc = I.buildArchive([
    { name: 'settings', kind: 'json', value: { a: [1, 2] }, version: 3, time: 1700000000000 },
    { name: 'files/pic.png', kind: 'bytes', mime: 'image/png', value: Uint8Array.of(137, 80, 78, 71), version: 1, time: 1700000000001 },
  ], { scope: 'testapp-k7m2a9', service: 'https://wiai.test/datastore/', exported: when });
  assert.equal(arc.manifest.records.length, 2);
  assert.deepEqual(arc.manifest.records[1], { name: 'files/pic.png', file: 'files/pic.png', kind: 'bytes', mime: 'image/png', version: 1, time: 1700000000001, size: 4 });
  const dir = mkTemp('wds-exp-');
  const file = join(dir, 'e.zip');
  writeFileSync(file, Buffer.from(await arc.blob.arrayBuffer()));
  assert.match(execFileSync('unzip', ['-t', file]).toString(), /No errors detected/);
  assert.deepEqual(JSON.parse(execFileSync('unzip', ['-p', file, 'settings.json']).toString()), { a: [1, 2] });
  assert.equal(JSON.parse(execFileSync('unzip', ['-p', file, 'wds-export.json']).toString()).scope, 'testapp-k7m2a9');
});

test('access sheet HTML escapes values and only shows the emergency code when there is one', () => {
  const t = I.makeT('en');
  const html = I.buildSheetHtml({ appName: '<script>alert(1)</script>', scope: 'x-k7m2a9', accessId: 'AAAA-BBBB-CCCC-DDDD-EEEE', recoveryCode: '1111-2222', service: 'https://wiai.test/datastore/', created: 1700000000000, role: 'owner' }, t, 'en');
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('1111-2222') && html.includes('AAAA-BBBB-CCCC-DDDD-EEEE'));
  assert.ok(html.includes(I.TEXT.en['escrow.text']) && html.includes('Emergency code'));
  const member = I.buildSheetHtml({ appName: 'App', scope: 'x-k7m2a9', accessId: 'AAAA-BBBB-CCCC-DDDD-EEEE', recoveryCode: null, service: 's', created: 0, role: 'write' }, I.makeT('de'), 'de');
  assert.ok(!member.includes('Notfallcode</th>'));
  assert.ok(member.includes('lang="de"'));
});

test('wds-ui.js: ES2020 only, no HTML injection or dynamic code, no passphrase logging', () => {
  const src = strip(uiSource);
  for (const [re, what] of [[/\?\?=|\|\|=|&&=/, 'logical assignment'], [/\.at\(/, 'Array.at'], [/\.replaceAll\(/, 'replaceAll'], [/structuredClone/, 'structuredClone'], [/#[a-zA-Z_]+\s*[=(;]/, 'private fields'], [/Object\.hasOwn\(/, 'Object.hasOwn'], [/\.findLast\(/, 'findLast'], [/static\s*\{/, 'static blocks']]) {
    assert.ok(!re.test(src), 'uses ' + what);
  }
  for (const [re, what] of [[/innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'HTML injection'], [/\beval\s*\(|new Function\s*\(/, 'dynamic code'], [/console\.(log|info|debug)/, 'console output'], [/shadowRoot|attachShadow/, 'Shadow DOM']]) {
    assert.ok(!re.test(src), 'uses ' + what);
  }
});

function tempProject() {
  const root = mkTemp('wds-build-');
  const client = new URL('..', import.meta.url).pathname;
  cpSync(join(client, 'src'), join(root, 'src'), { recursive: true });
  cpSync(join(client, 'vendor'), join(root, 'vendor'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '2.3.4' }));
  return root;
}

test('build: bundle order, version, pins, SRI file, hashes.json, and freezing', async () => {
  const root = tempProject();
  const pins = ['A'.repeat(43), 'B'.repeat(43)];
  const r = build({ root, escrowPins: pins });
  assert.equal(r.version, '2.3.4');
  const bytes = readFileSync(r.file);
  assert.equal(r.file.endsWith('wds-2.3.4.js'), true);
  assert.equal(readFileSync(r.file + '.sri', 'utf8'), 'sha384-' + createHash('sha384').update(bytes).digest('base64'));
  const hashes = JSON.parse(readFileSync(join(root, 'dist', 'hashes.json'), 'utf8'));
  assert.equal(hashes['2.3.4'].sri, r.sri);
  assert.deepEqual(hashes['2.3.4'].escrow_pins, pins);
  const text = bytes.toString('utf8');
  assert.ok(text.indexOf('hash-wasm') < text.indexOf('wds-core.js - WIAI') && text.indexOf('wds-core.js - WIAI') < text.indexOf('wds-ui.js - WIAI'));
  // runs as a classic script, with the version and the pins filled in
  const ctx = { crypto: webcrypto, TextEncoder, TextDecoder, WebAssembly, console, setTimeout, clearTimeout, queueMicrotask, URL, Blob, fetch: () => {} };
  vm.createContext(ctx);
  vm.runInContext(text, ctx);
  assert.equal(vm.runInContext('WDSCore.version + " " + WDS.version + " " + typeof WDS.connect + " " + typeof hashwasm', ctx), '2.3.4 2.3.4 function undefined');
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(new WDSCore.Client({scope: "x-k7m2a9"}).escrowPins)', ctx)), pins);
  // deterministic
  assert.equal(build({ root, escrowPins: pins }).sri, r.sri);
  // frozen versions refuse different bytes
  build({ root, escrowPins: pins, freeze: true });
  writeFileSync(join(root, 'src', 'wds-ui.js'), uiSource + '\n// changed\n');
  assert.throws(() => build({ root, escrowPins: pins }), /frozen/);
  assert.notEqual(build({ root, escrowPins: pins, force: true }).sri, r.sri);
  assert.throws(() => build({ root, escrowPins: ['short'] }), /43-character/);
  assert.throws(() => build({ root, escrowPins: [pins[0]] }), /2 pins/);
  assert.throws(() => build({ root, escrowPins: pins, retiredEscrow: [{ id: pins[0], until: 5 }] }), /both pinned and retired/);
  assert.throws(() => build({ root, escrowPins: pins, retiredEscrow: [{ id: 'C'.repeat(43), until: 'soon' }] }), /until/);
});

// Review finding: the production bundle exposed test hooks, read the global hashwasm on every call, depended on the page's
// AMD loader being absent, and let app code replace the pinned escrow keys.
test('production bundle: no test hooks, private hash-wasm, works beside an AMD loader, pins fixed by the build', async () => {
  const root = tempProject();
  const pins = ['A'.repeat(43), 'B'.repeat(43)], retired = [{ id: 'C'.repeat(43), until: 1234567 }];
  const r = build({ root, escrowPins: pins, retiredEscrow: retired });
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'dist', 'hashes.json'), 'utf8'))['2.3.4'].retired_escrow, retired);
  const text = readFileSync(r.file, 'utf8');
  const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
  const mkCtx = (extra) => {
    const c = Object.assign({ crypto: webcrypto, TextEncoder, TextDecoder, WebAssembly, console: { warn() {}, error() {} }, setTimeout, clearTimeout, queueMicrotask, URL, Blob, Response, fetch: () => {} }, extra);
    return vm.createContext(c);
  };

  // no hooks that could weaken the randomness or hand over the passphrase, no global hash-wasm
  const ctx = mkCtx({});
  vm.runInContext(text, ctx);
  assert.equal(vm.runInContext('[typeof WDSCore.setRandom, typeof WDSCore.setArgon2, typeof WDSCore.internals, typeof hashwasm, Object.isFrozen(WDSCore)].join(" ")', ctx), 'undefined undefined undefined undefined true');
  assert.equal(vm.runInContext('JSON.stringify(Object.keys(WDS.internals.testHooks))', ctx), '[]');   // the hooks of the library's own tests (the focus check at once) are only in the test bundles
  assert.equal(build({ root, escrowPins: pins, retiredEscrow: retired, testHooks: true }).sri !== r.sri, true);

  // the pinned escrow keys cannot be replaced by app code, neither through WDS.connect nor through the core
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(new WDSCore.Client({ scope: "x-k7m2a9", escrowPins: ["Z".repeat(43)], retiredEscrow: [] }).escrowPins)', ctx)), pins);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(new WDSCore.Client({ scope: "x-k7m2a9", retiredEscrow: [] }).retiredEscrow)', ctx)), retired);

  // a page with an AMD loader: define() is not called, module.exports stays untouched, the globals are still set
  const calls = [];
  const amd = mkCtx({ define: Object.assign((...a) => calls.push(a), { amd: {} }), module: { exports: {} }, exports: {} });
  vm.runInContext(text, amd);
  assert.equal(calls.length, 0);
  assert.equal(vm.runInContext('typeof WDSCore.Client + " " + typeof WDS.connect + " " + Object.keys(module.exports).length + " " + Object.keys(exports).length + " " + typeof hashwasm', amd), 'function function 0 0 undefined');

  // Argon2id runs inside the bundle (the token in the Authorization header is derived from the vector KEK), also when the page
  // has its own hashwasm and replaces it later: that object is neither read nor called
  const { I: CI } = await import('./helpers.mjs');
  const accessId = await CI.randomAccessId();
  const headers = [];
  const spy = { argon2id() { throw new Error('the page hashwasm must not be used'); } };
  const page = mkCtx({ hashwasm: spy });
  page.accessId = accessId; page.kdf = V.argon2id.kdf; page.pass = V.argon2id.passphrase_nfd;
  page.fetch = async (url, init) => {
    if (/\/kdf$/.test(url)) return new Response(JSON.stringify({ kind: 'passphrase', kdf: V.argon2id.kdf }), { status: 200 });
    headers.push(init.headers.Authorization);
    return new Response(JSON.stringify({ error: 'unauthorized', message: 'no' }), { status: 401 });
  };
  vm.runInContext(text, page);
  page.hashwasm = spy;
  const unlock = vm.runInContext('new WDSCore.Client({ scope: "x-k7m2a9", fetch: fetch, storage: { getItem() { return null; }, setItem() {}, removeItem() {} } }).unlock({ accessId: accessId, passphrase: pass }).then(function () { return "unlocked"; }, function (e) { return e.name + ": " + e.message; })', page);
  assert.match(await unlock, /^AuthError: /);
  const token = (await CI.deriveSlotKeys(CI.unhex(V.argon2id.kek_hex))).token;
  assert.equal(headers[0], CI.bearerHeader(accessId, token));
});
