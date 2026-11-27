// Re-derives every value of vectors.json with the library and compares (PROTOCOL.md section 12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { core, I, hashwasm, seq, rejects } from './helpers.mjs';

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const hex = I.hex, unhex = I.unhex, b64u = I.b64u, EMPTY = new Uint8Array(0);
const SCOPE = V.record_json.scope;

test('b32c encode, decode, failures', async () => {
  for (const c of V.b32c.encode) {
    assert.equal(await I.b32cEncode(unhex(c.hex)), c.b32c);
    assert.equal(core.displayCode(c.b32c), c.display);
    assert.equal(hex(await I.b32cDecode(c.b32c, c.hex.length / 2)), c.hex);
  }
  for (const c of V.b32c.decode_ok) assert.equal(hex(await I.b32cDecode(c.input, c.hex.length / 2)), c.hex, c.input);
  for (const c of V.b32c.decode_fail) await assert.rejects(I.b32cDecode(c.input, c.bytes), undefined, c.reason);
  assert.equal(await I.vaultIdFromPub(unhex(V.b32c.plain_crockford.input_hex)), V.b32c.plain_crockford.vault_id);
});

test('cjson valid, invalid, strict parser', () => {
  for (const c of V.cjson.valid) {
    assert.equal(I.cjson(c.value), c.canonical);
    assert.deepEqual(I.cjsonParse(c.canonical), c.value);
  }
  for (const c of V.cjson.invalid) assert.throws(() => I.cjson(JSON.parse(c.json)), core.errors.UsageError, c.reason);
  for (const c of V.cjson.invalid_parse) assert.throws(() => I.cjsonParse(c.text), core.errors.IntegrityError, c.reason);
});

test('padme table', () => {
  for (const c of V.padme) assert.equal(I.padme(c.L), c.padme, 'L=' + c.L);
});

test('argon2id: NFC and NFD give the same KEK', async () => {
  const a = V.argon2id;
  assert.equal(I.cjson(a.kdf), a.kdf_canonical);
  assert.equal(hex(await I.argon2idKey(a.passphrase_nfc, a.kdf, hashwasm.argon2id)), a.kek_hex);
  assert.equal(hex(await I.argon2idKey(a.passphrase_nfd, a.kdf, hashwasm.argon2id)), a.kek_hex);
  assert.notEqual(a.passphrase_nfc, a.passphrase_nfd);
});

test('slot keys, vault keys, record id seed', async () => {
  for (const c of Object.values(V.slot_keys)) {
    const sk = await I.deriveSlotKeys(unhex(c.ikm_hex));
    assert.equal(hex(sk.kWrap), c.k_wrap_hex);
    assert.equal(hex(sk.token), c.token_hex);
    assert.equal(b64u(sk.token), c.token_b64u);
    assert.equal(b64u(sk.tokenHash), c.token_hash_b64u);
    assert.equal(I.bearerHeader(c.access_id, sk.token), c.bearer);
  }
  assert.equal(V.slot_keys.kek_case.k_wrap_hex, '592302fe98cbcdee20f85a7d785e6c07f1b0c6b6276ac3f1829dba285edbcd68');
  assert.equal(V.slot_keys.kek_case.token_b64u, 'PPnWDESSTT3vYHXn8TuGaH5KTZBb9irv3_kdycj7zXg');
  assert.equal(V.slot_keys.kek_case.token_hash_b64u, '_b2KzFpTzPo4PqqrDsHAecJR1cJZdq6B0FbxjqZ8TJQ');
  const k = V.vault_keys, dk = await I.deriveVaultKeys(unhex(k.vmk1_hex), unhex(k.nk_hex));
  assert.equal(hex(dk.kEnc), k.k_enc_1_hex); assert.equal(hex(dk.kId), k.k_id_hex); assert.equal(hex(dk.kCommit), k.k_commit_hex);
  assert.equal(hex(dk.kState), k.k_state_hex); assert.equal(b64u(dk.cVmk), k.c_1); assert.equal(b64u(dk.cNk), k.c_nk);
  const kid = await I.hkdf(unhex(V.record_id_seed.k_id_ikm_hex), EMPTY, 'wds1/record-id');
  assert.equal(await I.recordId(kid, V.record_id_seed.name), V.record_id_seed.record_id);
});

