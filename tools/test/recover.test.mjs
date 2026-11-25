// wds-recover end to end against the real server: start, status, cancel, complete (after the waiting period), and what the users see.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { startMock } from '../lib/wds-mock.mjs';
import { core, hashwasm, tmpDir, run, makeEscrowFiles, writeToken } from './helpers.mjs';

let mock, keys, dir, tokenFile, scope, base;
const PASS = 'founder passphrase 7 horses purple';
const RPASS = 'recovered owner passphrase 4 blue tractors';

before(async () => {
  dir = tmpDir();
  keys = makeEscrowFiles(dir);
  mock = await startMock({ escrow: { current: keys.current.pub, spare: keys.spare.pub } });
  scope = (await mock.createScope('recover-test')).scope;
  tokenFile = writeToken(dir, mock.operatorToken);
  base = mock.service.replace(/\/$/, '');
});
after(async () => { if (mock) await mock.stop(); });

const client = () => new core.Client({ scope, service: mock.service, escrowPins: [keys.current.pub.key_id, keys.spare.pub.key_id], argon2: hashwasm.argon2id, storage: core.memoryStorage() });
const recover = (args, o) => run('wds-recover.mjs', [...args, '--base', base, '--token-file', tokenFile], o);

test('usage errors and bad input do not reach the server', async () => {
  assert.equal((await run('wds-recover.mjs', [])).code, 2);
  assert.match((await run('wds-recover.mjs', ['status'])).stderr, /needs the vault ID/);
  assert.match((await recover(['status', 'not-a-vault'])).stderr, /not a vault ID/);
  assert.match((await run('wds-recover.mjs', ['status', 'A'.repeat(26), '--token-file', join0(dir, 'missing')])).stderr, /cannot read the operator token file/);
  assert.equal((await recover(['frobnicate', 'A'.repeat(26)])).code, 2);
  assert.match((await recover(['complete', 'A'.repeat(26)])).stderr, /--escrow-key/);
  assert.equal((await recover(['start', 'A'.repeat(26)])).code, 2);
  assert.equal((await recover(['status', 'A'.repeat(26)])).code, 1); // an unknown vault: the server answers 404
});

function join0(d, f) { return d + '/' + f; }

