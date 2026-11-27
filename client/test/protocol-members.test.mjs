// Invites, key renewal, roles, revocation with resumable re-encryption, recovery by the faculty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { core, I, setupVault, newClient, addMember, rejects, seq } from './helpers.mjs';

const roles = (c) => c.members().map((m) => m.role + ':' + m.kind).sort();

test('invite, redeem, automatic renewal by the owner, key set cleanup', async () => {
  const ctx = await setupVault();
  const { founder, world } = ctx;
  await founder.put('shared', { hello: 'world' });
  const invite = await founder.createInvite({ role: 'write' });
  assert.equal(invite.code.canonical.length, 48);
  assert.equal(invite.code.display.split('-').length, 12);
  assert.equal(founder.status().rosterVersion, 2);
  assert.ok(founder.members().some((m) => m.slotId === invite.slotId && m.kind === 'invite' && m.role === 'write' && !m.used));

  const member = newClient(world);
  const st = await member.redeemInvite({ inviteCode: invite.code.display.toLowerCase(), passphrase: 'member pass one' });
  assert.equal(st.role, 'write'); assert.equal(st.kind, 'invite'); assert.equal(st.renewalPending, true);
  assert.deepEqual(await member.get('shared'), { hello: 'world' });
  await member.put('from-member', 7);
  assert.equal(member.s.keySets.length, 2); // invite keys and the new keys; the roster still lists the invite keys
  assert.equal(member.s.activeIdx, 0);

  // the invite is spent
  await rejects(newClient(world).redeemInvite({ inviteCode: invite.code.canonical, passphrase: 'x y z x y z' }), core.errors.RequestError, /already/);

  // owner unlock adopts the renewal into roster version 3
  const f2 = newClient(world, { storage: world.storage });
  const st2 = await f2.unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase });
  assert.equal(st2.rosterVersion, 3);
  assert.deepEqual(await f2.get('from-member'), 7);
  const m = f2.members().find((x) => x.slotId === invite.slotId);
  assert.equal(m.kind, 'passphrase'); assert.equal(m.expires, null); assert.equal(m.renewalPending, false);
  const head = f2.s.head.body;
  assert.notEqual(head.slots.find((s) => s.id === invite.slotId).e_pub, f2.s.chain[1].body.slots.find((s) => s.id === invite.slotId).e_pub);
  assert.equal(world.server.vaults.get(ctx.created.vaultId).slots.get(invite.slotId).renewal, null);

  // the member's next unlock uses the new keys and drops the invite keys from the stored blob
  const member2 = newClient(world, { storage: core.memoryStorage() });
  const st3 = await member2.unlock({ accessId: member.s.accessId, passphrase: 'member pass one' });
  assert.equal(st3.rosterVersion, 3); assert.equal(st3.kind, 'passphrase');
  assert.equal(member2.s.keySets.length, 1);
  assert.deepEqual(await member2.get('shared'), { hello: 'world' });
  // owner added data after adoption is readable by the member (keyring entry for the new keys)
  await f2.put('after', 'x');
  assert.equal(await member2.get('after'), 'x');
});

test('an unredeemed invite expires; owners can cancel it', async () => {
  const ctx = await setupVault();
  const i1 = await ctx.founder.createInvite({ role: 'read', expiresIn: 3600 });
  ctx.world.server.nowFn = () => Math.floor(Date.now() / 1000) + 4000;
  await rejects(newClient(ctx.world).redeemInvite({ inviteCode: i1.code.display, passphrase: 'abc def ghi jkl' }), core.errors.AuthError);
  ctx.world.server.nowFn = () => Math.floor(Date.now() / 1000);
  const i2 = await ctx.founder.createInvite({ role: 'write' });
  await ctx.founder.cancelInvite(i2.slotId);
  assert.ok(!ctx.founder.members().some((m) => m.slotId === i2.slotId));
  await rejects(newClient(ctx.world).redeemInvite({ inviteCode: i2.code.display, passphrase: 'abc def ghi jkl' }), core.errors.RequestError);
  await rejects(ctx.founder.createInvite({ role: 'owner' }), core.errors.UsageError);
  await rejects(ctx.founder.createInvite({ role: 'write', expiresIn: 20 * 86400 }), core.errors.UsageError);
  await rejects(newClient(ctx.world).redeemInvite({ inviteCode: i2.code.display.slice(0, -1) + (i2.code.display.endsWith('0') ? '1' : '0'), passphrase: 'abc def ghi jkl' }), core.errors.UsageError);
});

