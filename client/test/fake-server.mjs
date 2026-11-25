// In-memory fake of the WIAI Datastore API (PROTOCOL.md section 8), used by the client tests.
// It enforces the server-side rules the client relies on (preconditions, roster rules, epochs, keyring completeness)
// but, like the real server, never verifies signatures or decrypts anything.
import { createRequire } from 'node:module';
import { createHash, timingSafeEqual } from 'node:crypto';
const require = createRequire(import.meta.url);
const core = require('../src/wds-core.js');
const I = core.internals;

class HttpError extends Error {
  constructor(status, code, extra, headers) { super(code); this.status = status; this.code = code; this.extra = extra || {}; this.headers = headers || {}; }
}
const fail = (status, code, extra, headers) => { throw new HttpError(status, code, extra, headers); };
const sha256b64 = (bytes) => I.b64u(createHash('sha256').update(bytes).digest());
const last = (a) => a[a.length - 1];

export class FakeServer {
  constructor(opts = {}) {
    this.service = opts.service || 'https://wiai.test/datastore/';
    this.nowFn = opts.now || (() => Math.floor(Date.now() / 1000));
    this.scopes = new Map();
    this.vaults = new Map();
    this.access = new Map(); // access id -> {vault, slotId}
    this.revoked = new Set();
    this.escrow = null;
    this.requests = []; // log of {method, path}
    this.beforeRequest = null; // hook(method, path) may throw to simulate a network failure
    this.delayMs = 0; // artificial latency of every request (concurrency tests)
    this.inflight = 0; this.maxInflight = 0; // requests being served right now, and the maximum seen since resetInflight()
    this.failPreconditions = null; // predicate(rid): answer every record PUT of that record with 412 (conflict-cap tests)
    this.fetch = this.fetch.bind(this);
  }
  now() { return this.nowFn(); }
  resetInflight() { this.maxInflight = 0; }
  // The nightly wipe of a sandbox: every vault and access ID of the scope is gone.
  wipe(scopeId) {
    for (const [id, v] of Array.from(this.vaults)) {
      if (v.scope !== scopeId) continue;
      for (const [aid, ref] of Array.from(this.access)) if (ref.vault === id) this.access.delete(aid);
      this.vaults.delete(id);
    }
  }
  setEscrow(current, spare) { this.escrow = { current, spare }; }
  addScope(o = {}) {
    const slug = o.slug || 'testapp';
    const id = slug + '-' + (o.suffix || 'k7m2a9');
    const limits = Object.assign({ history_versions: 10, max_value_bytes: 10485760, vault_bytes: 209715200, scope_bytes: 2147483648, max_vaults: 50 }, o.limits || {});
    this.scopes.set(id, { id, name: o.name || 'Test', status: 'active', enrollment: o.enrollment || 'open', join_code: o.join_code || null, limits, sandbox: o.sandbox || null, hibp: o.hibp });
    return id;
  }
  scopeLimits(scope) {
    const l = scope.limits;
    return { history_versions: l.history_versions, max_envelope_bytes: I.padme(4 + 2048 + l.max_value_bytes) + 38, max_value_bytes: l.max_value_bytes, vault_bytes: l.vault_bytes };
  }

  async fetch(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    this.requests.push({ method, path: u.pathname + u.search });
    if (this.beforeRequest) this.beforeRequest(method, u.pathname + u.search);
    const headers = new Map(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body = init.body;
    if (typeof body === 'string') body = new TextEncoder().encode(body);
    const prefix = new URL(this.service).pathname + 'api/v1';
    if (!u.pathname.startsWith(prefix)) return new Response('not found', { status: 404 });
    const path = u.pathname.slice(prefix.length);
    this.inflight++; this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      if (this.delayMs) await new Promise((res) => setTimeout(res, this.delayMs));
      const r = await this.route(method, path, u.searchParams, headers, body);
      return this.respond(r.status || 200, r.json !== undefined ? JSON.stringify(r.json) : r.bytes, Object.assign(r.json !== undefined ? { 'content-type': 'application/json' } : { 'content-type': 'application/octet-stream' }, r.headers || {}));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return this.respond(e.status, JSON.stringify(Object.assign({ error: e.code, message: e.code }, e.extra)), Object.assign({ 'content-type': 'application/json' }, e.headers));
    } finally { this.inflight--; }
  }
  respond(status, body, headers) {
    return new Response(body, { status, headers: Object.assign({ 'access-control-allow-origin': '*', 'cache-control': 'no-store' }, headers) });
  }
  json(headers) {
    return headers;
  }
  parseJson(body) {
    try { return JSON.parse(new TextDecoder().decode(body)); } catch (e) { return fail(400, 'bad_request'); }
  }

