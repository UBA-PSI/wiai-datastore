// The mock server must not outlive the process that started it, however that process ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const MOCK = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'wds-mock.mjs');
const alive = async (port) => { try { return (await fetch('http://127.0.0.1:' + port + '/datastore/healthz', { signal: AbortSignal.timeout(1500) })).ok; } catch (e) { return false; } };
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };

for (const how of ['exit without stop()', 'uncaught error', 'SIGTERM']) {
  test('the mock server is gone after the parent ends: ' + how, async () => {
    const code = "import(" + JSON.stringify(MOCK) + ").then(async (m) => { const mock = await m.startMock(); console.log('PORT ' + mock.port);"
      + (how === 'exit without stop()' ? ' process.exit(0);' : how === 'uncaught error' ? " setTimeout(() => { throw new Error('boom'); }, 200);" : ' setInterval(() => {}, 1000);')
      + ' });';
    const child = spawn('node', ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    assert.ok(await until(() => /PORT \d+/.test(out), 30000), 'the mock did not start: ' + out);
    const port = Number(/PORT (\d+)/.exec(out)[1]);
    if (how !== 'exit without stop()') assert.equal(await alive(port), true);   // (the first variant exits at once; the mock was healthy when it printed the port)
    if (how === 'SIGTERM') child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once('exit', r));
    assert.ok(await until(async () => !(await alive(port))), 'the mock server on port ' + port + ' is still running');
  });
}
