// Low-level building blocks: strict codecs, envelopes, record plaintexts, UMD loading.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { core, I, rejects, seq } from './helpers.mjs';

test('base64url: round trips, rejects padding, bad characters, non-canonical tails and bad lengths', () => {
  for (let n = 0; n < 40; n++) {
    const b = I.randomBytes(n), s = I.b64u(b);
    assert.ok(!/[=+/]/.test(s));
    assert.deepEqual(I.b64uDecode(s), b);
    assert.deepEqual(I.b64uDecode(s, n), b);
  }
  assert.equal(I.b64u(new Uint8Array([0xfb, 0xff])), '-_8');
  assert.deepEqual(Array.from(I.b64uDecode('-_8')), [0xfb, 0xff]);
  for (const bad of ['QQ==', 'Q', 'QR', 'QQR=', 'a+b/', 'ab cd', 'ab\ncd', 'ä', 'QUJDRA=', '-_9']) assert.throws(() => I.b64uDecode(bad), core.errors.IntegrityError, bad);
  assert.throws(() => I.b64uDecode('QQ', 2), core.errors.IntegrityError); // wrong decoded length
  assert.deepEqual(Array.from(I.b64uDecode('QQ')), [0x41]);
});

test('b32c: check bits catch typos; all lengths used in the protocol round-trip', async () => {
  for (const n of [12, 17]) for (let i = 0; i < 20; i++) {
    const b = I.randomBytes(n), s = await I.b32cEncode(b);
    assert.equal(s.length, n === 12 ? 20 : 28);
    assert.deepEqual(await I.b32cDecode(s, n), b);
  }
  const good = await I.b32cEncode(seq(12, 5));
  let undetected = 0, total = 0;
  for (let i = 0; i < good.length; i++) for (const c of '0123456789ABCDEFGHJKMNPQRSTVWXYZ') {
    if (c === good[i]) continue;
    total++;
    try { await I.b32cDecode(good.slice(0, i) + c + good.slice(i + 1), 12); undetected++; } catch (e) { /* detected */ }
  }
  // 4 check bits: at most about 1/16 of single-symbol substitutions inside the data pass by chance
  assert.ok(undetected / total < 0.1, undetected + '/' + total);
  await rejects(I.b32cDecode(good, 17), core.errors.UsageError);
  assert.equal(core.classifyCode('abc'), 'unknown');
  assert.equal(core.classifyCode('U'.repeat(20)), 'unknown');
});

test('cjson: encoder rules', () => {
  for (const bad of [1.5, -1, NaN, Infinity, 2 ** 53, undefined, 1n, new Date(0), () => 1, 'é', 'a"b', 'a\\b', 'tab\t', { a: undefined }, { 'k"': 1 }, [undefined]]) {
    assert.throws(() => I.cjson(bad), core.errors.UsageError, String(bad));
  }
  assert.equal(I.cjson({ b: [1, true, null], a: 'x' }), '{"a":"x","b":[1,true,null]}');
  assert.equal(I.cjson(Object.create(null)), '{}');
  assert.equal(I.cjson(0), '0');
  assert.throws(() => I.cjson(Object.is(-0, -0) ? -0 : 0), core.errors.UsageError);
  assert.throws(() => I.cjsonParse('{"a":1}x'), core.errors.IntegrityError);
  assert.throws(() => I.cjsonParse('[' .repeat(40) + ']'.repeat(40)), core.errors.IntegrityError);
  assert.throws(() => I.cjsonParse('{"a":01}'), core.errors.IntegrityError);
  assert.deepEqual(I.cjsonParse('{"a":[1,{"b":null}],"c":false}'), { a: [1, { b: null }], c: false });
});

test('padme: never shrinks, bounded overhead, idempotent', () => {
  for (let L = 1; L < 5000; L++) {
    const p = I.padme(L);
    assert.ok(p >= L);
    assert.equal(I.padme(p), p);
    if (L > 64) assert.ok(p / L <= 1.125, L + ' -> ' + p);
  }
  assert.throws(() => I.padme(0), core.errors.UsageError);
});

