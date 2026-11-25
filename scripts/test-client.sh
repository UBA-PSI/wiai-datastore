#!/usr/bin/env bash
# Runs the client test suite: node tests (protocol, vectors, UI helpers, build), then the bundle build, then the
# Playwright browser tests (Chromium; the browsers come from ~/Library/Caches/ms-playwright).
# SKIP_BROWSER=1 runs only the node tests. Needs Node >= 22 (developed on Node 26).
set -euo pipefail
cd "$(dirname "$0")/../client"
node --version
node --test test/*.test.mjs
node build.mjs
if [ "${SKIP_BROWSER:-}" = "1" ]; then exit 0; fi
if [ ! -d node_modules/@playwright/test ]; then npm install --no-audit --no-fund; fi
npx playwright test
