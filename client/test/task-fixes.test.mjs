// Regression tests: withdrawing used invites, reads and re-encryption independent of the scope limit, strict escrow slot ID
// and expiry rules in the chain verifier, a missing keyring entry, and the owner cleanup of expired invites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { core, I, setupVault, newClient, rejects } from './helpers.mjs';

const NOW = () => Math.floor(Date.now() / 1000);
const accessHeader = async (invite) => {
  const p = await core.parseInviteCode(invite.code.display);
  return I.bearerHeader(p.accessId, (await I.deriveSlotKeys(p.secret)).token);
};
// What the first request of a redemption does (also what someone who intercepted the code can do): GET /slots/{id}.
async function openInvite(ctx, invite) {
  const res = await ctx.world.server.fetch(ctx.world.server.service + 'api/v1/slots/' + invite.accessId, { headers: { Authorization: await accessHeader(invite) } });
  assert.equal(res.status, 200);
  return res.json();
}
const status = (ctx, invite, auth) => ctx.world.server.fetch(ctx.world.server.service + 'api/v1/slots/' + invite.accessId, { headers: { Authorization: auth } }).then((r) => r.status);

// ---- cancelInvite ----
test('cancelInvite removes an unused invite without a new epoch', async () => {
  const ctx = await setupVault();
  const { founder } = ctx;
  const inv = await founder.createInvite({ role: 'write' });
  assert.equal(founder.members().find((m) => m.slotId === inv.slotId).used, false);
  const r = await founder.cancelInvite(inv.slotId);
  assert.deepEqual(r, { revoked: false });
  assert.equal(founder.status().epoch, 1);
  assert.equal(founder.members().some((m) => m.slotId === inv.slotId), false);
});

test('cancelInvite on an invite that was opened with its token falls back to a revocation', async () => {
  const ctx = await setupVault();
  const { founder, world } = ctx;
  await founder.put('data', { precious: true });
  const inv = await founder.createInvite({ role: 'write' });
  const auth = await accessHeader(inv);
  const slot = await openInvite(ctx, inv);
  assert.ok(slot.keyring && slot.keyring.entry, 'the response already contains the keyring entry');
  await founder.maintain();
  assert.equal(founder.members().find((m) => m.slotId === inv.slotId).used, true);
  // the UI asks for a confirmation first: without the fallback the call reports what is needed
  const e = await rejects(founder.cancelInvite(inv.slotId, { revoke: false }), core.RequestError, /revocation_required/);
  assert.equal(e.status, 409);
  assert.equal(founder.status().epoch, 1);
  const r = await founder.cancelInvite(inv.slotId);
  assert.equal(r.revoked, true); assert.equal(r.done, true);
  assert.equal(founder.status().epoch, 2);
  assert.equal(founder.members().some((m) => m.slotId === inv.slotId), false);
  assert.equal(await status(ctx, inv, auth), 401, 'the intercepted token is dead');
  assert.deepEqual(await founder.get('data'), { precious: true });
  assert.equal(founder.status().rekeyPending, false);
  assert.deepEqual(await (await (async () => { const c = newClient(world); await c.unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase }); return c; })()).get('data'), { precious: true });
});

test('cancelInvite: the invite is used between the last sync and the roster POST (409 revocation_required)', async () => {
  const ctx = await setupVault();
  const { founder } = ctx;
  const inv = await founder.createInvite({ role: 'read' });
  await openInvite(ctx, inv);
  // the owner's view is stale: the server still reports the invite as unused in the sync that cancelInvite starts with
  const real = founder._syncHead;
  founder._syncHead = async function () { await real.call(this); if (this.s.serverSlots[inv.slotId]) this.s.serverSlots[inv.slotId].used = false; };
  const r = await founder.cancelInvite(inv.slotId);
  founder._syncHead = real;
  assert.equal(r.revoked, true);
  assert.equal(founder.status().epoch, 2);
});