  // ---- auth ----
  authenticate(headers, pathAccessId) {
    const h = headers.get('authorization') || '';
    const m = /^Bearer wds1\.([0-9A-HJKMNP-TV-Z]{20})\.([A-Za-z0-9_-]{43})$/.exec(h);
    if (!m) fail(401, 'unauthorized', {}, { 'www-authenticate': 'Bearer realm="wds"' });
    const accessId = m[1];
    if (this.revoked.has(accessId)) fail(401, 'revoked');
    const ref = this.access.get(accessId);
    if (!ref) fail(401, 'unauthorized');
    const vault = this.vaults.get(ref.vault), slot = vault.slots.get(ref.slotId);
    const given = createHash('sha256').update(I.b64uDecode(m[2], 32)).digest();
    const want = I.b64uDecode(slot.tokenHash, 32);
    if (!timingSafeEqual(given, want)) fail(401, 'unauthorized');
    if (slot.expires !== null && !slot.redeemed && slot.expires <= this.now()) fail(410, 'invite_expired');
    slot.used = true;
    if (pathAccessId && pathAccessId !== accessId) fail(403, 'forbidden');
    return { accessId, vault, slot };
  }
  roleOf(vault, slotId) {
    const e = last(vault.rosters).body.slots.find((s) => s.id === slotId);
    return e ? e.role : null;
  }
  needRole(auth, level) {
    const role = this.roleOf(auth.vault, auth.slot.slotId);
    const ok = level === 'any' ? !!role : level === 'write' ? role === 'owner' || role === 'write' : role === 'owner';
    if (!ok) fail(403, 'forbidden');
  }
  vaultAuth(headers, vaultId) {
    const auth = this.authenticate(headers);
    if (auth.vault.id !== vaultId) fail(403, 'forbidden');
    if (auth.vault.deleted) fail(410, 'vault_deleted');
    return auth;
  }
  slotJson(vault, slot) {
    const head = last(vault.rosters);
    const role = this.roleOf(vault, slot.slotId);
    return {
      access_id: slot.accessId, slot: slot.slotId, vault: vault.id, scope: vault.scope, kind: slot.kind, role, sv: slot.sv,
      kdf: slot.kdf, wrapped: slot.wrapped, expires: slot.expires,
      keyring: { rv: vault.keyringVersion, entry: vault.keyring.get(slot.slotId) },
      epoch: vault.epoch, roster: { version: head.body.version, head: head.hash },
      renewal_pending: !!slot.renewal, recovery: this.roleOf(vault, slot.slotId) === 'owner' ? (vault.recovery || null) : null,
    };
  }

  // ---- routing ----
  async route(method, path, q, headers, body) {
    let m;
    if ((m = /^\/scopes\/([^/]+)$/.exec(path)) && method === 'GET') return this.getScope(m[1]);
    if ((m = /^\/scopes\/([^/]+)\/vaults$/.exec(path)) && method === 'POST') return this.createVault(m[1], this.parseJson(body));
    if ((m = /^\/slots\/([^/]+)\/kdf$/.exec(path)) && method === 'GET') return this.getKdf(m[1]);
    if ((m = /^\/slots\/([^/]+)$/.exec(path))) {
      if (method === 'GET') { const a = this.authenticate(headers, m[1]); this.checkVaultAlive(a.vault); return { json: this.slotJson(a.vault, a.slot) }; }
      if (method === 'PUT') return this.putSlot(headers, m[1], body);
    }
    if ((m = /^\/slots\/([^/]+)\/redeem$/.exec(path)) && method === 'POST') return this.redeem(headers, m[1], body);
    if ((m = /^\/slots\/([^/]+)\/renewal$/.exec(path)) && method === 'POST') return this.renewal(headers, m[1], body);
    if ((m = /^\/vaults\/([^/]+)(\/.*)?$/.exec(path))) return this.vaultRoute(method, m[1], m[2] || '', q, headers, body);
    return fail(404, 'not_found');
  }
  checkVaultAlive(vault) { if (vault.deleted) fail(410, 'vault_deleted'); }

