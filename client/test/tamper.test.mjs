// Tamper detection: a malicious or broken server must never get the client to accept forged data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { core, I, setupVault, newClient, addMember, rejects, makeWorld, seq } from './helpers.mjs';

const vaultOf = (ctx) => ctx.world.server.vaults.get(ctx.created.vaultId);
const codeOf = (e) => e.code;

test('forged keyring entry: wrong keys under the right ECIES envelope fail the roster commitments', async () => {
  const ctx = await setupVault();
  const { member, accessId } = await addMember(ctx, 'write', 'member pass one');
  await ctx.founder.maintain();
  await ctx.founder.put('a', { secret: 1 });
  const vault = vaultOf(ctx), slotId = member.s.slotId, head = ctx.founder.s.head;
  const entry = head.body.slots.find((s) => s.id === slotId), pub = I.b64uDecode(entry.e_pub);
  // the server (which only knows public keys) encrypts attacker-chosen keys to the member
  const fakeVmk = I.randomBytes(32), fakeNk = I.randomBytes(32);
  const env = await I.eciesSeal({ recipientPub: pub, plaintext: I.keyringPlaintext([{ e: 1, k: fakeVmk }], fakeNk), aadTail: I.aadKeyring(ctx.world.scope, ctx.created.vaultId, slotId, head.body.version, pub) });
  vault.keyring.set(slotId, I.b64u(env));
  const c = newClient(ctx.world, { storage: core.memoryStorage() });
  const e = await rejects(c.unlock({ accessId, passphrase: 'member pass one' }), core.IntegrityError);
  assert.equal(e.code, 'keyring_mismatch');
  // right VMK, wrong NK
  const realVmk = ctx.founder.s.vmk.get(1);
  const env2 = await I.eciesSeal({ recipientPub: pub, plaintext: I.keyringPlaintext([{ e: 1, k: realVmk }], fakeNk), aadTail: I.aadKeyring(ctx.world.scope, ctx.created.vaultId, slotId, head.body.version, pub) });
  vault.keyring.set(slotId, I.b64u(env2));
  const e2 = await rejects(newClient(ctx.world, { storage: core.memoryStorage() }).unlock({ accessId, passphrase: 'member pass one' }), core.IntegrityError);
  assert.equal(e2.code, 'keyring_mismatch');
  // an entry copied from another slot (the founder's) does not decrypt under this slot's AAD and key
  vault.keyring.set(slotId, vault.keyring.get(ctx.founder.s.slotId));
  await rejects(newClient(ctx.world, { storage: core.memoryStorage() }).unlock({ accessId, passphrase: 'member pass one' }), core.IntegrityError);
  // an entry from an older roster version (replayed) fails the AAD
  const olderEnv = await I.eciesSeal({ recipientPub: pub, plaintext: I.keyringPlaintext([{ e: 1, k: realVmk }], ctx.founder.s.nk), aadTail: I.aadKeyring(ctx.world.scope, ctx.created.vaultId, slotId, head.body.version - 1, pub) });
  vault.keyring.set(slotId, I.b64u(olderEnv));
  await rejects(newClient(ctx.world, { storage: core.memoryStorage() }).unlock({ accessId, passphrase: 'member pass one' }), core.IntegrityError);
});

test('a keyring entry missing a committed epoch, or listing extra ones, is rejected', async () => {
  const ctx = await setupVault();
  const { member, accessId } = await addMember(ctx, 'write', 'member pass one');
  await ctx.founder.maintain();
  const vault = vaultOf(ctx), head = ctx.founder.s.head, slotId = member.s.slotId;
  const entry = head.body.slots.find((s) => s.id === slotId), pub = I.b64uDecode(entry.e_pub);
  const aad = I.aadKeyring(ctx.world.scope, ctx.created.vaultId, slotId, head.body.version, pub);
  const k = ctx.founder.s.vmk.get(1), nk = ctx.founder.s.nk;
  vault.keyring.set(slotId, I.b64u(await I.eciesSeal({ recipientPub: pub, plaintext: I.keyringPlaintext([{ e: 1, k }, { e: 2, k }], nk), aadTail: aad })));
  await rejects(newClient(ctx.world, { storage: core.memoryStorage() }).unlock({ accessId, passphrase: 'member pass one' }), core.IntegrityError, /keyring/);
  vault.keyring.set(slotId, I.b64u(await I.eciesSeal({ recipientPub: pub, plaintext: I.keyringPlaintext([], nk), aadTail: aad })));
  await rejects(newClient(ctx.world, { storage: core.memoryStorage() }).unlock({ accessId, passphrase: 'member pass one' }), core.IntegrityError, /keyring/);
});