test('a redeemed invite is revoked, not cancelled', async () => {
  const ctx = await setupVault();
  const { founder, world } = ctx;
  const inv = await founder.createInvite({ role: 'write' });
  const member = newClient(world);
  await member.redeemInvite({ inviteCode: inv.code.display, passphrase: 'member passphrase one two' });
  await rejects(founder.cancelInvite(inv.slotId, { revoke: false }), core.RequestError, /revocation_required/);
  const r = await founder.cancelInvite(inv.slotId);
  assert.equal(r.revoked, true);
  await rejects(member.get('x'), core.AuthError);
});

// ---- reads and re-encryption do not depend on the scope's current limit ----
test('records above a lowered max_value_bytes stay readable, listable, exportable and re-encryptable', async () => {
  const ctx = await setupVault({ world: { scope: { limits: { max_value_bytes: 4 * 1024 * 1024 } } } });
  const { founder, world } = ctx;
  const big = new Uint8Array(300000).map((_, i) => i & 255);
  await founder.put('files/big.bin', big);
  await founder.put('small', { a: 1 });
  world.server.scopes.get(world.scope).limits.max_value_bytes = 1000;
  const info = await founder.getScopeInfo(true);
  assert.ok(info.limits.max_envelope_bytes < 300000);
  const got = await founder.getRecord('files/big.bin');
  assert.deepEqual(Array.from(got.value.subarray(0, 5)), [0, 1, 2, 3, 4]);
  assert.equal(got.length, 300000);
  assert.equal((await founder.list()).length, 2);
  assert.equal((await founder.readAll()).length, 2);
  // a revocation re-encrypts the blob
  const inv = await founder.createInvite({ role: 'write' });
  const r = await founder.revoke([inv.slotId]);
  assert.equal(r.done, true); assert.equal(r.rekeyed, 2);
  assert.equal(founder.status().rekeyPending, false);
  assert.equal((await founder.getRecord('files/big.bin')).epoch, 2);
});

test('the fixed read bound is the 25 MiB ceiling, not a scope value', async () => {
  const ceiling = I.padme(4 + 2048 + 26214400) + 38;
  const header = I.envHeader(1, 1);
  const over = new Uint8Array(ceiling + 1); over.set(header);
  const exact = new Uint8Array(ceiling); exact.set(header);
  assert.throws(() => I.parseEnvelope(over, 1), /length out of range/);
  assert.equal(I.parseEnvelope(exact, 1).epoch, 1);
});

// ---- chain verifier: escrow slot ID and expiry ----
async function forged(ctx, change) {
  const { founder, world, created } = ctx;
  const chain = founder.s.chain, head = chain[chain.length - 1];
  const body = JSON.parse(JSON.stringify(head.body));
  body.version++; body.prev = head.hash; body.signer = founder.s.slotId; body.time += 1;
  await change(body);
  body.slots.sort((a, b) => (a.id < b.id ? -1 : 1));
  const doc = await I.signRoster(body, founder.s.sPriv);
  const docs = chain.map((c) => ({ body: c.body, sig: c.sig })).concat([doc]);
  return I.verifyRosterChain({ scope: world.scope, vault: created.vaultId, escrowPins: world.pins, docs, prior: null });
}

test('the verifier requires the escrow slot to keep its slot ID', async () => {
  const ctx = await setupVault();
  await forged(ctx, () => {}); // an unchanged copy is fine for the verifier (the server refuses no-ops)
  await rejects(forged(ctx, (body) => { body.slots.find((s) => s.kind === 'escrow').id = I.randomSlotId(); }), core.IntegrityError, /escrow slot must keep its slot ID/);
  // a second escrow slot with the old one removed is the same swap
  await rejects(forged(ctx, (body) => {
    const old = body.slots.find((s) => s.kind === 'escrow');
    body.slots = body.slots.filter((s) => s !== old).concat([Object.assign({}, old, { id: I.randomSlotId() })]);
  }), core.IntegrityError, /escrow slot must keep its slot ID/);
});

