#!/usr/bin/env bash
# Tests of the example apps in examples/: each app runs from a file:// page in a browser against the real server with a temporary
# database (the integration environment), with its library URL and service URL mapped to that local server. examples/docs-recipes.spec.mjs
# runs the code recipes of docs/site/integration.md the same way (and wds-verify on the example of the guide, against the mock and a sandbox).
# Needs Node >= 22, the project venv (.venv, see server/README.md) and the Playwright browsers (Chromium; WDS_BROWSERS=chromium,firefox,webkit for more).
#   scripts/test-examples.sh [playwright arguments, e.g. -g "notes"]
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
exec npx playwright test -c ../examples/playwright.config.mjs "$@"
