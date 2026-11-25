// Protocol client against the in-memory fake server: vault lifecycle and record operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { core, I, setupVault, newClient, addMember, rejects, makeWorld, realArgon2, seq } from './helpers.mjs';

test('create vault: access sheet data, roster v1, state', async () => {
  const { world, founder, created } = await setupVault();
  assert.match(created.accessId, /^[0-9A-HJKMNP-TV-Z]{20}$/);
  assert.match(created.vaultId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(created.accessIdDisplay.length, 24);
  assert.equal(created.recoveryCode.canonical.length, 28);
  assert.equal(created.recoveryCode.display.split('-').length, 7);
  assert.equal((await core.parseRecoveryCode(created.recoveryCode.display)).canonical, created.recoveryCode.canonical);
  const kf = await core.parseKeyFile(created.keyFile.text, { scope: world.scope, service: world.server.service });
  assert.equal(kf.accessId, created.accessId);
  assert.equal(kf.vaultId, created.vaultId);
  const st = founder.status();
  assert.equal(st.role, 'owner'); assert.equal(st.epoch, 1); assert.equal(st.rosterVersion, 1);
  // server stored the recovery hash of the code we were shown
  const vault = world.server.vaults.get(created.vaultId);
  assert.equal(vault.recoveryHash, (await core.parseRecoveryCode(created.recoveryCode.canonical)).hash);
  assert.equal(founder.rememberedAccessId(), created.accessId);
});

test('unlock with passphrase, wrong passphrase, key file vault check', async () => {
  const { world, created, passphrase } = await setupVault();
  const c2 = newClient(world, { storage: world.storage });
  const st = await c2.unlock({ accessId: created.accessIdDisplay, passphrase, vaultId: created.vaultId });
  assert.equal(st.role, 'owner');
  assert.equal(st.stateStatus, 'ok');
  const c3 = newClient(world);
  await rejects(c3.unlock({ accessId: created.accessId, passphrase: 'wrong wrong wrong' }), core.AuthError);
  const c4 = newClient(world);
  await rejects(c4.unlock({ accessId: created.accessId, passphrase, vaultId: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ' }), core.IntegrityError, /key file/);
  await rejects(newClient(world).unlock({ accessId: '00000000000000000000', passphrase }), core.UsageError);
  await rejects(newClient(world).unlock({ accessId: await I.randomAccessId(), passphrase }), core.RequestError);
});

test('real Argon2id end to end (vendored hash-wasm)', async () => {
  const world = await makeWorld();
  const c = newClient(world, { argon2: realArgon2 });
  const created = await c.createVault({ passphrase: 'Korrekt Pferd Batterie Heftklammer ü' });
  await c.put('a', { x: 1 });
  const c2 = newClient(world, { argon2: realArgon2 });
  await c2.unlock({ accessId: created.accessId, passphrase: 'Korrekt Pferd Batterie Heftklammer u' + String.fromCharCode(0x308) }); // NFD input, same key
  assert.deepEqual(await c2.get('a'), { x: 1 });
});

test('json and bytes records, list, prefix filter, tombstones', async () => {
  const { founder } = await setupVault();
  assert.equal(await founder.get('missing'), undefined);
  await founder.put('settings', { theme: 'dark', n: [1, 2, 3] });
  await founder.put('files/a.bin', seq(100, 0), { mime: 'application/octet-stream' });
  await founder.put('files/Prüfung.pdf', new Blob([seq(5000, 1)], { type: 'application/pdf' }));
  assert.deepEqual(await founder.get('settings'), { theme: 'dark', n: [1, 2, 3] });
  const bin = await founder.getRecord('files/a.bin');
  assert.equal(bin.kind, 'bytes'); assert.equal(bin.mime, 'application/octet-stream');
  assert.deepEqual(Array.from(bin.value), Array.from(seq(100, 0)));
  const pdf = await founder.getRecord('files/Prüfung.pdf');
  assert.equal(pdf.mime, 'application/pdf'); assert.equal(pdf.value.length, 5000);
  const all = await founder.list();
  assert.deepEqual(all.map((r) => r.name), ['files/Prüfung.pdf', 'files/a.bin', 'settings']);
  assert.deepEqual((await founder.list('files/')).map((r) => r.name), ['files/Prüfung.pdf', 'files/a.bin']);
  assert.equal(all.find((r) => r.name === 'files/a.bin').length, 100);
  assert.equal(await founder.delete('settings'), true);
  assert.equal(await founder.get('settings'), undefined);
  assert.equal(await founder.delete('settings'), false);
  assert.deepEqual((await founder.list()).map((r) => r.name), ['files/Prüfung.pdf', 'files/a.bin']);
  // recreate after the tombstone: version continues
  const r = await founder.put('settings', { again: true });
  assert.equal(r.version, 3);
  assert.deepEqual(await founder.get('settings'), { again: true });
});

test('invalid names and values are rejected before any request', async () => {
  const { founder, world } = await setupVault();
  const n = world.server.requests.length;
  for (const bad of ['', 'a' + String.fromCharCode(0xd800) + 'b', 'x'.repeat(1025)]) await rejects(founder.put(bad, 1), core.UsageError);
  await rejects(founder.put('a', undefined), core.UsageError);
  await rejects(founder.put('a', () => 1), core.UsageError);
  assert.equal(world.server.requests.length, n);
  await founder.put('x'.repeat(1024), 1); // exactly 1024 bytes is fine
  await founder.put('äöü'.repeat(100), 1);
});

test('conflicts: stale write, concurrent create, delete vs update, keep mine', async () => {
  const { world, founder, created, passphrase } = await setupVault();
  await founder.put('doc', { v: 1 });
  const other = newClient(world);
  await other.unlock({ accessId: created.accessId, passphrase });
  await rejects(other.put('doc', { v: 'blind' }), core.ConflictError); // never read it: treated as a new name
  await other.get('doc');
  await other.put('doc', { v: 'other' });
  // founder still believes version 1
  const err = await rejects(founder.put('doc', { v: 'mine' }), core.ConflictError);
  assert.equal(err.name, 'ConflictError');
  assert.equal(err.record, 'doc');
  assert.deepEqual(err.theirs.value, { v: 'other' });
  assert.equal(err.theirs.version, 2);
  assert.deepEqual(err.mine.value, { v: 'mine' });
  assert.equal(err.current, 2);
  // not silently retried: server still has the other value
  assert.deepEqual(await other.get('doc'), { v: 'other' });
  // keep mine: saved on top, theirs stays in history
  const r = await founder.put('doc', { v: 'mine' }, { base: err.current });
  assert.equal(r.version, 3);
  const h = await founder.history('doc');
  assert.deepEqual(h.versions.map((v) => v.version), [3, 2, 1]);
  assert.deepEqual((await founder.getVersion('doc', 2)).value, { v: 'other' });
  // two clients create the same new name
  const a = await founder.put('new', 1);
  assert.equal(a.version, 1);
  const e2 = await rejects(other.put('new', 2), core.ConflictError);
  assert.equal(e2.theirs.value, 1);
  // delete vs update
  await other.get('doc');
  await other.delete('doc');
  const e3 = await rejects(founder.put('doc', { v: 'late' }), core.ConflictError);
  assert.equal(e3.theirs.deleted, true); assert.equal(e3.theirs.version, 4);
  const r2 = await founder.put('doc', { v: 'recreated' }, { base: e3.current });
  assert.equal(r2.version, 5);
  // stale delete
  const e4 = await rejects(other.delete('doc', { base: 4 }), core.ConflictError);
  assert.equal(e4.current, 5);
});

test('history, restore, purge', async () => {
  const { founder } = await setupVault();
  for (let i = 1; i <= 4; i++) await founder.put('note', { i });
  const h = await founder.history('note');
  assert.equal(h.current, 4); assert.equal(h.versions.length, 4);
  assert.ok(h.versions.every((v) => v.commit && v.epoch === 1));
  const r = await founder.restore('note', 2);
  assert.equal(r.version, 5);
  assert.deepEqual(await founder.get('note'), { i: 2 });
  await founder.delete('note');
  await rejects(founder.restore('note', 6), core.UsageError); // tombstone
  await founder.restore('note', 3);
  assert.deepEqual(await founder.get('note'), { i: 3 });
  const freed = await founder.deleteHistory('note');
  assert.ok(freed.freed > 0);
  assert.equal((await founder.history('note')).versions.length, 1);
});

test('history retention keeps only the configured number of versions', async () => {
  const { founder } = await setupVault({ world: { scope: { limits: { history_versions: 3 } } } });
  for (let i = 1; i <= 6; i++) await founder.put('n', i);
  const h = await founder.history('n');
  assert.deepEqual(h.versions.map((v) => v.version), [6, 5, 4]);
  assert.equal(await founder.getVersion('n', 1), null);
});

test('rollback state: persisted per access ID, MAC protected, forged state is a new device', async () => {
  const { world, founder, created, passphrase } = await setupVault();
  await founder.put('a', 1);
  const key = 'wds:' + world.scope + ':' + created.accessId + ':state';
  const raw = world.storage.getItem(key);
  assert.ok(raw);
  const doc = I.cjsonParse(raw);
  assert.equal(doc.state.rv, 1); assert.equal(doc.state.epoch, 1); assert.equal(doc.state.records.length, 1); assert.equal(doc.state.records[0][1], 1);
  assert.equal(doc.mac.length, 43);
  const c2 = newClient(world, { storage: world.storage });
  assert.equal((await c2.unlock({ accessId: created.accessId, passphrase })).stateStatus, 'ok');
  // a modified state fails the MAC: counts as a new device (no lower pin can be forced)
  const forged = JSON.parse(raw); forged.state.rv = 0; forged.state.records = [];
  world.storage.setItem(key, JSON.stringify(forged));
  const c3 = newClient(world, { storage: world.storage });
  const st = await c3.unlock({ accessId: created.accessId, passphrase });
  assert.equal(st.stateStatus, 'invalid'); assert.equal(st.newDevice, true);
  // empty storage: new device
  const c4 = newClient(world, { storage: core.memoryStorage() });
  assert.equal((await c4.unlock({ accessId: created.accessId, passphrase })).stateStatus, 'new');
  // another access ID's state is separate
  assert.equal(world.storage.getItem('wds:' + world.scope + ':OTHER:state'), null);
});

test('change passphrase', async () => {
  const { world, founder, created, passphrase } = await setupVault();
  await founder.put('a', 1);
  const old = founder.s.token;
  await founder.changePassphrase('a completely new passphrase');
  assert.deepEqual(await founder.get('a'), 1); // the session continues with the new token
  await rejects(newClient(world).unlock({ accessId: created.accessId, passphrase }), core.AuthError);
  const c = newClient(world);
  await c.unlock({ accessId: created.accessId, passphrase: 'a completely new passphrase' });
  assert.deepEqual(await c.get('a'), 1);
  assert.notDeepEqual(Array.from(old), Array.from(c.s.token));
});

test('offline, quota and size errors map to typed errors', async () => {
  const { world, founder } = await setupVault({ world: { scope: { limits: { max_value_bytes: 1000, vault_bytes: 3500 } } } });
  await founder.getScopeInfo(true);
  await rejects(founder.put('big', seq(2000, 0)), core.QuotaError, /larger/);
  await founder.put('ok', seq(900, 0));
  await founder.put('ok2', seq(900, 0));
  await founder.put('ok3', seq(900, 0));
  const e = await rejects(founder.put('ok4', seq(900, 0)), core.QuotaError);
  assert.equal(e.status, 507); assert.equal(e.body.limit, 'vault_bytes');
  world.server.beforeRequest = () => { throw new TypeError('fetch failed'); };
  await rejects(founder.get('ok'), core.OfflineError);
  world.server.beforeRequest = null;
  assert.deepEqual(Array.from((await founder.get('ok'))), Array.from(seq(900, 0)));
});

test('locked client refuses operations; lock() drops the session', async () => {
  const { founder } = await setupVault();
  founder.lock();
  await rejects(founder.get('a'), core.UsageError, /locked/);
  assert.equal(founder.status().unlocked, false);
});

test('read-only slots cannot write; export of everything via readAll', async () => {
  const ctx = await setupVault();
  await ctx.founder.put('a', { n: 1 });
  await ctx.founder.put('b/c', seq(10, 0));
  const { member } = await addMember(ctx, 'read');
  await rejects(member.put('x', 1), core.AuthError);
  assert.deepEqual(await member.get('a'), { n: 1 });
  const all = await member.readAll();
  assert.deepEqual(all.map((r) => r.name), ['a', 'b/c']);
  await rejects(member.delete('a'), core.AuthError);
  await rejects(member.deleteHistory('a'), core.AuthError);
});