test('invalid renewals are ignored, valid member renewals are adopted', async () => {
  const ctx = await setupVault();
  const { member, accessId } = await addMember(ctx, 'write');
  await ctx.founder.maintain(); // adopt the redemption renewal
  assert.equal(ctx.founder.members().filter((m) => m.kind === 'passphrase' && m.role === 'write').length, 1);
  // member announces fresh keys
  await member.renewKeys();
  assert.equal(member.s.keySets.length, 2);
  const server = ctx.world.server, vault = server.vaults.get(ctx.created.vaultId);
  const slot = Array.from(vault.slots.values()).find((s) => s.accessId === accessId);
  const good = JSON.parse(JSON.stringify(slot.renewal));
  // forged: server swaps in its own key under the member's signature
  const evil = await I.generateKeyPair('E');
  slot.renewal = { body: Object.assign({}, good.body, { e_pub: I.b64u(evil.pub) }), sig: good.sig };
  await ctx.founder.maintain();
  assert.ok(ctx.founder.status().warnings.some((w) => /invalid key renewal/.test(w)));
  assert.equal(ctx.founder.status().rosterVersion, 3);
  // the genuine statement is adopted
  slot.renewal = good;
  await ctx.founder.maintain();
  assert.equal(ctx.founder.status().rosterVersion, 4);
  // the member keeps working through the switch and cleans up its blob
  await member.put('k', 1);
  await member.maintain();
  assert.equal(member.s.keySets.length, 1);
  assert.equal(member.status().rosterVersion, 4);
  assert.equal(await ctx.founder.get('k'), 1);
});

test('owner renews its own keys', async () => {
  const ctx = await setupVault();
  await ctx.founder.put('a', 1);
  const before = ctx.founder.s.head.body.slots.find((s) => s.id === ctx.founder.s.slotId).e_pub;
  await ctx.founder.renewKeys();
  const after = ctx.founder.s.head.body.slots.find((s) => s.id === ctx.founder.s.slotId).e_pub;
  assert.notEqual(before, after);
  assert.equal(ctx.founder.s.keySets.length, 1);
  const c = newClient(ctx.world);
  await c.unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase });
  assert.equal(c.status().rosterVersion, 2);
  assert.equal(await c.get('a'), 1);
});

test('roles: write to read and back; roster edits retry after a concurrent change', async () => {
  const ctx = await setupVault();
  const { member } = await addMember(ctx, 'write');
  await ctx.founder.maintain();
  const slotId = member.s.slotId;
  await member.put('a', 1);
  await ctx.founder.setRole(slotId, 'read');
  await rejects(member.put('a', 2), core.errors.AuthError); // the server enforces the role from the head roster
  await ctx.founder.setRole(slotId, 'write');
  await member.get('a');
  await member.put('a', 3);
  await rejects(ctx.founder.setRole(ctx.founder.s.slotId, 'read'), core.errors.UsageError);
  // a roster conflict (somebody else was faster) is retried on a fresh head
  ctx.world.server.conflictOnce = true;
  await ctx.founder.setRole(slotId, 'read');
  assert.equal(ctx.founder.members().find((m) => m.slotId === slotId).role, 'read');
});

async function populate(f, n = 6) {
  for (let i = 0; i < n; i++) {
    await f.put('doc' + i, { i });
    await f.put('doc' + i, { i, again: true });
  }
  await f.put('file', seq(3000, 0));
}
const epochsOnServer = (server, vaultId) => {
  const set = new Set();
  for (const r of server.vaults.get(vaultId).records.values()) for (const v of r.versions) if (!v.deleted) set.add(v.epoch);
  return Array.from(set).sort();
};

