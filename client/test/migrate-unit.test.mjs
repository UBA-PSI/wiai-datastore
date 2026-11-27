// Unit tests of the pure parts of store.migrateLocal (ids, helpers, option checks, value checks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WDS = require('../src/wds-ui.js');
const M = WDS.internals.migrate;

test('h.id: same key, same id; 1 and "1" differ; "a/b" and "a_b" differ; never a "/"', () => {
  const t = 'abcd1234';
  assert.equal(M.buildId(t, 12), t + '-j12');
  assert.equal(M.buildId(t, '12'), t + '-s12');
  assert.notEqual(M.buildId(t, 1), M.buildId(t, '1'));
  assert.notEqual(M.buildId(t, 'a/b'), M.buildId(t, 'a_b'));
  assert.ok(!M.buildId(t, 'a/b/c').includes('/'));
  assert.equal(M.buildId(t, 'a/b'), t + '-sa%2Fb');
  assert.equal(M.buildId(t, 7, '.pdf'), t + '-j7.pdf');
  assert.equal(M.buildId(t, 7, '.pdf'), M.buildId(t, 7, '.pdf'));
  assert.equal(M.buildId(t, [1, 'x']), t + '-j%5B1%2C%22x%22%5D');
  assert.equal(M.buildId(t, new Uint8Array([1, 255])), t + '-b01ff');
  assert.notEqual(M.buildId(t, new Uint8Array([1, 255])), M.buildId(t, new Uint8Array([1, 254])));
  assert.throws(() => M.buildId(t, 1, 'pdf'), /ending/);
  assert.throws(() => M.buildId(t, 1, '.toolongending'), /ending/);
  assert.throws(() => M.buildId(t, 1, '/x'), /ending/);
});
test('h.id: more than 200 characters are cut to 180 plus "~" and a hash of the whole id, the ending stays', () => {
  const long = 'x'.repeat(500);
  const a = M.buildId('abcd1234', long, '.pdf'), b = M.buildId('abcd1234', long + 'y', '.pdf'), c = M.buildId('abcd1234', long);
  assert.ok(a.length <= 200 && b.length <= 200 && c.length <= 200);
  assert.match(a, /^abcd1234-s[x]{170}~[0-9a-f]{8}\.pdf$/);
  assert.notEqual(a, b);                                          // different keys that share the first 180 characters
  assert.equal(a, M.buildId('abcd1234', long, '.pdf'));
  assert.equal(M.buildId('abcd1234', 'x'.repeat(170)).length, 8 + 1 + 1 + 170);   // 180 characters stay as they are
  // an id that fits without its ending but not with it is cut as well
  const edge = M.buildId('abcd1234', 'y'.repeat(197), '.pdf');
  assert.ok(edge.length <= 200 && edge.endsWith('.pdf') && edge.includes('~'));
});

