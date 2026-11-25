/*!
 * wds-core.js - WIAI Datastore: cryptography and protocol client (wire protocol v1, see PROTOCOL.md).
 *
 * UMD: loads as a classic script (window.WDSCore) and can be required from Node (>= 20, WebCrypto required).
 * Argon2id comes from the vendored hash-wasm build. In the production bundle (client/build.mjs) the build hands the
 * function to this file through a private variable and the bundle exposes no test hooks (no setRandom, setArgon2 or
 * internals). When this file is loaded on its own (tests, tools), Argon2id is taken once, at load time, from the global
 * "hashwasm" if present, or from the "argon2" client option; WDSCore.setRandom/setArgon2/internals exist only then.
 *
 * Layout: 1 primitives and encodings, 2 envelopes/records/slots/keyring, 3 roster, 4 codes, 5 errors, 6 Client.
 * Everything that is signed, hashed or MACed uses canonical JSON (cjson).
 *
 * API summary (all methods async unless noted; errors are WDSError subclasses, see "errors"):
 *
 *   const c = new WDSCore.Client({ scope, service?, fetch?, storage?, now?, argon2?, escrowPins? })
 *     service      API origin + mount path, default WDSCore.SERVICE_URL (the key file must name the same service)
 *     fetch        injectable (tests); storage: localStorage-like {getItem,setItem,removeItem}, default localStorage
 *     argon2       injectable Argon2id (default: the vendored build). escrowPins / retiredEscrow: escrow key IDs the library
 *                  accepts (tests only: a build with escrow pins ignores both options, see BUILTIN_ESCROW_PINS)
 *   c.getScopeInfo(force?)                    GET /scopes/{scope} (kdf defaults, limits, enrollment, privacy_url)
 *   c.createVault({passphrase, joinCode?, recoveryContact?})
 *        -> {accessId, accessIdDisplay, vaultId, recoveryCode:{canonical,display}, keyFile:{text,filename}}; unlocks
 *   c.unlock({accessId, passphrase, vaultId?, maintain?})   -> status()
 *   c.redeemInvite({inviteCode, passphrase})                -> status() + keyFile; unlocks
 *   c.lock(); c.status() (sync): {unlocked, role, epoch, rosterVersion, rekeyPending, recoveredByFaculty, escrowRetired, newDevice,
 *        stateStatus: 'ok'|'new'|'invalid', recovery, warnings, ...}
 *   c.get(name, {fresh?}) -> value|undefined      c.getRecord(name, {fresh?}) -> {name,version,kind,mime,time,length,epoch,value}|null
 *        fresh: skip the short-lived copy that list() keeps, always read from the server
 *   c.put(name, value, {mime?, base?})  value: JSON value | Uint8Array | ArrayBuffer | Blob. base: omitted = version this
 *        client knows (If-None-Match for unknown names), null = must not exist, n = If-Match n; an explicit undefined is a
 *        UsageError (a base that was never read must not silently fall back to what this client happens to know). Rejects with
 *        ConflictError {record, mine, theirs:{version,deleted,value,...}|null, current}; resolve with put(..., {base: err.current}).
 *   c.delete(name, {base?}) (alias remove) -> bool      c.list(prefix?) -> [{name,version,kind,mime,length,time,epoch}]
 *   c.history(name), c.getVersion(name, n), c.restore(name, n), c.deleteHistory(name) (owner), c.usage(), c.readAll(prefix?)
 *   c.checkRemote() -> [{name, version, known, deleted}] records read/written here that are newer on the server
 *   c.cancelRecovery() (owner)
 *   c.members() (sync), c.createInvite({role:'write'|'read', expiresIn?}) -> {code:{canonical,display}, ...} (owner)
 *   c.cancelInvite(slotId, {revoke?}) (an invite the server saw in use is withdrawn by a revocation, see the method),
 *        c.setRole(slotId, role), c.revoke(slotIds, {rekey?, maxItems?, onProgress?}) (owner; owner slots
 *        only under the rule in PLAN 5.7: an owner may revoke owner slots added by escrow, and an escrow-added owner may
 *        revoke the slots that existed before; see c.members()[i].revocable)
 *   c.resumeRekey({maxItems?, onProgress?, dropOld?}) -> {done, rekeyed}; c.adoptRenewals(); c.renewKeys();
 *   c.changePassphrase(newPassphrase); c.maintain(); c.acknowledgeRecovery(); c.deleteVault()
 *   c.rememberedAccessId() / rememberedAccess() -> {id, t} / rememberAccessId(id) / forgetAccessId()   (localStorage "wds:<scope>:access_id", JSON {id, t})
 *   WDSCore.parseInviteCode / parseRecoveryCode / classifyCode / makeKeyFile / parseKeyFile / displayCode / normalizeCode
 *   WDSCore.internals: low-level building blocks used by tests, vectors and tools (not for app code; not in the bundle).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) module.exports = factory(root);
  else root.WDSCore = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var SERVICE_URL = 'https://wiai.uni-bamberg.de/datastore/';
  // SHA-256 based IDs (b64u of SHA-256(E.pub || S.pub)) of the escrow key sets the library accepts for new work:
  // current and spare (PROTOCOL.md 3.4). Filled in by the build once wds-keygen has produced the keys. When this list
  // is not empty, the "escrowPins" and "retiredEscrow" client options are ignored (they exist for tests only).
  var BUILTIN_ESCROW_PINS = [];
  // Escrow key sets that earlier library versions pinned and that were retired since: [{id, until}]. They stay valid
  // for the history of a vault (versions that name them, and escrow-signed versions with time <= until) but are never
  // accepted as the head of a vault an owner works on and never receive new keyring entries. Filled in by the build.
  var BUILTIN_RETIRED_ESCROW = [];
  // The build sets this to true: no test hooks, no global lookups of the Argon2id function.
  var PRODUCTION = false;

  // ------------------------------------------------------------------------------------------------------------
  // 5. Errors (defined first, used everywhere)
  // ------------------------------------------------------------------------------------------------------------
  class WDSError extends Error {
    constructor(message, props) {
      super(message);
      this.name = this.constructor.name;
      if (props) Object.assign(this, props);
    }
  }
  class ConflictError extends WDSError {}
  class OfflineError extends WDSError {}
  class QuotaError extends WDSError {}
  class AuthError extends WDSError {}
  class IntegrityError extends WDSError {}
  class VersionError extends WDSError {}
  class RequestError extends WDSError {}
  class UsageError extends WDSError {}

  // ------------------------------------------------------------------------------------------------------------
  // 1. Primitives and encodings
  // ------------------------------------------------------------------------------------------------------------
  var te = new TextEncoder();
  var tdFatal = new TextDecoder('utf-8', { fatal: true });
  var rng = null; // test hook (not exported in the production bundle): function (n) -> Uint8Array
  function randomBytes(n) {
    if (!PRODUCTION && rng) return rng(n);
    var b = new Uint8Array(n);
    root.crypto.getRandomValues(b);
    return b;
  }
  function setRandom(fn) { rng = fn || null; }

  function concat() {
    var n = 0, i, a;
    for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arguments.length; i++) { a = arguments[i]; out.set(a, o); o += a.length; }
    return out;
  }
  function u32(n) {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new UsageError('u32 out of range');
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }
  function readU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function lp(x) { return concat(u32(x.length), x); }
  function ascii(s) {
    if (typeof s !== 'string') throw new UsageError('ascii: not a string');
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c > 127) throw new UsageError('ascii: non-ASCII character');
      b[i] = c;
    }
    return b;
  }
  function utf8(s) { return te.encode(s); }
  function utf8Decode(b) {
    try { return tdFatal.decode(b); } catch (e) { throw new IntegrityError('invalid UTF-8'); }
  }
  function hex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function unhex(s) {
    if (typeof s !== 'string' || s.length % 2 || /[^0-9a-f]/.test(s)) throw new UsageError('invalid hex');
    var b = new Uint8Array(s.length / 2);
    for (var i = 0; i < b.length; i++) b[i] = parseInt(s.substr(i * 2, 2), 16);
    return b;
  }
  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }
  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    throw new UsageError('expected bytes (Uint8Array or ArrayBuffer)');
  }

  // ---- base64url (strict) ----
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64REV = (function () {
    var t = new Int16Array(128).fill(-1);
    for (var i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
    return t;
  })();
  function b64u(bytes) {
    bytes = toBytes(bytes);
    var out = [], i = 0, n = bytes.length, chunk = '';
    for (; i + 2 < n; i += 3) {
      var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      chunk += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
      if (chunk.length >= 8192) { out.push(chunk); chunk = ''; }
    }
    if (n - i === 1) {
      var v1 = bytes[i] << 16;
      chunk += B64[v1 >> 18] + B64[(v1 >> 12) & 63];
    } else if (n - i === 2) {
      var v2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      chunk += B64[v2 >> 18] + B64[(v2 >> 12) & 63] + B64[(v2 >> 6) & 63];
    }
    out.push(chunk);
    return out.join('');
  }
  function b64uDecode(s, expectLen) {
    if (typeof s !== 'string') throw new IntegrityError('base64url: not a string');
    var n = s.length;
    if (n % 4 === 1) throw new IntegrityError('base64url: bad length');
    var outLen = Math.floor(n * 3 / 4);
    var out = new Uint8Array(outLen), o = 0, acc = 0, bits = 0;
    for (var i = 0; i < n; i++) {
      var c = s.charCodeAt(i);
      var v = c < 128 ? B64REV[c] : -1;
      if (v < 0) throw new IntegrityError('base64url: invalid character');
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; acc &= (1 << bits) - 1; }
    }
    if (acc !== 0) throw new IntegrityError('base64url: non-canonical encoding');
    if (expectLen !== undefined && o !== expectLen) throw new IntegrityError('base64url: unexpected length');
    return out;
  }

  // ---- Crockford base32 with check bits ----
  var CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  var CROCK_REV = (function () {
    var t = {};
    for (var i = 0; i < 32; i++) t[CROCK[i]] = i;
    return t;
  })();
  function symbolsFromBits(bytes, tailValue, tailBits, maxSymbols) {
    var acc = 0, nb = 0, out = '';
    function feed(val, bits) {
      acc = (acc << bits) | val; nb += bits;
      while (nb >= 5 && out.length < maxSymbols) { out += CROCK[(acc >> (nb - 5)) & 31]; nb -= 5; }
      acc &= (1 << nb) - 1;
    }
    for (var i = 0; i < bytes.length; i++) feed(bytes[i], 8);
    if (tailBits) feed(tailValue, tailBits);
    return out;
  }
  function checkBitCount(n) { return (5 - ((8 * n) % 5)) % 5; }
  async function b32cEncode(bytes) {
    bytes = toBytes(bytes);
    var k = checkBitCount(bytes.length);
    var h = k ? (await sha256(bytes))[0] >> (8 - k) : 0;
    return symbolsFromBits(bytes, h, k, Infinity);
  }
  function normalizeCode(s) {
    if (typeof s !== 'string') throw new UsageError('code: not a string');
    s = s.toUpperCase().replace(/[ \t\r\n \-.]/g, '');
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === 'O') c = '0'; else if (c === 'I' || c === 'L') c = '1';
      if (CROCK_REV[c] === undefined) throw new UsageError('code: invalid character', { code: 'invalid_code' });
      out += c;
    }
    return out;
  }
  async function b32cDecode(str, expectedBytes) {
    var s = normalizeCode(str);
    var k = checkBitCount(expectedBytes);
    var want = (8 * expectedBytes + k) / 5;
    if (s.length !== want) throw new UsageError('code: wrong length', { code: 'invalid_code' });
    var acc = 0, nb = 0, out = new Uint8Array(expectedBytes), o = 0, tail = 0;
    for (var i = 0; i < s.length; i++) {
      acc = (acc << 5) | CROCK_REV[s[i]]; nb += 5;
      while (nb >= 8 && o < expectedBytes) { nb -= 8; out[o++] = (acc >> nb) & 255; acc &= (1 << nb) - 1; }
    }
    tail = acc; // remaining k bits
    if (k) {
      var h = (await sha256(out))[0] >> (8 - k);
      if (h !== tail) throw new UsageError('code: check bits do not match', { code: 'invalid_code' });
    }
    return out;
  }
  function plainCrockford(bytes, nSymbols) { return symbolsFromBits(toBytes(bytes), 0, 0, nSymbols); }
  function displayCode(s) { return s.replace(/(.{4})(?=.)/g, '$1-'); }

  // ---- canonical JSON ----
  function cjsonCheckString(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x20 || c > 0x7e || c === 0x22 || c === 0x5c) throw new UsageError('cjson: character not allowed in string');
    }
  }
  function cjson(v) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'number') {
      if (!Number.isSafeInteger(v) || v < 0 || Object.is(v, -0)) throw new UsageError('cjson: not a non-negative safe integer');
      return String(v);
    }
    if (t === 'string') { cjsonCheckString(v); return '"' + v + '"'; }
    if (Array.isArray(v)) return '[' + v.map(cjson).join(',') + ']';
    if (t === 'object') {
      if (Object.prototype.toString.call(v) !== '[object Object]') throw new UsageError('cjson: not a plain object');
      var keys = Object.keys(v).sort();
      var parts = [];
      for (var i = 0; i < keys.length; i++) {
        cjsonCheckString(keys[i]);
        if (v[keys[i]] === undefined) throw new UsageError('cjson: undefined value');
        parts.push('"' + keys[i] + '":' + cjson(v[keys[i]]));
      }
      return '{' + parts.join(',') + '}';
    }
    throw new UsageError('cjson: unsupported value');
  }
  function cjsonBytes(v) { return ascii(cjson(v)); }
  // Strict parser for canonical documents: no whitespace, keys strictly ascending (so no duplicates),
  // integers only, no escapes. Anything else is an IntegrityError.
  function cjsonParse(text) {
    var i = 0, n = text.length;
    function fail(m) { throw new IntegrityError('non-canonical JSON: ' + m); }
    function str() {
      if (text[i] !== '"') fail('string expected');
      var j = ++i;
      while (i < n && text[i] !== '"') {
        var c = text.charCodeAt(i);
        if (c < 0x20 || c > 0x7e || c === 0x5c) fail('character in string');
        i++;
      }
      if (i >= n) fail('unterminated string');
      var s = text.slice(j, i); i++;
      return s;
    }
    function val(depth) {
      if (depth > 32) fail('too deep');
      var c = text[i];
      if (c === '{') {
        i++; var o = {}, last = null;
        if (text[i] === '}') { i++; return o; }
        for (;;) {
          var k = str();
          if (last !== null && !(k > last)) fail('keys not strictly ascending');
          last = k;
          if (text[i] !== ':') fail(': expected'); i++;
          o[k] = val(depth + 1);
          if (text[i] === ',') { i++; continue; }
          if (text[i] === '}') { i++; return o; }
          fail('bad object');
        }
      }
      if (c === '[') {
        i++; var a = [];
        if (text[i] === ']') { i++; return a; }
        for (;;) {
          a.push(val(depth + 1));
          if (text[i] === ',') { i++; continue; }
          if (text[i] === ']') { i++; return a; }
          fail('bad array');
        }
      }
      if (c === '"') return str();
      if (text.startsWith('true', i)) { i += 4; return true; }
      if (text.startsWith('false', i)) { i += 5; return false; }
      if (text.startsWith('null', i)) { i += 4; return null; }
      var m = /^(0|[1-9][0-9]*)/.exec(text.slice(i, i + 20));
      if (!m) fail('value expected');
      var num = Number(m[1]);
      if (!Number.isSafeInteger(num)) fail('integer too large');
      i += m[1].length;
      if (/^[.eE]/.test(text.slice(i, i + 1))) fail('float');
      return num;
    }
    var v = val(0);
    if (i !== n) fail('trailing data');
    return v;
  }

  // ---- Padme ----
  function bitlen(x) { return x === 0 ? 0 : 32 - Math.clz32(x); }
  function padme(L) {
    if (!Number.isInteger(L) || L < 1 || L > 0xffffffff) throw new UsageError('padme: bad length');
    var E = bitlen(L) - 1, S = bitlen(E), z = E - S, p = Math.pow(2, z);
    return Math.ceil(L / p) * p;
  }

  // ---- WebCrypto wrappers ----
  function subtle() {
    var c = root.crypto;
    if (!c || !c.subtle) throw new WDSError('WebCrypto (crypto.subtle) is not available; a secure context is required');
    return c.subtle;
  }
  async function sha256(data) { return new Uint8Array(await subtle().digest('SHA-256', toBytes(data))); }
  var EMPTY = new Uint8Array(0);
  async function hkdf(ikm, salt, info) {
    var k = await subtle().importKey('raw', toBytes(ikm), 'HKDF', false, ['deriveBits']);
    var bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt || EMPTY, info: ascii(info) }, k, 256);
    return new Uint8Array(bits);
  }
  async function hmacKey(raw) {
    return subtle().importKey('raw', toBytes(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  async function hmacSign(key, data) { return new Uint8Array(await subtle().sign('HMAC', key, toBytes(data))); }
  // A key argument is either raw bytes or an already imported (non-extractable) CryptoKey.
  function isKey(x) { return !!x && typeof x === 'object' && typeof x.type === 'string' && typeof x.extractable === 'boolean'; }
  async function hmac(key, data) { return hmacSign(isKey(key) ? key : await hmacKey(key), data); }
  async function aesKey(raw) { return isKey(raw) ? raw : subtle().importKey('raw', toBytes(raw), 'AES-GCM', false, ['encrypt', 'decrypt']); }
  async function aesSeal(key, nonce, plaintext, aad) {
    return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext));
  }
  async function aesOpen(key, nonce, ct, aad) {
    try {
      return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, ct));
    } catch (e) {
      throw new IntegrityError('decryption failed (wrong key, tampered data or wrong context)', { code: 'decrypt_failed' });
    }
  }
  var ECDH = { name: 'ECDH', namedCurve: 'P-256' }, ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
  function checkPub(pub) {
    if (!pub || !ArrayBuffer.isView(pub) || pub.length !== 65 || pub[0] !== 4) throw new IntegrityError('invalid public key encoding');
  }
  async function generateKeyPair(kind) { // kind 'E' (ECDH) or 'S' (ECDSA)
    var kp = await subtle().generateKey(kind === 'E' ? ECDH : ECDSA, true, kind === 'E' ? ['deriveBits'] : ['sign', 'verify']);
    var jwk = await subtle().exportKey('jwk', kp.privateKey);
    var pub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
    return { d: b64uDecode(jwk.d, 32), pub: pub };
  }
  async function importPrivate(kind, d, pub) {
    checkPub(pub);
    var jwk = { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
    return subtle().importKey('jwk', jwk, kind === 'E' ? ECDH : ECDSA, false, kind === 'E' ? ['deriveBits'] : ['sign']);
  }
  async function importPublic(kind, pub) {
    checkPub(pub);
    return subtle().importKey('raw', pub, kind === 'E' ? ECDH : ECDSA, true, kind === 'E' ? [] : ['verify']);
  }
  async function ecdh(privKey, pub) {
    var pk = await importPublic('E', pub);
    return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pk }, privKey, 256));
  }
  async function ecdsaSign(privKey, data) {
    return new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, toBytes(data)));
  }
  async function ecdsaVerify(pub, sig, data) {
    if (sig.length !== 64) return false;
    var pk = await importPublic('S', pub);
    return subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, pk, sig, toBytes(data));
  }

  // ---- Argon2id ----
  var argon2Impl = null; // test hook (not exported in the production bundle)
  function setArgon2(fn) { argon2Impl = fn || null; }
  // Captured once, at load time. In the bundle the build declares WDS_VENDOR_ARGON2 around this file (the vendored
  // hash-wasm runs in a private scope, so no global is read and no later script can replace it).
  var argon2Builtin = (function () {
    if (typeof WDS_VENDOR_ARGON2 === 'function') return WDS_VENDOR_ARGON2;
    if (!PRODUCTION && root.hashwasm && typeof root.hashwasm.argon2id === 'function') return root.hashwasm.argon2id;
    return null;
  })();
  function getArgon2(custom) {
    if (custom) return custom;
    if (!PRODUCTION && argon2Impl) return argon2Impl;
    if (argon2Builtin) return argon2Builtin;
    throw new WDSError('Argon2id implementation not found (hash-wasm build is not loaded)');
  }
  var KDF_WINDOW = { mMin: 65536, mMax: 262144, tMin: 3, tMax: 10 };
  var DEFAULT_KDF = { alg: 'argon2id', m: 65536, p: 1, t: 3, v: 19 };
  // Returns the descriptor (canonical copy) or throws IntegrityError. withSalt: salt required.
  function checkKdf(kdf, withSalt) {
    if (!kdf || typeof kdf !== 'object' || Array.isArray(kdf)) throw new IntegrityError('invalid KDF descriptor');
    if (kdf.alg === 'invite') {
      if (Object.keys(kdf).length !== 1) throw new IntegrityError('invalid invite KDF descriptor');
      return { alg: 'invite' };
    }
    var keys = Object.keys(kdf).sort().join(',');
    if (keys !== (withSalt === false ? 'alg,m,p,t,v' : 'alg,m,p,salt,t,v')) throw new IntegrityError('invalid KDF descriptor');
    if (kdf.alg !== 'argon2id' || kdf.v !== 19 || kdf.p !== 1 ||
        !Number.isInteger(kdf.m) || kdf.m < KDF_WINDOW.mMin || kdf.m > KDF_WINDOW.mMax ||
        !Number.isInteger(kdf.t) || kdf.t < KDF_WINDOW.tMin || kdf.t > KDF_WINDOW.tMax) {
      throw new IntegrityError('KDF parameters outside the accepted window', { code: 'weak_kdf' });
    }
    var out = { alg: 'argon2id', m: kdf.m, p: kdf.p, t: kdf.t, v: kdf.v };
    if (withSalt !== false) {
      b64uDecode(kdf.salt, 16);
      out.salt = kdf.salt;
    }
    return out;
  }
  async function argon2idKey(passphrase, kdf, impl) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) throw new UsageError('passphrase required');
    kdf = checkKdf(kdf);
    var out = await getArgon2(impl)({
      password: utf8(passphrase.normalize('NFC')), salt: b64uDecode(kdf.salt, 16),
      parallelism: kdf.p, iterations: kdf.t, memorySize: kdf.m, hashLength: 32, outputType: 'binary',
    });
    return toBytes(out);
  }

  // ------------------------------------------------------------------------------------------------------------
  // 2. Envelopes, records, slot blobs, keyring entries
  // ------------------------------------------------------------------------------------------------------------
  var T_RECORD = 1, T_SLOT = 2, T_KEYRING = 3;
  // Records: the largest envelope any scope can hold (the 25 MiB ceiling of max_value_bytes, PROTOCOL 7.1). Reads and
  // re-encryption are bounded by this fixed value and never by the scope's current limit: an operator who lowers
  // max_value_bytes later must not make stored values unreadable (PLAN 8.3). The AEAD tag protects integrity anyway.
  var MAX_VALUE_CEILING = 26214400;
  var ENV_MIN = { 1: 38, 2: 38, 3: 103 }, ENV_MAX = { 1: padme(4 + 2048 + MAX_VALUE_CEILING) + 38, 2: 4096, 3: 16384 };
  function envHeader(type, epoch) {
    return new Uint8Array([0x57, 0x44, 0x53, 0x31, type, 0, (epoch >>> 24) & 255, (epoch >>> 16) & 255, (epoch >>> 8) & 255, epoch & 255]);
  }
  // Parse the outer structure; returns {type, epoch, header, nonce, eph, ct}.
  function parseEnvelope(b, wantType, maxLen) {
    if (!b || !ArrayBuffer.isView(b) || b.length < 10) throw new IntegrityError('malformed envelope', { code: 'malformed_envelope' });
    if (b[0] !== 0x57 || b[1] !== 0x44 || b[2] !== 0x53 || b[3] !== 0x31) throw new IntegrityError('bad envelope magic', { code: 'malformed_envelope' });
    var type = b[4];
    if (type !== wantType) throw new IntegrityError('unexpected envelope type', { code: 'malformed_envelope' });
    if (b[5] !== 0) throw new IntegrityError('unsupported envelope flags', { code: 'malformed_envelope' });
    var epoch = readU32(b, 6);
    var max = maxLen || ENV_MAX[type] || Infinity;
    if (b.length < ENV_MIN[type] || b.length > max) throw new IntegrityError('envelope length out of range', { code: 'malformed_envelope' });
    if (type !== T_RECORD && epoch !== 0) throw new IntegrityError('nonzero epoch in non-record envelope', { code: 'malformed_envelope' });
    var o = 10, eph = null;
    if (type === T_KEYRING) {
      eph = b.subarray(10, 75); o = 75;
      if (eph[0] !== 4) throw new IntegrityError('bad ephemeral key', { code: 'malformed_envelope' });
    }
    return { type: type, epoch: epoch, header: b.subarray(0, 10), eph: eph, nonce: b.subarray(o, o + 12), ct: b.subarray(o + 12) };
  }
  async function sealEnvelope(key, type, epoch, plaintext, aadTail, nonce, ephPub) {
    var H = envHeader(type, epoch);
    nonce = nonce || randomBytes(12);
    var ct = await aesSeal(key, nonce, plaintext, concat(H, aadTail));
    return concat(H, ephPub || EMPTY, nonce, ct);
  }
  async function openEnvelope(key, env, aadTail) {
    return aesOpen(key, env.nonce, env.ct, concat(env.header, aadTail));
  }

  // AAD tails (everything after the 10-byte header), PROTOCOL.md 4.2
  function aadRecord(scope, vault, rid, version) {
    return concat(lp(ascii(scope)), lp(ascii(vault)), lp(ascii(rid)), lp(u32(version)));
  }
  function aadSlot(scope, vault, accessId, kdf) {
    return concat(lp(ascii(scope)), lp(ascii(vault)), lp(ascii(accessId)), lp(cjsonBytes(kdf)));
  }
  function aadKeyring(scope, vault, slotId, rosterVersion, recipientPub) {
    return concat(lp(ascii(scope)), lp(ascii(vault)), lp(ascii(slotId)), lp(u32(rosterVersion)), lp(recipientPub));
  }

  // ---- derived keys (3.2) ----
  async function deriveSlotKeys(ikm) {
    var kWrap = await hkdf(ikm, EMPTY, 'wds1/slot-wrap');
    var token = await hkdf(ikm, EMPTY, 'wds1/slot-auth');
    return { kWrap: kWrap, token: token, tokenHash: await sha256(token) };
  }
  async function deriveVaultKeys(vmk, nk) {
    var out = {};
    if (vmk) {
      out.kEnc = await hkdf(vmk, EMPTY, 'wds1/record-enc');
      out.cVmk = await hkdf(vmk, EMPTY, 'wds1/check/vmk');
    }
    if (nk) {
      out.kId = await hkdf(nk, EMPTY, 'wds1/record-id');
      out.kCommit = await hkdf(nk, EMPTY, 'wds1/history-commit');
      out.kState = await hkdf(nk, EMPTY, 'wds1/local-state');
      out.cNk = await hkdf(nk, EMPTY, 'wds1/check/nk');
    }
    return out;
  }
  async function recordId(kId, name) { return b64u(await hmac(kId, utf8(name))); } // kId: raw bytes or HMAC CryptoKey
  async function commitment(kCommit, rid, version, plaintext) { // kCommit: raw bytes or HMAC CryptoKey
    var data = concat(lp(ascii(rid)), lp(u32(version)), lp(await sha256(plaintext)));
    return b64u(await hmac(kCommit, data));
  }
  function bearerHeader(accessId, token) { return 'Bearer wds1.' + accessId + '.' + b64u(token); }

  // ---- record names and plaintext (2, 4.4) ----
  function checkRecordName(name) {
    if (typeof name !== 'string' || name.length === 0) throw new UsageError('record name must be a non-empty string');
    for (var i = 0; i < name.length; i++) {
      var c = name.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        var d = name.charCodeAt(i + 1);
        if (!(d >= 0xdc00 && d <= 0xdfff)) throw new UsageError('record name contains a lone surrogate');
        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new UsageError('record name contains a lone surrogate');
    }
    if (utf8(name).length > 1024) throw new UsageError('record name longer than 1024 bytes');
    return name;
  }
  function buildRecordPlaintext(name, kind, body, mime, time) {
    checkRecordName(name);
    if (kind !== 'json' && kind !== 'bytes') throw new UsageError('kind must be json or bytes');
    var hdr = { k: kind, l: body.length };
    if (mime !== undefined && mime !== null && mime !== '') {
      if (kind !== 'bytes') throw new UsageError('mime only applies to bytes records');
      if (utf8(mime).length > 255) throw new UsageError('mime type longer than 255 bytes');
      hdr.m = mime;
    }
    hdr.n = name;
    hdr.t = time;
    var hb = utf8(JSON.stringify(hdr));
    if (hb.length > 2048) throw new UsageError('record header larger than 2048 bytes');
    var used = 4 + hb.length + body.length;
    var pt = new Uint8Array(padme(used));
    pt.set(u32(hb.length), 0); pt.set(hb, 4); pt.set(body, 4 + hb.length);
    return { plaintext: pt, header: hdr, headerBytes: hb };
  }
  function parseRecordPlaintext(pt, expectName) {
    if (pt.length < 4) throw new IntegrityError('record plaintext too short');
    var hl = readU32(pt, 0);
    if (hl > 2048 || 4 + hl > pt.length) throw new IntegrityError('bad record header length');
    var hdr;
    try { hdr = JSON.parse(utf8Decode(pt.subarray(4, 4 + hl))); } catch (e) { throw new IntegrityError('bad record header'); }
    if (!hdr || typeof hdr !== 'object' || Array.isArray(hdr)) throw new IntegrityError('bad record header');
    if (expectName !== undefined && hdr.n !== expectName) throw new IntegrityError('record name mismatch');
    if (typeof hdr.n !== 'string') throw new IntegrityError('bad record header');
    if (hdr.k !== 'json' && hdr.k !== 'bytes') throw new IntegrityError('bad record kind');
    if (!Number.isInteger(hdr.l) || hdr.l < 0 || 4 + hl + hdr.l > pt.length) throw new IntegrityError('bad record body length');
    if (!Number.isInteger(hdr.t) || hdr.t < 0) throw new IntegrityError('bad record time');
    if (hdr.m !== undefined && typeof hdr.m !== 'string') throw new IntegrityError('bad record mime');
    for (var i = 4 + hl + hdr.l; i < pt.length; i++) if (pt[i] !== 0) throw new IntegrityError('nonzero padding');
    var body = pt.slice(4 + hl, 4 + hl + hdr.l);
    var value;
    if (hdr.k === 'json') {
      try { value = JSON.parse(utf8Decode(body)); } catch (e) { throw new IntegrityError('record body is not valid JSON'); }
    } else value = body;
    return { name: hdr.n, kind: hdr.k, mime: hdr.m === undefined ? null : hdr.m, time: hdr.t, value: value, body: body };
  }
  // Record envelope (type 0x01).
  async function sealRecord(o) { // {kEncRaw|key, epoch, scope, vault, rid, version, plaintext, nonce?}
    var key = o.key || await aesKey(o.kEncRaw);
    return sealEnvelope(key, T_RECORD, o.epoch, o.plaintext, aadRecord(o.scope, o.vault, o.rid, o.version), o.nonce);
  }
  async function openRecord(o) { // {key, envelope(bytes), scope, vault, rid, version, maxLen?} -> {plaintext, epoch}
    var env = parseEnvelope(o.envelope, T_RECORD, o.maxLen);
    var pt = await openEnvelope(o.key, env, aadRecord(o.scope, o.vault, o.rid, o.version));
    return { plaintext: pt, epoch: env.epoch };
  }

  // ---- slot blob (type 0x02, 3.3) ----
  function slotPlaintext(vault, slotId, keySets) {
    return cjsonBytes({
      keys: keySets.map(function (k) { return { e_d: b64u(k.e.d), e_pub: b64u(k.e.pub), s_d: b64u(k.s.d), s_pub: b64u(k.s.pub) }; }),
      slot: slotId, v: 1, vault: vault,
    });
  }
  async function wrapSlot(o) { // {kWrap (CryptoKey or raw bytes; kWrapRaw is the same), scope, vault, accessId, kdf, slotId, keySets, nonce?}
    var key = await aesKey(o.kWrap || o.kWrapRaw);
    return sealEnvelope(key, T_SLOT, 0, slotPlaintext(o.vault, o.slotId, o.keySets), aadSlot(o.scope, o.vault, o.accessId, o.kdf), o.nonce);
  }
  async function unwrapSlot(o) { // {kWrap (CryptoKey or raw bytes; kWrapRaw is the same), scope, vault, accessId, kdf, envelope} -> {slot, vault, keySets}
    var key = await aesKey(o.kWrap || o.kWrapRaw);
    var env = parseEnvelope(o.envelope, T_SLOT);
    var pt = await openEnvelope(key, env, aadSlot(o.scope, o.vault, o.accessId, o.kdf));
    var doc = cjsonParse(utf8Decode(pt));
    if (doc.v !== 1) throw new VersionError('unknown slot blob format version');
    if (Object.keys(doc).join(',') !== 'keys,slot,v,vault') throw new IntegrityError('bad slot blob');
    if (!Array.isArray(doc.keys) || doc.keys.length < 1 || doc.keys.length > 2) throw new IntegrityError('bad slot blob keys');
    var sets = doc.keys.map(function (k) {
      if (Object.keys(k).join(',') !== 'e_d,e_pub,s_d,s_pub') throw new IntegrityError('bad slot key set');
      var s = { e: { d: b64uDecode(k.e_d, 32), pub: b64uDecode(k.e_pub, 65) }, s: { d: b64uDecode(k.s_d, 32), pub: b64uDecode(k.s_pub, 65) } };
      checkPub(s.e.pub); checkPub(s.s.pub);
      return s;
    });
    return { slot: doc.slot, vault: doc.vault, keySets: sets };
  }

  // ---- keyring entry (ECIES, type 0x03, 4.3) ----
  async function eciesSeal(o) { // {recipientPub, plaintext(bytes), aadTail, eph?: {d,pub}, nonce?} -> envelope
    checkPub(o.recipientPub);
    var eph = o.eph || await generateKeyPair('E');
    var ephPriv = await importPrivate('E', eph.d, eph.pub);
    var z = await ecdh(ephPriv, o.recipientPub);
    var k = await aesKey(await hkdf(z, concat(eph.pub, o.recipientPub), 'wds1/ecies'));
    return sealEnvelope(k, T_KEYRING, 0, o.plaintext, o.aadTail, o.nonce, eph.pub);
  }
  async function eciesOpen(o) { // {recipientPriv(CryptoKey), recipientPub, envelope(bytes), aadTail} -> plaintext
    var env = parseEnvelope(o.envelope, T_KEYRING);
    var z = await ecdh(o.recipientPriv, env.eph);
    var k = await aesKey(await hkdf(z, concat(env.eph, o.recipientPub), 'wds1/ecies'));
    return openEnvelope(k, env, o.aadTail);
  }
  function keyringPlaintext(epochs, nk) { // epochs: [{e, k(bytes)}]
    var list = epochs.slice().sort(function (a, b) { return a.e - b.e; }).map(function (x) { return { e: x.e, k: b64u(x.k) }; });
    return cjsonBytes({ epochs: list, nk: b64u(nk), v: 1 });
  }
  function parseKeyringPlaintext(pt) {
    var doc = cjsonParse(utf8Decode(pt));
    if (doc.v !== 1) throw new VersionError('unknown keyring format version');
    if (Object.keys(doc).join(',') !== 'epochs,nk,v' || !Array.isArray(doc.epochs)) throw new IntegrityError('bad keyring entry');
    var last = 0, epochs = doc.epochs.map(function (x) {
      if (Object.keys(x).join(',') !== 'e,k' || !Number.isInteger(x.e) || x.e <= last) throw new IntegrityError('bad keyring epoch list');
      last = x.e;
      return { e: x.e, k: b64uDecode(x.k, 32) };
    });
    return { epochs: epochs, nk: b64uDecode(doc.nk, 32) };
  }

  // ---- identities ----
  async function vaultIdFromPub(sPub) { return plainCrockford(await sha256(sPub), 26); }
  async function escrowKeyId(ePub, sPub) { return b64u(await sha256(concat(ePub, sPub))); }
  function randomSlotId() { return b64u(randomBytes(12)); }
  async function randomAccessId() { return b32cEncode(randomBytes(12)); }
  var RE_ACCESS = /^[0-9A-HJKMNP-TV-Z]{20}$/, RE_VAULT = /^[0-9A-HJKMNP-TV-Z]{26}$/, RE_SLOT = /^[A-Za-z0-9_-]{16}$/;
  async function checkAccessId(id) {
    if (typeof id !== 'string' || !RE_ACCESS.test(id)) throw new UsageError('invalid access ID', { code: 'invalid_code' });
    await b32cDecode(id, 12);
    return id;
  }

  // ---- local state MAC (7.4) ----
  // The MACed state names the scope, vault, access ID and slot it belongs to (the caller checks them after opening), so a
  // state blob copied from another member of the same vault or from another vault is not accepted. The MAC does not
  // prove freshness: local code that can write localStorage can put back an older genuine blob of the same slot.
  async function sealState(kState, state) { // kState: raw bytes or HMAC CryptoKey
    var mac = b64u(await hmac(kState, cjsonBytes(state)));
    return cjson({ mac: mac, state: state });
  }
  async function openState(kState, text) { // -> state or null
    try {
      var doc = cjsonParse(text);
      if (Object.keys(doc).join(',') !== 'mac,state') return null;
      var mac = b64uDecode(doc.mac, 32);
      if (!bytesEqual(mac, await hmac(kState, cjsonBytes(doc.state)))) return null;
      return doc.state;
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------------------------------------------------------
  // 3. Roster (6): building, signing, chain verification
  // ------------------------------------------------------------------------------------------------------------
  var ROSTER_KEYS = 'commit,epoch,prev,scope,signer,slots,time,type,v,vault,version';
  var SLOT_KEYS = 'e_pub,expires,id,kind,role,s_pub';
  async function rosterHash(body) { return b64u(await sha256(cjsonBytes(body))); }
  async function signRoster(body, sPrivKey) {
    return { body: body, sig: b64u(await ecdsaSign(sPrivKey, cjsonBytes(body))) };
  }
  function cloneJson(x) { return JSON.parse(JSON.stringify(x)); }
  function commitmentFor(body, epoch) {
    for (var i = 0; i < body.commit.epochs.length; i++) if (body.commit.epochs[i].e === epoch) return body.commit.epochs[i].c;
    return null;
  }
  function findSlot(body, id) {
    for (var i = 0; i < body.slots.length; i++) if (body.slots[i].id === id) return body.slots[i];
    return null;
  }
  function isInt(x) { return Number.isSafeInteger(x) && x >= 0; }

  function checkRosterShape(body, expect) {
    function bad(m) { throw new IntegrityError('invalid roster: ' + m, { code: 'invalid_roster' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) bad('not an object');
    if (body.v !== 1) throw new VersionError('unknown roster format version');
    if (Object.keys(body).sort().join(',') !== ROSTER_KEYS) bad('unexpected keys');
    if (body.type !== 'roster') bad('wrong type');
    if (body.scope !== expect.scope || body.vault !== expect.vault) bad('scope or vault mismatch');
    if (!isInt(body.version) || body.version < 1 || !isInt(body.epoch) || body.epoch < 1 || !isInt(body.time)) bad('bad numbers');
    if (typeof body.prev !== 'string' || (body.prev !== '' && body.prev.length !== 43)) bad('bad prev');
    if (!RE_SLOT.test(body.signer)) bad('bad signer');
    var c = body.commit;
    if (!c || typeof c !== 'object' || Object.keys(c).sort().join(',') !== 'epochs,nk' || !Array.isArray(c.epochs)) bad('bad commit');
    b64uDecode(c.nk, 32);
    var last = 0, hasCur = false;
    c.epochs.forEach(function (x) {
      if (!x || Object.keys(x).sort().join(',') !== 'c,e' || !isInt(x.e)) bad('bad commit entry');
      if (x.e <= last || x.e > body.epoch) bad('commit epochs not ascending or above epoch');
      last = x.e; if (x.e === body.epoch) hasCur = true;
      b64uDecode(x.c, 32);
    });
    if (!hasCur) bad('commit lacks current epoch');
    if (!Array.isArray(body.slots) || body.slots.length < 2 || body.slots.length > 64) bad('bad slot count');
    var prevId = null, esc = 0, owners = 0;
    body.slots.forEach(function (s) {
      if (!s || typeof s !== 'object' || Object.keys(s).sort().join(',') !== SLOT_KEYS) bad('bad slot entry');
      if (!RE_SLOT.test(s.id)) bad('bad slot id');
      if (prevId !== null && !(s.id > prevId)) bad('slots not sorted or duplicate');
      prevId = s.id;
      if (['passphrase', 'invite', 'escrow'].indexOf(s.kind) < 0 || ['owner', 'write', 'read'].indexOf(s.role) < 0) bad('bad kind or role');
      checkPub(b64uDecode(s.e_pub, 65)); checkPub(b64uDecode(s.s_pub, 65));
      if (s.kind === 'invite') { if (!isInt(s.expires)) bad('invite without expiry'); } else if (s.expires !== null) bad('expiry on non-invite');
      if (s.kind === 'escrow') { esc++; if (s.role !== 'owner') bad('escrow must be owner'); }
      if (s.role === 'owner' && s.kind !== 'escrow') owners++;
    });
    if (esc !== 1) bad('exactly one escrow slot required');
    if (owners < 1) bad('no owner slot');
    if (cjson(body).length > 65536) bad('roster too large');
  }
  function bodyEscrow(body) {
    for (var i = 0; i < body.slots.length; i++) if (body.slots[i].kind === 'escrow') return body.slots[i];
    return null;
  }

  // Escrow key IDs in rosters: every version of the chain must name an escrow key set that this library pins (current or
  // spare: "active") or that it lists as retired. Retired sets are valid for history only: an escrow-signed version
  // counts only if its time is not after the retirement ("until", Unix seconds). Whether the head still names a retired
  // set is the caller's business (an owner replaces it, see Client._migrateEscrow).
  function escrowStatus(o, id) {
    if (o.escrowPins.indexOf(id) >= 0) return { state: 'active' };
    var r = o.retiredEscrow || [];
    for (var i = 0; i < r.length; i++) if (r[i].id === id) return { state: 'retired', until: r[i].until };
    return null;
  }
  async function bodyEscrowId(body) {
    var esc = bodyEscrow(body);
    return escrowKeyId(b64uDecode(esc.e_pub), b64uDecode(esc.s_pub));
  }

  // docs: array of {body, sig} for consecutive versions; prior: {body, hash} of the last verified version or null.
  // Returns [{body, hash, sig, signedByEscrow, escrowId}] for the new versions.
  async function verifyRosterChain(o) { // {scope, vault, escrowPins, retiredEscrow?, docs, prior}
    var out = [], prev = o.prior || null, prevEscId = prev ? (prev.escrowId || await bodyEscrowId(prev.body)) : null;
    for (var di = 0; di < o.docs.length; di++) {
      var doc = o.docs[di];
      if (!doc || typeof doc !== 'object' || typeof doc.sig !== 'string') throw new IntegrityError('malformed roster document');
      var body = doc.body;
      checkRosterShape(body, o);
      var fail = function (m) { throw new IntegrityError('roster version ' + body.version + ': ' + m, { code: 'invalid_roster' }); };
      var escId = await bodyEscrowId(body);
      if (!escrowStatus(o, escId)) fail('escrow keys are not pinned by this library');
      var hash = await rosterHash(body), sigBytes = b64uDecode(doc.sig, 64), signerPub, escrowSigned = false;
      if (!prev) {
        if (body.version !== 1 || body.prev !== '' || body.epoch !== 1) fail('first version must be version 1, epoch 1, empty prev');
        if (body.slots.length !== 2) fail('version 1 must contain exactly the founder and escrow');
        var fs = findSlot(body, body.signer);
        if (!fs || fs.kind !== 'passphrase' || fs.role !== 'owner') fail('signer of version 1 must be the founder owner slot');
        signerPub = b64uDecode(fs.s_pub);
        if ((await vaultIdFromPub(signerPub)) !== body.vault) fail('vault ID does not match the founder key');
      } else {
        var P = prev.body;
        if (body.version !== P.version + 1) fail('version number does not continue the chain');
        if (body.prev !== prev.hash) fail('prev hash does not match');
        if (body.epoch !== P.epoch && body.epoch !== P.epoch + 1) fail('epoch may only stay or grow by one');
        var ps = findSlot(P, body.signer);
        if (!ps || ps.role !== 'owner') fail('signer was not an owner in the previous version');
        signerPub = b64uDecode(ps.s_pub);
        escrowSigned = ps.kind === 'escrow';
        if (escrowSigned) {
          var signerStatus = escrowStatus(o, prevEscId);
          if (!signerStatus) fail('escrow keys are not pinned by this library');
          if (signerStatus.state === 'retired' && !(body.time <= signerStatus.until)) fail('signed by a retired escrow key after its retirement');
        }
        checkRosterTransition(P, body, escrowSigned, fail);
      }
      if (!(await ecdsaVerify(signerPub, sigBytes, cjsonBytes(body)))) fail('invalid signature');
      var rec = { body: body, sig: doc.sig, hash: hash, signedByEscrow: escrowSigned, escrowId: escId };
      out.push(rec);
      prev = rec; prevEscId = escId;
    }
    return out;
  }
  function checkRosterTransition(P, N, escrowSigned, fail) {
    var i, s, p;
    // commitments of surviving epochs never change; new epochs only via an epoch bump
    if (N.commit.nk !== P.commit.nk) fail('name key commitment changed');
    N.commit.epochs.forEach(function (x) {
      var old = commitmentFor(P, x.e);
      if (old === null) { if (x.e !== N.epoch || N.epoch !== P.epoch + 1) fail('commitment for an epoch that was not created by this version'); }
      else if (old !== x.c) fail('epoch commitment changed');
    });
    // The escrow slot keeps its slot ID (PROTOCOL 6.2, 6.3): it is never replaced by a slot with another ID or removed.
    var pEsc = bodyEscrow(P), nEsc = bodyEscrow(N);
    if (!pEsc || !nEsc || nEsc.id !== pEsc.id) fail('the escrow slot must keep its slot ID');
    var newIds = [];
    for (i = 0; i < N.slots.length; i++) {
      s = N.slots[i]; p = findSlot(P, s.id);
      if (!p) {
        newIds.push(s.id);
        if (s.kind !== 'invite') fail('new slots must be invites');
        if (s.role === 'owner' && !escrowSigned) fail('owner invites may only be added by escrow');
        if (s.role !== 'owner' && s.role !== 'write' && s.role !== 'read') fail('bad role');
        continue;
      }
      if (p.kind === 'escrow') { if (s.kind !== 'escrow') fail('escrow slot changed kind'); continue; }
      if (s.kind !== p.kind && !(p.kind === 'invite' && s.kind === 'passphrase')) fail('illegal kind change');
      if (s.role !== p.role) {
        if (p.role === 'owner' || s.role === 'owner') fail('owner roles never change');
      }
      if (s.kind === 'passphrase' && p.kind === 'invite' && s.expires !== null) fail('expiry must be cleared');
      if (s.kind === p.kind && s.expires !== p.expires) fail('expiry cannot change');
      if (p.role === 'owner' && (s.e_pub !== p.e_pub || s.s_pub !== p.s_pub) && N.signer !== p.id && !escrowSigned) fail('only an owner may change its own keys');
    }
    for (i = 0; i < P.slots.length; i++) {
      p = P.slots[i];
      if (findSlot(N, p.id)) continue;
      if (p.kind === 'escrow') continue;
      if (N.epoch !== P.epoch + 1 && p.kind !== 'invite') fail('slot removed without epoch change');
    }
    if (escrowSigned) {
      if (newIds.length !== 1 || N.slots.length !== P.slots.length + 1 || N.epoch !== P.epoch || N.commit.epochs.length !== P.commit.epochs.length) fail('escrow may only add exactly one owner invite');
      if (findSlot(N, newIds[0]).role !== 'owner') fail('escrow may only add an owner invite');
      for (i = 0; i < P.slots.length; i++) {
        p = P.slots[i]; s = findSlot(N, p.id);
        if (!s || s.e_pub !== p.e_pub || s.s_pub !== p.s_pub || s.role !== p.role || s.kind !== p.kind || s.expires !== p.expires) fail('escrow changed existing slots');
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // 4. Codes and key file
  // ------------------------------------------------------------------------------------------------------------
  async function makeInviteCode(accessIdBytes, secret) {
    var canonical = (await b32cEncode(accessIdBytes)) + (await b32cEncode(secret));
    return { canonical: canonical, display: displayCode(canonical) };
  }
  async function parseInviteCode(input) {
    var s = normalizeCode(input);
    if (s.length !== 48) throw new UsageError('invite code must have 48 symbols', { code: 'invalid_code' });
    var idBytes = await b32cDecode(s.slice(0, 20), 12), secret = await b32cDecode(s.slice(20), 17);
    return { accessId: s.slice(0, 20), secret: secret, idBytes: idBytes };
  }
  async function makeRecoveryCode(bytes) {
    bytes = bytes || randomBytes(17);
    var canonical = await b32cEncode(bytes);
    return { bytes: bytes, canonical: canonical, display: displayCode(canonical), hash: b64u(await sha256(bytes)) };
  }
  async function parseRecoveryCode(input) {
    var s = normalizeCode(input);
    var bytes = await b32cDecode(s, 17);
    return { bytes: bytes, canonical: s, display: displayCode(s), hash: b64u(await sha256(bytes)) };
  }
  // Classify user input by length: 20 access ID, 48 invite code, 28 recovery code.
  function classifyCode(input) {
    var s;
    try { s = normalizeCode(input); } catch (e) { return 'unknown'; }
    return s.length === 20 ? 'access_id' : s.length === 48 ? 'invite' : s.length === 28 ? 'recovery' : 'unknown';
  }
  function makeKeyFile(o) { // {scope, accessId, vaultId, service?}
    var text = cjson({ access_id: o.accessId, scope: o.scope, service: o.service || SERVICE_URL, type: 'wds-keyfile', v: 1, vault: o.vaultId });
    return { text: text, filename: o.scope + '-' + o.accessId.slice(0, 4) + '.wds.json' };
  }
  async function parseKeyFile(text, o) { // {scope, service?} -> {accessId, vaultId}
    var doc;
    try { doc = JSON.parse(text); } catch (e) { throw new UsageError('key file is not valid JSON', { code: 'invalid_keyfile' }); }
    if (!doc || typeof doc !== 'object' || doc.type !== 'wds-keyfile') throw new UsageError('not a key file', { code: 'invalid_keyfile' });
    if (doc.v !== 1) throw new VersionError('unknown key file version');
    if (doc.service !== (o.service || SERVICE_URL)) throw new UsageError('key file belongs to a different service', { code: 'invalid_keyfile' });
    if (doc.scope !== o.scope) throw new UsageError('key file belongs to a different app', { code: 'invalid_keyfile' });
    await checkAccessId(doc.access_id);
    if (typeof doc.vault !== 'string' || !RE_VAULT.test(doc.vault)) throw new UsageError('key file has an invalid vault ID', { code: 'invalid_keyfile' });
    return { accessId: doc.access_id, vaultId: doc.vault };
  }

  // ------------------------------------------------------------------------------------------------------------
  // 6. Protocol client
  // ------------------------------------------------------------------------------------------------------------
  function memoryStorage() {
    var m = new Map();
    return {
      getItem: function (k) { return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(k, String(v)); },
      removeItem: function (k) { m.delete(k); },
    };
  }
  function defaultStorage() {
    try { if (root.localStorage) return root.localStorage; } catch (e) { /* access denied */ }
    return memoryStorage();
  }
  function last(a) { return a[a.length - 1]; }
  async function pool(items, n, fn) {
    var i = 0, results = new Array(items.length);
    async function worker() {
      while (i < items.length) { var k = i++; results[k] = await fn(items[k], k); }
    }
    var ws = [];
    for (var w = 0; w < Math.min(n, items.length); w++) ws.push(worker());
    await Promise.all(ws);
    return results;
  }
  var RE_SCOPE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*-[0-9a-hjkmnp-tv-z]{6}$/;

  // Build one keyring entry per slot of roster body (6.4). vmkMap: epoch -> 32 bytes.
  async function makeKeyring(scope, body, vmkMap, nk) {
    var epochs = body.commit.epochs.map(function (x) {
      var k = vmkMap.get(x.e);
      if (!k) throw new WDSError('missing key for committed epoch ' + x.e);
      return { e: x.e, k: k };
    });
    var plaintext = keyringPlaintext(epochs, nk), out = {};
    for (var i = 0; i < body.slots.length; i++) {
      var sl = body.slots[i], pub = b64uDecode(sl.e_pub, 65);
      out[sl.id] = b64u(await eciesSeal({ recipientPub: pub, plaintext: plaintext, aadTail: aadKeyring(scope, body.vault, sl.id, body.version, pub) }));
    }
    return out;
  }

  function Client(opts) {
    opts = opts || {};
    if (!RE_SCOPE.test(opts.scope || '')) throw new UsageError('invalid scope ID');
    this.scope = opts.scope;
    var service = opts.service || SERVICE_URL;
    this.service = service.slice(-1) === '/' ? service : service + '/';
    this.apiBase = this.service + 'api/v1';
    var f = opts.fetch || root.fetch;
    if (typeof f !== 'function') throw new WDSError('no fetch implementation available');
    this.fetch = opts.fetch ? opts.fetch : f.bind(root);
    this.storage = opts.storage || defaultStorage();
    this.now = opts.now || function () { return Date.now(); };
    this.argon2 = opts.argon2 || null;
    // A build that pins escrow keys ignores the options: app code cannot replace the pinned faculty escrow keys.
    if (BUILTIN_ESCROW_PINS.length) {
      if ((opts.escrowPins || opts.retiredEscrow) && typeof console !== 'undefined' && console.warn) console.warn('wds: the escrowPins and retiredEscrow options are ignored by a library build with pinned escrow keys');
      this.escrowPins = BUILTIN_ESCROW_PINS; this.retiredEscrow = BUILTIN_RETIRED_ESCROW;
    } else {
      this.escrowPins = opts.escrowPins || []; this.retiredEscrow = opts.retiredEscrow || [];
    }
    this.s = null;
    this._scopeInfo = null;
  }
  var CP = Client.prototype;

  // ---- HTTP ----
  CP._auth = function () {
    if (!this.s) throw new UsageError('locked: unlock the vault first', { code: 'locked' });
    return { accessId: this.s.accessId, token: this.s.token };
  };
  CP._req = async function (method, path, o) {
    o = o || {};
    var headers = Object.assign({}, o.headers), body = o.body;
    if (o.auth) headers.Authorization = bearerHeader(o.auth.accessId, o.auth.token);
    if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
    var res;
    try { res = await this.fetch(this.apiBase + path, { method: method, headers: headers, body: body }); }
    catch (e) { throw new OfflineError('network error: ' + (e && e.message ? e.message : e), { cause: e }); }
    if (res.ok) return res;
    throw await this._httpError(res);
  };
  CP._json = async function (method, path, o) {
    var res = await this._req(method, path, o);
    try { return await res.json(); } catch (e) { throw new IntegrityError('server sent invalid JSON'); }
  };
  CP._httpError = async function (res) {
    var b = null;
    try { b = await res.json(); } catch (e) { /* no body */ }
    var code = b && typeof b.error === 'string' ? b.error : null;
    var msg = (b && typeof b.message === 'string' ? b.message : 'HTTP ' + res.status) + (code ? ' (' + code + ')' : '');
    var props = { status: res.status, code: code, body: b, retryAfter: res.headers && res.headers.get ? res.headers.get('Retry-After') : null };
    var st = res.status;
    if (st === 401 || (st === 403 && code === 'forbidden') || st === 410) return new AuthError(msg, props);
    if (st === 412) return new ConflictError(msg, props);
    if (st === 413 || st === 507 || (st === 503 && code === 'read_only')) return new QuotaError(msg, props);
    return new RequestError(msg, props);
  };

  // ---- scope and escrow ----
  CP.getScopeInfo = async function (force) {
    if (this._scopeInfo && !force) return this._scopeInfo;
    var info = await this._json('GET', '/scopes/' + this.scope);
    if (!info || info.scope !== this.scope) throw new IntegrityError('scope information does not match');
    checkKdf(info.kdf, false);
    this._scopeInfo = info;
    return info;
  };
  CP._pickEscrow = async function (info) {
    if (!this.escrowPins.length) throw new WDSError('no escrow key IDs are pinned in this build of the library');
    var cur = (info.escrow || []).filter(function (x) { return x.status === 'current'; })[0];
    if (!cur) throw new IntegrityError('server offers no current escrow keys');
    var e = b64uDecode(cur.e_pub, 65), sp = b64uDecode(cur.s_pub, 65);
    checkPub(e); checkPub(sp);
    var id = await escrowKeyId(e, sp);
    if (id !== cur.id || this.escrowPins.indexOf(id) < 0) throw new IntegrityError('escrow keys offered by the server are not pinned', { code: 'escrow_not_pinned' });
    return { e_pub: cur.e_pub, s_pub: cur.s_pub, id: id };
  };
  CP._freshKdf = async function () {
    var info = await this.getScopeInfo();
    var k = checkKdf(info.kdf, false);
    k.salt = b64u(randomBytes(16));
    return checkKdf(k);
  };

  // ---- remembered access ID (not secret) ----
  // Stored as JSON {id, t}: t is the time (ms) the ID was first remembered on this device (creation or redemption), so a
  // sandbox can tell that the vault behind the ID was deleted by a nightly wipe.
  CP.rememberedAccess = function () {
    var raw = this.storage.getItem('wds:' + this.scope + ':access_id'), v = null;
    try { v = raw ? JSON.parse(raw) : null; } catch (e) { return null; }
    return v && typeof v === 'object' && typeof v.id === 'string' && RE_ACCESS.test(v.id) && Number.isFinite(v.t) ? { id: v.id, t: v.t } : null;
  };
  CP.rememberedAccessId = function () { var a = this.rememberedAccess(); return a ? a.id : null; };
  // t is when this device first remembered the ID (the creation or the redemption of the vault), not the last unlock: a sandbox
  // compares it with the last nightly wipe to see whether the vault is gone.
  CP.rememberAccessId = function (id) {
    var old = this.rememberedAccess();
    this.storage.setItem('wds:' + this.scope + ':access_id', JSON.stringify({ id: id, t: old && old.id === id ? old.t : this.now() }));
  };
  CP.forgetAccessId = function () { this.storage.removeItem('wds:' + this.scope + ':access_id'); };

  // ---- create vault ----
  CP.createVault = async function (o) { // {passphrase, joinCode?, recoveryContact?}
    var info = await this.getScopeInfo();
    var escrow = await this._pickEscrow(info);
    var kdf = await this._freshKdf();
    var kek = await argon2idKey(o.passphrase, kdf, this.argon2);
    for (var attempt = 0; ; attempt++) {
      try { return await this._createVaultOnce(escrow, kdf, kek, o); }
      catch (e) {
        if (e && e.status === 409 && ['vault_exists', 'access_id_taken', 'slot_id_taken'].indexOf(e.code) >= 0 && attempt < 3) continue;
        throw e;
      }
    }
  };
  CP._createVaultOnce = async function (escrow, kdf, kek, o) {
    var scope = this.scope;
    var fE = await generateKeyPair('E'), fS = await generateKeyPair('S');
    var vaultId = await vaultIdFromPub(fS.pub);
    var founderSlot = randomSlotId(), escrowSlot = randomSlotId();
    var accessId = await randomAccessId();
    var vmk1 = randomBytes(32), nk = randomBytes(32);
    var dk = await deriveVaultKeys(vmk1, nk);
    var rec = await makeRecoveryCode();
    var sk = await deriveSlotKeys(kek);
    var wrapped = await wrapSlot({ kWrapRaw: sk.kWrap, scope: scope, vault: vaultId, accessId: accessId, kdf: kdf, slotId: founderSlot, keySets: [{ e: fE, s: fS }] });
    var body = {
      commit: { epochs: [{ c: b64u(dk.cVmk), e: 1 }], nk: b64u(dk.cNk) }, epoch: 1, prev: '', scope: scope, signer: founderSlot,
      slots: [
        { e_pub: b64u(fE.pub), expires: null, id: founderSlot, kind: 'passphrase', role: 'owner', s_pub: b64u(fS.pub) },
        { e_pub: escrow.e_pub, expires: null, id: escrowSlot, kind: 'escrow', role: 'owner', s_pub: escrow.s_pub },
      ].sort(function (a, b) { return a.id < b.id ? -1 : 1; }),
      time: Math.floor(this.now() / 1000), type: 'roster', v: 1, vault: vaultId, version: 1,
    };
    var roster = await signRoster(body, await importPrivate('S', fS.d, fS.pub));
    var keyring = await makeKeyring(scope, body, new Map([[1, vmk1]]), nk);
    var req = {
      vault: vaultId, roster: roster,
      slots: [{ slot: founderSlot, access_id: accessId, kdf: kdf, token_hash: b64u(sk.tokenHash), wrapped: b64u(wrapped) }],
      keyring: keyring, recovery_hash: rec.hash,
      recovery_contact: o.recoveryContact || null, join_code: o.joinCode || null,
    };
    await this._json('POST', '/scopes/' + scope + '/vaults', { json: req });
    await this._openSession({ accessId: accessId, ikm: kek, kdf: kdf, expectedVault: vaultId });
    this.rememberAccessId(accessId);
    var kf = makeKeyFile({ scope: scope, accessId: accessId, vaultId: vaultId, service: this.service });
    return {
      accessId: accessId, accessIdDisplay: displayCode(accessId), vaultId: vaultId,
      recoveryCode: { canonical: rec.canonical, display: rec.display }, keyFile: kf, role: 'owner',
    };
  };

  // ---- unlock ----
  CP.unlock = async function (o) { // {accessId, passphrase, vaultId?}
    var accessId = await checkAccessId(typeof o.accessId === 'string' ? normalizeCode(o.accessId) : o.accessId);
    var k = await this._json('GET', '/slots/' + accessId + '/kdf');
    if (k.kind === 'invite') throw new UsageError('this ID belongs to an unredeemed invite; use redeemInvite', { code: 'invite_not_redeemed' });
    var kdf = checkKdf(k.kdf);
    var kek = await argon2idKey(o.passphrase, kdf, this.argon2);
    await this._openSession({ accessId: accessId, ikm: kek, kdf: kdf, expectedVault: o.vaultId, maintain: o.maintain });
    this.rememberAccessId(accessId);
    return this.status();
  };
  CP.lock = function () { this.s = null; };

  CP._openSession = async function (o) {
    var sk = await deriveSlotKeys(o.ikm);
    this.s = {
      accessId: o.accessId, token: sk.token, tokenHash: sk.tokenHash, kWrap: await aesKey(sk.kWrap), kdf: o.kdf, expectedVault: o.expectedVault || null,
      vaultId: null, slotId: null, chain: [], head: null, epoch: 0, role: null, kind: null, sv: 0, wrappedStr: null,
      keySets: null, activeIdx: 0, ePriv: null, sPriv: null,
      vmk: new Map(), nk: null, keys: null, encKeys: new Map(),
      pin: { rv: 0, head: '', epoch: 0 }, stateLoaded: false, stateStatus: null,
      seen: new Map(), known: new Map(), nameCache: new Map(), listed: new Map(), listedBytes: 0, persistChain: Promise.resolve(),
      serverSlots: {}, recovery: null, recoveredSlots: [], recoveryAck: false, rekeyPending: false, warnings: [],
    };
    try {
      await this._syncHead();
      if (o.maintain !== false) await this._maintain();
    } catch (e) { this.s = null; throw e; }
  };

  // Reload slot, roster and keyring, verify everything (called on unlock, after epoch changes and before roster edits).
  CP._syncHead = async function () {
    var s = this.s, scope = this.scope;
    for (var attempt = 0; attempt < 4; attempt++) {
      var auth = this._auth();
      var slotRes = await this._json('GET', '/slots/' + s.accessId, { auth: auth });
      if (slotRes.access_id !== s.accessId || slotRes.scope !== scope || typeof slotRes.vault !== 'string' || !RE_VAULT.test(slotRes.vault)) throw new IntegrityError('slot response does not match the request');
      if (s.expectedVault && s.expectedVault !== slotRes.vault) throw new IntegrityError('vault ID differs from the key file', { code: 'vault_mismatch' });
      if (s.vaultId && s.vaultId !== slotRes.vault) throw new IntegrityError('vault ID changed');
      if (cjson(checkKdf(slotRes.kdf)) !== cjson(s.kdf)) throw new IntegrityError('server changed the KDF descriptor');
      var vaultId = slotRes.vault;
      // unwrap (first time, or when the blob changed)
      var keySets = s.keySets;
      if (s.wrappedStr !== slotRes.wrapped) {
        var blob = await unwrapSlot({ kWrap: s.kWrap, scope: scope, vault: vaultId, accessId: s.accessId, kdf: s.kdf, envelope: b64uDecode(slotRes.wrapped) });
        if (blob.vault !== vaultId || blob.slot !== slotRes.slot) throw new IntegrityError('slot blob belongs to a different slot or vault');
        keySets = blob.keySets;
      }
      // roster
      var prior = s.chain.length ? last(s.chain) : null, since = prior ? prior.body.version : 0;
      var rr = await this._json('GET', '/vaults/' + vaultId + '/roster' + (since ? '?since=' + since : ''), { auth: auth });
      if (!rr || !Array.isArray(rr.versions) || !isInt(rr.head)) throw new IntegrityError('bad roster response');
      if (rr.head < since) throw new IntegrityError('roster rolled back by the server', { code: 'rollback' });
      var added = await verifyRosterChain({ scope: scope, vault: vaultId, escrowPins: this.escrowPins, retiredEscrow: this.retiredEscrow, docs: rr.versions, prior: prior });
      var chain = s.chain.concat(added), head = last(chain);
      if (!head || head.body.version !== rr.head || head.hash !== rr.head_hash) throw new IntegrityError('roster head does not match the verified chain', { code: 'rollback' });
      if (!slotRes.keyring || !isInt(slotRes.keyring.rv) || typeof slotRes.keyring.entry !== 'string') throw new IntegrityError('the server has no keyring entry for this slot', { code: 'keyring_mismatch' });
      if (slotRes.keyring.rv !== head.body.version) continue; // roster changed between the two requests
      // my entry and key set
      var entry = findSlot(head.body, slotRes.slot);
      if (!entry) throw new AuthError('this slot is no longer part of the vault', { code: 'revoked' });
      var idx = -1;
      for (var i = 0; i < keySets.length; i++) if (b64u(keySets[i].e.pub) === entry.e_pub && b64u(keySets[i].s.pub) === entry.s_pub) idx = i;
      if (idx < 0) throw new IntegrityError('slot keys do not match the signed roster', { code: 'keys_mismatch' });
      var ePub = keySets[idx].e.pub;
      var ePriv = await importPrivate('E', keySets[idx].e.d, ePub), sPriv = await importPrivate('S', keySets[idx].s.d, keySets[idx].s.pub);
      var plain = await eciesOpen({ recipientPriv: ePriv, recipientPub: ePub, envelope: b64uDecode(slotRes.keyring.entry), aadTail: aadKeyring(scope, vaultId, slotRes.slot, head.body.version, ePub) });
      var kr = parseKeyringPlaintext(plain);
      var wantEpochs = head.body.commit.epochs;
      if (kr.epochs.length !== wantEpochs.length) throw new IntegrityError('keyring entry does not list the committed epochs', { code: 'keyring_mismatch' });
      var vmk = new Map();
      for (var j = 0; j < wantEpochs.length; j++) {
        if (kr.epochs[j].e !== wantEpochs[j].e) throw new IntegrityError('keyring epochs differ from the roster', { code: 'keyring_mismatch' });
        var cv = b64u(await hkdf(kr.epochs[j].k, EMPTY, 'wds1/check/vmk'));
        if (cv !== wantEpochs[j].c) throw new IntegrityError('keyring entry fails the roster commitment', { code: 'keyring_mismatch' });
        vmk.set(kr.epochs[j].e, kr.epochs[j].k);
      }
      var vk = await deriveVaultKeys(null, kr.nk);
      if (b64u(vk.cNk) !== head.body.commit.nk) throw new IntegrityError('name key fails the roster commitment', { code: 'keyring_mismatch' });
      // commit to the session
      s.vaultId = vaultId; s.slotId = slotRes.slot; s.sv = slotRes.sv; s.wrappedStr = slotRes.wrapped;
      s.keySets = keySets; s.activeIdx = idx; s.ePriv = ePriv; s.sPriv = sPriv;
      if (!s.keys || !bytesEqual(s.nk, kr.nk)) {
        s.nk = kr.nk;
        // Only non-extractable CryptoKeys are kept for these three (NK, the VMKs and the private scalars stay raw: key building and re-wrapping need them).
        s.keys = { kIdKey: await hmacKey(vk.kId), kCommit: await hmacKey(vk.kCommit), kState: await hmacKey(vk.kState) };
      }
      if (!s.stateLoaded) await this._loadState(chain);
      this._checkPin(chain);
      s.chain = chain; s.head = head; s.epoch = head.body.epoch; s.role = entry.role; s.kind = entry.kind;
      s.vmk = vmk; s.encKeys = new Map();
      s.serverSlots = rr.slots || {}; s.recovery = slotRes.recovery || null; s.renewalPending = !!slotRes.renewal_pending;
      s.escrowRetired = this.escrowPins.indexOf(head.escrowId) < 0; // the head still names a retired escrow set: an owner replaces it (_migrateEscrow)
      s.rekeyPending = entry.role === 'owner' && head.body.commit.epochs.length > 1;
      s.recoveredSlots = [];
      for (var c = 1; c < chain.length; c++) {
        if (!chain[c].signedByEscrow) continue;
        for (var q = 0; q < chain[c].body.slots.length; q++) {
          var cand = chain[c].body.slots[q];
          if (!findSlot(chain[c - 1].body, cand.id) && findSlot(head.body, cand.id)) s.recoveredSlots.push(cand.id);
        }
      }
      if (head.body.version > s.pin.rv || (head.body.epoch > s.pin.epoch)) {
        s.pin = { rv: head.body.version, head: head.hash, epoch: Math.max(head.body.epoch, s.pin.epoch) };
        await this._persist();
      }
      return;
    }
    throw new WDSError('roster kept changing while loading; try again');
  };
  CP._stateKeyName = function () { return 'wds:' + this.scope + ':' + this.s.accessId + ':state'; };
  CP._loadState = async function () {
    var s = this.s, raw = this.storage.getItem(this._stateKeyName());
    s.stateLoaded = true;
    if (raw === null || raw === undefined) { s.stateStatus = 'new'; return; }
    var st = await openState(s.keys.kState, raw);
    if (!st || !isInt(st.rv) || !isInt(st.epoch) || typeof st.head !== 'string' || !Array.isArray(st.records)) { s.stateStatus = 'invalid'; return; }
    if (st.scope !== this.scope || st.vault !== s.vaultId || st.access !== s.accessId || st.slot !== s.slotId) { s.stateStatus = 'invalid'; return; }
    s.stateStatus = 'ok';
    s.pin = { rv: st.rv, head: st.head, epoch: st.epoch };
    st.records.forEach(function (r) { if (Array.isArray(r) && typeof r[0] === 'string' && isInt(r[1])) s.seen.set(r[0], r[1]); });
  };
  CP._checkPin = function (chain) {
    var s = this.s, pin = s.pin;
    if (!pin.rv) return;
    if (chain.length < pin.rv) throw new IntegrityError('the server presented an older roster than this device has seen', { code: 'rollback' });
    if (chain[pin.rv - 1].hash !== pin.head) throw new IntegrityError('the roster differs from the one this device has seen', { code: 'rollback' });
    if (last(chain).body.epoch < pin.epoch) throw new IntegrityError('epoch rolled back', { code: 'rollback' });
  };
  CP._persist = function () {
    var self = this, s = this.s;
    if (!s || !s.keys) return Promise.resolve();
    s.persistChain = s.persistChain.then(async function () {
      var recs = Array.from(s.seen.entries()).sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
      var state = { access: s.accessId, epoch: s.pin.epoch, head: s.pin.head, records: recs, rv: s.pin.rv, scope: self.scope, slot: s.slotId, vault: s.vaultId };
      try { self.storage.setItem(self._stateKeyName(), await sealState(s.keys.kState, state)); } catch (e) { /* storage full or denied */ }
    });
    return s.persistChain;
  };
  CP._see = function (rid, version) {
    var s = this.s;
    if (version > (s.seen.get(rid) || 0)) s.seen.set(rid, version);
  };
  CP._checkSeen = function (rid, version) {
    var prev = this.s.seen.get(rid) || 0;
    if (version < prev) throw new IntegrityError('record version rolled back by the server', { code: 'rollback' });
  };

  CP.status = function () {
    var s = this.s;
    if (!s) return { unlocked: false };
    return {
      unlocked: true, scope: this.scope, accessId: s.accessId, vaultId: s.vaultId, slotId: s.slotId, role: s.role, kind: s.kind,
      epoch: s.epoch, rosterVersion: s.head.body.version, rekeyPending: s.rekeyPending,
      recoveredByFaculty: s.chain.some(function (c) { return c.signedByEscrow; }), escrowRetired: !!s.escrowRetired,
      recoverySlots: s.recoveredSlots.slice(), stateStatus: s.stateStatus, newDevice: s.stateStatus !== 'ok',
      recovery: s.recovery, warnings: s.warnings.slice(), renewalPending: s.renewalPending,
    };
  };
  CP._need = function (role) {
    var s = this.s;
    if (!s) throw new UsageError('locked: unlock the vault first', { code: 'locked' });
    if (role === 'owner' && s.role !== 'owner') throw new AuthError('this action needs an owner slot', { code: 'forbidden' });
    if (role === 'write' && s.role === 'read') throw new AuthError('this slot is read-only', { code: 'forbidden' });
  };

  // ---- records ----
  CP._rid = async function (name) { checkRecordName(name); return b64u(await hmacSign(this.s.keys.kIdKey, utf8(name))); };
  CP._encKey = async function (epoch) {
    var s = this.s, k = s.encKeys.get(epoch);
    if (k) return k;
    var vmk = s.vmk.get(epoch);
    if (!vmk) return null;
    k = await aesKey(await hkdf(vmk, EMPTY, 'wds1/record-enc'));
    s.encKeys.set(epoch, k);
    return k;
  };
  CP._fetchRecord = async function (rid, version) {
    var s = this.s;
    var path = '/vaults/' + s.vaultId + '/records/' + rid + (version ? '/versions/' + version : '');
    var res;
    try { res = await this._req('GET', path, { auth: this._auth() }); }
    catch (e) {
      if (e.status === 404 && e.code === 'deleted' && e.body && isInt(e.body.version)) return { deleted: true, version: e.body.version };
      if (e.status === 404) return null;
      throw e;
    }
    var m = /^"(\d+)"$/.exec(res.headers.get('ETag') || '');
    var commit = res.headers.get('WDS-Commit');
    if (!m || !commit) throw new IntegrityError('record response lacks ETag or commitment');
    var v = Number(m[1]);
    if (version && v !== version) throw new IntegrityError('server returned a different version than requested');
    return { version: v, commit: commit, bytes: new Uint8Array(await res.arrayBuffer()) };
  };
  CP._openFetched = async function (rid, name, f) {
    var s = this.s;
    var env = parseEnvelope(f.bytes, T_RECORD);
    var key = await this._encKey(env.epoch);
    if (!key) { await this._syncHead(); key = await this._encKey(env.epoch); }
    if (!key) throw new IntegrityError('no key for epoch ' + env.epoch + ' in the keyring', { code: 'missing_epoch' });
    var pt = await openEnvelope(key, env, aadRecord(this.scope, s.vaultId, rid, f.version));
    if (f.commit !== await commitment(s.keys.kCommit, rid, f.version, pt)) throw new IntegrityError('history commitment does not match', { code: 'commit_mismatch' });
    var rec = parseRecordPlaintext(pt, name);
    if (name === undefined && (await this._rid(rec.name)) !== rid) throw new IntegrityError('record name does not match its ID');
    rec.version = f.version; rec.epoch = env.epoch; rec.length = rec.body.length;
    return rec;
  };
  function publicRecord(r) {
    return { name: r.name, version: r.version, kind: r.kind, mime: r.mime, time: r.time, length: r.length, epoch: r.epoch, value: r.value };
  }
  // What the name cache keeps: metadata only (bodies of attachments must not pile up in memory).
  function recordMeta(r) {
    return { name: r.name, version: r.version, kind: r.kind, mime: r.mime, time: r.time, length: r.length, epoch: r.epoch };
  }
  // A record that list() downloaded is kept for a short time, so that the get() that follows a list() does not download it a second
  // time. The entry is used once, only for the version that list() saw, and only while nothing else touched the record.
  var LISTED_TTL_MS = 30000, LISTED_MAX_ONE = 1048576, LISTED_MAX_ALL = 16777216;
  CP._dropListed = function (rid) {
    var s = this.s, h = s.listed.get(rid);
    if (h) { s.listed.delete(rid); s.listedBytes -= h.size; }
  };
  CP._keepListed = function (rid, rec) {
    var s = this.s, size = rec.length;
    this._dropListed(rid);
    if (size > LISTED_MAX_ONE || s.listedBytes + size > LISTED_MAX_ALL) return;
    s.listed.set(rid, { rec: rec, size: size, t: this.now() });
    s.listedBytes += size;
  };
  CP._takeListed = function (rid, name) {
    var s = this.s, h = s.listed.get(rid), k = s.known.get(rid);
    if (!h) return null;
    this._dropListed(rid);
    if (this.now() - h.t > LISTED_TTL_MS || h.rec.name !== name || !k || k.deleted || k.version !== h.rec.version) return null;
    return h.rec;
  };
  // opts.fresh: read from the server even when list() just downloaded the record (the list cache).
  CP.getRecord = async function (name, opts) {
    this._need('read');
    var s = this.s, rid = await this._rid(name);
    if (opts && opts.fresh) this._dropListed(rid);
    var held = this._takeListed(rid, name);
    if (held) {
      this._checkSeen(rid, held.version);
      s.nameCache.set(rid, recordMeta(held));
      this._see(rid, held.version);
      await this._persist();
      return publicRecord(held);
    }
    var f = await this._fetchRecord(rid);
    if (!f) return null;
    this._checkSeen(rid, f.version);
    if (f.deleted) { s.known.set(rid, { version: f.version, deleted: true }); s.nameCache.delete(rid); return null; }
    var rec = await this._openFetched(rid, name, f);
    s.known.set(rid, { version: f.version, deleted: false });
    s.nameCache.set(rid, recordMeta(rec));
    this._see(rid, f.version);
    await this._persist();
    return publicRecord(rec);
  };
  CP.get = async function (name, opts) {
    var r = await this.getRecord(name, opts);
    return r === null ? undefined : r.value;
  };
  async function encodeValue(value, opts) {
    var kind, body, mime = opts && opts.mime;
    if (value === undefined) throw new UsageError('cannot store undefined');
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) { kind = 'bytes'; body = toBytes(value); }
    else if (typeof Blob !== 'undefined' && value instanceof Blob) {
      kind = 'bytes'; body = new Uint8Array(await value.arrayBuffer());
      if (!mime && value.type) mime = value.type;
    } else {
      var text = JSON.stringify(value);
      if (text === undefined) throw new UsageError('value is not JSON-serialisable');
      kind = 'json'; body = utf8(text);
    }
    return { kind: kind, body: body, mime: kind === 'bytes' ? mime : undefined };
  }
  CP.put = async function (name, value, opts) {
    opts = opts || {};
    if (Object.prototype.hasOwnProperty.call(opts, 'base') && opts.base === undefined) throw new UsageError('put: base is undefined; pass a version number, null (must not exist), or leave it out');
    this._need('write');
    var s = this.s, enc = await encodeValue(value, opts);
    var info = this._scopeInfo;
    if (info && info.limits && isInt(info.limits.max_value_bytes) && enc.body.length > info.limits.max_value_bytes) {
      throw new QuotaError('value larger than the limit of ' + info.limits.max_value_bytes + ' bytes', { code: 'value_too_large', limit: info.limits.max_value_bytes });
    }
    var rid = await this._rid(name);
    for (var attempt = 0; ; attempt++) {
      var k = s.known.get(rid);
      var base = opts.base !== undefined ? opts.base : (k ? k.version : null);
      var version = base === null ? 1 : base + 1;
      var built = buildRecordPlaintext(name, enc.kind, enc.body, enc.mime, this.now());
      var env = await sealRecord({ key: await this._encKey(s.epoch), epoch: s.epoch, scope: this.scope, vault: s.vaultId, rid: rid, version: version, plaintext: built.plaintext });
      var headers = { 'Content-Type': 'application/octet-stream', 'WDS-Commit': await commitment(s.keys.kCommit, rid, version, built.plaintext) };
      if (base === null) headers['If-None-Match'] = '*'; else headers['If-Match'] = '"' + base + '"';
      var res;
      try { res = await this._req('PUT', '/vaults/' + s.vaultId + '/records/' + rid, { auth: this._auth(), headers: headers, body: env }); }
      catch (e) {
        if (e.status === 409 && e.code === 'epoch_changed' && attempt === 0) { await this._syncHead(); continue; }
        if (e.status === 412) throw await this._conflict(name, rid, { value: value, kind: enc.kind, mime: enc.mime }, e);
        throw e;
      }
      var r;
      try { r = await res.json(); } catch (e2) { throw new IntegrityError('server sent invalid JSON'); }
      if (r.version !== version) throw new IntegrityError('server stored a different version than requested');
      this._dropListed(rid);
      s.known.set(rid, { version: version, deleted: false });
      s.nameCache.set(rid, { name: name, kind: enc.kind, mime: enc.mime === undefined ? null : enc.mime, time: this.now(), length: enc.body.length, version: version, epoch: s.epoch });
      this._see(rid, version);
      await this._persist();
      return { name: name, version: version, size: r.size, epoch: s.epoch };
    }
  };
  CP._conflict = async function (name, rid, mine, err) {
    var s = this.s, theirs = null, f = await this._fetchRecord(rid);
    if (f && f.deleted) { theirs = { version: f.version, deleted: true }; s.known.set(rid, { version: f.version, deleted: true }); }
    else if (f) {
      this._checkSeen(rid, f.version);
      var rec = await this._openFetched(rid, name, f);
      theirs = { version: f.version, deleted: false, kind: rec.kind, mime: rec.mime, time: rec.time, value: rec.value };
      s.known.set(rid, { version: f.version, deleted: false });
      s.nameCache.set(rid, recordMeta(rec));
      this._see(rid, f.version);
    }
    return new ConflictError('Another device or person changed "' + name + '" in the meantime', {
      status: 412, code: 'precondition_failed', record: name, rid: rid, mine: mine, theirs: theirs, current: theirs ? theirs.version : null, body: err.body,
    });
  };
  CP.delete = async function (name, opts) {
    opts = opts || {};
    this._need('write');
    var s = this.s, rid = await this._rid(name), base = opts.base;
    if (base === undefined) {
      var k = s.known.get(rid);
      if (k && k.deleted) return false;
      if (k) base = k.version;
      else {
        var f = await this._fetchRecord(rid);
        if (!f || f.deleted) return false;
        base = f.version;
      }
    }
    var res;
    try { res = await this._req('DELETE', '/vaults/' + s.vaultId + '/records/' + rid, { auth: this._auth(), headers: { 'If-Match': '"' + base + '"' } }); }
    catch (e) {
      if (e.status === 412) throw await this._conflict(name, rid, { deleted: true }, e);
      throw e;
    }
    var r = await res.json();
    if (r.version !== base + 1) throw new IntegrityError('server stored a different version than requested');
    this._dropListed(rid);
    s.known.set(rid, { version: r.version, deleted: true });
    s.nameCache.delete(rid);
    this._see(rid, r.version);
    await this._persist();
    return true;
  };
  CP.remove = CP.delete;

  // Lists live records: [{name, version, kind, mime, length, time, epoch}] filtered by name prefix, sorted by name.
  // Names are only known inside the encrypted records, so every new or changed record is downloaded once per session.
  CP.list = async function (prefix) {
    this._need('read');
    var s = this.s, entries = [], after = null;
    do {
      var r = await this._json('GET', '/vaults/' + s.vaultId + '/records?limit=1000' + (after ? '&after=' + encodeURIComponent(after) : ''), { auth: this._auth() });
      if (!r || !Array.isArray(r.records)) throw new IntegrityError('bad record list');
      entries = entries.concat(r.records);
      after = r.next || null;
    } while (after);
    var self = this, live = [], now = this.now();
    s.listed.forEach(function (h, rid) { if (now - h.t > LISTED_TTL_MS) self._dropListed(rid); });
    entries.forEach(function (e) {
      self._checkSeen(e.id, e.version);
      if (e.deleted) { s.nameCache.delete(e.id); s.known.set(e.id, { version: e.version, deleted: true }); } else live.push(e);
    });
    var out = await pool(live, 4, async function (e) {
      var c = s.nameCache.get(e.id);
      if (!c || c.version !== e.version) {
        var f = await self._fetchRecord(e.id);
        if (!f || f.deleted) return null;
        self._checkSeen(e.id, f.version);
        var full = await self._openFetched(e.id, undefined, f);
        c = recordMeta(full);
        s.nameCache.set(e.id, c);
        self._keepListed(e.id, full);
      }
      s.known.set(e.id, { version: c.version, deleted: false });
      self._see(e.id, c.version);
      return publicRecord(c);
    });
    await this._persist();
    prefix = prefix || '';
    return out.filter(function (r) { return r !== null && r.name.startsWith(prefix); }).map(function (r) { delete r.value; return r; })
      .sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  };
  CP.readAll = async function (prefix) {
    var names = await this.list(prefix), out = [];
    for (var i = 0; i < names.length; i++) { var r = await this.getRecord(names[i].name); if (r) out.push(r); }
    return out;
  };

  CP.history = async function (name) {
    this._need('read');
    var s = this.s, rid = await this._rid(name);
    var h = await this._json('GET', '/vaults/' + s.vaultId + '/records/' + rid + '/versions', { auth: this._auth() });
    if (!h || !Array.isArray(h.versions) || h.id !== rid) throw new IntegrityError('bad history response');
    return { name: name, current: h.current, versions: h.versions.map(function (v) {
      return { version: v.version, epoch: v.epoch, size: v.size, created: v.created, deleted: !!v.deleted, commit: v.commit || null };
    }) };
  };
  CP.getVersion = async function (name, version) {
    this._need('read');
    var rid = await this._rid(name), f = await this._fetchRecord(rid, version);
    if (!f) return null;
    if (f.deleted) return { name: name, version: f.version, deleted: true };
    return publicRecord(await this._openFetched(rid, name, f));
  };
  CP.restore = async function (name, version) {
    this._need('write');
    var old = await this.getVersion(name, version);
    if (!old || old.deleted) throw new UsageError('that version does not hold a value', { code: 'not_restorable' });
    var h = await this.history(name);
    var value = old.kind === 'bytes' ? old.value : old.value;
    return this.put(name, value, { base: h.current, mime: old.mime === null ? undefined : old.mime });
  };
  CP.deleteHistory = async function (name) {
    this._need('owner');
    var rid = await this._rid(name);
    return this._json('DELETE', '/vaults/' + this.s.vaultId + '/records/' + rid + '/versions', { auth: this._auth() });
  };
  // Records this session has read or written whose version on the server is newer than the known one (cheap: only the
  // record list, nothing is downloaded). Returns [{name|null, version, known, deleted}].
  // opts.names: record names that count as known at version 0 when this session has not seen them yet (a collection index that did not exist
  // when it was loaded), so that their first appearance is reported too.
  CP.checkRemote = async function (opts) {
    this._need('read');
    var s = this.s, after = null, out = [], watch = new Map();
    var names = (opts && opts.names) || [];
    for (var wi = 0; wi < names.length; wi++) watch.set(await this._rid(names[wi]), names[wi]);
    do {
      var r = await this._json('GET', '/vaults/' + s.vaultId + '/records?limit=1000' + (after ? '&after=' + encodeURIComponent(after) : ''), { auth: this._auth() });
      if (!r || !Array.isArray(r.records)) throw new IntegrityError('bad record list');
      for (var i = 0; i < r.records.length; i++) {
        var e = r.records[i], k = s.known.get(e.id);
        if (!k && watch.has(e.id) && !e.deleted) out.push({ name: watch.get(e.id), version: e.version, known: 0, deleted: false });
        else if (k && e.version > k.version) {
          var c = s.nameCache.get(e.id);
          out.push({ name: c ? c.name : null, version: e.version, known: k.version, deleted: !!e.deleted });
        }
      }
      after = r.next || null;
    } while (after);
    return out;
  };
  // Owner: cancel a pending faculty recovery request (DELETE /vaults/{v}/recovery).
  CP.cancelRecovery = async function () {
    this._need('owner');
    var r = await this._json('DELETE', '/vaults/' + this.s.vaultId + '/recovery', { auth: this._auth() });
    if (this.s) this.s.recovery = null;
    return r;
  };
  CP.usage = async function () { this._need('read'); return this._json('GET', '/vaults/' + this.s.vaultId + '/usage', { auth: this._auth() }); };
  CP.deleteVault = async function () {
    this._need('owner');
    var r = await this._json('DELETE', '/vaults/' + this.s.vaultId, { auth: this._auth() });
    this.s = null;
    return r;
  };

  // ---- roster editing (owner) ----
  // change(body, ctx): mutates the draft (next version, prev/hash/signer/time already set). ctx: {vmk: Map, nk, newSlots: [], session}.
  CP._commitRoster = async function (change) {
    this._need('owner');
    var s = this.s;
    for (var attempt = 0; attempt < 4; attempt++) {
      await this._syncHead();
      var head = s.head;
      if (s.recoveredSlots.some(function (id) { return id !== s.slotId; }) && !s.recoveryAck) {
        throw new UsageError('this vault was recovered by the faculty; acknowledge the added owner first', { code: 'recovery_unacknowledged' });
      }
      var body = cloneJson(head.body);
      body.version = head.body.version + 1; body.prev = head.hash; body.time = Math.floor(this.now() / 1000); body.signer = s.slotId;
      var ctx = { vmk: new Map(s.vmk), nk: s.nk, newSlots: [], session: s };
      await change(body, ctx);
      // Keyring entries are encrypted to the escrow slot: never to a retired (possibly leaked) key.
      if (this.escrowPins.indexOf(await bodyEscrowId(body)) < 0) throw new UsageError('the escrow keys of this vault are retired; they are replaced first', { code: 'escrow_retired' });
      body.slots.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      body.commit.epochs.sort(function (a, b) { return a.e - b.e; });
      var keyring = await makeKeyring(this.scope, body, ctx.vmk, ctx.nk);
      var roster = await signRoster(body, s.sPriv);
      var req = { roster: roster, keyring: keyring };
      if (ctx.newSlots.length) req.new_slots = ctx.newSlots;
      var res;
      try { res = await this._json('POST', '/vaults/' + s.vaultId + '/roster', { auth: this._auth(), json: req }); }
      catch (e) { if (e.status === 409 && e.code === 'roster_conflict') continue; throw e; }
      await this._syncHead();
      return res;
    }
    throw new WDSError('the roster changed concurrently too often; try again');
  };
  CP.acknowledgeRecovery = function () { this._need('owner'); this.s.recoveryAck = true; };

  // Members as the owner sees them: roster entry plus the server's view of each slot.
  CP.members = function () {
    var s = this.s, me = this;
    if (!s) throw new UsageError('locked', { code: 'locked' });
    return s.head.body.slots.map(function (sl) {
      var st = s.serverSlots[sl.id] || {};
      return {
        slotId: sl.id, role: sl.role, kind: sl.kind, expires: sl.expires, self: sl.id === s.slotId, escrow: sl.kind === 'escrow',
        revocable: s.role === 'owner' && me._mayRevoke(sl),
        used: !!st.used, redeemed: st.redeemed || null, expired: !!st.expired, renewalPending: !!st.renewal,
        addedByEscrow: s.recoveredSlots.indexOf(sl.id) >= 0,
      };
    });
  };

  CP.createInvite = async function (o) { // {role: 'write'|'read', expiresIn: seconds}
    o = o || {};
    this._need('owner');
    var role = o.role || 'write';
    if (role !== 'write' && role !== 'read') throw new UsageError('invites are for write or read access');
    var expiresIn = o.expiresIn === undefined ? 172800 : o.expiresIn;
    if (!Number.isInteger(expiresIn) || expiresIn < 3600 || expiresIn > 14 * 86400) throw new UsageError('invite expiry must be between 1 hour and 14 days');
    for (var attempt = 0; ; attempt++) {
      var s = this.s;
      var e = await generateKeyPair('E'), sg = await generateKeyPair('S');
      var secret = randomBytes(17), idBytes = randomBytes(12), accessId = await b32cEncode(idBytes), slotId = randomSlotId();
      var sk = await deriveSlotKeys(secret), kdf = { alg: 'invite' };
      var wrapped = await wrapSlot({ kWrapRaw: sk.kWrap, scope: this.scope, vault: s.vaultId, accessId: accessId, kdf: kdf, slotId: slotId, keySets: [{ e: e, s: sg }] });
      var expires = Math.floor(this.now() / 1000) + expiresIn;
      try {
        await this._commitRoster(function (body, ctx) {
          body.slots.push({ e_pub: b64u(e.pub), expires: expires, id: slotId, kind: 'invite', role: role, s_pub: b64u(sg.pub) });
          ctx.newSlots.push({ slot: slotId, access_id: accessId, kdf: kdf, token_hash: b64u(sk.tokenHash), wrapped: b64u(wrapped) });
        });
      } catch (err) {
        if (err && err.status === 409 && (err.code === 'slot_id_taken' || err.code === 'access_id_taken') && attempt < 3) continue;
        throw err;
      }
      var code = await makeInviteCode(idBytes, secret);
      return { code: code, accessId: accessId, slotId: slotId, role: role, expires: expires };
    }
  };

  // Redeem an invite code: choose a passphrase, re-wrap the slot keys, announce fresh keys. Leaves the vault unlocked.
  CP.redeemInvite = async function (o) { // {inviteCode, passphrase}
    var p = await parseInviteCode(o.inviteCode);
    var k = await this._json('GET', '/slots/' + p.accessId + '/kdf');
    if (k.kind !== 'invite') throw new RequestError('this invite was already redeemed', { status: 409, code: 'already_redeemed' });
    var inv = await deriveSlotKeys(p.secret), auth = { accessId: p.accessId, token: inv.token }, kdfInv = { alg: 'invite' };
    var slotRes = await this._json('GET', '/slots/' + p.accessId, { auth: auth });
    if (slotRes.access_id !== p.accessId || slotRes.scope !== this.scope || !RE_VAULT.test(slotRes.vault || '')) throw new IntegrityError('slot response does not match the request');
    var blob = await unwrapSlot({ kWrapRaw: inv.kWrap, scope: this.scope, vault: slotRes.vault, accessId: p.accessId, kdf: kdfInv, envelope: b64uDecode(slotRes.wrapped) });
    if (blob.vault !== slotRes.vault || blob.slot !== slotRes.slot || blob.keySets.length !== 1) throw new IntegrityError('invite blob does not match the slot');
    var rr = await this._json('GET', '/vaults/' + slotRes.vault + '/roster', { auth: auth });
    var chain = await verifyRosterChain({ scope: this.scope, vault: slotRes.vault, escrowPins: this.escrowPins, retiredEscrow: this.retiredEscrow, docs: rr.versions || [], prior: null });
    var head = last(chain);
    if (!head || head.body.version !== rr.head || head.hash !== rr.head_hash) throw new IntegrityError('roster head does not match the verified chain');
    var entry = findSlot(head.body, slotRes.slot), old = blob.keySets[0];
    if (!entry || entry.kind !== 'invite' || entry.e_pub !== b64u(old.e.pub) || entry.s_pub !== b64u(old.s.pub)) throw new IntegrityError('invite keys do not match the signed roster', { code: 'keys_mismatch' });
    var eN = await generateKeyPair('E'), sN = await generateKeyPair('S');
    var rbody = { e_pub: b64u(eN.pub), rv: head.body.version, s_pub: b64u(sN.pub), scope: this.scope, slot: slotRes.slot, type: 'renewal', v: 1, vault: slotRes.vault };
    var renewal = await signRoster(rbody, await importPrivate('S', old.s.d, old.s.pub)); // same {body, sig} shape
    var kdf = await this._freshKdf();
    var kek = await argon2idKey(o.passphrase, kdf, this.argon2);
    var sk = await deriveSlotKeys(kek);
    var wrapped = await wrapSlot({ kWrapRaw: sk.kWrap, scope: this.scope, vault: slotRes.vault, accessId: p.accessId, kdf: kdf, slotId: slotRes.slot, keySets: [old, { e: eN, s: sN }] });
    await this._json('POST', '/slots/' + p.accessId + '/redeem', { auth: auth, json: { kdf: kdf, token_hash: b64u(sk.tokenHash), wrapped: b64u(wrapped), renewal: renewal } });
    await this._openSession({ accessId: p.accessId, ikm: kek, kdf: kdf, expectedVault: slotRes.vault, maintain: o.maintain });
    this.rememberAccessId(p.accessId);
    return Object.assign(this.status(), { keyFile: makeKeyFile({ scope: this.scope, accessId: p.accessId, vaultId: slotRes.vault, service: this.service }) });
  };

  CP._rewrap = async function (keySets) {
    var s = this.s;
    var wrapped = await wrapSlot({ kWrap: s.kWrap, scope: this.scope, vault: s.vaultId, accessId: s.accessId, kdf: s.kdf, slotId: s.slotId, keySets: keySets });
    var res;
    try { res = await this._json('PUT', '/slots/' + s.accessId, { auth: this._auth(), headers: { 'If-Match': '"' + s.sv + '"' }, json: { kdf: s.kdf, token_hash: b64u(s.tokenHash), wrapped: b64u(wrapped) } }); }
    catch (e) { if (e.status === 412) return false; throw e; }
    s.sv = res.sv; s.wrappedStr = b64u(wrapped); s.keySets = keySets; s.activeIdx = 0;
    return true;
  };
  // Light maintenance after unlock: drop superseded key sets, adopt pending renewals (owner).
  CP._maintain = async function () {
    var s = this.s;
    try {
      if (s.keySets.length === 2 && s.activeIdx === 1) await this._rewrap([s.keySets[1]]);
      if (s.role === 'owner' && s.escrowRetired) await this._migrateEscrow();
      if (s.role === 'owner') await this.adoptRenewals();
      if (s.role === 'owner') await this._dropExpiredInvites();
    } catch (e) {
      if (e instanceof OfflineError || e instanceof RequestError || e instanceof ConflictError) s.warnings.push('maintenance failed: ' + e.message);
      else if (e instanceof UsageError && e.code === 'recovery_unacknowledged') s.warnings.push('maintenance skipped until the recovery notice is acknowledged');
      else if (e instanceof IntegrityError && e.code === 'escrow_not_pinned') s.warnings.push('escrow migration skipped: ' + e.message);
      else throw e;
    }
  };
  // Owner: the head roster names an escrow key set that this library has retired. Switch the escrow slot to the
  // current pinned set the server offers (owner-signed; PROTOCOL 6.3 (c)); the keyring entry for the escrow slot is
  // re-encrypted to the new key by the normal keyring rule (6.4). Returns true when a roster version was written.
  CP._migrateEscrow = async function () {
    this._need('owner');
    var esc = await this._pickEscrow(await this.getScopeInfo(true));
    await this._syncHead();
    if (!this.s.escrowRetired) return false;
    await this._commitRoster(function (body) {
      var sl = bodyEscrow(body);
      sl.e_pub = esc.e_pub; sl.s_pub = esc.s_pub;
    });
    return true;
  };
  CP.maintain = async function () { this._need('read'); await this._syncHead(); await this._maintain(); return this.status(); };

  async function verifyRenewal(doc, entry, head, scope) {
    try {
      var b = doc && doc.body;
      if (!b || Object.keys(b).sort().join(',') !== 'e_pub,rv,s_pub,scope,slot,type,v,vault') return false;
      if (b.type !== 'renewal' || b.v !== 1 || b.scope !== scope || b.vault !== head.vault || b.slot !== entry.id) return false;
      if (!isInt(b.rv) || b.rv > head.version) return false;
      checkPub(b64uDecode(b.e_pub, 65)); checkPub(b64uDecode(b.s_pub, 65));
      return await ecdsaVerify(b64uDecode(entry.s_pub, 65), b64uDecode(doc.sig, 64), cjsonBytes(b));
    } catch (e) { return false; }
  }
  // Owner: sign pending key renewals of members (and of this slot) into a new roster version.
  CP.adoptRenewals = async function () {
    this._need('owner');
    var s = this.s, head = s.head.body, todo = [], ids = Object.keys(s.serverSlots || {});
    for (var i = 0; i < ids.length; i++) {
      var st = s.serverSlots[ids[i]], entry = findSlot(head, ids[i]);
      if (!st || !st.renewal || !entry || entry.kind === 'escrow') continue;
      // An owner slot adopts its own renewal only (PROTOCOL 6.3): another owner's keys are never signed in by someone else.
      if (entry.role === 'owner' && ids[i] !== s.slotId) continue;
      if (!(await verifyRenewal(st.renewal, entry, head, this.scope))) { s.warnings.push('ignored an invalid key renewal'); continue; }
      var b = st.renewal.body;
      if (b.e_pub === entry.e_pub && b.s_pub === entry.s_pub) continue;
      todo.push({ id: ids[i], e_pub: b.e_pub, s_pub: b.s_pub, redeemed: st.redeemed });
    }
    if (!todo.length) return { adopted: 0 };
    await this._commitRoster(function (body) {
      todo.forEach(function (t) {
        var sl = findSlot(body, t.id);
        if (!sl) return;
        sl.e_pub = t.e_pub; sl.s_pub = t.s_pub;
        if (sl.kind === 'invite' && t.redeemed) { sl.kind = 'passphrase'; sl.expires = null; }
      });
    });
    return { adopted: todo.length };
  };
  // Replace this slot's key pairs (members announce, owners sign it in directly).
  CP.renewKeys = async function () {
    this._need('read');
    await this._syncHead(); // make sure the active key set is the one the head roster lists
    var s = this.s, e = await generateKeyPair('E'), sg = await generateKeyPair('S');
    var sets = [s.keySets[s.activeIdx], { e: e, s: sg }];
    var wrapped = await wrapSlot({ kWrap: s.kWrap, scope: this.scope, vault: s.vaultId, accessId: s.accessId, kdf: s.kdf, slotId: s.slotId, keySets: sets });
    if (s.role === 'owner') {
      var r = await this._json('PUT', '/slots/' + s.accessId, { auth: this._auth(), headers: { 'If-Match': '"' + s.sv + '"' }, json: { kdf: s.kdf, token_hash: b64u(s.tokenHash), wrapped: b64u(wrapped) } });
      s.sv = r.sv; s.wrappedStr = b64u(wrapped); s.keySets = sets; s.activeIdx = 0;
      var slotId = s.slotId;
      await this._commitRoster(function (body) { var sl = findSlot(body, slotId); sl.e_pub = b64u(e.pub); sl.s_pub = b64u(sg.pub); });
      if (s.keySets.length === 2 && s.activeIdx === 1) await this._rewrap([s.keySets[1]]);
    } else {
      var rbody = { e_pub: b64u(e.pub), rv: s.head.body.version, s_pub: b64u(sg.pub), scope: this.scope, slot: s.slotId, type: 'renewal', v: 1, vault: s.vaultId };
      var renewal = await signRoster(rbody, s.sPriv);
      var r2 = await this._json('POST', '/slots/' + s.accessId + '/renewal', { auth: this._auth(), headers: { 'If-Match': '"' + s.sv + '"' }, json: { renewal: renewal, wrapped: b64u(wrapped) } });
      s.sv = r2.sv; s.wrappedStr = b64u(wrapped); s.keySets = sets; s.activeIdx = 0;
    }
    return this.status();
  };
  CP.changePassphrase = async function (newPassphrase) {
    this._need('read');
    var s = this.s, kdf = await this._freshKdf();
    var kek = await argon2idKey(newPassphrase, kdf, this.argon2), sk = await deriveSlotKeys(kek);
    var wrapped = await wrapSlot({ kWrapRaw: sk.kWrap, scope: this.scope, vault: s.vaultId, accessId: s.accessId, kdf: kdf, slotId: s.slotId, keySets: s.keySets });
    var r = await this._json('PUT', '/slots/' + s.accessId, { auth: this._auth(), headers: { 'If-Match': '"' + s.sv + '"' }, json: { kdf: kdf, token_hash: b64u(sk.tokenHash), wrapped: b64u(wrapped) } });
    s.token = sk.token; s.tokenHash = sk.tokenHash; s.kWrap = await aesKey(sk.kWrap); s.kdf = kdf; s.sv = r.sv; s.wrappedStr = b64u(wrapped);
    return { sv: r.sv };
  };

  // ---- members: revoke, cancel, roles ----
  CP.revoke = async function (slotIds, o) {
    o = o || {};
    this._need('owner');
    var ids = Array.isArray(slotIds) ? slotIds.slice() : [slotIds], s = this.s, self = this;
    if (!ids.length) throw new UsageError('nothing to revoke');
    ids.forEach(function (id) {
      var sl = findSlot(s.head.body, id);
      if (!sl) throw new UsageError('unknown slot', { code: 'unknown_slot' });
      if (sl.kind === 'escrow') throw new UsageError('the escrow slot cannot be revoked', { code: 'forbidden_target' });
      if (id === s.slotId) throw new UsageError('an owner cannot revoke its own slot', { code: 'forbidden_target' });
      if (!self._mayRevoke(sl)) throw new UsageError('this owner slot cannot be revoked by this owner (PLAN 5.7)', { code: 'forbidden_target' });
    });
    await this._commitRoster(async function (body, ctx) {
      body.slots = body.slots.filter(function (x) { return ids.indexOf(x.id) < 0; });
      var e = body.epoch + 1, vmk = randomBytes(32), dk = await deriveVaultKeys(vmk, null);
      ctx.vmk.set(e, vmk);
      body.epoch = e;
      body.commit.epochs.push({ c: b64u(dk.cVmk), e: e });
    });
    if (o.rekey === false) return { done: false, rekeyed: 0 };
    return this.resumeRekey(o);
  };
  // PLAN 5.7: members (write, read) can always be revoked by an owner. Owner slots only like this: an owner may revoke an
  // owner slot that escrow added (recovery), and an escrow-added owner may revoke any other owner slot (so a user who
  // recovers after losing a device can cut off the old credential). The two original-style owners never evict each other.
  CP._mayRevoke = function (sl) {
    var s = this.s;
    if (!sl || sl.kind === 'escrow' || sl.id === s.slotId) return false;
    if (sl.role !== 'owner') return true;
    return s.recoveredSlots.indexOf(sl.id) >= 0 || s.recoveredSlots.indexOf(s.slotId) >= 0;
  };
  // Withdraw an invite. An invite that was never used is simply removed from the roster. Any request with the invite
  // token marks it as used on the server (the first request of a redemption, an aborted redemption, or someone who
  // intercepted the code), and that very response contains the keyring entry with the vault keys. Such an invite can
  // only be withdrawn like a member: by a revocation (new epoch and re-encryption, see revoke()), which is what this
  // method does when the server reports the invite as used or answers 409 revocation_required. With
  // {revoke: false} it throws that RequestError instead (the UI asks for a confirmation first). Other options are
  // those of revoke(). Returns {revoked: bool} (plus {done, rekeyed} after a revocation).
  CP.cancelInvite = async function (slotId, o) {
    o = o || {};
    this._need('owner');
    await this._syncHead(); // fresh server view of used/redeemed
    var s = this.s, sl = findSlot(s.head.body, slotId);
    if (!sl || sl.kind !== 'invite') throw new UsageError('not an invite', { code: 'unknown_slot' });
    var used = !!(s.serverSlots[slotId] && s.serverSlots[slotId].used);
    if (!used) {
      try {
        await this._commitRoster(function (body) {
          var x = findSlot(body, slotId);
          if (!x || x.kind !== 'invite') throw new UsageError('not an invite', { code: 'unknown_slot' });
          body.slots = body.slots.filter(function (y) { return y.id !== slotId; });
        });
        return { revoked: false };
      } catch (e) {
        if (!(e && e.status === 409 && e.code === 'revocation_required')) throw e;
        // the invite was used between the two requests: fall through to the revocation
      }
    }
    if (o.revoke === false) throw new RequestError('this invite was used; withdrawing it needs a revocation', { status: 409, code: 'revocation_required' });
    var r = await this.revoke([slotId], o);
    return Object.assign({ revoked: true }, r);
  };
  // Owner, after unlock: remove invite slots that expired without being redeemed. The server cannot do this itself:
  // it never signs, and every roster version needs an owner's signature, which clients verify along the whole chain
  // (PROTOCOL 6.3). Until an owner unlocks, an expired invite is already dead: its token answers 410 invite_expired.
  // Invites that were never used are removed in one version without a new epoch. If one of them was used, the
  // cleanup is a revocation (epoch + 1); its re-encryption is left to the resumable rekey (rekeyPending) so that the
  // unlock does not wait for it. Owner invites (added by the faculty) are never removed automatically.
  CP._dropExpiredInvites = async function () {
    var s = this.s, ids = [], used = false;
    s.head.body.slots.forEach(function (sl) {
      var st = s.serverSlots[sl.id];
      if (sl.kind !== 'invite' || sl.role === 'owner' || !st || !st.expired || st.redeemed) return;
      ids.push(sl.id);
      if (st.used) used = true;
    });
    if (!ids.length) return 0;
    if (used) await this.revoke(ids, { rekey: false });
    else {
      await this._commitRoster(function (body) {
        body.slots = body.slots.filter(function (x) { return ids.indexOf(x.id) < 0 || x.kind !== 'invite'; });
      });
    }
    return ids.length;
  };
  CP.setRole = async function (slotId, role) {
    this._need('owner');
    if (role !== 'write' && role !== 'read') throw new UsageError('role must be write or read');
    await this._commitRoster(function (body) {
      var sl = findSlot(body, slotId);
      if (!sl || sl.role === 'owner') throw new UsageError('role of this slot cannot change', { code: 'forbidden_target' });
      sl.role = role;
    });
  };

  // ---- re-encryption after revocation (resumable) ----
  CP._rekeyOne = async function (item, cur) {
    var s = this.s;
    var f = await this._fetchRecord(item.id, item.version);
    if (!f || f.deleted) return false;
    var env = parseEnvelope(f.bytes, T_RECORD);
    if (env.epoch >= cur) return false;
    var oldKey = await this._encKey(env.epoch);
    if (!oldKey) throw new IntegrityError('no key for epoch ' + env.epoch, { code: 'missing_epoch' });
    var pt = await openEnvelope(oldKey, env, aadRecord(this.scope, s.vaultId, item.id, f.version));
    if (f.commit !== await commitment(s.keys.kCommit, item.id, f.version, pt)) throw new IntegrityError('history commitment does not match; refusing to re-encrypt', { code: 'commit_mismatch' });
    var out = await sealRecord({ key: await this._encKey(cur), epoch: cur, scope: this.scope, vault: s.vaultId, rid: item.id, version: f.version, plaintext: pt });
    try {
      await this._req('PUT', '/vaults/' + s.vaultId + '/records/' + item.id + '/versions/' + f.version + '/rekey',
        { auth: this._auth(), headers: { 'Content-Type': 'application/octet-stream', 'If-Match': '"e' + env.epoch + '"' }, body: out });
    } catch (e) {
      if (e.status === 412) return false; // somebody else was faster
      if (e.status === 409 && e.code === 'epoch_changed') return 'epoch_changed';
      throw e;
    }
    return true;
  };
  // o: {maxItems, onProgress({rekeyed, remaining}), dropOld}. Returns {done, rekeyed}.
  CP.resumeRekey = async function (o) {
    o = o || {};
    this._need('owner');
    var s = this.s, rekeyed = 0, passes = 0;
    outer: for (;;) {
      await this._syncHead();
      var cur = s.epoch;
      if (!s.rekeyPending) return { done: true, rekeyed: rekeyed };
      var after = null;
      do {
        var page = await this._json('GET', '/vaults/' + s.vaultId + '/rekey?limit=500' + (after ? '&after=' + encodeURIComponent(after) : ''), { auth: this._auth() });
        if (page.epoch !== cur) continue outer;
        for (var i = 0; i < page.items.length; i++) {
          if (o.maxItems !== undefined && rekeyed >= o.maxItems) return { done: false, rekeyed: rekeyed };
          var r = await this._rekeyOne(page.items[i], cur);
          if (r === 'epoch_changed') continue outer;
          if (r) rekeyed++;
          if (o.onProgress) o.onProgress({ rekeyed: rekeyed, remaining: Math.max(0, page.remaining - i - 1) });
        }
        after = page.next || null;
      } while (after);
      var check = await this._json('GET', '/vaults/' + s.vaultId + '/rekey?limit=1', { auth: this._auth() });
      if (check.items.length === 0) break;
      if (++passes >= 3) throw new WDSError('re-encryption did not converge');
    }
    if (o.dropOld !== false) await this._dropOldEpochs();
    return { done: true, rekeyed: rekeyed };
  };
  // The client's own check that no stored blob uses an old epoch (does not trust the server's count).
  CP._verifyNoOldEpochs = async function () {
    var s = this.s, cur = s.epoch, after = null, ids = [];
    do {
      var r = await this._json('GET', '/vaults/' + s.vaultId + '/records?limit=1000' + (after ? '&after=' + encodeURIComponent(after) : ''), { auth: this._auth() });
      for (var i = 0; i < r.records.length; i++) {
        var e = r.records[i];
        if (e.epoch !== null && e.epoch !== undefined && e.epoch < cur) return false;
        if (e.version > 1) ids.push(e.id);
      }
      after = r.next || null;
    } while (after);
    var self = this, bad = false;
    await pool(ids, 6, async function (id) {
      var h = await self._json('GET', '/vaults/' + s.vaultId + '/records/' + id + '/versions', { auth: self._auth() });
      h.versions.forEach(function (v) { if (v.epoch !== null && v.epoch !== undefined && v.epoch < cur) bad = true; });
    });
    return !bad;
  };
  CP._dropOldEpochs = async function () {
    if (!(await this._verifyNoOldEpochs())) throw new WDSError('blobs with old epochs remain; not dropping old keys', { code: 'old_epoch_blobs' });
    await this._commitRoster(function (body) {
      body.commit.epochs = body.commit.epochs.filter(function (x) { return x.e === body.epoch; });
    });
  };

  // low-level building blocks (tests, test vectors, tools such as wds-recover); not part of the app API and not exported
  // by the production bundle
  var internals = {
    b64u: b64u, b64uDecode: b64uDecode, hex: hex, unhex: unhex, concat: concat, u32: u32, lp: lp, ascii: ascii, utf8: utf8,
    bytesEqual: bytesEqual, b32cEncode: b32cEncode, b32cDecode: b32cDecode, plainCrockford: plainCrockford,
    cjson: cjson, cjsonBytes: cjsonBytes, cjsonParse: cjsonParse, padme: padme,
    sha256: sha256, hkdf: hkdf, hmac: hmac, aesKey: aesKey, aesSeal: aesSeal, aesOpen: aesOpen,
    generateKeyPair: generateKeyPair, importPrivate: importPrivate, importPublic: importPublic, ecdh: ecdh, ecdsaSign: ecdsaSign, ecdsaVerify: ecdsaVerify,
    argon2idKey: argon2idKey, checkKdf: checkKdf, DEFAULT_KDF: DEFAULT_KDF, KDF_WINDOW: KDF_WINDOW,
    envHeader: envHeader, parseEnvelope: parseEnvelope, sealEnvelope: sealEnvelope, openEnvelope: openEnvelope,
    aadRecord: aadRecord, aadSlot: aadSlot, aadKeyring: aadKeyring,
    deriveSlotKeys: deriveSlotKeys, deriveVaultKeys: deriveVaultKeys, recordId: recordId, commitment: commitment, bearerHeader: bearerHeader,
    checkRecordName: checkRecordName, buildRecordPlaintext: buildRecordPlaintext, parseRecordPlaintext: parseRecordPlaintext,
    sealRecord: sealRecord, openRecord: openRecord, slotPlaintext: slotPlaintext, wrapSlot: wrapSlot, unwrapSlot: unwrapSlot,
    eciesSeal: eciesSeal, eciesOpen: eciesOpen, keyringPlaintext: keyringPlaintext, parseKeyringPlaintext: parseKeyringPlaintext,
    makeKeyring: makeKeyring, vaultIdFromPub: vaultIdFromPub, escrowKeyId: escrowKeyId,
    rosterHash: rosterHash, signRoster: signRoster, verifyRosterChain: verifyRosterChain, verifyRenewal: verifyRenewal,
    makeInviteCode: makeInviteCode, makeRecoveryCode: makeRecoveryCode, sealState: sealState, openState: openState,
    randomBytes: randomBytes, randomSlotId: randomSlotId, randomAccessId: randomAccessId,
  };

  var api = {
    version: VERSION, SERVICE_URL: SERVICE_URL, Client: Client,
    errors: { WDSError: WDSError, ConflictError: ConflictError, OfflineError: OfflineError, QuotaError: QuotaError, AuthError: AuthError, IntegrityError: IntegrityError, VersionError: VersionError, RequestError: RequestError, UsageError: UsageError },
    ConflictError: ConflictError, OfflineError: OfflineError, QuotaError: QuotaError, AuthError: AuthError, IntegrityError: IntegrityError, VersionError: VersionError, RequestError: RequestError, UsageError: UsageError, WDSError: WDSError,
    memoryStorage: memoryStorage,
    // codes and key file (usable without a Client)
    parseInviteCode: parseInviteCode, parseRecoveryCode: parseRecoveryCode, classifyCode: classifyCode, normalizeCode: normalizeCode,
    displayCode: displayCode, makeKeyFile: makeKeyFile, parseKeyFile: parseKeyFile, checkAccessId: checkAccessId,
  };
  if (!PRODUCTION) {
    api.setArgon2 = setArgon2; api.setRandom = setRandom; api.internals = internals;
  } else {
    Object.freeze(api.errors); Object.freeze(api);
  }
  return api;
});
