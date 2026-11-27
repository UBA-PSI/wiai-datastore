// Regression tests for the client review findings: owner-versus-owner rules, escrow retirement, local state binding and
// non-extractable session keys. (Bundle hardening is tested in ui-unit.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { core, I, setupVault, newClient, addMember, rejects, recoverOwner } from './helpers.mjs';

const stateKey = (world, accessId) => 'wds:' + world.scope + ':' + accessId + ':state';
const NEW_OWNER_PASS = 'recovered owner passphrase';

// The recovered owner redeems the invite the way the UI does: maintenance is left to a later unlock.
async function recoveredVault(opts = {}) {
  const ctx = await setupVault();
  const { founder, world } = ctx;
  await founder.put('data', { precious: true });
  const rec = await recoverOwner(ctx);
  await founder.maintain();
  founder.acknowledgeRecovery();
  const newOwner = newClient(world);
  await newOwner.redeemInvite({ inviteCode: rec.inviteCode, passphrase: NEW_OWNER_PASS, maintain: opts.maintain });
  return Object.assign(ctx, { rec, newOwner });
}
const unlockFounder = async (ctx, c = newClient(ctx.world, { storage: ctx.world.storage }), extra = {}) => {
  await c.unlock(Object.assign({ accessId: ctx.created.accessId, passphrase: ctx.passphrase }, extra));
  return c;
};

// ---- critical: only an owner adopts its own key renewal ----
test('a founder does not adopt the key renewal of an owner slot added by the faculty; the vault stays readable', async () => {
  const ctx = await recoveredVault({ maintain: false });
  const { world, created, rec } = ctx;
  const f2 = await unlockFounder(ctx, undefined, { maintain: false });
  assert.equal(f2.s.serverSlots[rec.slotId].renewal !== null, true, 'the new owner announced new keys');
  const before = f2.status().rosterVersion;
  f2.acknowledgeRecovery();
  await f2.maintain();
  assert.equal(f2.status().rosterVersion, before, 'no roster version was written for the other owner');
  assert.equal(f2.s.warnings.length, 0);
  // fresh unlocks of both owners verify the whole chain
  assert.deepEqual(await (await unlockFounder(ctx, newClient(world))).get('data'), { precious: true });
  const o2 = newClient(world);
  await o2.unlock({ accessId: rec.accessId, passphrase: NEW_OWNER_PASS }); // the owner's own maintenance adopts its renewal
  assert.equal(o2.status().rosterVersion, before + 1);
  const self = o2.members().find((m) => m.self);
  assert.equal(self.kind, 'passphrase'); assert.equal(o2.status().renewalPending, false);
  assert.deepEqual(await o2.get('data'), { precious: true });
  const f3 = await unlockFounder(ctx, newClient(world));
  assert.equal(f3.status().rosterVersion, before + 1);
  assert.deepEqual(await f3.get('data'), { precious: true });
  assert.equal(created.vaultId, f3.status().vaultId);
});

test('the chain rule: a roster signed by one owner that changes another owner\'s keys is invalid', async () => {
  const ctx = await recoveredVault({ maintain: false });
  const { founder, world, created, rec } = ctx;
  const f2 = await unlockFounder(ctx, undefined, { maintain: false });
  const head = f2.s.head, renewal = f2.s.serverSlots[rec.slotId].renewal.body;
  const body = JSON.parse(JSON.stringify(head.body));
  body.version++; body.prev = head.hash; body.signer = f2.s.slotId;
  const sl = body.slots.find((x) => x.id === rec.slotId);
  sl.e_pub = renewal.e_pub; sl.s_pub = renewal.s_pub; sl.kind = 'passphrase'; sl.expires = null;
  const roster = await I.signRoster(body, f2.s.sPriv);
  const docs = f2.s.chain.map((c) => ({ body: c.body, sig: c.sig })).concat([roster]);
  await rejects(I.verifyRosterChain({ scope: world.scope, vault: created.vaultId, escrowPins: world.pins, docs, prior: null }), core.errors.IntegrityError, /own keys/);
  // the server refuses it as well
  const keyring = await I.makeKeyring(world.scope, body, f2.s.vmk, f2.s.nk);
  const res = await world.server.fetch(world.server.service + 'api/v1/vaults/' + created.vaultId + '/roster', {
    method: 'POST', headers: { Authorization: I.bearerHeader(f2.s.accessId, f2.s.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ roster, keyring }),
  });
  assert.notEqual(res.status, 200);
  assert.ok(founder);
});