test('keys: public keys match scalars, IDs', async () => {
  for (const [name, k] of Object.entries(V.keys)) {
    if (!k.d) continue;
    const kind = name.endsWith('_s') ? 'S' : 'E';
    // the private key imports with its public key (WebCrypto validates the pair when signing/deriving)
    const priv = await I.importPrivate(kind, unhex(k.d), I.b64uDecode(k.pub, 65));
    if (kind === 'S') assert.ok(await I.ecdsaVerify(I.b64uDecode(k.pub, 65), await I.ecdsaSign(priv, seq(3, 0)), seq(3, 0)), name);
    else assert.equal((await I.ecdh(priv, I.b64uDecode(V.keys.founder_e.pub, 65))).length, 32);
    assert.equal(hex(await I.sha256(I.ascii('wds1-vector-' + name))), k.d);
  }
  assert.equal(await I.escrowKeyId(I.b64uDecode(V.keys.escrow_current_e.pub), I.b64uDecode(V.keys.escrow_current_s.pub)), V.keys.escrow_ids.current);
  assert.equal(await I.escrowKeyId(I.b64uDecode(V.keys.escrow_spare_e.pub), I.b64uDecode(V.keys.escrow_spare_s.pub)), V.keys.escrow_ids.spare);
  assert.equal(await I.vaultIdFromPub(I.b64uDecode(V.keys.founder_s.pub)), V.keys.founder_vault_id);
});

for (const name of ['record_json', 'record_bytes']) {
  test(name + ': plaintext, AAD, envelope, commitment, decrypt', async () => {
    const r = V[name], kd = V.vault_keys;
    const kId = unhex(kd.k_id_hex), kEnc = unhex(kd.k_enc_1_hex), kCommit = unhex(kd.k_commit_hex);
    assert.equal(await I.recordId(kId, r.name), r.record_id);
    const body = unhex(r.body_hex);
    const built = I.buildRecordPlaintext(r.name, r.kind, body, r.mime || undefined, r.time);
    assert.equal(new TextDecoder().decode(built.headerBytes), r.header);
    assert.equal(hex(built.plaintext), r.plaintext_hex);
    assert.equal(built.plaintext.length, I.padme(4 + built.headerBytes.length + body.length));
    const env = await I.sealRecord({ kEncRaw: kEnc, epoch: r.epoch, scope: r.scope, vault: r.vault, rid: r.record_id, version: r.version, plaintext: built.plaintext, nonce: unhex(r.nonce_hex) });
    assert.equal(hex(env), r.envelope_hex);
    assert.equal(env.length, r.envelope_len);
    assert.equal(env.length, I.padme(4 + built.headerBytes.length + body.length) + 38);
    assert.equal(hex(I.concat(env.subarray(0, 10), I.aadRecord(r.scope, r.vault, r.record_id, r.version))), r.aad_hex);
    assert.equal(await I.commitment(kCommit, r.record_id, r.version, built.plaintext), r.commit);
    const opened = await I.openRecord({ key: await I.aesKey(kEnc), envelope: unhex(r.envelope_hex), scope: r.scope, vault: r.vault, rid: r.record_id, version: r.version });
    const rec = I.parseRecordPlaintext(opened.plaintext, r.name);
    assert.equal(hex(rec.body), r.body_hex);
    // wrong version in the AAD must fail
    await rejects(I.openRecord({ key: await I.aesKey(kEnc), envelope: unhex(r.envelope_hex), scope: r.scope, vault: r.vault, rid: r.record_id, version: r.version + 1 }), core.errors.IntegrityError);
  });
}

