# WIAI Datastore server

Python 3.13, Starlette 0.46.1, uvicorn 0.32.0, PyNaCl 1.5.0 (login.psi) and the standard library. The wire format
is specified in [`../PROTOCOL.md`](../PROTOCOL.md); the design in [`../PLAN.md`](../PLAN.md).

## Run

```sh
uv venv --python 3.13 .venv
uv pip install --python .venv starlette==0.46.1 uvicorn==0.32.0 pynacl==1.5.0
cd server
../.venv/bin/python -m wds_server --db /tmp/wds.db --host 127.0.0.1 --port 8000 --config config.ini
```

`--forwarded-allow-ips` names the reverse proxy whose `X-Forwarded-For` is trusted (default `127.0.0.1`); the rate limits use
that client IP. There is no access log. Configuration: copy `config.example.ini`.

Dev commands (`python -m wds_server.cli …`, all take `--db` and optionally `--config`):

| Command | Purpose |
|---|---|
| `create-scope --slug s --name N [--join-code C] [--limit max_vaults=5]` | create a scope directly in the database (a random join code unless given), prints the scope document as JSON |
| `limits --scope ID --limit max_vaults=100 [--limit history_versions=default]` | the operator changes the limits of a scope (the dashboard only shows them; `KEY=default` resets one) |
| `maintenance` | purge empty (7 days) and soft-deleted (30 days) vaults, sweep histories, incremental vacuum, WAL checkpoint |
| `operator-token` | generate an operator token and the hash for the config file |
| `sandbox status` | state of the public sandbox: vaults, bytes, next and last wipe |
| `sandbox wipe` | purge every sandbox vault now and set the wipe marker to now (needs `--config` with a `[sandbox]` section) |

## Sandbox

The `[sandbox]` section of the configuration (see `config.example.ini`) turns one scope into a public sandbox for testing apps:
enrollment without a join code (the only open scope), small quotas, every vault deleted nightly. The server owns that scope row (`ensure_sandbox`
at start and in `maintenance`; a scope with the same ID that the section did not create stops the start, and removing the section
deletes the scope). Behaviour: oldest vaults that were created and last written at least `evict_min_age` ago are purged when a creation or a write would exceed
`max_vaults` or `scope_bytes`; creations are limited per IP bucket (`create_per_ip` in `create_window`, IPv6 by `create_ipv6_prefix`) and for the whole sandbox
(`create_global` in `create_global_window`, 503 `sandbox_busy`); an owner's vault deletion purges at once and gives the creation back to both counters; there is no recovery (operator recovery and escrow endpoints answer 409 `sandbox_no_recovery`); at most `invite_slots` invites per vault, expiring before the next wipe; `enabled = false` answers creations and
redeems with 503 `sandbox_disabled`. The nightly wipe runs in the maintenance sweep (`sweep_interval`): it purges every sandbox
vault created before the latest scheduled wipe instant, one transaction per vault, and records that instant in the `meta` table
(`sandbox_last_wipe`); vaults created after it stay until the next night. The scope document carries a `sandbox` field (`enabled`,
`wipe_at`, `timezone`, `next_wipe`, `last_wipe`) that is `null` for every other scope. The dashboard shows the scope to operators,
read-only; it never appears for staff.

## Dashboard

`/datastore/` serves the dashboard (server-rendered HTML, strict CSP with a per-response nonce, no external assets), `/datastore/privacy`
the Art. 13 notice. Login goes through login.psi: put the 32-byte shared key (base64) in the file named by `[loginpsi] key_file`
and register `wiai-datastore` with callback `<public_base>/_lpmiddleware/login` on login.psi. Staff (e-mail ending exactly in
`@uni-bamberg.de`, no matriculation number) can create scopes; operators are listed in `[dashboard] operators`. The privacy page takes
its date and the VM backup sentence from `[privacy]`. `[server] help_contact` (an e-mail address or a short text, empty by default) adds a "Questions?" line to the help box of every app page.
A scope page shows lay staff a default view (next steps with the text for Claude and the join code, usage, help, App ID) and folds everything else into the "Expert settings" (opened for operators, after an error and after a form in it). The limits are shown only; only operators pause an app and change limits (`cli limits`). The text for Claude is one English text (`prompt.py`) that is also the app's CLAUDE.md / AGENTS.md section. For local development set `[dashboard] dev_login = true` (never in production):
the login page then shows a form that creates a session for any user ID, applying the same staff rule. The pre-login cookie is `__Host-wds_pre; Secure`. Chromium and Firefox store it on
`http://127.0.0.1`, WebKit/Safari do not: to check the dashboard in WebKit, serve it under an https origin (for example a
local TLS proxy or a mapped host name with a certificate the browser trusts). Production runs on https and is not affected.