test('swapped blobs: record A served for B, version 1 served as version 2, tampered bytes', async () => {
  const ctx = await setupVault();
  const { founder } = ctx;
  await founder.put('A', { n: 'a' }); await founder.put('B', { n: 'b' });
  await founder.put('A', { n: 'a2' });
  const vault = vaultOf(ctx), ridA = await founder._rid('A'), ridB = await founder._rid('B');
  const reader = newClient(ctx.world, { storage: core.memoryStorage() });
  await reader.unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase });
  const recA = vault.records.get(ridA), recB = vault.records.get(ridB);
  // 1. B's envelope and commitment under A's ID
  const saved = recA.versions.map((v) => Object.assign({}, v));
  recA.versions[1].bytes = recB.versions[0].bytes; recA.versions[1].commit = recB.versions[0].commit;
  await rejects(reader.get('A'), core.IntegrityError);
  // 2. A's old version 1 presented as the latest (ETag 2): the version in the AAD does not match
  recA.versions[1].bytes = saved[0].bytes; recA.versions[1].commit = saved[0].commit;
  await rejects(reader.get('A'), core.IntegrityError);
  // 3. one flipped bit
  recA.versions[1].bytes = new Uint8Array(saved[1].bytes); recA.versions[1].bytes[recA.versions[1].bytes.length - 3] ^= 1; recA.versions[1].commit = saved[1].commit;
  await rejects(reader.get('A'), core.IntegrityError);
  // 4. header tampering (epoch field) is caught by the AAD too
  recA.versions[1].bytes = new Uint8Array(saved[1].bytes); recA.versions[1].bytes[9] = 7;
  await rejects(reader.get('A'), core.IntegrityError);
  // restored: fine again
  recA.versions[1].bytes = saved[1].bytes;
  assert.deepEqual(await reader.get('A'), { n: 'a2' });
  // list() notices a record whose content belongs to another ID
  recA.versions[1].bytes = recB.versions[0].bytes; recA.versions[1].commit = recB.versions[0].commit;
  const lister = newClient(ctx.world, { storage: core.memoryStorage() });
  await lister.unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase });
  await rejects(lister.list(), core.IntegrityError);
});

test('history commitment: a replaced commitment or a rewritten old version is detected', async () => {
  const ctx = await setupVault();
  const { founder } = ctx;
  await founder.put('n', { v: 1 }); await founder.put('n', { v: 2 });
  const vault = vaultOf(ctx), rid = await founder._rid('n'), rec = vault.records.get(rid);
  const good = rec.versions[0].commit;
  rec.versions[0].commit = I.b64u(seq(32, 9));
  await rejects(founder.getVersion('n', 1), core.IntegrityError, /commitment/);
  rec.versions[0].commit = good;
  assert.deepEqual((await founder.getVersion('n', 1)).value, { v: 1 });
  // a (colluding) write member rewrites version 1 under the same ID and version with other content, keeping the commitment
  const forged = I.buildRecordPlaintext('n', 'json', I.utf8(JSON.stringify({ v: 'evil' })), undefined, Date.now());
  rec.versions[0].bytes = await I.sealRecord({ kEncRaw: await I.hkdf(founder.s.vmk.get(1), new Uint8Array(0), 'wds1/record-enc'), epoch: 1, scope: ctx.world.scope, vault: ctx.created.vaultId, rid, version: 1, plaintext: forged.plaintext });
  await rejects(founder.getVersion('n', 1), core.IntegrityError, /commitment/);
});

test('rekey refuses to re-encrypt a version whose content no longer matches its commitment', async () => {
  const ctx = await setupVault();
  const { founder } = ctx;
  const { member } = await addMember(ctx, 'write');
  await founder.maintain();
  await founder.put('n', { v: 1 }); await founder.put('n', { v: 2 });
  const vault = vaultOf(ctx), rid = await founder._rid('n'), rec = vault.records.get(rid);
  const forged = I.buildRecordPlaintext('n', 'json', I.utf8(JSON.stringify({ v: 'xx' })), undefined, Date.now());
  const old = rec.versions[0].bytes;
  const fb = await I.sealRecord({ kEncRaw: await I.hkdf(founder.s.vmk.get(1), new Uint8Array(0), 'wds1/record-enc'), epoch: 1, scope: ctx.world.scope, vault: ctx.created.vaultId, rid, version: 1, plaintext: forged.plaintext });
  assert.ok(fb.length <= old.length + 32);
  rec.versions[0].bytes = fb;
  const e = await rejects(founder.revoke([member.s.slotId]), core.IntegrityError);
  assert.equal(e.code, 'commit_mismatch');
  // the old epoch was not dropped
  assert.ok(founder.s.head.body.commit.epochs.length === 2);
});