test('revocation re-encrypts current records and history, then drops the old epoch', async () => {
  const ctx = await setupVault();
  const { founder, world, created } = ctx;
  const m1 = await addMember(ctx, 'write', 'member one pass');
  const m2 = await addMember(ctx, 'write', 'member two pass');
  await founder.maintain();
  await populate(founder);
  assert.deepEqual(epochsOnServer(world.server, created.vaultId), [1]);
  const res = await founder.revoke([m1.member.s.slotId]);
  assert.equal(res.done, true);
  assert.ok(res.rekeyed >= 13);
  assert.deepEqual(epochsOnServer(world.server, created.vaultId), [2]);
  const st = founder.status();
  assert.equal(st.epoch, 2); assert.equal(st.rekeyPending, false);
  assert.deepEqual(founder.s.head.body.commit.epochs.map((x) => x.e), [2]); // old commitment dropped
  assert.equal(founder.s.chain.length, 6); // two invites, adoption of both renewals, revocation, epoch drop
  // history is intact and readable
  assert.deepEqual((await founder.history('doc0')).versions.map((v) => v.version), [2, 1]);
  assert.deepEqual((await founder.getVersion('doc0', 1)).value, { i: 0 });
  // revoked member is locked out; the other member continues without any manual refresh
  await rejects(m1.member.get('doc0'), core.errors.AuthError);
  const e = await rejects(m1.member.get('doc0'), core.errors.AuthError); assert.equal(e.code, 'revoked');
  assert.deepEqual(await m2.member.get('doc1'), { i: 1, again: true }); // epoch 2 envelope: member reloads its keyring entry
  const w = await m2.member.put('doc1', { by: 'member2' }); // stale epoch on write: 409 epoch_changed, reload, retry
  assert.equal(w.epoch, 2);
  assert.deepEqual(await founder.get('doc1'), { by: 'member2' });
  assert.deepEqual(await m2.member.get('file'), seq(3000, 0));
  // the revoked member's old keyring entry does not exist any more; a new device of m2 starts fresh and works
  const dev = newClient(world, { storage: core.memoryStorage() });
  await dev.unlock({ accessId: m2.accessId, passphrase: 'member two pass' });
  assert.deepEqual(await dev.get('doc3'), { i: 3, again: true });
});