test('the verifier refuses an expiry change of a slot that stays an invite', async () => {
  const ctx = await setupVault();
  const inv = await ctx.founder.createInvite({ role: 'write' });
  await rejects(forged(ctx, (body) => { body.slots.find((s) => s.id === inv.slotId).expires += 60; }), core.IntegrityError, /expiry cannot change/);
});

// ---- a missing keyring entry is an integrity failure, not a TypeError ----
test('GET /slots without a keyring entry raises IntegrityError', async () => {
  const ctx = await setupVault();
  const { world, created, passphrase } = ctx;
  const orig = world.server.fetch;
  const fetch = async (url, init) => {
    const res = await orig(url, init);
    if ((init && init.method || 'GET') === 'GET' && new URL(url).pathname.endsWith('/slots/' + created.accessId)) {
      const doc = await res.json(); doc.keyring = null;
      return new Response(JSON.stringify(doc), { status: res.status, headers: res.headers });
    }
    return res;
  };
  const e = await rejects(newClient(world, { fetch }).unlock({ accessId: created.accessId, passphrase }), core.IntegrityError, /keyring/);
  assert.ok(!(e instanceof TypeError));
});

// ---- owner cleanup of expired invites ----
async function afterExpiry(ctx, seconds) {
  ctx.world.server.nowFn = () => NOW() + seconds;
  const c = newClient(ctx.world, { storage: ctx.world.storage });
  await c.unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase });
  return c;
}

test('unlock removes expired unredeemed invites; never-used ones need no new epoch', async () => {
  const ctx = await setupVault();
  const { founder } = ctx;
  await founder.put('data', 1);
  const a = await founder.createInvite({ role: 'write', expiresIn: 3600 });
  const b = await founder.createInvite({ role: 'read', expiresIn: 3600 });
  const keep = await founder.createInvite({ role: 'read', expiresIn: 5 * 86400 });
  const version = founder.status().rosterVersion;
  const c = await afterExpiry(ctx, 7200);
  const ids = c.members().map((m) => m.slotId);
  assert.equal(ids.includes(a.slotId), false); assert.equal(ids.includes(b.slotId), false);
  assert.equal(ids.includes(keep.slotId), true, 'a valid invite stays');
  assert.equal(c.status().rosterVersion, version + 1, 'one roster version for both');
  assert.equal(c.status().epoch, 1);
  assert.equal(c.s.warnings.length, 0);
  // the next unlock has nothing to clean up
  const d = await afterExpiry(ctx, 7300);
  assert.equal(d.status().rosterVersion, version + 1);
});

test('unlock revokes an expired invite that was used, and the re-encryption stays resumable', async () => {
  const ctx = await setupVault();
  const { founder } = ctx;
  await founder.put('data', { precious: true });
  const unused = await founder.createInvite({ role: 'write', expiresIn: 3600 });
  const opened = await founder.createInvite({ role: 'read', expiresIn: 3600 });
  await openInvite(ctx, opened);
  const c = await afterExpiry(ctx, 7200);
  const ids = c.members().map((m) => m.slotId);
  assert.equal(ids.includes(unused.slotId) || ids.includes(opened.slotId), false);
  assert.equal(c.status().epoch, 2, 'a used invite is withdrawn by a revocation');
  assert.equal(c.status().rekeyPending, true, 'the unlock does not wait for the re-encryption');
  const r = await c.resumeRekey();
  assert.equal(r.done, true);
  assert.equal(c.status().rekeyPending, false);
  assert.deepEqual(await c.get('data'), { precious: true });
});

test('an expired invite is not touched by members or when maintenance is off', async () => {
  const ctx = await setupVault();
  const { founder } = ctx;
  const inv = await founder.createInvite({ role: 'write', expiresIn: 3600 });
  ctx.world.server.nowFn = () => NOW() + 7200;
  const c = newClient(ctx.world, { storage: ctx.world.storage });
  await c.unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase, maintain: false });
  assert.equal(c.members().some((m) => m.slotId === inv.slotId), true);
  assert.equal(c.members().find((m) => m.slotId === inv.slotId).expired, true);
  await c.maintain();
  assert.equal(c.members().some((m) => m.slotId === inv.slotId), false);
});