test('a record whose header names another record is rejected', async () => {
  const ctx = await setupVault();
  const { founder } = ctx;
  await founder.put('real', { v: 1 });
  const vault = vaultOf(ctx), rid = await founder._rid('real'), rec = vault.records.get(rid);
  const forged = I.buildRecordPlaintext('other', 'json', I.utf8('{}'), undefined, Date.now());
  const key = await I.hkdf(founder.s.vmk.get(1), new Uint8Array(0), 'wds1/record-enc');
  rec.versions[0].bytes = await I.sealRecord({ kEncRaw: key, epoch: 1, scope: ctx.world.scope, vault: ctx.created.vaultId, rid, version: 1, plaintext: forged.plaintext });
  rec.versions[0].commit = await I.commitment(founder.s.keys.kCommit, rid, 1, forged.plaintext);
  await rejects(founder.get('real'), core.IntegrityError, /name/);
});

test('rolled-back roster: an older head is refused on a device that has seen the newer one', async () => {
  const ctx = await setupVault();
  const { founder, world, created, passphrase } = ctx;
  const vault = vaultOf(ctx);
  const keyringV1 = new Map(vault.keyring);
  await founder.createInvite({ role: 'write' }); // roster version 2, pinned in world.storage
  const c0 = newClient(world, { storage: world.storage });
  assert.equal((await c0.unlock({ accessId: created.accessId, passphrase })).rosterVersion, 2);
  // the server drops version 2 and serves the old keyring
  const v2 = vault.rosters.pop(); vault.keyring = keyringV1; vault.keyringVersion = 1;
  const e = await rejects(newClient(world, { storage: world.storage }).unlock({ accessId: created.accessId, passphrase }), core.IntegrityError);
  assert.equal(e.code, 'rollback');
  // with a fresh device the same rollback is invisible (documented limitation, PLAN.md section 5.5)
  const fresh = newClient(world, { storage: core.memoryStorage() });
  assert.equal((await fresh.unlock({ accessId: created.accessId, passphrase })).rosterVersion, 1);
  assert.ok(v2);
});

test('rolled-back roster, part 2: live session and forks', async () => {
  const ctx = await setupVault();
  const { founder, world, created, passphrase } = ctx;
  const vault = vaultOf(ctx);
  const keyringV1 = new Map(vault.keyring);
  await founder.createInvite({ role: 'write' });
  const keyringV2 = new Map(vault.keyring), v2 = vault.rosters[1];
  assert.equal(founder.status().rosterVersion, 2);
  // live session: the server pretends the head is version 1 again
  vault.rosters.pop(); vault.keyring = keyringV1; vault.keyringVersion = 1;
  const e = await rejects(founder._syncHead(), core.IntegrityError);
  assert.equal(e.code, 'rollback');
  // fork: the server shows a different version 2 (also signed by the founder, who could be tricked or compromised)
  const body = JSON.parse(JSON.stringify(v2.body)); body.time += 5;
  const sPriv = await I.importPrivate('S', founder.s.keySets[0].s.d, founder.s.keySets[0].s.pub);
  const forked = await I.signRoster(body, sPriv);
  vault.rosters.push({ body: forked.body, sig: forked.sig, hash: await I.rosterHash(forked.body) });
  vault.keyring = keyringV2; vault.keyringVersion = 2;
  const e2 = await rejects(newClient(world, { storage: world.storage }).unlock({ accessId: created.accessId, passphrase }), core.IntegrityError);
  assert.equal(e2.code, 'rollback');
  // on a new device (no pinned state) nothing can be detected: documented limitation, and visible as stateStatus 'new'
  const fresh = newClient(world, { storage: core.memoryStorage() });
  const st = await fresh.unlock({ accessId: created.accessId, passphrase });
  assert.equal(st.newDevice, true);
});

