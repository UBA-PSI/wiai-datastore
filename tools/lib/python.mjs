// Finding the Python that can run the server (the mock of wds-verify and the tests of the tools).
// Needs Python with the packages of server/requirements.txt: WDS_PYTHON, then <repo>/.venv/bin/python, then python3.13 on the PATH.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

export class MockUnavailable extends Error {}

// The Python that can run the server, or a MockUnavailable with a message that says what to do.
export function findPython() {
  const candidates = [];
  if (process.env.WDS_PYTHON) candidates.push(process.env.WDS_PYTHON);
  else {
    candidates.push(join(ROOT, '.venv', 'bin', 'python'));
    candidates.push('python3.13');
  }
  const probe = 'import sys, starlette, uvicorn, nacl\nassert sys.version_info >= (3, 13)';
  const problems = [];
  for (const py of candidates) {
    if (py.includes('/') && !existsSync(py)) { problems.push(py + ': not found'); continue; }
    const r = spawnSync(py, ['-I', '-c', probe], { encoding: 'utf8' });
    if (r.error) { problems.push(py + ': ' + r.error.message); continue; }
    if (r.status === 0) return py;
    problems.push(py + ': ' + (r.stderr.trim().split('\n').pop() || 'cannot run the server (needs Python 3.13 with starlette, uvicorn and pynacl)'));
  }
  throw new MockUnavailable('cannot start the local mock server: no Python 3.13 with starlette, uvicorn and PyNaCl found.\n  '
    + problems.join('\n  ') + '\n  Create the project venv:  uv venv --python 3.13 .venv && uv pip install --python .venv starlette==0.46.1 uvicorn==0.32.0 pynacl==1.5.0\n'
    + '  or point WDS_PYTHON at a Python that has them.');
}

