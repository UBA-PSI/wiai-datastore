// Unit tests of the pure parts of store.migrateLocal (ids, option checks, value checks, the picture of a row).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WDS = require('../src/wds-ui.js');
const M = WDS.internals.migrate;

test('old.id and ref: same tag, store and key give the same id; 1 and "1" differ; "a/b" and "a_b" differ; never a "/"', () => {
  const t = 'abcd1234', src = 'db/notes';
  assert.equal(M.rowId(t, src, 12), M.rowId(t, src, 12));
  assert.match(M.rowId(t, src, 12), /^abcd1234-[0-9a-f]{8}-j12$/);
  assert.match(M.rowId(t, src, '12'), /^abcd1234-[0-9a-f]{8}-s12$/);
  assert.notEqual(M.rowId(t, src, 1), M.rowId(t, src, '1'));
  assert.notEqual(M.rowId(t, src, 'a/b'), M.rowId(t, src, 'a_b'));
  assert.ok(!M.rowId(t, src, 'a/b/c').includes('/'));
  assert.notEqual(M.rowId(t, 'db/notes', 1), M.rowId(t, 'db/photos', 1));     // the same key in two stores
  assert.notEqual(M.rowId(t, src, 1), M.rowId('cafe0001', src, 1));            // two browsers
  assert.match(M.rowId(t, src, [1, 'x']), /-j%5B1%2C%22x%22%5D$/);
  assert.match(M.rowId(t, src, new Uint8Array([1, 255])), /-b01ff$/);
  assert.notEqual(M.rowId(t, src, new Uint8Array([1, 255])), M.rowId(t, src, new Uint8Array([1, 254])));
});
test('old.id: more than 200 characters are cut to 180 plus "~" and a hash of the whole id', () => {
  const long = 'x'.repeat(500);
  const a = M.rowId('abcd1234', 's', long), b = M.rowId('abcd1234', 's', long + 'y');
  assert.ok(a.length <= 200 && b.length <= 200);
  assert.match(a, /~[0-9a-f]{8}$/);
  assert.notEqual(a, b);                                          // different keys that share the first 180 characters
  assert.equal(a, M.rowId('abcd1234', 's', long));
});
test('the options: unknown option, bad id, no source, prefixes, doubles, the removed options', () => {
  const ok = { id: 'literatur', map() {}, indexedDB: { db: ['a', 'b'] }, localStorage: ['k', 'p.*'] };
  const cfg = M.parse(ok);
  assert.deepEqual(cfg.dbs, [{ name: 'db', stores: ['a', 'b'] }]);
  assert.deepEqual(cfg.local, [{ key: 'k' }, { prefix: 'p.' }]);
  const bad = (o, re) => assert.throws(() => M.parse(o), (e) => e.name === 'UsageError' && re.test(e.message), JSON.stringify(Object.keys(o || {})));
  bad(undefined, /options object/);
  bad({ ...ok, id: 'Bad' }, /id must be/);
  bad({ ...ok, id: '' }, /id must be/);
  bad({ ...ok, id: 'a'.repeat(41) }, /id must be/);
  bad({ ...ok, id: '-x' }, /id must be/);
  bad({ ...ok, map: undefined }, /map must be a function/);
  bad({ id: 'x', map() {} }, /name a source/);
  bad({ ...ok, localStorage: ['*'] }, /key, or "prefix\*"/);
  bad({ ...ok, localStorage: [''] }, /key, or "prefix\*"/);
  bad({ ...ok, localStorage: ['wds:*'] }, /belong to the library/);
  bad({ ...ok, localStorage: ['wds:x'] }, /belong to the library/);
  bad({ ...ok, localStorage: { keys: ['k'] } }, /list of keys/);
  bad({ ...ok, indexedDB: [{ name: 'a', stores: ['s'] }] }, /look like/);
  bad({ ...ok, indexedDB: { a: [] } }, /list of store names/);
  bad({ ...ok, indexedDB: { a: 'store' } }, /list of store names/);
  for (const removed of ['applySettings', 'tagged', 'texts', 'whatever']) bad({ ...ok, [removed]: 1 }, new RegExp('unknown option "' + removed + '"'));
  assert.equal(M.parse({ id: 'x', map() {}, indexedDB: { a: ['s'], b: ['s'] } }).dbs.length, 2);   // the same store name in two databases is fine
});
test('JSON values: a nested Blob, buffer, Map or Set, BigInt and cycles stop the run and name the item', () => {
  const chk = (v) => M.checkJson(v, 'map result for db/notes key 1', 0);
  chk({ a: [1, { b: 'c' }], d: new Date(), e: null });
  const stops = (v, re) => assert.throws(() => chk(v), (e) => e.isMigrateStop && re.test(e.why) && e.why.includes('db/notes key 1'));
  stops({ f: new Blob(['x']) }, /file, Map or Set/);
  stops({ f: new Uint8Array(2) }, /file, Map or Set/);
  stops({ f: new ArrayBuffer(2) }, /file, Map or Set/);
  stops({ f: new Map() }, /file, Map or Set/);
  stops({ f: [new Set()] }, /file, Map or Set/);
  stops({ f: 10n }, /bigint/);
  const cyc = { a: 1 }; cyc.self = cyc;
  stops(cyc, /contains itself/);
});
test('the picture of a row: same data, same text; blobs by size and type; key order does not matter; cycles throw', () => {
  const b = new Blob(['abc'], { type: 'text/plain' });
  assert.equal(M.canonText({ x: 1, y: [1, 2] }), M.canonText({ y: [1, 2], x: 1 }));
  assert.notEqual(M.canonText({ x: 1 }), M.canonText({ x: '1' }));
  assert.notEqual(M.canonText(new Date(1)), M.canonText(new Date(2)));
  assert.match(M.canonText({ f: b }), /"\$blob":\[3,"text\/plain"/);
  const bad = { a: 1 }; bad.me = bad;
  assert.throws(() => M.canonText(bad), /contains itself/);
});