## Breach check of passphrases

`GET /datastore/api/v1/pwned/<5 uppercase hex characters>` (no token) answers the Pwned Passwords range list for that prefix of a SHA-1
hash as `text/plain` (lines `SUFFIX:COUNT`, padded). The server asks `api.pwnedpasswords.com` (HTTPS, port 443, header `Add-Padding`) on the
library's behalf, so that service sees the server and never the person's IP address. Answers are cached in memory for 24 hours (at most
500 prefixes); a client may send 120 requests per minute (`[ratelimit] pwned`, `pwned_window`; cached answers count too, IPv6 per /64). It
answers 400 for a malformed prefix, 429 with `Retry-After`, and 503 `pwned_unavailable` (with `Retry-After: 60`) when the service cannot be
reached, the answer is not in its format or `[server] pwned_url` is empty. After a failure the server tries again only after a minute, so a
blocked outbound connection never ties up threads; everything else works as before, and the library then checks the passphrase locally only.
The prefix is never logged (there is no access log; the one warning about an outage names the kind of error only). A reverse proxy in front must
not log the path of `/datastore/api/v1/pwned/` together with the client address. The outbound connection needs api.pwnedpasswords.com:443.

## Tests

`scripts/test-server.sh` (unittest, no network; an in-process ASGI client, an injectable clock and disk probe). One test
starts the real server with uvicorn. `scripts/test-integration.sh` runs the real server against the real client bundle in
browsers (see `client/README.md`).

## Layout

| Module | Role |
|---|---|
| `app.py` | app factory; outermost ASGI layer adds CORS and security headers, answers preflights, turns crashes into JSON 500 |
| `service.py` | configuration, DB pool, clock, disk probe, limiter; fixed protocol constants (floor 600 s, invite 15 days, …) |
| `db.py` | SQLite pool (WAL, `secure_delete`, incremental auto-vacuum), migrations by `user_version` |
| `auth.py` | slot token and operator token checks, then vault/scope state, role, read-only (the order of PROTOCOL 8.1) |
| `ratelimit.py` | in-memory sliding windows; authentication failures, vault creations and breach-check requests count |
| `pwned.py` | the breach-check proxy: fetch, answer cache, back-off after a failure |
| `roster.py` | roster structure, invariants, allowed changes (PROTOCOL 6), storage |
| `validate.py`, `util.py` | envelope/KDF/ID checks; b64u, b32c, canonical JSON, padme |
| `api_public.py`, `api_vaults.py`, `api_slots.py`, `api_records.py`, `api_admin.py`, `api_static.py` | endpoints, grouped as in PROTOCOL 8 and 9 (`api_static.py` also serves `client/hashes.json`) |
| `docs.py` | llms.txt, Markdown documentation and the export page from `docs/site` (config `docs_dir`); placeholders for the library tag and policy |
| `dashboard.py`, `ui.py`, `texts.py` | dashboard (staff and operator), login routes, forms with CSRF; layout, CSP and language; German/English texts |
| `loginpsi.py`, `access.py` | login.psi protocol (SecretBox, single-use nonce); sessions, staff rule, operators, scope admins |
| `privacy.py` | the Art. 13 GDPR page `/datastore/privacy` |
| `maintenance.py`, `purge.py`, `cli.py`, `scopes.py` | purge/sweep, vault purge, dev CLI, scope creation shared with the operator API |
| `sandbox.py` | the sandbox scope row, wipe schedule (DST-correct), nightly wipe, eviction |
| `prompt.py` | the text for the person's Claude (also the CLAUDE.md / AGENTS.md section), the official privacy sentence and the breach-check wording |

Every handler does its checks and database work in a worker thread; SQLite runs with one writer at a time
(`BEGIN IMMEDIATE`), which is what makes the compare-and-swap of records and rosters atomic.