test('the complete recovery: start, status, waiting period, cancel, restart, complete; the recovered owner reads the data and the founder sees the notice', { timeout: 240000 }, async () => {
  const founder = client();
  const v = await founder.createVault({ passphrase: PASS });
  await founder.put('note', { text: 'the founder wrote this', n: 1 });
  await founder.put('files/a', { x: [1, 2, 3] });
  const vault = v.vaultId, display = v.recoveryCode.display;

  // status before anything
  let st = JSON.parse((await recover(['status', vault, '--json'])).stdout);
  assert.equal(st.vault, vault);
  assert.equal(st.recovery, null);
  assert.equal(st.has_recovery_contact, false);

  // a wrong recovery code is refused (and counted by the server), a malformed one never leaves the tool
  const other = await core.internals.makeRecoveryCode();
  const wrong = await recover(['start', vault, other.display]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /recovery_code_invalid/);
  const malformed = await recover(['start', vault, 'ABCD-EFGH']);
  assert.equal(malformed.code, 2);
  assert.match(malformed.stderr, /not a recovery code/);
  // --contact needs a recovery contact
  assert.match((await recover(['start', vault, '--contact'])).stderr, /no_recovery_contact/);

  // start with the code as the user reads it from the access sheet (groups, lower case)
  const started = await recover(['start', vault, display.toLowerCase(), '--json']);
  assert.equal(started.code, 0, started.stderr);
  const s = JSON.parse(started.stdout);
  assert.equal(s.method, 'code');
  assert.ok(s.ready_at - s.requested === 72 * 3600);
  st = JSON.parse((await recover(['status', vault, '--json'])).stdout);
  assert.equal(st.recovery.method, 'code');
  assert.equal(st.ready, false);
  assert.ok(st.seconds_left > 71 * 3600);
  assert.match((await recover(['status', vault])).stdout, /pending, method code/);

  // the founder sees the request when unlocking
  const f1 = client();
  const seen = await f1.unlock({ accessId: v.accessId, passphrase: PASS });
  assert.equal(seen.recovery.method, 'code');

  // too early: the tool says so (exit 2) and sends nothing
  const early = await recover(['complete', vault, '--escrow-key', keys.current.file, '--yes']);
  assert.equal(early.code, 2);
  assert.match(early.stderr, /waiting period is not over/);

  // cancel by the operator; the founder no longer sees it; then start again
  assert.equal((await recover(['cancel', vault])).code, 0);
  assert.equal((await recover(['cancel', vault])).code, 1); // nothing pending any more
  const f2 = client();
  assert.equal((await f2.unlock({ accessId: v.accessId, passphrase: PASS })).recovery ?? null, null);
  assert.equal((await recover(['start', vault, display])).code, 0);
  mock.makeRecoveryReady();

  // wrong key files: a key set that is not the vault's, a file of another format
  const stranger = makeEscrowFiles(tmpDir());
  const wrongKey = await recover(['complete', vault, '--escrow-key', stranger.current.file, '--yes']);
  assert.equal(wrongKey.code, 1);
  assert.match(wrongKey.stderr, /escrow slot belongs to key set/);
  const publicOnly = await recover(['complete', vault, '--escrow-key', keys.current.file.replace('-private', '-public'), '--yes']);
  assert.equal(publicOnly.code, 2);
  assert.match(publicOnly.stderr, /not an escrow private key file/);
  const notJson = await recover(['complete', vault, '--escrow-key', tokenFile, '--yes']);
  assert.equal(notJson.code, 2);
  assert.match(notJson.stderr, /cannot read the escrow key file/);
  const needsYes = await recover(['complete', vault, '--escrow-key', keys.current.file]);
  assert.equal(needsYes.code, 2);
  assert.match(needsYes.stderr, /--yes/);

  // a dry run builds and checks everything and uploads nothing
  const scratch = tmpDir();
  const dry = await recover(['complete', vault, '--escrow-key', keys.current.file, '--dry-run', '--json'], { cwd: scratch });
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(readdirSync(scratch), [], 'the tool writes no file (the escrow key is never stored)');
  assert.equal(JSON.parse(dry.stdout).uploaded, false);
  assert.ok((JSON.parse((await recover(['status', vault, '--json'])).stdout)).recovery);

  // the real thing
  const done = await recover(['complete', vault, '--escrow-key', keys.current.file, '--yes', '--expires-in-hours', '48']);
  assert.equal(done.code, 0, done.stderr);
  const code = /\n  ([0-9A-Z]{4}(?:-[0-9A-Z]{4}){11})\n/.exec(done.stdout);
  assert.ok(code, 'the invite code is printed: ' + done.stdout);
  assert.match(done.stdout, /recovery completed: roster version 2/);
  // no secret in the output: neither the operator token nor the private scalars of the escrow key
  const priv = JSON.parse(readFileSync(keys.current.file, 'utf8'));
  for (const text of [done.stdout, done.stderr]) {
    assert.ok(!text.includes(mock.operatorToken));
    assert.ok(!text.includes(priv.e_d_hex) && !text.includes(priv.s_d_hex));
  }
  st = JSON.parse((await recover(['status', vault, '--json'])).stdout);
  assert.equal(st.recovery, null);
  assert.equal(st.roster_version, 2);
  // a second run has nothing to complete
  assert.match((await recover(['complete', vault, '--escrow-key', keys.current.file, '--yes'])).stderr, /no recovery is pending/);

  // the recovered user redeems the code, reads the founder's data, and knows that the faculty added them
  const recovered = client();
  const red = await recovered.redeemInvite({ inviteCode: code[1], passphrase: RPASS });
  assert.equal(red.role, 'owner');
  assert.equal(red.recoveredByFaculty, true);
  assert.deepEqual(await recovered.get('note'), { text: 'the founder wrote this', n: 1 });
  assert.deepEqual(await recovered.get('files/a'), { x: [1, 2, 3] });
  await recovered.put('note', { text: 'and the recovered owner added this', n: 2 });

  // the founder: the chain with the escrow-signed version verifies, the notice is derived from it, the founder sees the new data
  const f3 = client();
  const back = await f3.unlock({ accessId: v.accessId, passphrase: PASS });
  assert.equal(back.recoveredByFaculty, true);
  assert.equal(back.recoverySlots.length, 1);
  assert.deepEqual(await f3.get('note'), { text: 'and the recovered owner added this', n: 2 });
  await assert.rejects(f3.createInvite({ role: 'read' }), (e) => e.code === 'recovery_unacknowledged'); // until the founder confirms the notice
  f3.acknowledgeRecovery();
  assert.ok((await f3.createInvite({ role: 'read' })).code);
});

