#!/bin/sh
# Run the server unit tests with the project venv (Python 3.13, starlette 0.46.1, uvicorn 0.32.0, pynacl 1.5.0).
# No arguments: discover everything. Otherwise arguments go to unittest, e.g. tests.test_records.Records.test_cas
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/server"
if [ "$#" -eq 0 ]; then
  exec "$ROOT/.venv/bin/python" -m unittest discover -s tests -t .
fi
exec "$ROOT/.venv/bin/python" -m unittest "$@"