for (const name of ['passphrase', 'invite']) {
  test('slot_wrap ' + name, async () => {
    const w = V.slot_wrap[name];
    const sets = w.plaintext ? I.cjsonParse(w.plaintext).keys.map((k) => ({ e: { d: I.b64uDecode(k.e_d), pub: I.b64uDecode(k.e_pub) }, s: { d: I.b64uDecode(k.s_d), pub: I.b64uDecode(k.s_pub) } })) : [];
    assert.equal(I.cjson(w.kdf), w.kdf_canonical);
    const env = await I.wrapSlot({ kWrapRaw: unhex(w.k_wrap_hex), scope: w.scope, vault: w.vault, accessId: w.access_id, kdf: w.kdf, slotId: w.slot_id, keySets: sets, nonce: unhex(w.nonce_hex) });
    assert.equal(hex(env), w.envelope_hex);
    assert.equal(hex(I.concat(env.subarray(0, 10), I.aadSlot(w.scope, w.vault, w.access_id, w.kdf))), w.aad_hex);
    assert.equal(new TextDecoder().decode(I.slotPlaintext(w.vault, w.slot_id, sets)), w.plaintext);
    const back = await I.unwrapSlot({ kWrapRaw: unhex(w.k_wrap_hex), scope: w.scope, vault: w.vault, accessId: w.access_id, kdf: w.kdf, envelope: unhex(w.envelope_hex) });
    assert.equal(back.slot, w.slot_id); assert.equal(back.keySets.length, 1);
    // a different KDF descriptor (for example a weaker salt) must not decrypt
    const other = w.kdf.alg === 'invite' ? { alg: 'argon2id', m: 65536, p: 1, salt: b64u(seq(16, 1)), t: 3, v: 19 } : Object.assign({}, w.kdf, { salt: b64u(seq(16, 1)) });
    await rejects(I.unwrapSlot({ kWrapRaw: unhex(w.k_wrap_hex), scope: w.scope, vault: w.vault, accessId: w.access_id, kdf: other, envelope: unhex(w.envelope_hex) }), core.errors.IntegrityError);
  });
}

test('keyring_entry (ECIES)', async () => {
  const k = V.keyring_entry, eph = { d: unhex(k.ephemeral.d), pub: I.b64uDecode(k.ephemeral.pub, 65) }, recipient = I.b64uDecode(k.recipient_e_pub, 65);
  const ephPriv = await I.importPrivate('E', eph.d, eph.pub);
  const Z = await I.ecdh(ephPriv, recipient);
  assert.equal(hex(Z), k.z_hex);
  const salt = I.concat(eph.pub, recipient);
  assert.equal(hex(salt), k.hkdf_salt_hex);
  assert.equal(salt.length, 130);
  assert.equal(hex(await I.hkdf(Z, salt, 'wds1/ecies')), k.k_ecies_hex);
  const aadTail = I.aadKeyring(k.scope, k.vault, k.slot_id, k.roster_version, recipient);
  const env = await I.eciesSeal({ recipientPub: recipient, plaintext: I.ascii(k.plaintext), aadTail, eph, nonce: unhex(k.nonce_hex) });
  assert.equal(hex(env), k.envelope_hex);
  assert.equal(hex(I.concat(env.subarray(0, 10), aadTail)), k.aad_hex);
  const recipientPriv = await I.importPrivate('E', unhex(V.keys.founder_e.d), recipient);
  const pt = await I.eciesOpen({ recipientPriv, recipientPub: recipient, envelope: unhex(k.envelope_hex), aadTail });
  assert.equal(new TextDecoder().decode(pt), k.plaintext);
  const parsed = I.parseKeyringPlaintext(pt);
  assert.equal(parsed.epochs.length, 1);
  assert.equal(hex(parsed.epochs[0].k), V.vault_keys.vmk1_hex);
  assert.equal(hex(parsed.nk), V.vault_keys.nk_hex);
  // another roster version or recipient key in the AAD must fail
  await rejects(I.eciesOpen({ recipientPriv, recipientPub: recipient, envelope: unhex(k.envelope_hex), aadTail: I.aadKeyring(k.scope, k.vault, k.slot_id, 2, recipient) }), core.errors.IntegrityError);
});

test('ecdsa', async () => {
  const e = V.ecdsa, pub = I.b64uDecode(e.pub, 65), msg = unhex(e.message_hex);
  assert.ok(await I.ecdsaVerify(pub, I.b64uDecode(e.signature_b64u, 64), msg));
  assert.ok(!(await I.ecdsaVerify(pub, I.b64uDecode(e.signature_flipped_b64u, 64), msg)));
});