test('the invite is limited by the server: 15 days minus a margin, so a laptop clock that runs ahead cannot make it fail', async () => {
  for (const hours of ['400', '360']) {
    const r = await recover(['complete', 'A'.repeat(26), '--escrow-key', keys.current.file, '--yes', '--expires-in-hours', hours]);
    assert.equal(r.code, 2, hours);
    assert.match(r.stderr, /between 1 and 359/);
  }
});

test('the operator token goes only to https addresses (or localhost)', async () => {
  const run2 = (b) => run('wds-recover.mjs', ['status', 'A'.repeat(26), '--base', b, '--token-file', tokenFile]);
  for (const bad of ['http://wiai.uni-bamberg.de/datastore', 'http://192.168.1.5:8000/datastore', 'http://localhost.evil.example/datastore', 'ftp://localhost/x', 'not a url']) {
    const r = await run2(bad);
    assert.equal(r.code, 2, bad);
    assert.match(r.stderr, /refusing to send the operator token|is not a URL/, bad);
  }
  // localhost over http is how the tests (and a developer) reach a local server: it gets as far as the server
  assert.equal((await run2(base)).code, 1); // 404 for an unknown vault
  const { checkBase } = await import('../wds-recover.mjs');
  for (const ok of ['https://wiai.uni-bamberg.de/datastore', 'http://localhost:8000', 'http://127.0.0.1:1', 'http://[::1]:8000/datastore']) assert.doesNotThrow(() => checkBase(ok), ok);
});

test('the recovery code is read from stdin or a prompt, not from the argument list', { timeout: 120000 }, async () => {
  const founder = client();
  const v = await founder.createVault({ passphrase: PASS + ' stdin' });
  const display = v.recoveryCode.display;
  const empty = await recover(['start', v.vaultId], { input: '' });
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /needs the recovery code/);
  assert.doesNotMatch(empty.stderr, /visible to other processes/);
  const viaStdin = await recover(['start', v.vaultId, '-', '--json'], { input: display + '\n' });
  assert.equal(viaStdin.code, 0, viaStdin.stderr);
  assert.equal(JSON.parse(viaStdin.stdout).method, 'code');
  assert.doesNotMatch(viaStdin.stderr, /visible to other processes/);
  assert.equal((await recover(['cancel', v.vaultId])).code, 0);
  // still possible on the command line, with a warning
  const argv = await recover(['start', v.vaultId, display, '--json']);
  assert.equal(argv.code, 0, argv.stderr);
  assert.match(argv.stderr, /visible to other processes/);
  assert.equal((await recover(['cancel', v.vaultId])).code, 0);
});

test('recovery by contact: seven days, and the tool needs the recovery contact on the vault', { timeout: 120000 }, async () => {
  const founder = client();
  const v = await founder.createVault({ passphrase: PASS + ' contact', recoveryContact: 'founder@example.org' });
  const started = await recover(['start', v.vaultId, '--contact', '--json']);
  assert.equal(started.code, 0, started.stderr);
  const s = JSON.parse(started.stdout);
  assert.equal(s.method, 'contact');
  assert.equal(s.ready_at - s.requested, 7 * 86400);
  assert.equal((await recover(['start', v.vaultId, '--contact'])).code, 1); // already pending
  assert.equal((await recover(['cancel', v.vaultId])).code, 0);
});
