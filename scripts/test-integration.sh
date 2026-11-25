#!/usr/bin/env bash
# Integration tests: the real server (Python venv, temp database, scope created with the dev CLI) against the real client bundle in
# Chromium, Firefox and WebKit (a browser that is not installed is skipped with a notice; WDS_BROWSERS=chromium,firefox,webkit forces
# a list and fails when one is missing). Needs Node >= 22, the project venv (.venv, see server/README.md) and the Playwright browsers.
#   scripts/test-integration.sh [playwright arguments, e.g. --project=chromium -g "revocation"]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -x "$ROOT/.venv/bin/python" ]; then
  echo "creating the venv (Python 3.13, starlette 0.46.1, uvicorn 0.32.0, pynacl 1.5.0)"
  uv venv --python 3.13 "$ROOT/.venv"
  uv pip install --python "$ROOT/.venv" starlette==0.46.1 uvicorn==0.32.0 pynacl==1.5.0
fi
cd "$ROOT/client"
node --version
if [ ! -d node_modules/@playwright/test ]; then npm install --no-audit --no-fund; fi
exec npx playwright test -c playwright.integration.config.mjs "$@"
