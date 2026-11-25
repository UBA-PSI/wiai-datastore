#!/usr/bin/env bash
# Registers the WIAI Datastore dashboard with login.psi: creates the shared key on the service host and adds the
# application wiai-datastore to LOGINAPI_APPLICATIONS in the settings file of the login.psi host.
#
#   WDS_HOST=root@<service host> LOGINPSI_HOST=root@<login.psi host> LOGINPSI_SETTINGS=/path/to/settings.py deploy/loginpsi-register.sh
#
# Needed once. The key (32 bytes) is created on the service host (/etc/wiai-datastore/loginpsi.key, base64,
# root:wiai-datastore 0640) and travels from there through a pipe to the login.psi host; it is never stored on this
# machine and never printed. If it exists already, it is reused.
#
# On the login.psi host the script changes only the settings file: it adds one entry, puts a backup next to the file first,
# checks afterwards that the file still compiles and restores the backup otherwise. If the application is listed already,
# it changes nothing. Restart login.psi yourself afterwards (the script lists candidate services).
#
# Environment:
#   WDS_HOST           required: SSH target of the service host
#   WDS_SSH_KEY        optional: SSH private key for the service host (default: your SSH configuration)
#   LOGINPSI_HOST      required: SSH target of the login.psi host
#   LOGINPSI_SETTINGS  required: path of the settings file with LOGINAPI_APPLICATIONS on the login.psi host
set -Eeuo pipefail
: "${WDS_HOST:?set WDS_HOST to the SSH target of the service host}"
: "${LOGINPSI_HOST:?set LOGINPSI_HOST to the SSH target of the login.psi host}"
: "${LOGINPSI_SETTINGS:?set LOGINPSI_SETTINGS to the path of the settings file on the login.psi host}"
VM="$WDS_HOST"
SSH=(ssh -o BatchMode=yes)
[[ -n "${WDS_SSH_KEY:-}" ]] && SSH+=(-i "$WDS_SSH_KEY")
LOGIN="$LOGINPSI_HOST"
APP="wiai-datastore"
URL="https://wiai.uni-bamberg.de/datastore"
KEYFILE=/etc/wiai-datastore/loginpsi.key

echo "Key on the service host ..."
"${SSH[@]}" "$VM" "set -e; if [ ! -s $KEYFILE ]; then
    umask 077; python3 -c 'import base64, os; print(base64.b64encode(os.urandom(32)).decode())' > $KEYFILE.new
    chown root:wiai-datastore $KEYFILE.new; chmod 640 $KEYFILE.new; mv $KEYFILE.new $KEYFILE; echo '  created'
  else echo '  exists, reused'; fi"

PATCH="$(mktemp)"; trap 'rm -f "$PATCH"' EXIT
cat > "$PATCH" <<'PY'
import base64, datetime, py_compile, re, shutil, sys
app, url, PATH = sys.argv[1], sys.argv[2], sys.argv[3]
key = base64.b64decode(sys.stdin.read().strip(), validate=True)
if len(key) != 32:
    sys.exit("The key is not 32 bytes long; nothing changed.")
with open(PATH, encoding="utf-8") as f:
    text = f.read()
if re.search(r"""['"]%s['"]\s*:""" % re.escape(app), text):
    print(f"  {app} is already in LOGINAPI_APPLICATIONS; nothing changed.")
    print("  If the key there differs from the one on the service host, remove the entry by hand"
          " and run this script again.")
    sys.exit(0)
start = re.search(r"^LOGINAPI_APPLICATIONS\s*=\s*\{[ \t]*\n", text, re.M)
if not start:
    sys.exit("LOGINAPI_APPLICATIONS = { ... } not found; nothing changed.")
entry = (f"    '{app}': {{\n"
           f"        'SECRET_KEY': bytes.fromhex('{key.hex()}'),\n"
           f"        'URL': '{url}',\n"
           f"    }},\n")
backup = f"{PATH}.before-{app}-{datetime.datetime.now():%Y%m%d-%H%M%S}"
shutil.copy2(PATH, backup)
with open(PATH, "w", encoding="utf-8") as f:
    f.write(text[:start.end()] + entry + text[start.end():])
try:
    py_compile.compile(PATH, doraise=True)
except py_compile.PyCompileError as err:
    shutil.copy2(backup, PATH)
    sys.exit(f"settings.py did not compile afterwards; backup restored.\n{err}")
print(f"  {app} added (URL {url}); backup: {backup}")
PY

echo "Entry on the login.psi host ..."
REMOTE="$(ssh -o BatchMode=yes "$LOGIN" 'mktemp /root/loginpsi-register.XXXXXX')"
[[ "$REMOTE" == /root/loginpsi-register.* ]] || { echo "could not create a temporary file on the login.psi host" >&2; exit 1; }
scp -q -o BatchMode=yes "$PATCH" "$LOGIN:$REMOTE"
"${SSH[@]}" "$VM" "cat $KEYFILE" \
  | ssh -o BatchMode=yes "$LOGIN" "python3 '$REMOTE' '$APP' '$URL' '$LOGINPSI_SETTINGS'; rc=\$?; rm -f '$REMOTE'; exit \$rc"

echo "Now restart login.psi so that it knows the application. Running services that may be it:"
ssh -o BatchMode=yes "$LOGIN" "systemctl list-units --type=service --state=running --no-legend --plain \
  | awk '{print \$1}' | grep -iE 'login|shib|gunicorn|uwsgi|apache|httpd|nginx' | sed 's/^/  /'" || true
echo "Then: systemctl restart wiai-datastore on the service host (config.ini already names the key file)."