// ---- major: owners and the faculty-added owner can revoke each other (PLAN 5.7) ----
test('the founder can revoke an owner slot added by the faculty (epoch bump, re-encryption)', async () => {
  const ctx = await recoveredVault();
  const { world, founder, rec, newOwner } = ctx;
  await founder.maintain();
  assert.equal(founder.members().find((m) => m.slotId === rec.slotId).revocable, true);
  assert.equal(founder.members().find((m) => m.escrow).revocable, false);
  assert.equal(founder.members().find((m) => m.self).revocable, false);
  const r = await founder.revoke([rec.slotId]);
  assert.equal(r.done, true);
  assert.equal(founder.status().epoch, 2);
  assert.equal(founder.members().some((m) => m.slotId === rec.slotId), false);
  assert.deepEqual(await founder.get('data'), { precious: true });
  await rejects(newClient(world).unlock({ accessId: rec.accessId, passphrase: NEW_OWNER_PASS }), core.errors.RequestError, /not_found/); // the access ID is retired
  await rejects(newOwner.get('data'), core.errors.AuthError);
});

test('the owner recovered by the faculty can revoke the old founder slot', async () => {
  const ctx = await recoveredVault();
  const { world, founder, newOwner, created } = ctx;
  assert.equal(newOwner.status().role, 'owner');
  const old = newOwner.members().find((m) => m.slotId === founder.s.slotId);
  assert.equal(old.role, 'owner'); assert.equal(old.revocable, true);
  const r = await newOwner.revoke([old.slotId]);
  assert.equal(r.done, true);
  assert.equal(newOwner.status().epoch, 2);
  assert.deepEqual(await newOwner.get('data'), { precious: true });
  await newOwner.put('after', 1);
  await rejects(founder.get('data'), core.errors.AuthError);
  await rejects(newClient(world).unlock({ accessId: created.accessId, passphrase: ctx.passphrase }), core.errors.RequestError, /not_found/);
  // the escrow slot and the own slot stay out of reach
  await rejects(newOwner.revoke([newOwner.s.slotId]), core.errors.UsageError, /own slot/);
  await rejects(newOwner.revoke([newOwner.members().find((m) => m.escrow).slotId]), core.errors.UsageError, /escrow/);
});

test('without a recovery nobody can revoke an owner slot; a member cannot revoke at all', async () => {
  const ctx = await setupVault();
  const { founder } = ctx;
  const { member } = await addMember(ctx, 'write');
  await rejects(founder.revoke([founder.s.slotId]), core.errors.UsageError, /own slot/);
  await rejects(member.revoke([founder.s.slotId]), core.errors.AuthError);
  assert.equal(founder.members().filter((m) => m.revocable).length, 1); // only the member
});

// ---- major: escrow retirement ----
async function escrowSet() {
  const e = await I.generateKeyPair('E'), s = await I.generateKeyPair('S');
  return { e, s, e_pub: I.b64u(e.pub), s_pub: I.b64u(s.pub), id: await I.escrowKeyId(e.pub, s.pub) };
}

