// Tests for the small additions to wds-core.js made for the UI: checkRemote() and cancelRecovery().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupVault, newClient } from './helpers.mjs';

test('checkRemote lists records that are newer on the server than what this session knows', async () => {
  const ctx = await setupVault();
  await ctx.founder.put('a', { n: 1 });
  await ctx.founder.put('b', { n: 1 });
  const other = newClient(ctx.world);
  const created = ctx.created;
  await other.unlock({ accessId: created.accessId, passphrase: ctx.passphrase });
  await other.get('a');
  assert.deepEqual(await other.checkRemote(), []);
  await ctx.founder.put('a', { n: 2 });
  await ctx.founder.delete('b');
  const rows = await other.checkRemote();
  assert.equal(rows.length, 1); // 'b' was never read by 'other', so it is not tracked
  assert.equal(rows[0].name, 'a');
  assert.equal(rows[0].version, 2);
  assert.equal(rows[0].known, 1);
  assert.equal(rows[0].deleted, false);
});

test('cancelRecovery clears a pending recovery request (owner only)', async () => {
  const ctx = await setupVault();
  const vault = ctx.world.server.vaults.get(ctx.created.vaultId);
  vault.recovery = { method: 'code', requested: 1000, ready_at: 1000 + 259200 };
  await ctx.founder.unlock({ accessId: ctx.created.accessId, passphrase: ctx.passphrase });
  assert.equal(ctx.founder.status().recovery.method, 'code');
  await ctx.founder.cancelRecovery();
  assert.equal(ctx.founder.status().recovery, null);
  assert.equal(vault.recovery, null);
});