test('roster v1 and v2: bodies, hashes, signatures, chain verification', async () => {
  const r = V.roster, pins = [V.keys.escrow_ids.current, V.keys.escrow_ids.spare];
  for (const n of ['v1', 'v2']) {
    assert.equal(I.cjson(r[n].body), r[n].cjson);
    assert.equal(await I.rosterHash(r[n].body), r[n].hash);
    assert.ok(await I.ecdsaVerify(I.b64uDecode(V.keys.founder_s.pub, 65), I.b64uDecode(r[n].sig, 64), I.cjsonBytes(r[n].body)));
  }
  assert.equal(r.v2.body.prev, r.v1.hash);
  const chain = await I.verifyRosterChain({ scope: SCOPE, vault: V.keys.founder_vault_id, escrowPins: pins, docs: [{ body: r.v1.body, sig: r.v1.sig }, { body: r.v2.body, sig: r.v2.sig }], prior: null });
  assert.equal(chain.length, 2); assert.equal(chain[1].hash, r.v2.hash);
  // a tampered body must be rejected
  const bad = JSON.parse(JSON.stringify(r.v2.body)); bad.slots[0].role = bad.slots[0].role === 'owner' ? 'write' : 'owner';
  await rejects(I.verifyRosterChain({ scope: SCOPE, vault: V.keys.founder_vault_id, escrowPins: pins, docs: [{ body: r.v1.body, sig: r.v1.sig }, { body: bad, sig: r.v2.sig }], prior: null }), core.errors.IntegrityError);
  // unpinned escrow keys
  await rejects(I.verifyRosterChain({ scope: SCOPE, vault: V.keys.founder_vault_id, escrowPins: [V.keys.escrow_ids.spare], docs: [{ body: r.v1.body, sig: r.v1.sig }], prior: null }), core.errors.IntegrityError, /pinned/);
});

test('renewal statement verifies against the invite slot key', async () => {
  const r = V.renewal, head = V.roster.v2.body;
  assert.equal(I.cjson(r.body), r.cjson);
  const entry = head.slots.find((s) => s.id === r.body.slot);
  assert.ok(await I.verifyRenewal({ body: r.body, sig: r.sig }, entry, head, SCOPE));
  const forged = JSON.parse(JSON.stringify(r.body)); forged.e_pub = V.keys.founder_e.pub;
  assert.ok(!(await I.verifyRenewal({ body: forged, sig: r.sig }, entry, head, SCOPE)));
});

test('codes and key file', async () => {
  const c = V.codes;
  const inv = await core.parseInviteCode(c.invite.display);
  assert.equal(hex(inv.idBytes), c.invite.access_id_hex); assert.equal(hex(inv.secret), c.invite.secret_hex);
  assert.equal((await I.makeInviteCode(inv.idBytes, inv.secret)).canonical, c.invite.canonical);
  assert.equal(core.displayCode(c.invite.canonical), c.invite.display);
  const rec = await I.makeRecoveryCode(unhex(c.recovery.bytes_hex));
  assert.equal(rec.canonical, c.recovery.canonical); assert.equal(rec.display, c.recovery.display); assert.equal(rec.hash, c.recovery.recovery_hash);
  const parsed = await core.parseRecoveryCode(c.recovery.display.toLowerCase());
  assert.equal(parsed.hash, c.recovery.recovery_hash);
  assert.equal(core.classifyCode(c.invite.display), 'invite');
  assert.equal(core.classifyCode(c.recovery.display), 'recovery');
  assert.equal(core.classifyCode(c.key_file.access_id), 'access_id');
  const kf = core.makeKeyFile({ scope: c.key_file.scope, accessId: c.key_file.access_id, vaultId: c.key_file.vault });
  assert.equal(kf.text, c.key_file.text); assert.equal(kf.filename, c.key_file.filename);
  const back = await core.parseKeyFile(kf.text, { scope: c.key_file.scope });
  assert.equal(back.accessId, c.key_file.access_id); assert.equal(back.vaultId, c.key_file.vault);
  await rejects(core.parseKeyFile(kf.text, { scope: 'other-aaaaaa' }), core.errors.UsageError);
  await rejects(core.parseKeyFile(kf.text, { scope: c.key_file.scope, service: 'https://evil.example/datastore/' }), core.errors.UsageError);
});