test('retired escrow keys stay valid for history; an owner replaces them with the current pinned keys', async () => {
  const ctx = await setupVault();
  const { founder, world, created } = ctx;
  await founder.put('data', 1);
  const { member, accessId } = await addMember(ctx, 'write');
  const A = world.escrow.current, B = world.escrow.spare, C = await escrowSet();
  world.server.setEscrow(B, C); // the operator rotates: B is current now, C is the new spare, A is retired
  const cfg = { escrowPins: [B.id, C.id], retiredEscrow: [{ id: A.id, until: world.server.now() + 1000 }] };

  // a member opens the vault with the new library: accepted, flagged, nothing to do for a member
  const m2 = newClient(world, cfg);
  await m2.unlock({ accessId, passphrase: 'member passphrase one two' });
  assert.equal(m2.status().escrowRetired, true);
  assert.equal(await m2.get('data'), 1);
  assert.ok(member);

  // an owner who skips maintenance cannot edit the roster: nothing may be encrypted to the retired key
  const f2 = await unlockFounder(ctx, newClient(world, Object.assign({ storage: world.storage }, cfg)), { maintain: false });
  assert.equal(f2.status().escrowRetired, true);
  await rejects(f2.createInvite({ role: 'read' }), core.errors.UsageError, /retired/);
  const v0 = f2.status().rosterVersion;
  await f2.maintain();
  assert.equal(f2.status().escrowRetired, false);
  assert.ok(f2.status().rosterVersion > v0); // the migration, and the member's pending key renewal
  const esc = f2.s.head.body.slots.find((x) => x.kind === 'escrow');
  assert.equal(esc.e_pub, B.e_pub); assert.equal(esc.s_pub, B.s_pub);
  await f2.createInvite({ role: 'read' });

  // version 1 still names A: a fresh client with the new library verifies the whole chain and sees the vault as migrated
  const f3 = await unlockFounder(ctx, newClient(world, Object.assign({ storage: world.storage }, cfg)));
  assert.equal(f3.status().escrowRetired, false);
  assert.equal(f3.s.chain[0].escrowId, A.id);
  assert.equal(await f3.get('data'), 1);
  await m2.maintain();
  assert.equal(m2.status().escrowRetired, false);
  // an old library (pins A and B) still opens the migrated vault
  assert.equal(await (await unlockFounder(ctx, newClient(world, { storage: world.storage }))).get('data'), 1);
  assert.equal(created.vaultId, f3.status().vaultId);
});

test('a library that neither pins nor retires an escrow set refuses the vault; an unknown set is never accepted as retired', async () => {
  const ctx = await setupVault();
  const { world, created } = ctx;
  const A = world.escrow.current, B = world.escrow.spare, C = await escrowSet();
  const docs = ctx.founder.s.chain.map((c) => ({ body: c.body, sig: c.sig }));
  const base = { scope: world.scope, vault: created.vaultId, docs, prior: null };
  await rejects(I.verifyRosterChain(Object.assign({ escrowPins: [B.id, C.id] }, base)), core.errors.IntegrityError, /pinned/);
  await rejects(I.verifyRosterChain(Object.assign({ escrowPins: [B.id, C.id], retiredEscrow: [{ id: C.id, until: 5 }] }, base)), core.errors.IntegrityError, /pinned/);
  assert.equal((await I.verifyRosterChain(Object.assign({ escrowPins: [B.id, C.id], retiredEscrow: [{ id: A.id, until: 5 }] }, base))).length, 1);
});

test('a version signed by a retired escrow key counts only up to the retirement time', async () => {
  const ctx = await setupVault();
  const { founder, world } = ctx;
  await founder.put('data', 1);
  const rec = await recoverOwner(ctx); // escrow-signed with A at head time + 1
  const A = world.escrow.current, B = world.escrow.spare, C = await escrowSet();
  const signedAt = (await world.server.vaults.get(ctx.created.vaultId).rosters.at(-1)).body.time;
  world.server.setEscrow(B, C);
  const cfg = (until) => ({ escrowPins: [B.id, C.id], retiredEscrow: [{ id: A.id, until }], storage: core.memoryStorage() });
  const late = await rejects(newClient(world, cfg(signedAt - 1)).unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase }), core.errors.IntegrityError, /retired escrow key/);
  assert.equal(late.code, 'invalid_roster');
  const ok = newClient(world, cfg(signedAt));
  await ok.unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase });
  assert.equal(ok.status().recoveredByFaculty, true);
  assert.equal(ok.status().escrowRetired, true);
  // the recovery is not acknowledged yet: the migration waits, the vault stays usable
  assert.ok(ok.s.warnings.some((w) => /acknowledged/.test(w)));
  ok.acknowledgeRecovery();
  await ok.maintain();
  assert.equal(ok.status().escrowRetired, false);
  assert.ok(rec.slotId);
});

