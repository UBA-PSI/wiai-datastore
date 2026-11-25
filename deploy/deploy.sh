#!/usr/bin/env bash
# Deploys this repository's server, client bundle and documentation to the service host (the machine behind the reverse
# proxy that serves https://wiai.uni-bamberg.de/datastore/) and restarts the service. The host is prepared by the
# operator's configuration management (user, directories, config, systemd unit and /usr/local/sbin/wiai-datastore-install).
#
#   WDS_HOST=root@<service host> deploy/deploy.sh            run tests, upload, restart
#   WDS_HOST=root@<service host> deploy/deploy.sh --no-tests upload without running the test suites (emergencies only)
#
# Environment:
#   WDS_HOST     required: SSH target of the service host (user@host)
#   WDS_SSH_KEY  optional: SSH private key for that host (default: your SSH configuration)
set -euo pipefail
cd "$(dirname "$0")/.."
: "${WDS_HOST:?set WDS_HOST to the SSH target of the service host, e.g. WDS_HOST=root@<host> deploy/deploy.sh}"
TARGET="$WDS_HOST"
SSH=(ssh -o BatchMode=yes)
[[ -n "${WDS_SSH_KEY:-}" ]] && SSH+=(-i "$WDS_SSH_KEY")
if [[ "${1:-}" != "--no-tests" ]]; then
  scripts/test-server.sh >/dev/null 2>&1 || { echo "server tests fail, nothing uploaded" >&2; exit 1; }
fi
[[ -f client/dist/hashes.json ]] || { echo "client/dist missing: run node client/build.mjs" >&2; exit 1; }
"${SSH[@]}" "$TARGET" mkdir -p /opt/wiai-datastore/app/server /opt/wiai-datastore/app/client/dist /opt/wiai-datastore/app/docs/site
# --chown: -a would otherwise carry the local UID/GID over to the host
rsync -a --chown=root:root --delete -e "${SSH[*]}" --exclude '__pycache__' server/wds_server "$TARGET:/opt/wiai-datastore/app/server/"
rsync -a --chown=root:root --delete -e "${SSH[*]}" client/dist/ "$TARGET:/opt/wiai-datastore/app/client/dist/"
if [[ -d docs/site ]]; then
  rsync -a --chown=root:root --delete -e "${SSH[*]}" docs/site/ "$TARGET:/opt/wiai-datastore/app/docs/site/"
fi
"${SSH[@]}" "$TARGET" /usr/local/sbin/wiai-datastore-install