test('record rollback: an older version served after a newer one was seen', async () => {
  const ctx = await setupVault();
  const { founder } = ctx;
  await founder.put('x', 1); await founder.put('x', 2);
  const vault = vaultOf(ctx), rid = await founder._rid('x'), rec = vault.records.get(rid);
  const c = newClient(ctx.world, { storage: ctx.world.storage });
  await c.unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase });
  assert.equal(await c.get('x'), 2);
  rec.versions.pop(); // the server serves version 1 as the latest again (valid ciphertext, correct AAD for version 1)
  const e = await rejects(c.get('x'), core.IntegrityError);
  assert.equal(e.code, 'rollback');
  await rejects(c.list(), core.IntegrityError);
  // also after a restart of the app (state persisted)
  const c2 = newClient(ctx.world, { storage: ctx.world.storage });
  await c2.unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase });
  await rejects(c2.get('x'), core.IntegrityError);
});

test('wrong salt or weaker parameters from the server', async () => {
  const ctx = await setupVault();
  const { world, created, passphrase } = ctx;
  const vault = vaultOf(ctx), slot = vault.slots.get(ctx.founder.s.slotId), real = JSON.parse(JSON.stringify(slot.kdf));
  // weaker parameters: refused before any Argon2 run
  for (const bad of [{ m: 1024 }, { t: 1 }, { m: 1073741824 }, { p: 2 }, { v: 16 }]) {
    slot.kdf = Object.assign({}, real, bad);
    const e = await rejects(newClient(world).unlock({ accessId: created.accessId, passphrase }), core.IntegrityError);
    assert.equal(e.code, 'weak_kdf', JSON.stringify(bad));
  }
  slot.kdf = Object.assign({}, real, { salt: I.b64u(seq(8, 0)) });
  await rejects(newClient(world).unlock({ accessId: created.accessId, passphrase }), core.IntegrityError);
  slot.kdf = Object.assign({}, real, { extra: 1 });
  await rejects(newClient(world).unlock({ accessId: created.accessId, passphrase }), core.IntegrityError);
  // a different salt that the server also accepts the token for (it cannot know the passphrase here, so the test plays it):
  // the stored blob was wrapped under the original salt/KEK and its AAD names the original descriptor
  const other = Object.assign({}, real, { salt: I.b64u(seq(16, 77)) });
  const kek = await (await import('./helpers.mjs')).fastArgon2({ password: I.utf8(passphrase), salt: seq(16, 77), parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32 });
  slot.kdf = other; slot.tokenHash = I.b64u((await I.deriveSlotKeys(kek)).tokenHash);
  const e = await rejects(newClient(world).unlock({ accessId: created.accessId, passphrase }), core.IntegrityError);
  assert.equal(e.code, 'decrypt_failed');
  // the slot response disagreeing with the kdf endpoint
  slot.kdf = real; slot.tokenHash = I.b64u((await I.deriveSlotKeys(await (await import('./helpers.mjs')).fastArgon2({ password: I.utf8(passphrase), salt: I.b64uDecode(real.salt), parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32 }))).tokenHash);
  const orig = world.server.getKdf.bind(world.server);
  world.server.getKdf = (id) => { const r = orig(id); return { json: { kind: r.json.kind, kdf: Object.assign({}, r.json.kdf, { salt: I.b64u(seq(16, 3)) }) } }; };
  await rejects(newClient(world).unlock({ accessId: created.accessId, passphrase }), core.AuthError); // token differs: server answers 401
  world.server.getKdf = orig;
  await newClient(world).unlock({ accessId: created.accessId, passphrase });
});

test('a server that offers weak KDF parameters in scope info cannot make us create a vault with them', async () => {
  const world = await makeWorld();
  world.server.getScope = ((orig) => (id) => { const r = orig(id); r.json.kdf = { alg: 'argon2id', m: 4096, p: 1, t: 1, v: 19 }; return r; })(world.server.getScope.bind(world.server));
  await rejects(newClient(world).createVault({ passphrase: 'a perfectly fine passphrase' }), core.IntegrityError, /window|KDF/);
});

test('escrow keys that are not pinned are refused at vault creation and in rosters', async () => {
  const world = await makeWorld();
  const c = newClient(world, { escrowPins: ['0'.repeat(43)] });
  const e = await rejects(c.createVault({ passphrase: 'a perfectly fine passphrase' }), core.IntegrityError);
  assert.equal(e.code, 'escrow_not_pinned');
  // a server that sends a made-up ID for real keys
  world.server.escrow.current.id = 'x'.repeat(43);
  await rejects(newClient(world).createVault({ passphrase: 'a perfectly fine passphrase' }), core.IntegrityError);
  world.server.escrow.current.id = world.pins[0];
  // a vault created with escrow keys the library does not pin is not trusted later either
  const ok = await newClient(world).createVault({ passphrase: 'a perfectly fine passphrase' });
  await rejects(newClient(world, { escrowPins: [world.pins[1]] }).unlock({ accessId: ok.accessId, passphrase: 'a perfectly fine passphrase' }), core.IntegrityError, /pinned/);
  // no pins at all
  await rejects(newClient(world, { escrowPins: [] }).createVault({ passphrase: 'a perfectly fine passphrase' }), core.WDSError, /pinned/);
});