test('envelope parsing: magic, type, flags, epoch, lengths', async () => {
  const nonce = seq(12, 0), good = await I.sealEnvelope(await I.aesKey(seq(32, 0)), 1, 5, seq(30, 0), new Uint8Array(0), nonce);
  assert.equal(I.parseEnvelope(good, 1).epoch, 5);
  const mut = (f) => { const b = new Uint8Array(good); f(b); return b; };
  assert.throws(() => I.parseEnvelope(mut((b) => { b[0] = 0x58; }), 1), core.errors.IntegrityError);
  assert.throws(() => I.parseEnvelope(good, 2), core.errors.IntegrityError);
  assert.throws(() => I.parseEnvelope(mut((b) => { b[5] = 1; }), 1), core.errors.IntegrityError);
  assert.throws(() => I.parseEnvelope(good.subarray(0, 37), 1), core.errors.IntegrityError);
  assert.throws(() => I.parseEnvelope(good, 1, 40), core.errors.IntegrityError);
  const slot = await I.sealEnvelope(await I.aesKey(seq(32, 0)), 2, 0, seq(20, 0), new Uint8Array(0), nonce);
  assert.throws(() => I.parseEnvelope(mut.call(null, (b) => b) && new Uint8Array([...slot.subarray(0, 6), 0, 0, 0, 1, ...slot.subarray(10)]), 2), core.errors.IntegrityError); // epoch must be 0
  assert.throws(() => I.parseEnvelope(new Uint8Array(5000), 2), core.errors.IntegrityError);
  const ring = await I.eciesSeal({ recipientPub: (await I.generateKeyPair('E')).pub, plaintext: seq(10, 0), aadTail: new Uint8Array(0) });
  assert.equal(I.parseEnvelope(ring, 3).eph.length, 65);
  assert.throws(() => I.parseEnvelope(ring.subarray(0, 102), 3), core.errors.IntegrityError);
  assert.throws(() => I.parseEnvelope(mut.call(null, () => new Uint8Array([...ring.subarray(0, 10), 5, ...ring.subarray(11)])), 3), core.errors.IntegrityError);
});

test('ECIES: only the intended recipient can open; AAD is bound', async () => {
  const r = await I.generateKeyPair('E'), other = await I.generateKeyPair('E');
  const aad = seq(20, 1);
  const env = await I.eciesSeal({ recipientPub: r.pub, plaintext: I.utf8('hello'), aadTail: aad });
  const open = async (kp, a) => I.eciesOpen({ recipientPriv: await I.importPrivate('E', kp.d, kp.pub), recipientPub: kp.pub, envelope: env, aadTail: a });
  assert.equal(new TextDecoder().decode(await open(r, aad)), 'hello');
  await rejects(open(other, aad), core.errors.IntegrityError);
  await rejects(open(r, seq(20, 2)), core.errors.IntegrityError);
  assert.notDeepEqual(await I.eciesSeal({ recipientPub: r.pub, plaintext: I.utf8('hello'), aadTail: aad }), env); // fresh ephemeral key and nonce
});

test('record plaintext: layout, padding checks, name check, size limits', () => {
  const body = I.utf8('{"a":1}');
  const built = I.buildRecordPlaintext('n', 'json', body, undefined, 123);
  const p = built.plaintext;
  assert.equal(p.length, I.padme(4 + built.headerBytes.length + body.length));
  assert.equal(JSON.stringify(Object.keys(JSON.parse(new TextDecoder().decode(built.headerBytes)))), '["k","l","n","t"]');
  assert.deepEqual(I.parseRecordPlaintext(p, 'n').value, { a: 1 });
  assert.throws(() => I.parseRecordPlaintext(p, 'other'), core.errors.IntegrityError);
  const dirty = new Uint8Array(p); dirty[dirty.length - 1] = 1;
  if (p.length > 4 + built.headerBytes.length + body.length) assert.throws(() => I.parseRecordPlaintext(dirty, 'n'), core.errors.IntegrityError, /padding/);
  assert.throws(() => I.parseRecordPlaintext(p.subarray(0, 10), 'n'), core.errors.IntegrityError);
  const long = new Uint8Array(p); long[3] = 200; assert.throws(() => I.parseRecordPlaintext(long, 'n'), core.errors.IntegrityError);
  // unknown header keys are ignored by readers
  const hdr = I.utf8(JSON.stringify({ k: 'json', l: 7, n: 'n', t: 1, zz: 'future' })), pt = new Uint8Array(4 + hdr.length + 7);
  pt.set(I.u32(hdr.length)); pt.set(hdr, 4); pt.set(body, 4 + hdr.length);
  assert.deepEqual(I.parseRecordPlaintext(pt, 'n').value, { a: 1 });
  assert.throws(() => I.buildRecordPlaintext('n', 'bytes', body, 'x'.repeat(256), 1), core.errors.UsageError);
  assert.throws(() => I.buildRecordPlaintext('n', 'json', body, 'text/plain', 1), core.errors.UsageError);
  assert.throws(() => I.buildRecordPlaintext('n', 'weird', body, undefined, 1), core.errors.UsageError);
  // names are used as they are: NFC and NFD forms are different records
  const k = seq(32, 0);
  return Promise.all([I.recordId(k, 'é'), I.recordId(k, 'e' + String.fromCharCode(0x301))]).then(([a, b]) => assert.notEqual(a, b));
});