// ---- minor: local state is bound to scope, vault, access ID and slot ----
test('the local rollback state names its owner: a state copied from another member or tampered with is refused', async () => {
  const ctx = await setupVault();
  const { founder, world, created } = ctx;
  await founder.put('data', 1);
  const raw = world.storage.getItem(stateKey(world, created.accessId));
  const opened = await I.openState(founder.s.keys.kState, raw);
  assert.deepEqual([opened.scope, opened.vault, opened.access, opened.slot], [world.scope, created.vaultId, created.accessId, founder.s.slotId]);

  const { accessId } = await addMember(ctx, 'write', 'member passphrase one two');
  const login = async () => { const c = newClient(world); await c.unlock({ accessId, passphrase: 'member passphrase one two' }); return c; };
  assert.equal((await login()).status().stateStatus, 'ok');
  // another member's genuine state of the same vault (same MAC key) is not accepted
  world.storage.setItem(stateKey(world, accessId), raw);
  assert.equal((await login()).status().stateStatus, 'invalid');
  assert.equal((await login()).status().stateStatus, 'ok'); // rewritten with the member's own binding
  // every bound field matters
  for (const [field, value] of [['scope', 'other-scope'], ['vault', 'X'.repeat(26)], ['access', 'A'.repeat(20)], ['slot', 'AAAAAAAAAAAAAAAA']]) {
    const own = await I.openState(founder.s.keys.kState, world.storage.getItem(stateKey(world, created.accessId)));
    world.storage.setItem(stateKey(world, created.accessId), await I.sealState(founder.s.keys.kState, Object.assign({}, own, { [field]: value })));
    assert.equal((await unlockFounder(ctx, newClient(world))).status().stateStatus, 'invalid', field);
    assert.equal((await unlockFounder(ctx, newClient(world))).status().stateStatus, 'ok', field + ' restored');
  }
  // a state without the binding fields (older format) counts as a new device
  const legacy = await I.openState(founder.s.keys.kState, world.storage.getItem(stateKey(world, created.accessId)));
  for (const f of ['scope', 'vault', 'access', 'slot']) delete legacy[f];
  world.storage.setItem(stateKey(world, created.accessId), await I.sealState(founder.s.keys.kState, legacy));
  assert.equal((await unlockFounder(ctx, newClient(world))).status().stateStatus, 'invalid');
});

// ---- minor: session keys that WebCrypto can hold are non-extractable CryptoKeys ----
test('K_wrap, K_commit and K_state are non-extractable CryptoKeys in the session', async () => {
  const ctx = await setupVault();
  const s = ctx.founder.s;
  for (const k of [s.kWrap, s.keys.kCommit, s.keys.kState, s.keys.kIdKey]) {
    assert.equal(typeof k, 'object'); assert.equal(k.type, 'secret'); assert.equal(k.extractable, false);
  }
  for (const gone of ['kIdRaw', 'kCommitRaw']) assert.equal(s.keys[gone], undefined, gone);
  assert.equal(s.kWrapRaw, undefined);
  // they still do their job after a passphrase change (K_wrap is replaced) and across a reload
  await ctx.founder.put('a', 1);
  await ctx.founder.changePassphrase('another good passphrase');
  assert.equal(ctx.founder.s.kWrap.extractable, false);
  await ctx.founder.renewKeys();
  const again = newClient(ctx.world, { storage: ctx.world.storage });
  await again.unlock({ accessId: ctx.created.accessId, passphrase: 'another good passphrase' });
  assert.equal(await again.get('a'), 1);
});

test('wds-core exposes the test hooks only outside the production build', () => {
  assert.equal(typeof core.setRandom, 'function'); assert.equal(typeof core.setArgon2, 'function'); assert.equal(typeof core.internals, 'object');
});