test('409 epoch_changed on a write: the member reloads its keyring entry and retries once', async () => {
  const ctx = await setupVault();
  const m1 = await addMember(ctx, 'write', 'member one pass'), m2 = await addMember(ctx, 'write', 'member two pass');
  await ctx.founder.maintain();
  await m2.member.put('warm', 1); // m2 has not seen epoch 2 yet when it writes next
  await ctx.founder.revoke([m1.member.s.slotId]);
  const before = ctx.world.server.requests.filter((r) => r.method === 'PUT' && /\/records\//.test(r.path)).length;
  const w = await m2.member.put('fresh', { after: 'revocation' });
  const puts = ctx.world.server.requests.filter((r) => r.method === 'PUT' && /\/records\//.test(r.path)).length - before;
  assert.equal(puts, 2); // first attempt answered 409 epoch_changed, second one succeeded
  assert.equal(w.epoch, 2);
  assert.deepEqual(await ctx.founder.get('fresh'), { after: 'revocation' });
  // a second 409 is not retried silently
  ctx.world.server.vaults.get(ctx.created.vaultId).epoch = 9;
  const e = await rejects(m2.member.put('other', 1), core.errors.RequestError);
  assert.equal(e.code, 'epoch_changed');
});

test('re-encryption resumes after an interruption (network loss, tab closed)', async () => {
  const ctx = await setupVault();
  const { founder, world, created, passphrase } = ctx;
  const { member } = await addMember(ctx, 'write');
  await founder.maintain();
  await populate(founder);
  const slotId = member.s.slotId;
  world.server.rekeyBudget = 4; // the connection dies after four re-encrypted blobs
  await rejects(founder.revoke([slotId]), core.errors.OfflineError);
  world.server.rekeyBudget = null;
  assert.deepEqual(epochsOnServer(world.server, created.vaultId), [1, 2]);
  assert.equal(world.server.vaults.get(created.vaultId).epoch, 2);
  await rejects(member.get('doc0'), core.errors.AuthError); // revocation took effect immediately
  // new session: the roster still commits epoch 1, so re-encryption is pending
  const f2 = newClient(world, { storage: world.storage });
  const st = await f2.unlock({ accessId: created.accessId, passphrase });
  assert.equal(st.rekeyPending, true);
  const part = await f2.resumeRekey({ maxItems: 3 });
  assert.equal(part.done, false); assert.equal(part.rekeyed, 3);
  const progress = [];
  const rest = await f2.resumeRekey({ onProgress: (p) => progress.push(p) });
  assert.equal(rest.done, true);
  assert.ok(progress.length > 0);
  assert.deepEqual(epochsOnServer(world.server, created.vaultId), [2]);
  assert.deepEqual(f2.s.head.body.commit.epochs.map((x) => x.e), [2]);
  assert.equal(f2.status().rekeyPending, false);
  assert.deepEqual(await f2.get('doc5'), { i: 5, again: true });
  // nothing left to do
  assert.deepEqual(await f2.resumeRekey(), { done: true, rekeyed: 0 });
});

test('two owner sessions resuming at once do not clobber each other', async () => {
  const ctx = await setupVault();
  const { founder, world, created, passphrase } = ctx;
  const { member } = await addMember(ctx, 'write');
  await founder.maintain();
  await populate(founder, 8);
  await founder.revoke([member.s.slotId], { rekey: false });
  const a = newClient(world, { storage: core.memoryStorage() }), b = newClient(world, { storage: core.memoryStorage() });
  await a.unlock({ accessId: created.accessId, passphrase }); await b.unlock({ accessId: created.accessId, passphrase });
  const [ra, rb] = await Promise.allSettled([a.resumeRekey(), b.resumeRekey()]);
  // one of them may lose the race when dropping the old epoch; the data is consistent in every case
  for (const r of [ra, rb]) if (r.status === 'rejected') assert.ok(r.reason instanceof core.errors.WDSError, String(r.reason));
  assert.deepEqual(epochsOnServer(world.server, created.vaultId), [2]);
  const c = newClient(world, { storage: core.memoryStorage() });
  await c.unlock({ accessId: created.accessId, passphrase });
  for (let i = 0; i < 8; i++) assert.deepEqual(await c.get('doc' + i), { i, again: true });
});

test('a member who leaves history behind is not able to read new epochs; cancelled invites need no epoch change', async () => {
  const ctx = await setupVault();
  const { member } = await addMember(ctx, 'write');
  await ctx.founder.maintain();
  await ctx.founder.put('before', 1);
  const oldVmk = new Uint8Array(member.s.vmk.get(1));
  await ctx.founder.revoke([member.s.slotId]);
  assert.equal(ctx.founder.s.vmk.size, 1);
  assert.ok(!I.bytesEqual(oldVmk, ctx.founder.s.vmk.get(2)));
  assert.equal(ctx.founder.status().epoch, 2);
  const i = await ctx.founder.createInvite({ role: 'read' });
  await ctx.founder.cancelInvite(i.slotId);
  assert.equal(ctx.founder.status().epoch, 2);
});

test('owners and escrow cannot be revoked; unknown slots are refused', async () => {
  const ctx = await setupVault();
  await rejects(ctx.founder.revoke([ctx.founder.s.slotId]), core.errors.UsageError);
  const esc = ctx.founder.members().find((m) => m.escrow);
  await rejects(ctx.founder.revoke([esc.slotId]), core.errors.UsageError);
  await rejects(ctx.founder.revoke(['AAAAAAAAAAAAAAAA']), core.errors.UsageError);
  const { member } = await addMember(ctx, 'write');
  await rejects(member.createInvite({ role: 'read' }), core.errors.AuthError);
  await rejects(member.revoke(['AAAAAAAAAAAAAAAA']), core.errors.AuthError);
});

test('recovery by the faculty: escrow-signed roster adds an owner invite; clients flag it and require acknowledgement', async () => {
  const ctx = await setupVault();
  const { founder, world, created } = ctx;
  await founder.put('data', { precious: true });
  const esc = world.escrow.current;
  // the operator's tool: decrypt escrow keyring entry (not needed here: we reuse the founder's copy of the keys), add an owner invite
  const s = founder.s, head = s.head;
  const escSlot = head.body.slots.find((x) => x.kind === 'escrow');
  const ownerE = await I.generateKeyPair('E'), ownerS = await I.generateKeyPair('S');
  const slotId = I.randomSlotId(), secret = I.randomBytes(17), idBytes = I.randomBytes(12), accessId = await I.b32cEncode(idBytes);
  const sk = await I.deriveSlotKeys(secret);
  const body = JSON.parse(JSON.stringify(head.body));
  body.version++; body.prev = head.hash; body.signer = escSlot.id; body.time += 1;
  body.slots.push({ e_pub: I.b64u(ownerE.pub), expires: Math.floor(Date.now() / 1000) + 86400, id: slotId, kind: 'invite', role: 'owner', s_pub: I.b64u(ownerS.pub) });
  body.slots.sort((a, b) => (a.id < b.id ? -1 : 1));
  const keyring = await I.makeKeyring(world.scope, body, s.vmk, s.nk);
  const roster = await I.signRoster(body, await I.importPrivate('S', esc.s.d, esc.s.pub));
  const wrapped = await I.wrapSlot({ kWrapRaw: sk.kWrap, scope: world.scope, vault: created.vaultId, accessId, kdf: { alg: 'invite' }, slotId, keySets: [{ e: ownerE, s: ownerS }] });
  const res = await world.server.fetch(world.server.service + 'api/v1/vaults/' + created.vaultId + '/roster', {
    method: 'POST', headers: { Authorization: I.bearerHeader(created.accessId, s.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ roster, keyring, new_slots: [{ slot: slotId, access_id: accessId, kdf: { alg: 'invite' }, token_hash: I.b64u(sk.tokenHash), wrapped: I.b64u(wrapped) }] }),
  });
  assert.equal(res.status, 200);
  // the founder notices the recovery (derived from the signed chain, not from a server flag) and refuses to encrypt to the new owner
  await founder.maintain();
  assert.equal(founder.status().recoveredByFaculty, true);
  assert.deepEqual(founder.status().recoverySlots, [slotId]);
  assert.ok(founder.members().find((m) => m.slotId === slotId).addedByEscrow);
  await rejects(founder.createInvite({ role: 'write' }), core.errors.UsageError, /recovered|acknowledge/);
  founder.acknowledgeRecovery();
  await founder.createInvite({ role: 'write' });
  // the user holding the recovery invite redeems it and becomes an owner; adopting its own renewal works
  const newOwner = newClient(world);
  const code = await I.makeInviteCode(idBytes, secret);
  const st = await newOwner.redeemInvite({ inviteCode: code.display, passphrase: 'new owner passphrase' });
  assert.equal(st.role, 'owner'); assert.equal(st.recoveredByFaculty, true);
  assert.deepEqual(await newOwner.get('data'), { precious: true });
  await newOwner.maintain();
  assert.equal(newOwner.members().find((m) => m.self).kind, 'passphrase');
  await newOwner.createInvite({ role: 'read' }); // an owner may use its own slot freely
});

test('server cannot make the escrow slot add anything else than one owner invite', async () => {
  const ctx = await setupVault();
  const { founder, world, created } = ctx;
  const esc = world.escrow.current, head = founder.s.head;
  const escSlot = head.body.slots.find((x) => x.kind === 'escrow');
  const body = JSON.parse(JSON.stringify(head.body));
  body.version++; body.prev = head.hash; body.signer = escSlot.id;
  body.slots.find((x) => x.kind === 'passphrase').e_pub = I.b64u((await I.generateKeyPair('E')).pub); // escrow swaps the founder's key
  const roster = await I.signRoster(body, await I.importPrivate('S', esc.s.d, esc.s.pub));
  await assert.rejects(I.verifyRosterChain({ scope: world.scope, vault: created.vaultId, escrowPins: world.pins, docs: [head.body && { body: founder.s.chain[0].body, sig: founder.s.chain[0].sig }, roster], prior: null }), core.errors.IntegrityError);
});