  getScope(id) {
    const s = this.scopes.get(id);
    if (!s) fail(404, 'not_found');
    const esc = (e, status) => ({ id: e.id, e_pub: e.e_pub, s_pub: e.s_pub, status });
    return { json: {
      scope: s.id, name: s.name, status: s.status, enrollment: s.enrollment, hibp: s.hibp === undefined ? true : s.hibp, read_only: false,
      limits: this.scopeLimits(s), kdf: { alg: 'argon2id', m: 65536, p: 1, t: 3, v: 19 },
      escrow: [esc(this.escrow.current, 'current'), esc(this.escrow.spare, 'spare')],
      library: { latest: '1.0.0', deprecated: [] }, privacy_url: this.service + 'privacy/',
      sandbox: s.sandbox ? Object.assign({ enabled: true, wipe_at: '03:30', timezone: 'Europe/Berlin', next_wipe: this.now() + 6 * 3600, last_wipe: null }, s.sandbox) : null,
    } };
  }
  getKdf(accessId) {
    if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(accessId)) fail(400, 'bad_request');
    const ref = this.access.get(accessId);
    if (!ref || this.revoked.has(accessId)) fail(404, 'not_found');
    const slot = this.vaults.get(ref.vault).slots.get(ref.slotId);
    return { json: { kind: slot.kind, kdf: slot.kdf } };
  }

  escrowOk(slot) {
    return [this.escrow.current, this.escrow.spare].some((e) => e.e_pub === slot.e_pub && e.s_pub === slot.s_pub);
  }
  checkKeyring(body, keyring) {
    const ids = body.slots.map((s) => s.id).sort();
    const got = Object.keys(keyring || {}).sort();
    if (JSON.stringify(ids) !== JSON.stringify(got)) fail(400, 'invalid_keyring');
    for (const id of ids) {
      let b; try { b = I.b64uDecode(keyring[id]); } catch (e) { fail(400, 'invalid_keyring'); }
      if (b.length < 103 || b.length > 16384 || b[4] !== 3) fail(400, 'invalid_keyring');
    }
  }
  createVault(scopeId, req) {
    const scope = this.scopes.get(scopeId);
    if (!scope) fail(404, 'not_found');
    if (scope.status !== 'active') fail(403, 'scope_suspended');
    if (scope.enrollment === 'closed') fail(403, 'enrollment_closed');
    if (scope.enrollment === 'join_code') {
      const norm = (req.join_code || '').toUpperCase().replace(/[ -]/g, '');
      if (norm !== scope.join_code) fail(403, 'join_code_invalid');
    }
    const body = req.roster && req.roster.body;
    if (!body || body.version !== 1 || body.scope !== scopeId || body.vault !== req.vault) fail(400, 'invalid_roster', { detail: 'basic structure' });
    if (body.slots.length !== 2 || body.epoch !== 1 || body.prev !== '') fail(400, 'invalid_roster', { detail: 'version 1 shape' });
    const esc = body.slots.filter((s) => s.kind === 'escrow');
    if (esc.length !== 1 || !this.escrowOk(esc[0])) fail(400, 'invalid_roster', { detail: 'escrow' });
    const founder = body.slots.find((s) => s.id === body.signer);
    if (!founder || I.plainCrockford(createHash('sha256').update(I.b64uDecode(founder.s_pub)).digest(), 26) !== req.vault) fail(400, 'invalid_roster', { detail: 'vault id' });
    if (!Array.isArray(req.slots) || req.slots.length !== 1 || req.slots[0].slot !== founder.id) fail(400, 'bad_request');
    this.checkKeyring(body, req.keyring);
    if (typeof req.recovery_hash !== 'string' || I.b64uDecode(req.recovery_hash).length !== 32) fail(400, 'bad_request');
    if (this.vaults.has(req.vault)) fail(409, 'vault_exists');
    const sl = req.slots[0];
    if (this.access.has(sl.access_id)) fail(409, 'access_id_taken');
    const count = Array.from(this.vaults.values()).filter((v) => v.scope === scopeId).length;
    if (count >= scope.limits.max_vaults) fail(403, 'vault_limit_reached');
    const hash = sha256b64(I.cjsonBytes(body));
    const vault = {
      id: req.vault, scope: scopeId, created: this.now(), deleted: null, epoch: 1, rosters: [{ body, sig: req.roster.sig, hash }],
      keyring: new Map(Object.entries(req.keyring)), keyringVersion: 1, slots: new Map(), usedSlotIds: new Set([body.slots[0].id, body.slots[1].id]),
      records: new Map(), recoveryHash: req.recovery_hash,
    };
    vault.slots.set(sl.slot, { slotId: sl.slot, accessId: sl.access_id, kdf: sl.kdf, tokenHash: sl.token_hash, wrapped: sl.wrapped, sv: 1, kind: 'passphrase', used: false, redeemed: null, expires: null, renewal: null });
    this.vaults.set(vault.id, vault);
    this.access.set(sl.access_id, { vault: vault.id, slotId: sl.slot });
    return { status: 201, json: { vault: vault.id, epoch: 1, roster_version: 1, head: hash } };
  }

  putSlot(headers, accessId, body) {
    const a = this.authenticate(headers, accessId); this.checkVaultAlive(a.vault);
    const slot = a.slot;
    if (slot.kind !== 'passphrase') fail(409, 'not_redeemed');
    this.checkIfMatch(headers, slot.sv, () => ({ current: slot.sv }));
    const req = this.parseJson(body);
    if (!req.kdf || !req.token_hash || !req.wrapped) fail(400, 'bad_request');
    try { core.internals.checkKdf(req.kdf); } catch (e) { fail(400, 'bad_request'); }
    slot.kdf = req.kdf; slot.tokenHash = req.token_hash; slot.wrapped = req.wrapped; slot.sv++;
    return { json: { sv: slot.sv } };
  }
  checkIfMatch(headers, current, extra) {
    const im = headers.get('if-match');
    if (im === undefined) fail(428, 'precondition_required');
    const m = /^"(\d+)"$/.exec(im);
    if (!m) fail(400, 'bad_request');
    if (Number(m[1]) !== current) fail(412, 'precondition_failed', extra());
  }
  redeem(headers, accessId, body) {
    const a = this.authenticate(headers, accessId); this.checkVaultAlive(a.vault);
    const slot = a.slot, vault = a.vault;
    if (slot.kind !== 'invite' || slot.redeemed) fail(409, 'already_redeemed');
    const req = this.parseJson(body);
    const rb = req.renewal && req.renewal.body;
    const head = last(vault.rosters);
    if (!rb || rb.slot !== slot.slotId || rb.vault !== vault.id || rb.scope !== vault.scope || rb.rv > head.body.version) fail(400, 'bad_request');
    slot.kdf = req.kdf; slot.tokenHash = req.token_hash; slot.wrapped = req.wrapped; slot.renewal = req.renewal;
    slot.redeemed = this.now(); slot.kind = 'passphrase'; slot.sv++;
    return { json: { sv: slot.sv } };
  }
  renewal(headers, accessId, body) {
    const a = this.authenticate(headers, accessId); this.checkVaultAlive(a.vault);
    this.checkIfMatch(headers, a.slot.sv, () => ({ current: a.slot.sv }));
    const req = this.parseJson(body);
    a.slot.renewal = req.renewal; a.slot.wrapped = req.wrapped; a.slot.sv++;
    return { json: { sv: a.slot.sv } };
  }

  // ---- vault routes ----
  vaultRoute(method, vaultId, rest, q, headers, body) {
    const auth = this.vaultAuth(headers, vaultId), vault = auth.vault;
    let m;
    if (rest === '' && method === 'DELETE') {
      this.needRole(auth, 'owner');
      vault.deleted = this.now();
      return { json: { deleted: vault.deleted, purge_after: vault.deleted + 2592000 } };
    }
    if (rest === '/recovery' && method === 'DELETE') {
      this.needRole(auth, 'owner');
      if (!vault.recovery) fail(404, 'not_found');
      vault.recovery = null;
      return { json: { cancelled: true } };
    }
    if (rest === '/roster') {
      if (method === 'GET') { this.needRole(auth, 'any'); return this.getRoster(vault, q); }
      if (method === 'POST') { this.needRole(auth, 'owner'); return this.postRoster(vault, auth, this.parseJson(body)); }
    }
    if (rest === '/records' && method === 'GET') { this.needRole(auth, 'any'); return this.listRecords(vault, q); }
    if (rest === '/usage' && method === 'GET') { this.needRole(auth, 'any'); return this.usage(vault); }
    if (rest === '/rekey' && method === 'GET') { this.needRole(auth, 'owner'); return this.listRekey(vault, q); }
    if ((m = /^\/records\/([A-Za-z0-9_-]{43})$/.exec(rest))) {
      if (method === 'GET') { this.needRole(auth, 'any'); return this.getVersionResponse(vault, m[1], null); }
      if (method === 'PUT') { this.needRole(auth, 'write'); return this.putRecord(vault, m[1], headers, body); }
      if (method === 'DELETE') { this.needRole(auth, 'write'); return this.deleteRecord(vault, m[1], headers); }
    }
    if ((m = /^\/records\/([A-Za-z0-9_-]{43})\/versions$/.exec(rest))) {
      if (method === 'GET') { this.needRole(auth, 'any'); return this.history(vault, m[1]); }
      if (method === 'DELETE') { this.needRole(auth, 'owner'); return this.purgeHistory(vault, m[1]); }
    }
    if ((m = /^\/records\/([A-Za-z0-9_-]{43})\/versions\/(\d+)$/.exec(rest)) && method === 'GET') { this.needRole(auth, 'any'); return this.getVersionResponse(vault, m[1], Number(m[2])); }
    if ((m = /^\/records\/([A-Za-z0-9_-]{43})\/versions\/(\d+)\/rekey$/.exec(rest)) && method === 'PUT') { this.needRole(auth, 'owner'); return this.rekey(vault, m[1], Number(m[2]), headers, body); }
    return fail(404, 'not_found');
  }

  getRoster(vault, q) {
    const since = Number(q.get('since') || 0);
    const head = last(vault.rosters);
    const slots = {};
    for (const s of head.body.slots) {
      if (s.kind === 'escrow') continue;
      const st = vault.slots.get(s.id);
      slots[s.id] = { used: st.used, redeemed: st.redeemed, expired: st.expires !== null && !st.redeemed && st.expires <= this.now(), renewal: st.renewal };
    }
    return { json: { head: head.body.version, head_hash: head.hash, epoch: vault.epoch,
      versions: vault.rosters.filter((r) => r.body.version > since).map((r) => ({ body: r.body, sig: r.sig })), slots } };
  }
  blobsUsingEpoch(vault, epoch) {
    for (const rec of vault.records.values()) for (const v of rec.versions) if (!v.deleted && v.epoch === epoch) return true;
    return false;
  }
  postRoster(vault, auth, req) {
    const head = last(vault.rosters), body = req.roster && req.roster.body, now = this.now();
    if (!body) fail(400, 'bad_request');
    if (this.conflictOnce) { this.conflictOnce = false; fail(409, 'roster_conflict', { head: head.body.version, head_hash: head.hash }); }
    if (body.version !== head.body.version + 1 || body.prev !== head.hash) fail(409, 'roster_conflict', { head: head.body.version, head_hash: head.hash });
    const bad = (detail) => fail(400, 'invalid_roster', { detail });
    if (body.vault !== vault.id || body.scope !== vault.scope || body.type !== 'roster' || body.v !== 1) bad('identity');
    if (body.epoch !== vault.epoch && body.epoch !== vault.epoch + 1) bad('epoch');
    const signer = head.body.slots.find((s) => s.id === body.signer);
    if (!signer || signer.role !== 'owner') bad('signer');
    if (body.signer !== auth.slot.slotId && signer.kind !== 'escrow') bad('signer is not the caller');
    if (new Set(body.slots.map((s) => s.id)).size !== body.slots.length || body.slots.length > 64) bad('slots');
    const esc = body.slots.filter((s) => s.kind === 'escrow');
    if (esc.length !== 1 || !this.escrowOk(esc[0])) bad('escrow');
    if (!body.slots.some((s) => s.role === 'owner' && s.kind !== 'escrow')) bad('no owner');
    if (!body.commit.epochs.some((x) => x.e === body.epoch)) bad('commit');
    const newSlots = req.new_slots || [];
    const added = body.slots.filter((s) => !head.body.slots.some((p) => p.id === s.id) && s.kind !== 'escrow');
    if (JSON.stringify(added.map((s) => s.id).sort()) !== JSON.stringify(newSlots.map((s) => s.slot).sort())) bad('new_slots do not match added slots');
    for (const a of added) {
      if (a.kind !== 'invite') bad('added slot is not an invite');
      if (vault.usedSlotIds.has(a.id)) fail(409, 'slot_id_taken');
      if (a.role === 'owner' && signer.kind !== 'escrow') bad('owner invite');
      if (!(a.expires > now && a.expires <= now + 15 * 86400)) bad('invite expiry');
      const sb = this.scopes.get(vault.scope) && this.scopes.get(vault.scope).sandbox;
      if (sb && a.expires > (sb.next_wipe === undefined ? now + 6 * 3600 : sb.next_wipe)) bad('in the sandbox an invite cannot outlive the next nightly wipe');
    }
    for (const ns of newSlots) if (this.access.has(ns.access_id)) fail(409, 'access_id_taken');
    for (const p of head.body.slots) {
      const n = body.slots.find((s) => s.id === p.id);
      if (!n) {
        if (p.kind === 'escrow') continue;
        const st = vault.slots.get(p.id);
        if (body.epoch !== vault.epoch + 1 && !(p.kind === 'invite' && !st.used)) fail(409, 'revocation_required');
        continue;
      }
      if (p.kind !== 'escrow' && (n.e_pub !== p.e_pub || n.s_pub !== p.s_pub)) {
        const st = vault.slots.get(p.id), r = st && st.renewal && st.renewal.body;
        const okSelf = signer.id === p.id && p.role === 'owner';
        const okRenewal = r && p.role !== 'owner' && r.e_pub === n.e_pub && r.s_pub === n.s_pub; // owner keys change only by that owner (PROTOCOL 6.3)
        if (!okSelf && !okRenewal) fail(409, 'renewal_mismatch');
      }
      if (p.kind === 'invite' && n.kind === 'passphrase' && !vault.slots.get(p.id).redeemed) bad('kind change without redemption');
      if (p.kind !== 'escrow' && p.role === 'owner' && n.role !== 'owner') bad('owner role changed');
    }
    const dropped = head.body.commit.epochs.filter((x) => !body.commit.epochs.some((y) => y.e === x.e)).map((x) => x.e);
    const inUse = dropped.filter((e) => this.blobsUsingEpoch(vault, e));
    if (inUse.length) fail(409, 'epoch_in_use', { epochs: inUse });
    this.checkKeyring(body, req.keyring);
    // apply
    for (const p of head.body.slots) {
      if (body.slots.some((s) => s.id === p.id) || p.kind === 'escrow') continue;
      const st = vault.slots.get(p.id);
      this.revoked.add(st.accessId); vault.slots.delete(p.id);
    }
    for (const ns of newSlots) {
      vault.slots.set(ns.slot, { slotId: ns.slot, accessId: ns.access_id, kdf: ns.kdf, tokenHash: ns.token_hash, wrapped: ns.wrapped, sv: 1, kind: 'invite', used: false, redeemed: null, expires: body.slots.find((s) => s.id === ns.slot).expires, renewal: null });
      vault.usedSlotIds.add(ns.slot);
      this.access.set(ns.access_id, { vault: vault.id, slotId: ns.slot });
    }
    for (const s of body.slots) {
      const st = vault.slots.get(s.id);
      if (!st) continue;
      if (st.renewal && st.renewal.body.e_pub === s.e_pub && st.renewal.body.s_pub === s.s_pub) st.renewal = null;
    }
    const hash = sha256b64(I.cjsonBytes(body));
    vault.rosters.push({ body, sig: req.roster.sig, hash });
    vault.epoch = body.epoch;
    vault.keyring = new Map(Object.entries(req.keyring));
    vault.keyringVersion = body.version;
    return { json: { version: body.version, head: hash, epoch: body.epoch } };
  }

  // ---- records ----
  getRec(vault, rid) { return vault.records.get(rid) || null; }
  listRecords(vault, q) {
    const after = q.get('after'), limit = Math.min(Number(q.get('limit') || 1000), 1000);
    const ids = Array.from(vault.records.keys()).sort().filter((id) => !after || id > after);
    const page = ids.slice(0, limit);
    return { json: {
      records: page.map((id) => { const r = vault.records.get(id), v = last(r.versions); return { id, version: v.version, epoch: v.deleted ? null : v.epoch, size: v.deleted ? 0 : v.bytes.length, updated: v.created, deleted: v.deleted }; }),
      next: ids.length > limit ? page[page.length - 1] : null,
    } };
  }
  getVersionResponse(vault, rid, version) {
    const rec = this.getRec(vault, rid);
    if (!rec) fail(404, 'not_found');
    const v = version === null ? last(rec.versions) : rec.versions.find((x) => x.version === version);
    if (!v) fail(404, 'not_found');
    if (v.deleted) fail(404, 'deleted', { version: v.version });
    return { bytes: v.bytes, headers: { etag: '"' + v.version + '"', 'wds-commit': v.commit } };
  }
  putRecord(vault, rid, headers, body) {
    const scope = this.scopes.get(vault.scope);
    if (scope.status === 'suspended') fail(403, 'scope_suspended');
    const commit = headers.get('wds-commit');
    if (!commit || I.b64uDecode(commit).length !== 32) fail(400, 'bad_request');
    const im = headers.get('if-match'), inm = headers.get('if-none-match');
    if (im === undefined && inm === undefined) fail(428, 'precondition_required');
    if (inm !== undefined && inm !== '*') fail(400, 'bad_request');
    if (im !== undefined && !/^"\d+"$/.test(im)) fail(400, 'bad_request');
    const max = this.scopeLimits(scope).max_envelope_bytes;
    if (body.length > max) fail(413, 'value_too_large', { limit: max });
    if (body.length < 38 || body[0] !== 0x57 || body[1] !== 0x44 || body[2] !== 0x53 || body[3] !== 0x31 || body[4] !== 1 || body[5] !== 0) fail(400, 'malformed_envelope');
    const epoch = ((body[6] << 24) | (body[7] << 16) | (body[8] << 8) | body[9]) >>> 0;
    if (epoch !== vault.epoch) fail(409, 'epoch_changed', { epoch: vault.epoch });
    let rec = this.getRec(vault, rid);
    const latest = rec ? last(rec.versions) : null;
    if (this.failPreconditions && this.failPreconditions(rid)) fail(412, 'precondition_failed', { current: latest ? latest.version : null, deleted: latest ? latest.deleted : false });
    let next;
    if (inm !== undefined) {
      if (latest) fail(412, 'precondition_failed', { current: latest.version, deleted: latest.deleted });
      next = 1;
    } else {
      const n = Number(/"(\d+)"/.exec(im)[1]);
      if (!latest || latest.version !== n) fail(412, 'precondition_failed', { current: latest ? latest.version : null, deleted: latest ? latest.deleted : false });
      next = n + 1;
    }
    const used = this.vaultBytes(vault) + body.length;
    if (used > scope.limits.vault_bytes) fail(507, 'quota_exceeded', { limit: 'vault_bytes' });
    if (!rec) { rec = { versions: [] }; vault.records.set(rid, rec); }
    rec.versions.push({ version: next, bytes: new Uint8Array(body), commit, created: this.now(), deleted: false, epoch });
    this.prune(rec, scope.limits.history_versions);
    return { status: next === 1 ? 201 : 200, json: { version: next, epoch, size: body.length }, headers: { etag: '"' + next + '"' } };
  }
  prune(rec, keep) {
    while (rec.versions.length > keep) rec.versions.shift();
  }
  vaultBytes(vault) {
    let n = 0;
    for (const r of vault.records.values()) for (const v of r.versions) if (!v.deleted) n += v.bytes.length;
    return n;
  }
  deleteRecord(vault, rid, headers) {
    const im = headers.get('if-match');
    if (im === undefined) fail(428, 'precondition_required');
    const rec = this.getRec(vault, rid), latest = rec ? last(rec.versions) : null;
    const n = Number((/^"(\d+)"$/.exec(im) || fail(400, 'bad_request'))[1]);
    if (!latest || latest.version !== n || latest.deleted) fail(412, 'precondition_failed', { current: latest ? latest.version : null, deleted: latest ? latest.deleted : false });
    rec.versions.push({ version: n + 1, bytes: new Uint8Array(0), commit: null, created: this.now(), deleted: true, epoch: null });
    this.prune(rec, this.scopes.get(vault.scope).limits.history_versions);
    return { json: { version: n + 1 } };
  }
  history(vault, rid) {
    const rec = this.getRec(vault, rid);
    if (!rec) fail(404, 'not_found');
    return { json: { id: rid, current: last(rec.versions).version, versions: rec.versions.slice().reverse().map((v) => ({ version: v.version, epoch: v.epoch, size: v.bytes.length, created: v.created, deleted: v.deleted, commit: v.commit })) } };
  }
  purgeHistory(vault, rid) {
    const rec = this.getRec(vault, rid);
    if (!rec) fail(404, 'not_found');
    let freed = 0;
    while (rec.versions.length > 1) freed += rec.versions.shift().bytes.length;
    return { json: { freed } };
  }
  listRekey(vault, q) {
    const limit = Math.min(Number(q.get('limit') || 500), 500), after = q.get('after');
    const items = [];
    for (const rid of Array.from(vault.records.keys()).sort()) {
      for (const v of vault.records.get(rid).versions) if (!v.deleted && v.epoch < vault.epoch) items.push({ id: rid, version: v.version, epoch: v.epoch, size: v.bytes.length });
    }
    const key = (it) => it.id + ':' + String(it.version).padStart(10, '0');
    const rest = after ? items.filter((it) => key(it) > after) : items;
    const page = rest.slice(0, limit);
    return { json: { epoch: vault.epoch, remaining: items.length, items: page, next: rest.length > limit ? key(page[page.length - 1]) : null } };
  }
  rekey(vault, rid, version, headers, body) {
    if (this.rekeyBudget !== undefined && this.rekeyBudget !== null) {
      if (this.rekeyBudget <= 0) throw new TypeError('fetch failed');
      this.rekeyBudget--;
    }
    const rec = this.getRec(vault, rid), v = rec && rec.versions.find((x) => x.version === version);
    if (!v) fail(404, 'not_found');
    if (v.deleted) fail(404, 'deleted', { version });
    const im = headers.get('if-match'), m = /^"e(\d+)"$/.exec(im || '');
    if (!m) fail(im === undefined ? 428 : 400, im === undefined ? 'precondition_required' : 'bad_request');
    const k = Number(m[1]);
    if (v.epoch !== k) fail(412, 'precondition_failed', { epoch: v.epoch });
    const epoch = ((body[6] << 24) | (body[7] << 16) | (body[8] << 8) | body[9]) >>> 0;
    if (body[4] !== 1 || epoch !== vault.epoch) fail(409, 'epoch_changed', { epoch: vault.epoch });
    if (body.length !== v.bytes.length) fail(400, 'rekey_size_mismatch');
    v.bytes = new Uint8Array(body); v.epoch = epoch;
    return { json: { version, epoch } };
  }
  usage(vault) {
    let records = 0, versions = 0, old = 0;
    for (const r of vault.records.values()) { records++; for (const v of r.versions) { versions++; if (!v.deleted && v.epoch < vault.epoch) old++; } }
    return { json: { bytes: this.vaultBytes(vault), records, versions, old_epoch_blobs: old, read_only: false, limits: this.scopeLimits(this.scopes.get(vault.scope)) } };
  }
}

// Test harness helper: server with one scope and escrow keys; returns pieces tests need.
export async function makeWorld(opts = {}) {
  const mk = async () => {
    const e = await I.generateKeyPair('E'), s = await I.generateKeyPair('S');
    return { e, s, e_pub: I.b64u(e.pub), s_pub: I.b64u(s.pub), id: await I.escrowKeyId(e.pub, s.pub) };
  };
  const server = new FakeServer(opts.server);
  const current = await mk(), spare = await mk();
  server.setEscrow(current, spare);
  const scope = server.addScope(opts.scope);
  return { server, scope, escrow: { current, spare }, pins: [current.id, spare.id] };
}