const mkCtx = (rows) => {
  const refs = new Set(), skipped = new Map();
  return { refs, skipped, tag: 'cafe0001', hasRow: (s, k) => !!rows[s] && rows[s].includes(k), unknownRow: (r) => r.id };
};
test('h.ref: the id the other side computes, null for a dead or missing reference; the same call on both sides gives the same id', () => {
  const ctx = mkCtx({ pdfs: [1, 2] }), h = M.makeHelpers(ctx);
  assert.equal(h.ref('pdfs', 1, '.pdf'), h.id(1, '.pdf'));
  assert.equal(h.ref('pdfs', 99, '.pdf'), null);
  assert.equal(h.ref('pdfs', null), null);
  assert.equal(h.ref('pdfs', undefined), null);
  assert.deepEqual([...ctx.refs], ['cafe0001-j1.pdf']);
});
test('h.skip; there is no h.fail', () => {
  const ctx = mkCtx({}), h = M.makeHelpers(ctx);
  h.skip({ id: 'r1' }, 'not an entry');
  assert.deepEqual([...ctx.skipped], [['r1', 'not an entry']]);
  assert.equal(h.fail, undefined);
});
test('h.blob: Blob, field, .blob, .data (binary, data: URL), and a clear error otherwise', async () => {
  const b = new Blob(['hello'], { type: 'text/plain' });
  assert.equal(M.toBlob(b), b);
  assert.equal(M.toBlob({ blob: b }), b);
  assert.equal(M.toBlob({ file: b }, 'file'), b);
  const fromData = M.toBlob({ data: new Uint8Array([104, 105]), type: 'text/x' });
  assert.equal(fromData.type, 'text/x'); assert.equal(await fromData.text(), 'hi');
  const fromBuffer = M.toBlob({ data: new Uint8Array([1, 2, 3]).buffer });
  assert.equal(fromBuffer.size, 3);
  const url = M.toBlob({ data: 'data:application/pdf;base64,SGVsbG8=' });
  assert.equal(url.type, 'application/pdf'); assert.equal(await url.text(), 'Hello');
  const plainUrl = M.toBlob('data:text/plain,a%20b');
  assert.equal(await plainUrl.text(), 'a b');
  assert.throws(() => M.toBlob({ foo: 1 }), (e) => e.isMigrateStop && /h\.blob: found no Blob/.test(e.why));
  assert.throws(() => M.toBlob({ foo: 1 }, 'nope'), (e) => e.isMigrateStop && /"nope"/.test(e.why));
  assert.throws(() => M.toBlob('not a data url'), (e) => e.isMigrateStop);
});
test('h.created: Date, number, date string; undefined otherwise', () => {
  assert.equal(M.created(new Date(5000)), 5000);
  assert.equal(M.created(1700000000000), 1700000000000);
  assert.equal(M.created('2024-03-01T10:00:00.000Z'), Date.parse('2024-03-01T10:00:00.000Z'));
  assert.equal(M.created('garbage'), undefined);
  assert.equal(M.created(NaN), undefined);
  assert.equal(M.created(null), undefined);
  assert.equal(M.created(new Date('x')), undefined);
});
test('the options: unknown option, bad id, no source, prefixes, doubles, the removed options', () => {
  const ok = { id: 'literatur', map() {}, indexedDB: { name: 'db', stores: ['a', 'b'] }, localStorage: { keys: ['k'], prefixes: ['p.'] } };
  const cfg = M.parse(ok);
  assert.deepEqual(cfg.dbs, [{ name: 'db', stores: ['a', 'b'] }]);
  const bad = (o, re) => assert.throws(() => M.parse(o), (e) => e.name === 'UsageError' && re.test(e.message), JSON.stringify(Object.keys(o || {})));
  bad(undefined, /options object/);
  bad({ ...ok, id: 'Bad' }, /id must be/);
  bad({ ...ok, id: '' }, /id must be/);
  bad({ ...ok, id: 'a'.repeat(41) }, /id must be/);
  bad({ ...ok, id: '-x' }, /id must be/);
  bad({ ...ok, map: undefined }, /map must be a function/);
  bad({ id: 'x', map() {} }, /name a source/);
  bad({ ...ok, localStorage: { prefixes: [''] } }, /must not be empty/);
  bad({ ...ok, localStorage: { prefixes: ['wds:'] } }, /belong to the library/);
  bad({ ...ok, localStorage: { keys: ['wds:x'] } }, /belong to the library/);
  bad({ ...ok, indexedDB: [{ name: 'a', stores: ['s'] }, { name: 'a', stores: ['t'] }] }, /listed twice/);
  bad({ ...ok, indexedDB: { name: 'a', stores: ['s', 's'] } }, /listed twice/);
  bad({ ...ok, indexedDB: { name: 'a', stores: [] } }, /needs stores/);
  bad({ ...ok, applySettings() {} }, /unknown option "applySettings"/);
  bad({ ...ok, tagged: false }, /unknown option "tagged"/);
  bad({ ...ok, texts: {} }, /unknown option "texts"/);
  bad({ ...ok, whatever: 1 }, /unknown option "whatever"/);
  assert.equal(M.parse({ id: 'x', map() {}, indexedDB: [{ name: 'a', stores: ['s'] }, { name: 'b', stores: ['s'] }] }).dbs.length, 2);   // the same store name in two databases is fine
});
test('JSON values: a nested Blob, buffer, Map or Set, BigInt and cycles stop the run and name the item', () => {
  const chk = (v) => M.checkJson(v, 'items[0] ("refs/x")', [], 0);
  chk({ a: [1, { b: 'c' }], d: new Date(), e: null });
  const stops = (v, re) => assert.throws(() => chk(v), (e) => e.isMigrateStop && re.test(e.why) && e.why.includes('items[0] ("refs/x")'));
  stops({ f: new Blob(['x']) }, /Blob\/File/);
  stops({ f: new Uint8Array(2) }, /binary buffer/);
  stops({ f: new ArrayBuffer(2) }, /binary buffer/);
  stops({ f: new Map() }, /Map/);
  stops({ f: [new Set()] }, /Set/);
  stops({ f: 10n }, /bigint/);
  const cyc = { a: 1 }; cyc.self = cyc;
  stops(cyc, /contains itself/);
});
test('the picture of a row: same data, same text; blobs by size and type; key order does not matter; cycles throw', () => {
  const sha = new WeakMap(), b = new Blob(['abc'], { type: 'text/plain' });
  assert.equal(M.canonText({ x: 1, y: [1, 2] }, sha, true), M.canonText({ y: [1, 2], x: 1 }, sha, true));
  assert.notEqual(M.canonText({ x: 1 }, sha, true), M.canonText({ x: '1' }, sha, true));
  assert.notEqual(M.canonText(new Date(1), sha, true), M.canonText(new Date(2), sha, true));
  assert.match(M.canonText({ f: b }, sha, false), /"size":3/);
  const bad = { a: 1 }; bad.me = bad;
  assert.throws(() => M.canonText(bad, sha, true), /contains itself/);
});
