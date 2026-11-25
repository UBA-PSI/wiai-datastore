#!/usr/bin/env bash
# Tests of the operator and developer tools in tools/: wds-recover (end to end against the real server, escrow keys made by
# wds-keygen) and wds-verify (static checks, and the dynamic checks in Chromium against a local copy of the real server, with the
# good and the deliberately bad example apps in tools/test-apps/). Needs Node >= 22 (developed on Node 26), the project venv (.venv,
# see server/README.md; created here if missing) and the Playwright Chromium.
#   scripts/test-tools.sh                       everything
#   SKIP_BROWSER=1 scripts/test-tools.sh        without the tests that start a browser
#   scripts/test-tools.sh --test-name-pattern=recovery   node:test options are passed on
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -x "$ROOT/.venv/bin/python" ]; then
  echo "creating the venv (Python 3.13, starlette 0.46.1, uvicorn 0.32.0, pynacl 1.5.0)"
  uv venv --python 3.13 "$ROOT/.venv"
  uv pip install --python "$ROOT/.venv" starlette==0.46.1 uvicorn==0.32.0 pynacl==1.5.0
fi
# the tests check the example apps against the published hashes
if [ ! -f "$ROOT/client/dist/hashes.json" ]; then (cd "$ROOT/client" && node build.mjs); fi
cd "$ROOT/tools"
node --version
if [ "${SKIP_BROWSER:-}" != "1" ] && [ ! -d node_modules/playwright ] && [ ! -d ../client/node_modules/playwright ]; then npm install --no-audit --no-fund; fi
if [ "${SKIP_BROWSER:-}" = "1" ]; then
  FILES=(test/recover.test.mjs test/verify-static.test.mjs)
else
  FILES=(test/*.test.mjs)
fi
exec node --test --test-concurrency=4 "$@" "${FILES[@]}"