test('local state MAC: any change or a different key invalidates it', async () => {
  const k = seq(32, 7), state = { epoch: 1, head: I.b64u(seq(32, 0)), records: [['a', 1]], rv: 3 };
  const text = await I.sealState(k, state);
  assert.deepEqual(await I.openState(k, text), state);
  assert.equal(await I.openState(seq(32, 8), text), null);
  assert.equal(await I.openState(k, text.replace('"rv":3', '"rv":2')), null);
  assert.equal(await I.openState(k, 'not json'), null);
  assert.equal(await I.openState(k, '{"mac":"x","state":{}}'), null);
});

test('UMD: loads as a classic script (window.WDSCore) without require/module', () => {
  const src = readFileSync(new URL('../src/wds-core.js', import.meta.url), 'utf8');
  const ctx = { crypto: globalThis.crypto, TextEncoder, TextDecoder, console };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  assert.equal(typeof ctx.WDSCore.Client, 'function');
  assert.equal(ctx.WDSCore.version, core.version);
  assert.equal(ctx.WDSCore.internals.cjson({ b: 1, a: [true] }), '{"a":[true],"b":1}');
  assert.equal(ctx.WDSCore.SERVICE_URL, 'https://wiai.uni-bamberg.de/datastore/');
});

test('classic script bundle: hash-wasm first, then wds-core, finds the global hashwasm and derives the vector KEK', async () => {
  const vendor = readFileSync(new URL('../vendor/hash-wasm-argon2.umd.min.js', import.meta.url), 'utf8');
  const src = readFileSync(new URL('../src/wds-core.js', import.meta.url), 'utf8');
  const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
  const ctx = { crypto: globalThis.crypto, TextEncoder, TextDecoder, WebAssembly, console, setTimeout, queueMicrotask };
  vm.createContext(ctx);
  vm.runInContext(vendor + '\n;\n' + src, ctx);
  assert.equal(typeof ctx.hashwasm.argon2id, 'function');
  ctx.kdf = V.argon2id.kdf; ctx.pass = V.argon2id.passphrase_nfd;
  const hex = await vm.runInContext('WDSCore.internals.argon2idKey(pass, kdf).then(function (b) { return WDSCore.internals.hex(b); })', ctx);
  assert.equal(hex, V.argon2id.kek_hex);
  // Argon2id was captured at load time: a later replacement of the global is not used (review finding)
  ctx.hashwasm = { argon2id() { throw new Error('replaced hashwasm must not be used'); } };
  assert.equal(await vm.runInContext('WDSCore.internals.argon2idKey(pass, kdf).then(function (b) { return WDSCore.internals.hex(b); })', ctx), V.argon2id.kek_hex);
});

test('source stays within ES2020 (no newer syntax or built-ins that older browsers lack)', () => {
  const src = readFileSync(new URL('../src/wds-core.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const [re, what] of [[/\?\?=|\|\|=|&&=/, 'logical assignment'], [/\.at\(/, 'Array.at'], [/\.replaceAll\(/, 'replaceAll'], [/structuredClone/, 'structuredClone'], [/#[a-zA-Z_]+\s*[=(;]/, 'private fields'], [/\bawait\s+import\(/, 'dynamic import'], [/Object\.hasOwn\(/, 'Object.hasOwn'], [/\.findLast\(/, 'findLast'], [/static\s*\{/, 'static blocks']]) {
    assert.ok(!re.test(src), 'uses ' + what);
  }
});

test('vendored files match their checksums', async () => {
  const { createHash } = await import('node:crypto');
  const dir = new URL('../vendor/', import.meta.url);
  const lines = readFileSync(new URL('SHA256SUMS', dir), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 2);
  for (const l of lines) {
    const [sum, name] = l.split(/\s+/);
    assert.equal(createHash('sha256').update(readFileSync(new URL(name, dir))).digest('hex'), sum, name);
  }
});
