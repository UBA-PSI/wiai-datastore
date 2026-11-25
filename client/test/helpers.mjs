// Shared helpers for the client tests.
import { createRequire } from 'node:module';
import { makeWorld, FakeServer } from './fake-server.mjs';
const require = createRequire(import.meta.url);
export const core = require('../src/wds-core.js');
export const I = core.internals;
export const hashwasm = require('../vendor/hash-wasm-argon2.umd.min.js');
export { makeWorld, FakeServer };

// Real Argon2id (vendored hash-wasm). Slow (about 0.1 to 0.5 s per call): used where the KDF itself matters.
export const realArgon2 = hashwasm.argon2id;
// Stand-in for protocol tests: a salted, parameter-dependent hash. Same interface as hashwasm.argon2id.
export async function fastArgon2({ password, salt, parallelism, iterations, memorySize, hashLength }) {
  return I.sha256(I.concat(I.utf8('fake-argon2'), I.u32(password.length), password, salt, I.u32(parallelism), I.u32(iterations), I.u32(memorySize), I.u32(hashLength)));
}

export function newClient(world, opts = {}) {
  return new core.Client(Object.assign({
    scope: world.scope, service: world.server.service, fetch: world.server.fetch, storage: world.storage || core.memoryStorage(),
    escrowPins: world.pins, argon2: fastArgon2, now: () => world.server.now() * 1000,
  }, opts));
}
export const seq = (n, s) => Uint8Array.from({ length: n }, (_, i) => (s + i) & 255);

// Creates a world, a founder client with an unlocked vault, and returns everything the tests need.
export async function setupVault(opts = {}) {
  const world = await makeWorld(opts.world);
  world.storage = core.memoryStorage();
  const founder = newClient(world, { storage: world.storage });
  const created = await founder.createVault({ passphrase: opts.passphrase || 'correct horse battery staple' });
  return { world, founder, created, passphrase: opts.passphrase || 'correct horse battery staple' };
}
// Invite + redeem: returns the member client (unlocked) and the invite info.
export async function addMember(ctx, role = 'write', passphrase = 'member passphrase one two') {
  const invite = await ctx.founder.createInvite({ role });
  const member = newClient(ctx.world);
  await member.redeemInvite({ inviteCode: invite.code.display, passphrase });
  return { member, invite, passphrase, accessId: member.s.accessId };
}
export async function rejects(promise, ErrorClass, pattern) {
  try { await promise; } catch (e) {
    if (ErrorClass && !(e instanceof ErrorClass)) throw new Error('expected ' + ErrorClass.name + ' but got ' + e.name + ': ' + e.message);
    if (pattern && !pattern.test(e.message + ' ' + (e.code || ''))) throw new Error('error message did not match ' + pattern + ': ' + e.message);
    return e;
  }
  throw new Error('expected rejection' + (ErrorClass ? ' with ' + ErrorClass.name : ''));
}

// The operator's recovery step in a Node test (PROTOCOL.md 9): an escrow-signed roster version adds exactly one owner invite.
// The founder client lends its copy of the keys (standing in for the escrow keyring entry wds-recover would decrypt).
// Returns {slotId, accessId, inviteCode (display form)}.
export async function recoverOwner(ctx) {
  const { founder, world, created } = ctx;
  const esc = world.escrow.current, s = founder.s, head = s.head;
  const escSlot = head.body.slots.find((x) => x.kind === 'escrow');
  const ownerE = await I.generateKeyPair('E'), ownerS = await I.generateKeyPair('S');
  const slotId = I.randomSlotId(), secret = I.randomBytes(17), idBytes = I.randomBytes(12), accessId = await I.b32cEncode(idBytes);
  const sk = await I.deriveSlotKeys(secret);
  const body = JSON.parse(JSON.stringify(head.body));
  body.version++; body.prev = head.hash; body.signer = escSlot.id; body.time += 1;
  body.slots.push({ e_pub: I.b64u(ownerE.pub), expires: world.server.now() + 86400, id: slotId, kind: 'invite', role: 'owner', s_pub: I.b64u(ownerS.pub) });
  body.slots.sort((a, b) => (a.id < b.id ? -1 : 1));
  const keyring = await I.makeKeyring(world.scope, body, s.vmk, s.nk);
  const roster = await I.signRoster(body, await I.importPrivate('S', esc.s.d, esc.s.pub));
  const wrapped = await I.wrapSlot({ kWrapRaw: sk.kWrap, scope: world.scope, vault: created.vaultId, accessId, kdf: { alg: 'invite' }, slotId, keySets: [{ e: ownerE, s: ownerS }] });
  const res = await world.server.fetch(world.server.service + 'api/v1/vaults/' + created.vaultId + '/roster', {
    method: 'POST', headers: { Authorization: I.bearerHeader(created.accessId, s.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ roster, keyring, new_slots: [{ slot: slotId, access_id: accessId, kdf: { alg: 'invite' }, token_hash: I.b64u(sk.tokenHash), wrapped: I.b64u(wrapped) }] }),
  });
  if (res.status !== 200) throw new Error('recovery roster refused: ' + res.status + ' ' + await res.text());
  return { slotId, accessId, inviteCode: (await I.makeInviteCode(idBytes, secret)).display };
}