test('forged rosters: bad signature, non-owner signer, broken chain, wrong vault, unknown format', async () => {
  const ctx = await setupVault();
  const { founder, world, created } = ctx;
  await founder.createInvite({ role: 'write' });
  const chain = founder.s.chain, docs = chain.map((c) => ({ body: c.body, sig: c.sig }));
  const base = { scope: world.scope, vault: created.vaultId, escrowPins: world.pins, prior: null };
  const verify = (d, extra) => I.verifyRosterChain(Object.assign({}, base, { docs: d }, extra));
  assert.equal((await verify(docs)).length, 2);
  // flipped signature bit
  const sig = I.b64uDecode(docs[1].sig); sig[10] ^= 1;
  await rejects(verify([docs[0], { body: docs[1].body, sig: I.b64u(sig) }]), core.IntegrityError, /signature/);
  // signed by the invited member (not an owner in the previous version)
  const body = JSON.parse(JSON.stringify(docs[1].body)), member = body.slots.find((s) => s.kind === 'invite');
  body.signer = member.id;
  await rejects(verify([docs[0], { body, sig: docs[1].sig }]), core.IntegrityError, /owner/);
  // skipping a version
  const skip = JSON.parse(JSON.stringify(docs[1].body)); skip.version = 3;
  await rejects(verify([docs[0], { body: skip, sig: docs[1].sig }]), core.IntegrityError);
  // wrong prev
  const wp = JSON.parse(JSON.stringify(docs[1].body)); wp.prev = I.b64u(seq(32, 1));
  await rejects(verify([docs[0], { body: wp, sig: docs[1].sig }]), core.IntegrityError, /prev/);
  // a different vault ID (signature cannot match the vault ID derived from the founder key)
  await rejects(verify(docs, { vault: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ' }), core.IntegrityError);
  // first version must be 1
  await rejects(verify([docs[1]]), core.IntegrityError);
  // attacker-created chain for the same vault ID but with attacker keys
  const atk = await I.generateKeyPair('S'), atkE = await I.generateKeyPair('E');
  const forged = JSON.parse(JSON.stringify(docs[0].body)); const fs = forged.slots.find((s) => s.kind === 'passphrase');
  fs.s_pub = I.b64u(atk.pub); fs.e_pub = I.b64u(atkE.pub);
  const fr = await I.signRoster(forged, await I.importPrivate('S', atk.d, atk.pub));
  await rejects(verify([fr]), core.IntegrityError, /vault ID/);
  // unknown format versions are VersionErrors, not generic failures
  const v2 = JSON.parse(JSON.stringify(docs[0].body)); v2.v = 2;
  await rejects(verify([{ body: v2, sig: docs[0].sig }]), core.VersionError);
});

test('format versions: slot blob and keyring entry with v other than 1 raise VersionError', async () => {
  const kWrap = seq(32, 3), scope = 'notenrechner-k7m2a9', vault = 'A'.repeat(26), accessId = '000G40R40M30E209185Z';
  const pt = I.cjsonBytes({ keys: [], slot: 'AAAAAAAAAAAAAAAA', v: 2, vault });
  const env = await I.sealEnvelope(await I.aesKey(kWrap), 2, 0, pt, I.aadSlot(scope, vault, accessId, { alg: 'invite' }));
  await rejects(I.unwrapSlot({ kWrapRaw: kWrap, scope, vault, accessId, kdf: { alg: 'invite' }, envelope: env }), core.VersionError);
  assert.throws(() => I.parseKeyringPlaintext(I.cjsonBytes({ epochs: [], nk: I.b64u(seq(32, 0)), v: 2 })), core.VersionError);
});

test('the server cannot swap in another vault: scope and vault IDs are bound everywhere', async () => {
  const a = await setupVault(), b = await setupVault();
  await a.founder.put('x', 'a');
  // b's server data is shown to a client of a: different scope/vault in AAD and roster
  const slotA = vaultOf(a).slots.get(a.founder.s.slotId), slotB = vaultOf(b).slots.get(b.founder.s.slotId);
  slotA.wrapped = slotB.wrapped; // blob of another vault/access ID
  await rejects(newClient(a.world).unlock({ accessId: a.created.accessId, passphrase: a.passphrase }), core.IntegrityError);
});
