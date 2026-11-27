# Implementation log

Decisions and changes during implementation, appended in order. The design itself lives in `PLAN.md`, which is kept
in line with what is actually built.

## Setup

- Build plan: workflow A (protocol spec, server, client library, reviews, integration tests), infrastructure set up by
  the orchestrating session in parallel, workflow B (dashboard with login.psi, Art. 13 page, documentation, tools,
  `wds-verify`), workflow C (example app and visual end-to-end reviews).
- Roles: Opus orchestrates and reviews; Sonnet implements; Opus runs the visual end-to-end reviews.
- Server runtime: Debian 13 packages only (Python 3.13, starlette 0.46.1, uvicorn 0.32.0, PyNaCl 1.5.0). Local
  development uses a uv venv with exactly these versions. No python-multipart: dashboard forms are
  `application/x-www-form-urlencoded` and parsed with the standard library.
- Address fixed: `https://wiai.uni-bamberg.de/datastore/` (operator decision; a later move to a subdomain will be
  handled then).
- Scope creation: all staff (login.psi e-mail ends in `@uni-bamberg.de`, no matriculation number) – confirmed.
- Host: a dedicated virtual machine on the university's virtualisation cluster (details in the operator's internal documentation).

## Infrastructure

- The virtual machine has 2 cores, 2 GB RAM, a 16 GB root disk, a 50 GB data disk (XFS, mounted at `/var/lib/wiai-datastore`)
  and a 50 GB backup disk (XFS, mounted at `/var/backups/wiai-datastore`). Mounts use UUIDs from the configuration management.
- The hypervisor firewall for the VM was written before its first start: only the reverse proxy reaches the service port, SSH only
  from the internal management network.
- Host keys signed, base configuration applied, full upgrade (Debian 13.8), then the configuration-management role `datastore`
  (Debian packages starlette 0.46.1, uvicorn 0.32.0, nacl 1.5.0 confirmed on the VM; mounts; service user `wiai-datastore`;
  directories). Unit, config and backup followed once the server's command line was final.
- Reverse proxy: new optional `log_skip` per proxied path; site `wiai.uni-bamberg.de` gets `/datastore/` → the VM's port 8000
  with `log_skip` (no access log for this path), redirect `/datastore` → `/datastore/` (308) and `max_body: 32MB`. Checked: `/` 200,
  `/datastore` → 308 to `/datastore/`, `/datastore/healthz` 502 until the service was deployed. A leftover site in the proxy's
  configuration was removed on the way (operator decision).

## Escrow keys, operator token, first deployment

- `tools/wds-keygen.mjs` (Node, WebCrypto only) creates one escrow key set (ECDH + ECDSA P-256) per call. Production
  sets "current" (key ID `jPpQPgYBsi1_jbhpXomvO_qDGg6B_oqL8t8qCEU7AAg`) and "spare" (key ID `tVvmpc-8Du0iPnpniKhKa3vmXgL4uJ0atqDP6dOY1ic`) generated on the
  operator's workstation into a directory with mode 0700 (private files 0600) for import into a password manager; the
  spare goes into a separate database. Public parts in the configuration management; key IDs in
  `client/escrow-pins.json`, which `client/build.mjs` builds into the library.
- Operator token generated with `python -m wds_server.cli operator-token`; the token stays on the operator's workstation
  (mode 0600), only its SHA-256 goes into the server configuration (not secret).
- Role `datastore` completed: `config.ini` from the configuration management, hardened unit running `/usr/bin/python3 -m wds_server`
  (Debian packages, no venv) with `--forwarded-allow-ips` set to the reverse proxy's address, `wiai-datastore-install` (backup, restart,
  health check), nightly `wiai-datastore-backup` to the backup disk (2 copies, integrity check). In-service sweeps
  replace a separate maintenance timer.
- `deploy/deploy.sh`: runs server tests, rsyncs `server/wds_server` and `client/dist` (and `docs/site` once it exists)
  to `/opt/wiai-datastore/app`, calls the install script.
- First deployment of an intermediate state: `/datastore/healthz` answers through the reverse proxy; CORS preflight from
  `Origin: null` returns the expected headers.
## Workflow A: protocol, server, client library, integration

Protocol spec by Opus; server and client by Sonnet; one Opus review per side with Sonnet fixes; integration tests by
Sonnet; final Opus review. Results: server 212 unittest tests, client 94 node tests and 23 Playwright UI tests,
integration 18 tests per browser (Chromium, Firefox, WebKit), including a check that no canary plaintext appears in any
request body or in the database files.

### Server
- Server layout: Starlette app factory in wds_server/app.py with one module per endpoint group (api_public, api_vaults, api_slots, api_records, api_admin, api_static). dashboard.py is the placeholder router for the dashboard and login.psi.
- All request handling is two-phase: authentication, state and role checks run in a worker thread before the body is read. The compare-and-swap then runs in a second worker call inside one BEGIN IMMEDIATE transaction, which re-verifies the slot.
- SQLite uses a pool of 16 connections with WAL, synchronous=FULL, secure_delete=ON, foreign_keys=ON and auto_vacuum=INCREMENTAL, which only takes effect on a new database. Schema migrations are keyed on PRAGMA user_version, and an older server refuses a newer schema.
- Vault byte usage is cached in vaults.bytes and adjusted in the same transaction as every write, delete, prune and history purge. A test compares it to the real SUM(size). The scope total is the SUM over the scope's vaults, including soft-deleted ones.
- Revoked slots keep their row with revoked set and the token hash and blob wiped, so access IDs are never reused. A separate slot_ids table keeps every slot ID ever used per vault, including the escrow slot, so slot IDs are never reused either.
- The disk probe is a callable returning a fraction. The default is the df-style figure used/(used+available) from os.statvfs on the database directory (or disk_path). Tests inject a mutable value.
- The clock is injectable (Service(clock=...)). All timestamps, invite and recovery waits, the history floor and rate-limit windows use it, so tests advance time without sleeping.
- The in-process test client runs the app on a background event loop, so tests can fire truly concurrent requests. They cover CAS races on records and rosters and a revocation racing writes.
- The server accepts operator token hashes as 43-character base64url or 64-character hex, several at once. python -m wds_server.cli operator-token generates a token and its hash.
- The default for --forwarded-allow-ips is 127.0.0.1. Deployment passes the reverse proxy's address. Uvicorn runs with access_log off, server_header off and ws none.
- Review fixes in server/: an unredeemed invite token now gets 403 forbidden on every endpoint except GET slot, redeem, GET roster, PUT slot and POST renewal (opt-in via allow_unredeemed in authenticate_slot and reverify).
- Roster growth is bounded: no-op versions are rejected, ordinary versions stop at 1000 and protective versions at 1100 per vault, roster bytes are tracked in vaults.roster_bytes (cap 16 MiB, also counted toward vault and scope quota), and read-only mode accepts only protective roster versions. vaults.bytes keeps meaning record envelopes only.
- Schema migration 2 adds the access_ids table (backfilled from slots; never deleted by purge, so access IDs are never reused globally) and vaults.roster_bytes (backfilled from rosters).
- The owner-invite rule moved from parse_roster to apply_roster and applies only to added slots, so the founder can keep posting rosters while a recovered owner invite is pending.
- GET /slots/{id}/kdf no longer throttles or counts lookups of existing IDs, answers 410 for deleted vaults, and the per-IP limiter buckets IPv6 clients by /64.
- Failed operator calls (vault status, recovery start/cancel, escrow fetch, recovery complete) write an audit row <action>_failed in a separate transaction before the error is returned.

### Client
- wds-core.js is one UMD file (window.WDSCore, or CommonJS in Node) using WebCrypto only, apart from Argon2id from the vendored hash-wasm 4.13.0 (client/vendor, LICENSE, SHA256SUMS); core finds it via global hashwasm, WDSCore.setArgon2 or the Client argon2 option.
- Test vectors are generated by client/test/make-vectors.mjs into client/test/vectors.json. They are deterministic apart from ECDSA signatures, where an existing valid sample is kept so regenerating changes nothing; node:crypto is used only to derive public keys from the fixed scalars.
- The client keeps rollback state under wds:<scope>:<access_id>:state, MACed with K_state, and pins roster head hash and version, epoch and the highest version seen per record. Missing or invalid state is reported as stateStatus 'new' or 'invalid' (newDevice true) and never blocks.
- Chain verification also enforces what PROTOCOL.md leaves implicit: an escrow-signed version may only add exactly one owner invite and change nothing else; epoch commitments never change; new epochs only with an epoch bump; only an owner may change its own keys.
- A vault recovered by the faculty is derived from the signed chain. Owner roster edits are refused until acknowledgeRecovery() is called, unless the added owner slot is the caller's own.
- Revocation is one roster version with epoch+1 and a new VMK, followed by the resumable rekey loop. Each blob's history commitment is verified before re-encryption, the client checks itself that no blob uses an old epoch, and only then drops old commitments in a further roster version.
- Unlock does light maintenance only (adopt pending renewals as owner, drop superseded key sets from the stored blob); the heavy rekey is explicit via resumeRekey(), and status().rekeyPending tells the UI when it is needed.
- list() has to download every new or changed record once per session, because names exist only inside the encrypted records; the name cache keeps metadata only. A spec change is proposed in the open issues.
- Client tests run against an in-memory fake of the API (client/test/fake-server.mjs) that enforces preconditions, the roster rules, epochs and keyring completeness; protocol tests use a fast stand-in for Argon2id, real Argon2id is used for the vectors, one end-to-end test and the bundle test.
- wds-ui.js is one UMD file loaded after wds-core.js. In Node it exports only pure helpers (`internals`); in the browser it sets `window.WDS`. All DOM is built with an `el()` helper and `textContent`; a unit test forbids innerHTML, eval, Shadow DOM and console.log, and enforces ES2020.
- WDS.connect deliberately has no injectable fetch, storage or Argon2 option, so no hook can see the passphrase. The only test-oriented option is `escrowPins` (public key IDs), because the bundle has no built-in pins until wds-keygen exists.
- Every store method unlocks first when the store is locked, with one shared dialog for concurrent calls. This is a convenience for lay developers; `store.unlock({cancelable:true})` rejects with code `cancelled`.
- Writes to one record name are serialised in the UI layer, so autosave bursts never conflict with themselves. `set` resolves with `resolution: saved|mine|theirs|merged`; keep-mine and merge are written on top of theirs, so history keeps both.
- Unlock and redeem call the core with `maintain:false` and the UI runs `maintain()` after the recovery notices. Reason: core `maintain()` would throw `recovery_unacknowledged` for a founder whose vault was recovered by the faculty, which would make unlocking impossible before the acknowledgement that needs an unlocked vault.
- Passphrase rules (PLAN 5.3): 12 code points; exact common-password list (107 entries, leet and trailing-digit variants); a heuristic bit estimate that takes the cheapest decomposition into literals, ~378 common EN/DE words, years, repeats, sequences and keyboard walks; below 36 bits is refused and the meter has five levels. HIBP runs only on submit, never while typing, with an 8 s timeout, and fails open with a visible note on the sheet.
- Member labels are stored as the encrypted record `.wds/labels` (slot ID to text), owner-written. Names starting with `.wds/` are reserved: app calls reject them and `list`/`exportAll` hide them. Chosen because slots are anonymous and 'Member 2' is unusable; the alternative, labels in localStorage, would put personal data in shared `file://` storage.
- Export layout: every record is a file in a store-only ZIP; JSON records get `.json`, folders are kept, collisions get ' (2)', and `wds-export.json` maps name to file with kind, MIME, version, time and size. `README.txt` states that the files are unencrypted.
- Record `time` in the header is Unix milliseconds (PROTOCOL 4.4); the UI converts it for display.
- Added to wds-core.js: `checkRemote()` (record list only, reports records known to this session that are newer on the server, used for the focus warning of PLAN 8.2) and `cancelRecovery()` (`DELETE /vaults/{v}/recovery`, PROTOCOL 8.5). Both are tested. The fake server now models a pending recovery.
- build.mjs: no timestamps in the bundle, so builds are deterministic. `hashes.json` records per version file, SRI, SHA-256, size, escrow pins and a frozen flag. `--freeze` makes a released version immutable; a later build with different bytes needs `--force` or a version bump. Escrow pins: `--escrow-pins`, `WDS_ESCROW_PINS`, or `client/escrow-pins.json`.
- German dialog texts use the formal 'Sie'. It is a one-line change per string if the faculty prefers 'du'.
- Browser tests run on Chromium only: the installed WebKit build (2370) does not match Playwright 1.65.1 (2388) and Firefox is not installed. The Playwright version is pinned to 1.65.1 because it matches the installed Chromium revision 1255.
- Playwright test screenshots go to client/test-results/shots (git-ignored) for the visual review.
- Critical review finding fixed: adoptRenewals() skips owner slots other than the caller's own, and roster.py refuses another owner's key change on an owner slot. PROTOCOL 6.3 (b) now needs 'non-owner slots only'.
- Decision in PLAN 5.7: an owner may revoke faculty-added owner slots, a faculty-added owner may revoke any other owner slot, and nobody revokes the escrow slot or their own slot. Implemented in revoke(), members().revocable and the share dialog.
- Escrow pin enforcement: every roster version must name a pinned or retired escrow set (retired entries are {id, until}, set by the build). Escrow-signed versions of a retired set count only up to `until`. An owner's maintain() migrates a retired head to the current pinned set, and roster edits refuse until then (code escrow_retired).
- Local rollback state now names scope, vault, access ID and slot; PLAN 5.5 states that the MAC gives no freshness.
- The production bundle is one function scope with hash-wasm in a private scope. wds-core is built with PRODUCTION=true, which removes setRandom, setArgon2 and internals, freezes the API and captures argon2id once at load. A build with escrow pins ignores the escrowPins and retiredEscrow options.
- The Playwright suite builds its own pinless bundle into client/test-results/bundle so that dist/ always holds the production build with the real pins.
- K_wrap, K_commit, K_state and K_id are non-extractable CryptoKeys in the session. NK, the VMKs and the private scalars stay raw.
- Member labels are documented as unverified and shown with slot-ID prefixes. The recovery acknowledgement is persisted per access ID and slot ('acked' in localStorage). The vendor README points at the real checksum test and records the npm tarball integrity.

### Integration
- Integration tests (scripts/test-integration.sh, client/test/integration.spec.mjs, client/test/integration-env.mjs, client/playwright.integration.config.mjs) run the real Python server against a real bundle built from the current sources, with escrow keys generated for each run and pinned in that bundle, from file:// pages in Chromium, Firefox and WebKit: 18 tests per browser, 54 in total.
- The integration tests use an operator token and a temporary database, and the real server runs with read_only_threshold = 1.0 because the development disk is usually above 85 %. The read-only test starts a second server process on the same database with a threshold of 0.0001, so the server is always read-only. A rate-limit test starts a third process with a low budget.
- The 72 hour and 7 day recovery waits are skipped in the integration test by setting ready_at of the pending row in the temporary database. The operator side (escrow fetch, decrypt the keyring entry with the escrow private key, sign an escrow roster adding one owner invite, POST recovery/complete) is implemented in the test environment with the core internals, so it exercises the real endpoints and the client's handling of recovered vaults.
- Bug found by the integration tests and fixed in server/wds_server/roster.py: when an owner signed in its own new keys (a redeemed faculty-added owner invite), the pending renewal was never cleared. The server now clears it when the new keys equal the renewal. test_review_fixes.py asserts this.
- The playwright.config.mjs testMatch is now ui.spec.mjs only; integration.spec.mjs has its own config, so scripts/test-client.sh does not start the real server.
- A browser that is not installed is skipped with a notice (WDS_BROWSERS forces a list and fails on a missing one). If the WebKit build that Playwright expects is missing, an installed older webkit-* build is used (WDS_WEBKIT_EXECUTABLE overrides). Here the installed build 2370 works with Playwright 1.65.1. Firefox was run from a temporary PLAYWRIGHT_BROWSERS_PATH in the scratchpad and deleted afterwards.
- The canary check scans all request URLs and bodies of every browser context in a run (raw, hex, base64 at three alignments, base64url blobs inside JSON) plus the database files and the server log, includes positive controls for the detector and asserts that the 5 MB attachment body was captured.
- PROTOCOL.md was updated for the deviations of the server review fixes (see the spec changes): 2, 6.2, 6.3, 7.1, 8.2, 8.3, 8.5, 8.6, 8.7, 8.9 and 9. PLAN.md sections 7.2, 8.6, 9 and 11 were brought in line.

### Final review (open items handed to workflow B)
- major: cancelInvite() removes the invite slot without an epoch bump, so for any invite that is unredeemed but 'used' the server answers 409 revocation_required.
- major: The client checks every fetched record envelope against the scope's current max_envelope_bytes, both when reading (_openFetched) and in rekey (_rekeyOne, line 1780).
- minor: In recovery mode the server checks only that exactly one owner invite is added and nothing is removed.
- minor: Record PUT compares only record bytes with vault_bytes, and SUM(bytes) with scope_bytes.
- minor: The chain verifier accepts the escrow slot being replaced by a slot with a new ID, with the old escrow slot removed, as long as exactly one pinned escrow slot remains.
- PROTOCOL.md lagged behind the code in several places (unredeemed invite tokens, roster growth limits, escrow
  retirement, local state fields, rekey answers); synced in workflow B.

### Operations notes
- Playwright Firefox and WebKit 2388 installed into the shared cache, so `scripts/test-integration.sh` runs all three
  engines on this machine.
- VM backups: the university's nightly VM backup job covers the VM; the privacy page takes the VM backup retention
  from one config value until the operator decides on a retention.

## Workflow B: review fixes, dashboard, login.psi, privacy page, docs, tools

Sonnet built, Opus reviewed (security review of dashboard/login/privacy/wds-recover; a "fresh developer" trial that
integrated a sample app using only llms.txt and ran wds-verify), Sonnet fixed, Opus synced PLAN.md with the code.
Test state after the workflow: server 358, client 110 node + 25 Playwright, integration 88 (Chromium, Firefox, WebKit;
2 Chromium-only by design), tools 37.

### Review fixes and protocol sync
- Reads and re-encryption are bounded by a fixed ceiling-derived envelope size (26738726 bytes) instead of the scope's current limit: the client uses it in parseEnvelope for records, and the server uses the configured ceiling for the rekey PUT in addition to the stored-length check.
- PATCH /admin/scopes refuses to lower max_value_bytes below the largest stored envelope in the scope (history versions and deleted-but-unpurged vaults included) with 409 limit_below_stored_value, reporting largest_envelope_bytes and minimum_max_value_bytes; resetting to a lower default is checked the same way.
- cancelInvite falls back to a revocation (new epoch, resumable re-encryption) for invites the server saw in use or redeemed, and also when the roster POST answers 409 revocation_required; the share dialog offers Cancel only for unused invites and Revoke, with its own confirmation text, for opened ones.
- Expired invite slots cannot be removed by a server sweep because every roster version needs an owner's signature and the server holds no key; instead the owner client removes expired unredeemed write/read invites on unlock (maintain), in one version without a new epoch if none was used, as a revocation with rekey:false if one was, and never touches expired owner invites.
- The server's recovery mode now enforces what the client verifier accepts for escrow-signed versions: same epoch, identical commit object, every existing slot (escrow included) unchanged in every field, nothing removed, exactly one added owner invite.
- Record PUT now counts roster bytes toward vault_bytes and scope_bytes (vault bytes + roster_bytes, SUM(bytes + roster_bytes)); deletes, history purges, rekey and protective roster versions are never refused for quota reasons.
- The client chain verifier requires the escrow slot to keep its slot ID and rejects expiry changes of slots that stay invites; escrow-signed versions must also leave expires unchanged.
- GET /slots with keyring null raises IntegrityError in the client instead of a TypeError; PROTOCOL 8.4 documents the null case.
- PROTOCOL.md was brought in line with the code: recovery and complete rules, escrow slot ID, retired escrow sets and the time/until rule, expired-invite handling, rekey PUT answers, quota accounting, lowering rule and its error code, operator scope object with the full limits, local state fields access/scope/slot/vault, null keyring, used marking by any valid token, labels as unverified notes, freeze status of dist; PLAN.md lost the obsolete /revocations row and python-multipart and gained the cancel/expiry decision.
- Server quota tests now use Env.quota_scope, which adds the vault's roster bytes to the wanted record room, and the integration quota test runs in its own scope so that lowering max_value_bytes does not collide with the 5 MB value stored by the lifecycle test.

### Dashboard, login.psi, privacy page
- Dashboard layout: dashboard.py (handlers), ui.py (layout, CSS, strict CSP with per-response nonce, language), texts.py (German and English catalogue, formal Sie), access.py (sessions, staff rule, operators, scope admins), loginpsi.py (protocol), privacy.py (Art. 13 page); tests check that every text key exists in both languages.
- Schema migration 3 adds scopes.description, contact_email, creator and suspended_by, plus the tables scope_admins, sessions and blocked_users and an index on audit(ts).
- The login.psi nonce is '<unix time>.<random>' in the cookie __Host-wds_login (SameSite=Lax so it survives the cross-site return, Max-Age 600); the server enforces the ten-minute lifetime and single use from the nonce itself and an in-memory set of consumed nonces, so starting a login writes nothing on the server.
- The login callback answers 200 with a meta-refresh page instead of a 303, because a redirect that continues a cross-site navigation does not carry the SameSite=Strict session cookie (Firefox logs this as omitted because of a cross-site redirect); the flow was verified in Chromium and Firefox with a fake login.psi on another origin.
- Dashboard pages send Referrer-Policy: same-origin instead of the app-wide no-referrer, because with no-referrer Chromium puts 'Origin: null' on our own form posts; the CSRF check additionally refuses a Sec-Fetch-Site that is not same-origin or none, and an Origin that is not the public_base origin.
- Sessions are stored server-side with only the SHA-256 of the 32-byte cookie value; idle timeout 2 h and absolute timeout 12 h are configurable as [dashboard] session_idle and session_absolute; the matriculation number is used only for the staff rule and never stored.
- Authorisation: operators (username or e-mail from [dashboard] operators, compared case-insensitively) may enter even without the staff rule and may create scopes; staff may enter and create scopes; anyone listed as co-admin of a scope may enter and manage that scope but not create scopes unless staff; blocked Uni IDs never get a session and lose running ones when blocked; operators cannot be blocked.
- A scope suspended by an admin can be resumed by an admin; one suspended by the operator (scopes.suspended_by, and NULL for the operator API) only by the operator. The operator sees any scope read-only and can only suspend and resume.
- Deleting a scope soft-deletes all its vaults, wipes description, contact and join code at once, and the maintenance sweep removes the scope row and its scope_admins once the last vault is purged; audit entries stay for one year, deleted after 365 days by run_maintenance, which also sweeps expired sessions.
- The 70 % disk budget of PLAN 10.1 is enforced by the dashboard (scope creation and raised limits) through scopes.check_disk_budget and Service.disk_total_bytes (overridable in tests); lowering a limit is always allowed, and the operator API does not apply the check.
- Limits are entered in MiB for byte values and an empty field resets to the default; ceilings are validated through the existing validate_limits and patch_scope, including the stored-value check.
- The Art. 13 page follows Accept-Language like the dashboard (German when nothing says otherwise); the date comes from [privacy] updated (placeholder text when unset) and the VM backup sentence from [privacy] backup_retention_de and backup_retention_en with the placeholder default from the task.
- The privacy page states plainly that the faculty can decrypt every vault with the escrow key and that the matriculation number is not stored, and gives the figures for sessions, deleted vaults (30 days), empty vaults (7 days) and audit entries (1 year) from the same constants the server uses.
- Fixed a pre-existing flaky test in test_admin.py (a mistyped recovery code passed its check bits one time in sixteen and gave 403 instead of 400).

### Documentation and export tool
- Documentation is served from docs/site (config [server] docs_dir, default <app>/docs/site) by the new server/wds_server/docs.py with no build step; placeholders ({{script_tag}}, {{sri}}, {{version}}, {{csp}}, {{base}}, {{api_url}}, {{library_url}}, {{escrow_ids}}) are filled at request time from client/dist/hashes.json (else the .sri file, else the file's SHA-384) and public_base, in both the rendered and the raw .md.
- The Markdown renderer is built in (no package), always escapes raw HTML and accepts only http(s), mailto, anchor and relative link targets; documentation pages carry their own strict CSP header and a data: favicon so browsers do not request /favicon.ico.
- The recommended app CSP is built in docs.csp_policy and was verified from file:// in Chromium, Firefox and WebKit with the real bundle: default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' <base>/client/; style-src 'unsafe-inline'; img-src data: blob:; connect-src <base>/api/ https://api.pwnedpasswords.com; base-uri 'none'; form-action 'none'. 'self' is omitted because its meaning on file:// differs between browsers; a test without 'wasm-unsafe-eval' proves that Argon2id fails then.
- The script tag carries an onerror handler that replaces the body text with 'Storage service unreachable'; the tag belongs at the end of the body, and the test shows it fires on a wrong integrity hash and on a missing file in all three browsers.
- The export tool is docs/site/export.html, rendered by the server so that a saved copy contains the absolute SRI-pinned library URL and its own CSP meta tag; it asks only for app ID plus access ID or key file, pre-seeds the library's documented localStorage key wds:<scope>:access_id so the unlock dialog opens with the ID filled in, and lets the library's dialog take the passphrase, so no passphrase hook exists.
- The export page accepts key files only of its own service (the key file's service field must equal the page's base), so a foreign key file cannot redirect the unlock to another server.
- integration.md documents the real wds-verify command line (node tools/wds-verify.mjs <app.html>, no --scope option) and its wds-verify.json step format (click, fill, wait); the example app plus those steps pass wds-verify, and a Chromium test runs its static checks with production URLs against the hashes of the test bundle.
- operator.md uses the real wds-recover subcommands (start, status, cancel, complete --escrow-key) and states plainly that escrow migration moves the recovery slot but does not change content keys, so a compromised escrow key still exposes data stored until then.
- docs.spec.mjs is added to the integration Playwright config (testMatch) and starts a second server on the same stack with public_base set to its own local address (new publicBase option of startServer), so documentation URLs are absolute and local and nothing reaches the real host.

### Tools
- wds-recover verifies the roster chain, the key file against the head's escrow slot, and the escrow keyring entry against the signed commitments before it signs, and runs the client's verifyRosterChain over the old chain plus the new escrow-signed version before uploading, so a version the clients would refuse is never sent.
- wds-recover validates the roster chain with every escrow set named in the chain as a pin (structure, signatures and links only) and then requires that the head's escrow slot equals the key file; this keeps recoveries working for vaults whose older versions name a different set, while the key match still gates signing.
- wds-recover writes no file and never prints the operator token or the escrow private scalars; `complete` needs --yes when there is no terminal, supports --dry-run, and the invite lifetime is --expires-in-hours (default 72, maximum 360 = the server's 15 day limit).
- wds-verify runs the REAL server as the mock (venv, WDS_PYTHON or python3.13) with freshly generated escrow keys; because the production library pins the faculty keys, the dynamic run serves a library built from client/src with the mock keys pinned and opens a copy of the page whose integrity attribute is that bundle's hash, while the static checks run on the original tag.
- wds-verify maps https://wiai.uni-bamberg.de/datastore/ to the mock with Playwright routing, blocks all other hosts, and creates the scope an app names on first request by renaming the scope the server creates for the slug (scope IDs carry a random suffix, so the API cannot create an arbitrary ID).
- wds-verify observes the app with an init script that logs fetch, XMLHttpRequest, WebSocket, sendBeacon, EventSource and form submissions together with the caller (library frame on the stack or app code) and wraps WDS.connect to log set, autosave and exportAll; app code that calls the datastore host itself fails, library traffic is never blamed.
- Canaries are searched as raw, URL-encoded (also lower-case and form style), base64 and base64url at three alignments, hex (both cases), UTF-16LE (raw, hex, base64) and also as the core token alone; the vault passphrase and the text of wds-verify.json fill steps are treated as canaries too, and the mock's database files are scanned as an extra sink.
- Downloads are exempt only when they fall in the time window of a store.exportAll() call seen by the in-page hook, so a hand-made plaintext download still fails.
- wds-verify fails when the run could not make the app store anything (no vault created or no record write), pointing to wds-verify.json, so a pass cannot be vacuous; set-rate and single-record findings are warnings that become failures with --strict.
- wds-verify reads the library hashes from client/dist/hashes.json at run time (--hashes overrides) instead of embedding a copy, because unfrozen builds change the hash; a standalone copy of the tool needs that file shipped with it. The example apps carry the hash of the build they were written for and the tests substitute the current hash.
- Exit codes of wds-verify are 0 passed, 1 a check failed, 2 the tool could not run (no Python venv, no Playwright, bad usage); wds-recover uses 0 done, 1 failed, 2 usage error or waiting period not over.
- tools/package.json adds Playwright 1.65.1 as the only devDependency of tools/ (wds-verify falls back to client/node_modules), and scripts/test-tools.sh runs node --test with concurrency 4 (SKIP_BROWSER=1 skips the browser tests).

### Fixes after the reviews
- Dashboard: one person may hold at most 5 active (not deleted) scopes, checked inside the create transaction (MAX_SCOPES_PER_CREATOR in scopes.py); operators are exempt, and the operator can now delete any scope from the operator view, which frees the 70 % disk budget.
- A scope suspended by the operator is locked: scope admins get 403 on every admin action (limits, settings, admins, enrollment, join code, delete) and the edit forms are hidden; an operator can take over an admin suspension ('scope_locked' audit entry), after which the admins can no longer resume it.
- Audit: scope_updated records only the fields that changed (contact e-mail with old and new value) and nothing for a save that changes nothing; login and login_denied rows (user ID, no IP, no scope) are written and only appear on the operator audit page.
- Privacy page: the passphrase check is a named purpose with Art. 6(1)(e) as legal basis; the recipient is Cloudflare, Inc. (USA) under the EU-US Data Privacy Framework adequacy decision (Art. 45); portability (Art. 20), no automated decision-making, group (b) incl. co-admins, the __Host-wds_login cookie and internal recipients were added in German and English; the DPO still has to confirm the wording and whether the HIBP operator should be named as an Australian recipient.
- wds-recover refuses plain http except for localhost/127.0.0.1/[::1], reads the recovery code from a terminal prompt or stdin ('start <vault> -') and warns when it is passed as an argument, and caps --expires-in-hours at 359 so a laptop clock slightly ahead of the server cannot break the 15-day server limit.
- wds-verify CSP_TEMPLATE is now exactly docs.csp_policy (no 'self', with base-uri 'none' and form-action 'none'), guarded by a test that runs the Python function; the tool accepts font-src data:, media-src blob: data: and img-src https://host (reported as info) and fails on 'self' in script-src or a missing base-uri/form-action.
- wds-verify gained an upload step (generated PNG whose name and bytes are canaries, or a developer file whose name is a canary), reports what the steps did and counts step fills as filled fields, only warns about write bursts of 3 or more without a button press in between, bases the one-record check on canaries of two typed items landing in one record (plus the old rule only for a single record name without a folder), and shows promoted warnings under Failures with --strict.
- Library: list() keeps the records it downloaded (up to 1 MB each, 16 MB total, 30 s, used once and only for the listed version, dropped on put/delete) so the get() after list() does not download them a second time; the docs now say that list() downloads every record whatever the prefix and recommend an index record for apps with files.
- Library UI: WDS.connect({ label }) and showHistory(name, { title }) replace record names in the history title, conflict dialog and stale notice; the history Restore button is disabled for read members; exportAll adds a MIME-based file ending to byte records whose name has none.
- integration.md: the example 'New note' handler opens the note before storing it (docs.spec types right after the click in all three engines), section 12 has a setup block and says wds-verify needs a full checkout, and llms.txt rule 6 points to it; the real clone URL is not known to the repository and is left as <repository-address>, to be obtained from the operator.

### PLAN.md sync
- PLAN.md is now the design document of the system as built: its status line lists what is designed, built and tested, deployed and pending, and 'Nothing is deployed' is gone.
- PLAN.md status records that production serves an intermediate state: the data API, healthz and an earlier wds-1.0.0.js build whose hash differs from client/dist/hashes.json, while the dashboard is still the placeholder and privacy, llms.txt, docs and export answer 404 until the current state is deployed.
- PLAN.md 5.4 now matches PROTOCOL 4: type 0x04 is reserved (rosters are signed JSON), the record header keys are n, k, l, t, m, and keyring entries carry the 65-byte eph.pub before the nonce.
- PLAN.md 5.6 now gives the commitments as HKDF(VMK, wds1/check/vmk) and HKDF(NK, wds1/check/nk), lets every owner slot of the previous version sign (including a faculty-added owner), and lists roster slot fields without access IDs or a created field.
- PLAN.md 5.8 now gives the real invite facts: a 17-byte (136-bit) secret, a 48-symbol code shown in 12 groups of 4, 1/2/7/14 days in the dialog, 1 hour to 14 days in the library, at most 15 days on the server, and the owner's maintain() removing expired unredeemed invites.
- PLAN.md 10 to 13 now describe the dashboard, login.psi, the privacy page, the docs and export routes, the migration-3 tables, the in-service sweeps and the infrastructure (one VM, separate data and backup disks, no access log at the reverse proxy, Debian packages, deploy script) as implemented.
- PLAN.md 15 now has a state per work package, and 16 lists the remaining open points: deploy, freeze 1.0.0, login.psi registration, monitoring and internal documentation, privacy date and VM backup retention, Argon2 timing, Safari/Edge/Electron, list/export cost, unsigned member labels.
- The review log in PLAN.md gains a 'Final review of workflow A' table; all five findings are resolved in the code (cancelInvite falls back to revocation, ceiling bound on reads and rekey, strict recovery check, roster bytes in quotas, fixed escrow slot ID).

## Deployment of the workflow B state

- Configuration-management role `datastore`: config gains `docs_dir`, `[loginpsi]` (key file `/etc/wiai-datastore/loginpsi.key`),
  `[dashboard] operators` (operator's login.psi ID and e-mail) and `[privacy]` (`updated` set to "draft, DPO review
  pending"; VM backup retention left to the server's placeholder until the operator decides). The role now also creates
  `app/server`, `app/client` and `app/docs`; `deploy/deploy.sh` creates them too before rsync.
- Deployed: `/datastore/` (dashboard), `/datastore/privacy` (de/en), `/datastore/llms.txt`, `/datastore/docs/…` and
  `/datastore/export/` answer 200.
- `deploy/loginpsi-register.sh`: key created on the VM, application `wiai-datastore`
  (URL `https://wiai.uni-bamberg.de/datastore`) added to the application list of the login.psi host, with a backup of its
  settings file. The restart of login.psi was pending operator approval.

## Example app examples/zeit-notizen (built from llms.txt and the pages it links)

- examples/zeit-notizen/index.html: time tracking (timer, manual entries, weekly table, CSV) and notes with tags, project link, search and attachments, one HTML file, German UI with an English toggle, the demo scope zeitnotizen-demo-xn8kp9 and the default service URL. Script tag and policy are the ones the production server prints in integration.md; the hash equals client/dist/hashes.json and the file served at /datastore/client/wds-1.0.0.js.
- Data: one record per project, time entry, note; attachments as separate byte records; `index` (ids only) instead of `list()`; `timer` and `settings`; autosave for the note editor; `onConflict` merges the index and shows readable texts for everything else.
- examples/zeit-notizen/wds-verify.json (project, time entry, note with tags, upload) passes wds-verify; the report is in the README of the app. examples/zeit-notizen/app.spec.mjs and scripts/test-examples.sh run the app against the real server with a temporary database (production library and service URL mapped to it by the browser context); 5 tests, green in Chromium, Firefox and WebKit.
- A smoke run against the production demo scope (vault creation with the join code, project, time entry, note with attachment, reload) worked; the test vault was deleted with the owner delete.
- What the documents got right: the exact script tag and policy, the index advice for vaults with files, the `onConflict` merge example, the share and reload remarks, the wds-verify steps and the section 14 example as a starting point.
- Where they were thin or misleading: the files in docs/site/ carry `{{script_tag}}`, `{{csp}}` and `{{base}}` placeholders, so the text has to be read from the served URL; `onConflict` replaces the dialog for every record, so an app that needs a merge for one record has to write its own dialog for the others (the docs call the default right for most apps); `usage()` is said to report limits but the key names are not given (the app uses `limits.max_value_bytes`, found in the server source); section 11 forbids downloads of user data except `exportAll` while a CSV export is an obvious wish for a time tracker (the app does it on purpose, the report and README say so); the dialogs follow `navigator.language` and `locale` can only be given at `connect`, so an in-app language toggle does not reach them; a `<form>` with `preventDefault` works under `form-action 'none'` although section 3 reads as if forms were out; the label texts of the library dialogs (needed for tests) are only in the test files.

## Fixes after the visual review (library dialogs, example app, dashboard, docs)

Library (client/src/wds-ui.js, wds-1.0.0 rebuilt, not frozen; the SRI in client/dist/hashes.json and in the example app changed with it):
- Dialog CSS no longer depends on the host page: the checkbox rows (`.wds-root .wds-check`) reset width, min-height, padding, label display, case and weight that global `input` and `label` rules set. Test: ui-visual.spec.mjs opens the unlock, create and access-sheet views in a page with aggressive global rules at 1280 and 390 px.
- Unlocking a deleted vault (410 `vault_deleted`) says so ("Dieser Tresor wurde gelöscht. Er wird nach 30 Tagen endgültig entfernt ..."); only `invite_expired` (and other 410s) say the invite expired.
- Passphrases: the refused-name list gained German passwords and phrases (also without umlauts, separators and digits ignored), the word list German function words; the local limit is 40 bits (was 36). When no breach check is possible (switched off for the scope, or unreachable) the limit is 48 bits ("Diese Passphrase ist nicht stark genug: Die Prüfung auf bekannte Datenlecks ist nicht verfügbar ...").
- `store.setLocale(lang)` and `store.locale`; the example app and the export page call it. The create form shows a wrong join code at the join code field (focus, scrolled into view). `store.lock()` removes all notices. Notices on screens below 36 rem are limited to 40 % of the height.
- Texts: the new-device notice ("Dieses Gerät ist neu für Ihren Tresor. Das ist normal."), the export notice says "Datensätze", the faculty key has its own badge ("Fakultät, nur zur Wiederherstellung") instead of "Eigentümer", each explanation in "Mein Zugang" sits under its button. The export README.txt has no stray line break.
- The export page (docs/site/export.html) uses `notify: false`: its own message line is the only confirmation.

Example app (examples/zeit-notizen/index.html):
- Global input rule no longer hits checkboxes; selects use `appearance: none` with an arrow; the tab focus ring is inset; a date entered manually is reset to today after each entry.
- Weekly overview: wrapping project column, sticky total column, cards below 760 px; the test measures that every total is in view at 1280, 1024, 800 and 380 px.
- Errors: `errText` maps error classes to German or English sentences (never `e.message`); `fail()` stays silent when the session ended (revoked, expired). The app's notices moved to the bottom left (top below 960 px). The export is confirmed by the library only.
- The history heading is built by the library from the note title. The conflict dialog labels "Noch nicht gespeichert" / "Gespeichert: <Zeit>" and marks the lines that differ. A read member sees "Zeiteinträge", no upload hint and the badge "Nur lesen".
- Because the app now calls `setLocale`, its tests use the German dialogs.

Dashboard and privacy page (server/):
- Audit tables in words (actions, actors, details such as limits), local time (Europe/Berlin) in the format of the page language, numbers per language ("10,0 MiB"), details column wraps. Tables become cards below 40 rem (every cell carries its column title). Errors appear in the form they belong to (admin, limits, settings, delete, create, block), keep what was typed and take the focus; the admin message reads "Das ist keine gültige Uni-Kennung oder E-Mail-Adresse."
- The privacy page shows the "Stand" line in the page language: `[privacy] updated` may hold "German text / English text", or `updated_de` and `updated_en` are set.

Docs: users.de/users.en use the names of the dialogs (Darf bearbeiten, Nur lesen, Antrag abbrechen, the default conflict buttons plus a note that apps may word them differently), German quotes, "Wiederherstellungsschlüssel der Fakultät (Treuhandschlüssel)" at first mention (privacy page, operator view and dialogs now use the same term); the docs navigation follows the page language; integration.md documents `setLocale`, the `title` of `showHistory` and the lock behaviour of notices; PLAN.md 5.3 and 8.5 state the new passphrase limits.

Open: the privacy text still needs the review by the data protection officer and `[privacy] updated` on the production server has to be set to the review state (until then the service should stay limited to testers); the new library file has to be deployed and the production app (index.html) has to carry the new hash.

## Fixes after the second visual review

- Dashboard: the slug field pattern is `[a-z][a-z0-9\-]*` (the unescaped hyphen is invalid under the `v` flag that browsers use for `pattern`, so the check was silently off). Test: server/tests/test_dashboard_visual.py compiles the pattern with node under the `v` flag.
- Dashboard limits: two messages instead of one. "Größe eines Werts: Bitte geben Sie eine ganze Zahl ein." for text that is not a number, "Größe eines Werts: Bitte geben Sie eine ganze Zahl von 1 bis 25 MiB ein." for a number out of range (the ceiling is the one the form shows). `DashError` carries parameters and renders itself (`err.text(t)`).
- Example app: below 960 px the toast is placed just below the header and the tabs (computed when it is shown), so it covers no header button. Test: "the app toast never covers a button of the header or a tab" at 1280, 960, 900, 700 and 390 px.
- Docs: export page says "Datensätze"; users.de uses "Eigentümerin oder Eigentümer". server/README.md notes that local dashboard checks in WebKit need an https origin (the `__Host-` cookie is `Secure`).
- client/dist rebuilt: byte-identical to the build before (sha256 e15d5986...), no library change in this round.

Open: privacy text review by the data protection officer and the production `[privacy] updated_de/updated_en` (operator action); the production server still serves the older library file, deploy the current build and the matching example app.

## Workflow C: example app and visual end-to-end reviews

Sonnet built `examples/zeit-notizen` (time tracking and notes with attachments) using only `llms.txt` and the linked
documents; Opus ran two visual end-to-end passes with screenshots (first against production in Chromium, Firefox and
WebKit plus a local dashboard with dev login, second against a local server with the fixed build); Sonnet fixed the
findings after each pass.

### Example app
- Built examples/zeit-notizen/index.html (timer, manual entries, weekly table, notes with tags/search/attachments, share, export, CSV, DE/EN, light/dark, 380 px) from llms.txt and integration.md; script tag and CSP taken from the production-rendered integration.md; the production hash and the served library match client/dist/hashes.json.
- Data model: one record per project, time entry and note, attachments as separate byte records, an ids-only index record instead of list(), timer and settings records, autosave for the note editor, onConflict that unites the index and shows readable texts for all other records.
- wds-verify.json (project, time entry, note with tags, upload) passes tools/wds-verify.mjs (24 passed, 0 failed, 1 warning about 1.0.0 not being frozen); the report is in examples/zeit-notizen/README.md.
- app.spec.mjs and scripts/test-examples.sh: real local server with temp DB, production library and service URL mapped by the browser context, 5 tests, green in Chromium, Firefox and WebKit.
- Smoke run against the production demo scope worked (vault with join code, project, time entry, note with PDF, reload); the test vault was deleted with the owner delete.
- scripts/test-server.sh, test-tools.sh, test-integration.sh and test-client.sh are green; some failed once while two suites ran at the same time on the loaded machine and passed when rerun alone.
- README.md and IMPLEMENTATION-LOG.md updated; scratch files and test-results/pw-examples deleted; nothing committed or deployed.

### Fixes after visual pass 1
- Library: dialog CSS hardened against host input/label rules (.wds-root .wds-check), vault_deleted error text, German passphrase lists with BLOCK_BITS 40 and a strict 48 bit limit without a breach check, store.setLocale/locale, join code error at the field, notices cleared on lock and limited in height, new-device and export wording, faculty key badge, hints under buttons, README.txt wrap; dist rebuilt with new SRI.
- Example app: checkbox-safe input rule, responsive weekly overview (wrapping names, sticky total, cards below 760 px), localized error mapping without e.message, silent fail on revoked/expired sessions, toast placement, setLocale wiring, history title, conflict dialog with unsaved label, saved time and marked differing lines, read-only details, date reset, inset tab focus, select arrow; tests moved to German dialogs and extended (week layout at four widths, revoked member, conflict, language).
- Dashboard/privacy: audit in plain language, Europe/Berlin local time, per-language number format, tables as cards on narrow screens, errors inside their forms with typed values kept, privacy Stand line per language (updated_de/updated_en or 'DE / EN' split), unified term for the faculty recovery key; new server tests in test_dashboard_visual.py and adjusted existing ones.
- Docs: users.de/users.en aligned to dialog names with German quotes, docs navigation localized, integration.md/client README/PLAN.md/IMPLEMENTATION-LOG updated; new tests ui-visual.spec.mjs, ui-unit tests for passphrases and doc terminology.
- All suites green: test-server 368, test-client 112 node + 32 browser, test-integration 88 passed/2 skipped on three engines, test-tools 37, test-examples 18 on three engines. Scratch files deleted; nothing committed or deployed.

### Fixes after visual pass 2
- Dashboard slug pattern escaped for the v flag, with a node-based server test
- Dashboard limits: separate 'not a number' and 'out of range (1 to ceiling)' messages in German and English
- Example app: toast below 960 px placed below header and tabs; new overlap test at 1280, 960, 900, 700, 390 px in three engines
- Docs terminology: Datensätze on the export page, Eigentümer in users.de; server README note on WebKit and dev_login
- client/dist rebuilt: byte-identical (sha256 e15d5986...), SRI unchanged

### Deployment and documentation
- Production runs the reviewed build: `/datastore/client/wds-1.0.0.js` SHA-256 `e15d5986…` equals `client/dist/hashes.json`;
  the example app's script tag carries the matching SRI hash. Library 1.0.0 is not frozen yet.
- Privacy page config split into `[privacy] updated_de`/`updated_en`. The VM backup sentence now states the real
  retention (the oldest VM backup is at most about 93 days old). An earlier note in this log that backups were kept
  without limit was wrong.
- Demo scope `zeitnotizen-demo-xn8kp9` (join code enrollment) created through the operator API.
- Configuration management and the operator's internal host documentation updated and committed.
- Screenshots of the second visual pass kept in `client/test-results/visual-2/` (gitignored); other test output removed.

## login.psi activation (2026-11-25)

- The operator restarted the login.psi service. `GET /datastore/login` now answers 303 to
  `login.psi.uni-bamberg.de/loginapi/request?app=wiai-datastore&token=…`, and login.psi answers that with 302 to the
  university SAML IdP, so it knows the application. The callback after a real login (`/_lpmiddleware/login`) is
  covered by the server tests with a local SecretBox token. It has not yet run against the real login.psi, because that
  needs a university account.

## Round D: integration feedback

Scope: porting feedback, sandbox, collections, locale-proof verifier, publication prep.

Input: a feedback file from a Claude that ported an existing app ("Zeit & Notizen"); its content is now in the docs and this log, and the file was deleted. Operator decisions: public repository at github.com/UBA-PSI/wiai-datastore from a fresh history, a public sandbox scope on the real service,
one-time migration of old local data allowed, the feedback's proposals adopted, no backward compatibility (nothing is released), library version stays 1.0.0 (not frozen), internals in English, dashboard bilingual.

- **Library.** Per-name conflict handlers with fallback to the built-in dialog; `store.collection` (index record, op replay, no clocks or tombstones; entries carry the record version `v`; reads and writes of the index take turns;
  every waiting call rejects with `err.stored` when a write fails; `flush()`, `rebuild()`, `created`); `getMany`; `remove()` result object; autosave unique per name with statuses, lock snapshots (deep copy at lock time, written after the
  next unlock of the same vault, dropped with a notice for another vault); `onUnlock`; stable `data-wds` / `data-wds-view` attributes on every control; sandbox marks (title prefix, banner, bar, no contact field, "emptied" notice;
  the remembered access ID keeps the time of its first remembering); the share dialog of a sandbox offers only "until the wipe". Core: `put` refuses an explicit `base: undefined` (a first index write uses `base: null`).
- **Server.** `[sandbox]` section and scope row owned by the configuration; `meta` table; scope document field `sandbox`; nightly wipe in the maintenance sweep; eviction of vaults that nobody has written to for `evict_min_age`;
  creation limits per IPv6 /56 and for the whole sandbox (503 `sandbox_busy`), refunded when the owner deletes the vault; `sandbox_no_recovery`, `invite_limit`, `sandbox_disabled`; CLI `sandbox status|wipe`; privacy page section;
  dashboard prompt with scope settings, porting line and a CLAUDE.md / AGENTS.md snippet; `/client/hashes.json`; llms.txt block conditional on a configured sandbox.
- **Tools.** wds-verify: targets `auto|mock|sandbox`, `--locale`, `--sandbox-copy`, steps (select, press, download), `data-wds-verify="save"`, reload check, scope check (the app's real scope against the CSP, the service named in
  `baseUrl` or `WDS_VERIFY_SERVICE`), static checks for the sandbox ID, CSS that hides the library and unguarded deletion of local data, "Not tested" section. The scope rewrite for the sandbox changes only the scope that `WDS.connect` uses
  (literal or constant in the same script) and fails with a message when there is none. The mock server is killed on every exit path.
- **Docs.** integration.md: porting (inventory, mapping, the migration recipe with IndexedDB and localStorage, digest-guarded deletion in one transaction, oversize items as downloads, interrupted-run repair), collections, two devices,
  files, conflicts in code, lock and unlock again, wds-verify.json; the recipes run in Chromium, Firefox and WebKit against the real server (examples/docs-recipes.spec.mjs). operator.md: sandbox, abuse procedure.
- **Review round (two reviewers).** Fixed: invite expiry in the sandbox, lock snapshot deep copy, collection pump rejecting calls queued behind a failed write, the index write that fell back to `known`, stale meta winning on replay
  (version in entries), the refresh/write race, a batch continuing after a lock, recipe gaps (blocked delete and the again path, interrupted runs, localStorage, oversize, concurrency, injective ids, `created`), the sandbox rewrite of
  look-alike strings, the integration test that asked production, sandbox creation budget and eviction rule, missing publish files, mock teardown. Decisions: a full sandbox answers `403 vault_limit_reached` like every scope (docs corrected);
  vault sessions do not exist (the API is stateless), so nothing to delete there; the `access_ids` rows of purged sandbox vaults stay and the privacy page says so (the invariant "never reused" is kept).
- **Publication.** SECURITY.md, PUBLISH-MANIFEST.md and scripts/check-public.sh prepare a fresh-history public repository; the operator creates it and pushes. LICENSE and the security contact are open.

### Advisor review of the round D spec (decisions)

An advisor agent (Fable) reviewed the first spec; revision 2 adopted almost all of it. Decisions, in short:

1. Migration must not delete real data in the sandbox or in a shared vault: `status().sandbox`, migration only by the owner outside the
   sandbox, access ID in the confirmation, static WARN for unguarded deletion, the recipe is tested code.
2. Migration details: tag-prefixed ids (no collisions between browsers), size pre-check, `fresh` verification read, `onblocked` and
   named localStorage keys, oversize items offered as downloads, a `migration` record.
3. Pause/resume of autosave contradicted `onUnlock(start)`: handles are unique per name, a snapshot is taken before `onLock`, written
   after the next unlock of the same vault; handles stop on lock; registrations are idempotent.
4. Collections merge by operation replay on the last server base; no client clocks, no tombstones, no pruning.
5. Orphans and failures between item write and index write: ops stay queued and retry, rejects carry `stored/id/record`, 10 rounds with
   jitter, opportunistic reconcile on `list()`, `rebuild()` as explicit repair.
6. The sandbox ID must never ship in an app: static FAIL, never-write rule in llms.txt, prompt and snippet, `--sandbox-copy`, persistent bar.
7. App CSS must not be able to hide the sandbox label: label in titles and button texts, inline `!important`, verifier visibility FAIL, static CSS check.
8. Sandbox exhaustion and campus NAT: eviction of the oldest (min. age 30 min), small limits, per-prefix and global creation counters,
   refund on owner delete, "sandbox unavailable" exit 3, CLI wipe and `enabled` switch, invite cap 3 with expiry before the wipe.
9. No recovery in the sandbox (`409 sandbox_no_recovery`) and no separate escrow key set (one set of pins in the library); privacy page section.
10. Wipe semantics: purge `created < T`, `last_wipe` in the scope document, remembered access IDs older than the wipe are forgotten,
    per-vault transactions, marker in a new `meta` table.
11. Sandbox settings differ from the app's scope: wds-verify checks the app's real scope document (breach check against the CSP, limits printed).
12. `remove()` pauses handles during the request and stops them only on deleted/absent; "theirs" gives status `replaced` + `onReplaced`.
13. Collection ergonomics: `items()`/`has()` throw before `load()`, last options win, throwing handlers fall through to the dialog.
14. Public repository from a fresh history with a publication manifest and `scripts/check-public.sh`; the operator pushes; LICENSE is the operator's choice.
15. Prompt and snippet wording: "add this section, keep existing content", AGENTS.md too, the escrow sentence, settings via wds-verify, dated values.
16. Index size and write cost: guidance (a few thousand items, small meta), 10 s meta debounce, meta limit 512 bytes, warning at 256 KB.
    Rejected: a server-side history limit for index records (the server cannot see names).
17. Reload check FAIL rule, `data-wds-verify="save"` for the app's own buttons, `--target auto` with the reason in the first report line.
18. Simplifications: no `cancel()`/`downloadBoth()` on the conflict object, overlapping prefixes refused instead of a longest-prefix rule,
    no tombstones, no `--no-reload`, no array form of `wds-verify.json`; Node floor >= 22.
19. Coverage gaps closed: the static-only path without Python, cost figures, user-guide lines, a "Not tested" section in the report.

### Visual review (Chromium, Firefox, WebKit; dashboard in Chromium and Firefox)

Local server with a `[sandbox]` section, `dev_login` and an operator account; bundle built with freshly generated escrow pins. Dashboard (de/en,
1200 and 390 px), library dialogs in the sandbox (390 px, de/en) and zeit-notizen against the local server (join code, breach check on: two
contexts adding projects at the same moment kept all of them, the conflict dialog for the same note, lock and unlock, reload) all worked;
no page errors, no CSP violations. Fixed during the review:

- `server/wds_server/prompt.py`: prompt and snippet were hard-wrapped mid-sentence; each sentence or bullet is now one line. Wording "into this app".
- `client/src/wds-ui.js`: the fixed sandbox bar covered the app's header; the library now adds the bar height to the inline `padding-top` of
  `<html>` and restores it at lock. The sandbox create view and the faculty-key hint of the share dialog no longer promise a recovery. The invite
  expiry option reads "Until tonight ({time})" / "Bis heute Nacht ({time})". Bundle rebuilt (SRI `sha384-Tt3myi/ElC73CNHNBs1JXq4mcvhKLGq684YrG8XBay1ZT4FgaWZUx/UtFBFeBrfT`),
  example app and tool test apps updated.

Second review round (minor findings fixed): zeit-notizen starts in the browser language and clears its toast on lock; in a sandbox the library names the
page (`document.title`) next to the scope name in the "App:" line, the access sheet and the key file name; the page gets `--wds-sandbox-bar` (bar height) while the
bar is shown; the sandbox scope page shows one line instead of the Admins section; the dashboard prompt prints whole numbers without decimals and the breach line
as "an (… bleibt in connect-src)"; `.wds-code` no longer wraps (horizontal scroll, smaller font on narrow screens). Bundle rebuilt (SRI `sha384-EKOlMMIEnDNee/2BRzXKP7d5U5ECJfzkJTuQ0FFdy+9+U0XnS6RQ7qFm5jdTKH/I`).

Remaining issues (all minor, not fixed in this round):

- zeit-notizen sets German at start (`setLocale('de')`), so an English browser sees German library dialogs before unlock, contrary to
  integration.md section 4; either start from `navigator.language` (and change `app.spec.mjs`) or document the example as German-only.
- A `position: sticky` / `fixed` app header still slides under the 27 px sandbox bar when scrolled; a CSS custom property
  (`--wds-sandbox-bar`) for the bar height could help.
- Sandbox dialogs show the shared scope name ("WIAI Datastore sandbox") as the app; the person cannot see which app is under test. Proposal:
  show `document.title` or an `appName` option next to it.
- The operator's sandbox scope page shows an Admins section that contradicts itself ("creator always stays listed" / "No admins listed",
  creator `config:sandbox`); hide it or replace it with one line about the `[sandbox]` configuration.
- zeit-notizen keeps its own toast visible for a few seconds after lock; clear `#toast` in `onLock`.
- German prompt: "10,0 MiB" instead of "10 MiB", and the breach line has two colons in a row.
- The recovery code wraps inside its field on the access sheet at 1100 px (WebKit); `.wds-code` could get `white-space: nowrap`.
- The dashboard was not checked visually in WebKit (it does not store the `__Host-` cookie on http, documented in server/README.md).

### Publication prep (architect)

- README.md rewritten as the public landing page: what the service is, the security model in brief, documents, tests, how to verify the served
  library hash, license line ("to be decided").
- Internal infrastructure details removed from tracked files: this log now names roles (the reverse proxy, the login.psi host, the
  configuration management, the operator's workstation) instead of host names, addresses, VM numbers, backup job names and local paths.
  `deploy/deploy.sh` and `deploy/loginpsi-register.sh` take their hosts from `WDS_HOST` / `LOGINPSI_HOST` / `LOGINPSI_SETTINGS` (SSH key
  optional in `WDS_SSH_KEY`) and stop with a clear message when one is unset; the login.psi script is now in English. operator.md says
  "workstation" instead of naming the operator's computer.
- PLAN.md brought in line with the code: status, library API (§8.1, `getMany`, `remove()` result, autosave statuses, lock snapshots,
  `onUnlock`, `setLocale`, collections), conflict handler chain (§8.2), stable attributes and sandbox labels (§8.5), wds-verify targets,
  locale, reload and scope checks (§9), the dashboard prompt and CLAUDE.md / AGENTS.md section (§10), `[sandbox]`, migration 4, `hashes.json`,
  CLI (§11), documentation (§13), processes (§14), work packages and open points (§15, §16). PROTOCOL.md already covered the scope document
  field `sandbox`, `/client/hashes.json`, the sandbox rate limits and error codes.
- `git grep` for the internal address range, the internal domains and host names and home-directory paths finds nothing in tracked files; `scripts/check-public.sh` (untracked,
  excluded from the publication because it names the strings it searches for) is clean on the publication set.

### Deferred

- `wds-verify --role read` (testing an app as a read-only member).
- A Claude skill or plugin for the service.

### Test counts (final sequential run)

| Suite | Result |
|---|---|
| `scripts/test-server.sh` | 449 tests OK |
| `scripts/test-client.sh` | 119 node tests passed; 65 Playwright tests passed (Chromium) |
| `scripts/test-integration.sh` | 92 passed, 4 skipped (two engine-independent wds-verify checks of docs.spec run only in Chromium) in Chromium, Firefox, WebKit |
| `scripts/test-tools.sh` | 66 passed |
| `scripts/test-examples.sh` | 25 passed (Chromium) |

## Round D: deployment and publication (2026-11-25)

- After the workflow, a follow-up pass fixed the remaining minor findings of the visual review:
  - the example app's start language now follows the browser;
  - sandbox dialogs show the page title;
  - `--wds-sandbox-bar` is exposed;
  - the sandbox scope page no longer has an Admins section;
  - the toast is cleared on lock;
  - prompt number formatting;
  - recovery codes no longer wrap.

  All suites green: server 449, client 119 node + 65 Playwright, tools 66, integration 92 (4 skips), examples 26.
- **Licence:** MIT, chosen by the operator; `LICENSE` added and `client/package.json` updated. hash-wasm (vendored) is MIT as well.
- **Security contact:** `SECURITY.md` names GitHub private vulnerability reporting and the chair's public address.
- **Publication:** the whole tree is published, including this log, now that it is redacted, and `deploy/`, which takes its hosts
  from environment variables. Only `scripts/check-public.sh` and its test stay local, via `.git/info/exclude`, because they
  name the internal strings they search for. The publication manifest was dropped in favour of that rule. The history starts fresh
  with one root commit; the earlier private commit is not published.
- **Deployment:** first the code, then `[sandbox]` in the configuration management, because the old server would not know the
  section. Sandbox scope `sandbox-000000`, wiped at 03:30 Europe/Berlin, server defaults for its limits.
- **Production check:** `wds-verify --target sandbox` on examples/zeit-notizen against production passed (22 steps, vault
  created, no canary in requests or storage). The first run had failed with "service unreachable". It had started about four
  seconds after the configuration-management restart of the service, so it was a transient failure. The served
  `/client/hashes.json` equals `client/dist/hashes.json`.

## Round E: clean-room feedback

### Input

A Claude ported a local-only app ("Zeit & Notizen") in a clean-room container, with only the public documents (llms.txt,
integration.md) and the public repository. The ported app passed `wds-verify --target sandbox` against the public sandbox of the
production service: 26 checks passed, 0 failed, 2 warnings ("Library version released", "Data after reload" with 4 of 10 values,
because the tool looked only after the last `afterReload` step of a four-tab app). Its feedback, point by point:

| # | Feedback | Decision |
|---|---|---|
| 1 | The recipe assumes files as `ArrayBuffer`; the old app had `Blob`/`File`. `fingerprint()` took only size and type of a Blob, so a replaced attachment of the same size counted as unchanged; the backup replacer turned a Blob into `{}` | Recipe handles Blobs; the bytes of every Blob are part of the fingerprint; the backup handles Blobs |
| 2 | Settings in an IndexedDB key-value store: "read once" was not defined | `migratedSettings()`, `settingsDone()`, `fillGaps`; "applied" is state in the vault |
| 3 | Tagged ids contain `-`; the example's `labelOf` cut ids at `-` | Docs name `-` and `%` (selectors, attributes, hash routes, arithmetic); `labelOf` of the example takes the whole id |
| 4 | Is the tag needed for long random old ids? Duplicates vs. conflicts | Decision table in the recipe; `tagged: false` drops the tag from item ids only |
| 5 | Exact privacy sentence vs. the longer text of section 13; no German wording | One official sentence in English and German, word for word in prompt, CLAUDE.md section, llms.txt, integration.md, users.*.md and the example app |
| 6 | Testing the deletion path: may Claude ask for the join code? A test switch for the sandbox? | Prompt and Step 6 say: ask, pass it only through `WDS_JOIN_CODE`; `wds-verify --migration-delete` sets a test global that the recipe honours |
| W1 | wds-verify cannot test a migration | `seed` block in wds-verify.json |
| W2 | "Data after reload" sees only the last `afterReload` step | Union over the unlock view and every step |
| W3 | "Library version released" warns in every report | Now info |
| W4 | `collection.set`: upsert and `created` undocumented | Documented; `set` now takes `created` (library change) |
| – | The `data-wds` names had to be read from the source; Playwright from `tools/` reused | Table of views and controls in integration.md (a test compares it with wds-ui.js); `tools/lib/drive-library.mjs`; the Playwright of the clone may be used |
| – | The trial is not representative: the old app was the predecessor of the example, which the Claude copied | Open point in PLAN.md section 16: a trial with an app that does not derive from the example |

### Changes

- **wds-verify:** the `seed` block (`{ page, steps, keep? }`: an old local-only page whose data the migration must carry over) with the
  findings "Seed: the old app", "Seed: files of the old app", "Migration: old data visible", "Migration: old data only encrypted" and
  "Migration: old data deleted / kept in the sandbox"; `--migration-delete` sets `window.__WDS_MIGRATION_TEST__` (and `navigator.webdriver`)
  so that the deletion path runs in the sandbox; "Data after reload" looks after every `afterReload` step and takes the union; "Library
  version released" is information; a sandbox run no longer says "mock"; an info check "Privacy sentence" (page or README); `{canary}` in
  fill texts. `tools/lib/drive-library.mjs` drives the library's dialogs in other Playwright tests.
- **Library:** `collection.set(id, value, { meta, mime, created })`; `created` counts only for an entry the index does not have yet. Bundle
  rebuilt (not frozen), SRI `sha384-0chMIOOURpY8WD83X6US8o2hr2LtE5f9IAqz9OtBfXG3bDMeJa4dvx++OyqoEu0F`; the hash in
  examples/zeit-notizen/index.html and tools/test-apps follows it. Earlier entries of this log name earlier hashes.
- **Documents:** set versus add and `created`, set for a record the page has not read, the table of the library's dialogs, the migration
  recipe (Blobs, key-value stores, settings, tag decision table), the join code for a test vault, the `seed` block in "Writing
  wds-verify.json", the official privacy sentence in both languages (and for third languages: the English one). The recipe's
  `removeOldData(rows, st)` honours the test global.
- **Dashboard prompt:** the privacy sentence in both languages; a paragraph per enrollment mode on a test vault in the real scope
  (join code: ask, only through `WDS_JOIN_CODE`, never in a file or on a command line, tell the person when the test ran so that they delete
  the vault; open: create one; closed: none possible). The CLAUDE.md / AGENTS.md section carries the join-code bullet only for scopes with
  the enrollment "join code". The hint texts next to the prompt and the join code tell the staff member that Claude may ask for it.
- **Example app:** zeit-notizen is a new app, not a port, so it has no migration and no `seed` block. It uses the official privacy
  sentence, `labelOf` keeps whole ids, and its wds-verify.json has an `afterReload` step per tab. The migration chain (old app as `seed`,
  recipe, mock keeps nothing, sandbox keeps, `--migration-delete` deletes) is tested in examples/docs-recipes.spec.mjs with a small old
  app written by the test.

### Review of these changes and what was fixed

Reviewers went through the changes above. The library (client/src) did not change in this pass, so no rebuild: `node client/build.mjs`
gave a byte-identical dist and hashes.

- **Data after reload, autosaved values (major):** a value counts as expected back when the app showed it as text or **wrote it to the
  store** (the page instrumentation logs `set`, `autosave` and the collections' `add`, `set`, `autosave`). Before, a value that only sat in
  an autosaved field was dropped, so an editor that was never read back passed; a test with an autosaved textarea and a collection write
  that are never read back now gives warn, not pass.
- **afterReload fill that repeats a typed text (minor):** the step fails (the tool reads field values and would find its own text).
- **"Old data visible" (major):** only screens after the reload and unlock count; a prompt that names the old titles proved nothing. No
  record written: fail.
- **"Old data deleted" (major):** it only warned and only looked at places that held a canary. Now the whole old storage is snapshotted
  after the seed (every key, every store with rows); leftovers fail when the migration visibly ran and warn when it did not; `seed.keep` is
  the opt-out. A seed page with a file input and no `upload` step gets a warning.
- **Leak exemptions (minor):** seed values are exempt only in a JSON download and only in an old place that did not grow. Tests cover a
  text download (a leak) and the JSON backup (fine).
- **Test global (major/minor):** the recipe asks for `window.__WDS_MIGRATION_TEST__ === true && navigator.webdriver === true` (named access
  by an element id no longer counts, a person's browser never matches). Static fail when the app assigns it, dynamic fail when the page
  has it set although the run did not; wds-verify sets `navigator.webdriver` itself; the report names `--migration-delete` in a line at the
  top, and on the mock an info finding says that the flag has no effect.
- **Settings records on a rerun (critical):** they are snapshots that a rerun overwrites, outside the "differs means failed" rule.
- **Settings applied exactly once (critical):** the state is in the vault: the marker field `settings` is `pending`, `applied` or `none`;
  `migratedSettings()` takes no argument, `settingsDone(old)` is new. This closes the crash before the save and the stopped timer that came
  back. `fillGaps` must run before the app writes defaults, and `null` counts as a gap; both are documented.
- **`tagged: false` (major):** the tag is per browser in both modes and names the marker and the settings records; `tagged: false` only
  drops it from item ids. The tag stays in the old storage after the delete.
- **Blob fingerprint and the "again" shortcut (critical):** the bytes of every Blob are hashed before the transaction, a second reading is
  compared, and a cheap check runs inside the transaction. A start with a marker reads the copy back from the vault and compares it before
  it deletes. Tests cover a File and a plain Blob replaced with identical metadata but other bytes, and a copy that is gone from the vault.
- **`toNewRecords` silent traps (major):** it throws for rows with no Blob and no bytes and for Blob/Map/Set inside a value; a `Date` or an
  ISO string works for `created`, a Blob row value works, localStorage values stay strings. "Adapting toNewRecords" added to the docs.
- **`set` and `created` in the docs (major, twice):** the guide says `set(id, value, { meta, mime, created })`, applied only for a new index
  entry; test_docs.py checks it. Step 3 has a second import that keeps ids and rewrites references, tested including a second import.
- **Minor:** ids with `%` and `-`, the same-origin condition, the privacy sentence for third languages, `confirmSheet` throws a
  `DriveError` with the dialog text.
- **Join code (major):** one channel, the environment variable `WDS_JOIN_CODE`, read by drive-library, never printed, never in an error
  message. How the test vault is deleted is documented (the staff delete it in the dashboard; deleted vaults do not count against the vault
  limit). The prompt says the same in both languages without naming the dashboard.

### Rejected or only partly done

- **`--target scope` in wds-verify** (runs against a real scope with a join code): not done. An automated tool that writes canary data into
  a production scope with a real secret is what wds-verify avoids by design (mock and sandbox only). The environment variable and
  drive-library let the developer's own script make the test vault of Step 6.
- **Proof in the sandbox run that the visible values came from the vault:** not possible. The old data stays there, so a prompt that names
  the old titles, or a screen that lists the old storage, cannot be told from the copy. The pass text and the docs say so; the mock or
  `--migration-delete` run is the proof, and there a failed copy fails on "old data deleted".
- **A library call that deletes a vault:** the library has none; the docs name the dashboard instead of adding API.
- **A `migrationTest` option of `WDS.connect`** (the trial's suggestion): not done; the library does not know about migrations. The test
  global is set only by wds-verify, honoured only by the recipe, and only in an automated browser.
- **"Data after reload" when only some rounds come back:** stays a warning, not a failure (the existing semantics).

### Other changes the user may not expect

- The tag key stays in the old storage after the delete (it names the browser in the vault). Docs and tests say so.
- The wds-verify report in examples/zeit-notizen/README.md follows the new wording. Its run passes with 26 checks, 0 failed, 0 warnings
  (before round E: 25 passed, 2 warnings; the reload warning went with the `afterReload` step per tab, the version warning became information).

### Test counts (final sequential run)

| Suite | Result |
|---|---|
| `scripts/test-server.sh` | 453 tests OK |
| `scripts/test-client.sh` | 119 node tests passed; 66 Playwright tests passed (Chromium) |
| `scripts/test-tools.sh` | 86 passed |
| `scripts/test-integration.sh` | 92 passed, 4 skipped, in Chromium, Firefox, WebKit |
| `scripts/test-examples.sh` | 36 passed (Chromium) |

Nothing committed.

## Round F: library dialogs in the top layer, store.migrateLocal, porting.md, a dashboard for lay staff

### Input

The clean-room port of the "Literaturliste" (IndexedDB with auto-increment ids, PDFs as Blobs, a reference that points to its PDF, a localStorage settings key), built with only llms.txt, integration.md and the public repository. Its feedback, with the maintainer's three wishes for this round
(a library helper for the migration instead of the 200-line recipe; a dashboard whose jargon lay faculty staff understand or that explains it; a simple default in the dashboard and an expert view for the advanced options).

| # | Feedback / wish | Decision |
|---|---|---|
| 1 | A modal `<dialog>` of the app (opened with `showModal()`) blocked the library's conflict dialog: the page hung | The library's dialogs are modal `<dialog>` elements in the top layer; toasts and the sandbox bar are popovers hosted inside the topmost modal; a library dialog is put on top again when an app modal opens later; lock closes every library dialog (LIB). Docs: "The library's dialogs and your own modal dialogs", checklist for forms (porting.md, section 7) |
| 2 | The recipe needs adapting in more places than its comment says; texts fixed in English; reference in the other direction; no word on dead references; no five-liner for the download dialog | `store.migrateLocal({ id, indexedDB, localStorage, tagged, map, texts })`: the library owns the dialogs (German and English), the ids (`h.id`, `h.ref` returns null for a dead reference), the safety logic; porting.md has two complete examples (the Literaturliste shape with references both ways and files, and zeit-notizen) |
| 3 | The 200-line recipe | Gone from every document. `from` on every entry and `h.skip` (every old row is accounted for or nothing is deleted), the marker is the proof (a start with the marker never compares the vault again), map runs twice and must be identical, backup is a ZIP with the files, "differs" and "too large" are questions with answers, a second tab gets `busy`, members are `skipped` with a backup button, no `applySettings` (settings are filled by the library with `WDS.fillGaps`) |
| 4 | `collection.get(id, { fresh })` undocumented | Added to the library and documented (integration.md, method list) |
| 5 | A one-language app and `setLocale` | Every app calls `store.setLocale` once right after `WDS.connect` (a one-language app with its language), integration.md section 4 and llms.txt rule 3 say so; the example app of section 14 does it |
| 6 | The join code: an environment variable does not survive an agent's tool call and counts as a command line | The code is read from a file that the person creates in their own terminal (`~/.wds/join-code`, `WDS_JOIN_CODE_FILE`); checks on the file; the agent never reads it; the real-scope test is optional; Windows with Notepad (porting.md, "The join code for tests"; tools/README.md) |
| 7 | May an own test set `__WDS_MIGRATION_TEST__`? | Yes, in the developer's own automated browser (`context.addInitScript`); never in the app; the library honours it only with `navigator.webdriver === true` and only in a sandbox, with one console warning |
| 8 | MiB in prompt and dashboard, MB in the docs | MB everywhere (1 MB = 1,048,576 bytes), said once in the documents; the Argon2id memory keeps its binary name |
| 9 | Popup blocker after `await getBlob` | The window is opened inside the click and filled later, with a download link as fallback (integration.md "Files", porting.md checklist; both blocks are tested to be identical) |
| 10 | wds-verify: restored search filter, which field is "neither shown nor written", the "Deleting local data" heuristic, flaky dialog handling, the order of a seed run | TOOLS (see tools/README.md); the order of the seed run is copied into porting.md and a test checks the order of its six steps; `afterReload` reset of a restored filter is in "Writing wds-verify.json" |
| 11 | `porting.md` as its own file; a checklist for form apps | docs/site/porting.md (served at /docs/porting and /docs/porting.md, linked from llms.txt and integration.md; section 16 of integration.md is a pointer); checklist with six points plus the popup block |
| 12 | Dashboard: jargon, default and expert view | SERVER: glossary (app ID, vault, join code, breach check, checksum, faculty recovery key, pause, activity log), a default create form (name, contact, description) and a default scope page with next steps, usage and help; a folded expert view with a cookie `wds_expert`; the operator sees the expert area open. DOCS: integration.md section 1 describes it, users.*.md use the same words |

### Changes by area (DOCS)

- docs/site/porting.md (new): sections 1 to 7, the options and `map` reference, the ids and the tag decision table, the two examples, the result table (what the app does), what the person sees, the safety rules, the seed run in order, the test global, the join code file, the test vault, the checklist for forms.
- docs/site/integration.md: section 1 for the new dashboard; the breach-check sentence at the top, in section 13 and in llms.txt; section 3 wording (checksum); `migrateLocal`, `collection.get(id, { fresh })`, one language per screen, units; a subsection on the library's dialogs and own modal dialogs; the popup block; the table of dialogs with `migrate`, `migrate-differs`, `migrate-large`, readiness (`aria-busy`) and the toast key `migration`; section 12 (restored filters, named fields, the seed block, the test global); section 16 shrunk to a pointer. llms.txt rule 7 and the page list; users.de.md and users.en.md (app ID, checksum, the breach-check sentence, "Data from an earlier version"); operator.md and PLAN.md/PROTOCOL.md in MB; PLAN.md describes the dialogs, the migration, the dashboard and porting.md; export.html says checksum.
- examples/zeit-notizen: `old/index.html` (the local-only predecessor), the migration through `store.migrateLocal` (the block between two marker comments is the one of porting.md, a test compares them), a `seed` block in wds-verify.json (the report in the README is a new run: 30 checks passed), the privacy text with the breach-check sentence, a Playwright case for the take-over (Chromium).
- examples/docs-recipes.spec.mjs: the hand-recipe cases are gone (LIB's migrate.spec.mjs has their safety properties); new: the Literaturliste block of porting.md against a seeded old database (real server: migrated and deleted, the question asked once, references both directions, a dead reference, settings that do not overwrite, a second start finds nothing; tagged false gives the ids of the import; the sandbox keeps and a rerun asks nothing; the test global deletes), the options block, the start function, the zeit-notizen block equals the app's, the seed block equals the example's, the popup block, the checklist block, the autosave block, the static findings of the Literaturliste block and of hand-made code, the migration of zeit-notizen under wds-verify (mock deletes, sandbox keeps, `--migration-delete` deletes), and a test that every code block of both documents is run or parsed and that a new block must be classified.
- server/tests/test_docs.py: porting.md served and linked, the privacy and breach-check sentences in every document (identical to prompt.py), the hand recipe words gone from docs/site, no MiB, section 16 is a pointer, users documents explain the old data question.

### Deviations from the design (DOCS)

- The design asked for `applySettings`, `h.ending`, `h.tag` and `h.fail` only; the library has no `applySettings` and no `h.ending`/`h.tag` (critique 4, 10), `from` is required (critique 1). porting.md and the examples follow the library, not the design text.
- The zeit-notizen example builds the ending of a file id itself (nothing refers to a file's id); the Literaturliste block uses the fixed ending `.pdf` on both sides.
- porting.md's headings are numbered only for its seven main sections; references in the other documents name the heading ("The join code for tests").
- A popover fallback for old engines (critique 32) is not implemented by LIB; the documents give the minimum browsers.

### Test counts (DOCS, sequential)

| Suite | Result |
|---|---|
| `scripts/test-server.sh` | 491 tests OK |
| `scripts/test-examples.sh` | 37 passed (Chromium); the porting, popup, checklist, dialog-above-modal and block cases of docs-recipes.spec.mjs also in Firefox and WebKit (40 passed) |
| `scripts/check-public.sh` | clean |
| LIB (their report) | `scripts/test-client.sh`: 129 node tests and 80 Playwright cases (Chromium); `scripts/test-integration.sh`: 147 passed, 27 skipped (WebKit cannot keep Blobs in IndexedDB on file:// pages) in three engines |

Nothing committed.

## Round F, review fixes

Reviewers (code and visual review, advisor, a dogfood port that used only the docs) found 30-odd points. What changed, and what was rejected.

### Library (client/src/wds-ui.js)

- **`h.skip` no longer drops data silently.** Skipped rows are deleted with the old data, so the question now says so and "Take over" waits for a box (`migrate-skip-ack`) or the backup download; the zeit-notizen example copies an orphaned attachment with `note: null` and a timer of a deleted project without the project instead of skipping them. porting.md says that `h.skip` is for rows that are no user data.
- **`map` gets copies of the rows** (containers copied, Blobs and buffers shared) instead of frozen originals: a classic-mode `v.pdfId = h.ref(...)` now works and the old rows stay untouched.
- **`old.rows(name)` is `[]` for every configured store** whose database does not exist (it threw, so the app did not start for such users).
- **Only wrong options reject.** Every mistake that `map` or one user's data causes (a missing `from`, an id with a slash, a `created` that is no number, a damaged JSON key) is a `failed` result with the message in `console.error`: the page still starts.
- **Every notice that leaves the old data has a backup button**, and the result has a non-enumerable `downloadBackup()`; a member's notice is remembered as dismissed (`wds:migrate:<id>:member`); a backup that does not fit into a ZIP is saved as the data file plus every file (and the dialog says so); "Do not take over; delete the old data" (`discarded`, view `migrate-discard`); no question when only settings are left (`done.settings`).
- **Marker v2: per entry, what `map` made of it** (name to a short hash of value, meta, date, type), plus the fingerprints of skipped rows. A corrected `map` makes its entries new again; one localStorage key that holds many entries is compared per entry, so one added entry is one new entry (the "Entries that differ" dialog no longer shows what the person edited). A console warning names the marker when it is found in the sandbox.
- **Cost of a start.** The old storage is first only counted (`migrateAnyData`), then read after the unlock and the role check, and rows are compared by a cheap fingerprint (no file is read); the bytes of every file are compared once, right before the delete (`deepBytesEqual`), and every copy is checked byte for byte as before. The snapshot is taken after the unlock.
- **Layers.** Detection of an app dialog above a library dialog no longer tracks elements (a reused `<dialog>` was missed): a MutationObserver on the `open` attribute and a check of what is on top at the middle of the library dialog (`elementFromPoint`). The 400 ms timer runs only while a library dialog or an app modal is open.
- Message for two stores with the same keys corrected (`h.id(["notes", row.key])`).

### Tests

- migrate.spec.mjs: pages are served over `http://127.0.0.1` and WebKit runs in a persistent profile (an ephemeral one cannot keep Blobs): all 32 cases run in Chromium, Firefox and WebKit (before: every case that seeded an old IndexedDB was skipped in WebKit). New cases: sloppy-mode `map` that changes rows, a missing old database, `h.skip` confirmation, failed run with backup, a changed `map`, one localStorage key with many entries, discard, member dismissal.
- ui-layers.spec.mjs: a reused app dialog that is shown again above a library dialog. tools: static checks (comments masked, real sandbox guard, aliases, `objectStore().clear()`, storage next to `migrateLocal`, the breach sentence word for word), JSON downloads outside the library's dialog are leaks, a toast that covers a click, `h.skip` warning, `--script-tag` and `--scope-check off`. server: the lay texts, the anchors, the page script. examples: orphaned attachment and timer.

### Tools and dashboard

- wds-verify: `--script-tag` prints the complete tag with `onerror` (the text of docs.py, tested), `--hashes client/dist/hashes.json` for an unreleased build, "clone is newer than the service" instead of "outdated", `--scope-check off` for an unregistered scope, the CSP place named as in integration.md; a click covered by a library notice is retried after dismissing it and noted; the tool ticks `migrate-skip-ack` and warns (`migration-skipped-rows`).
- Dashboard: an intro on the home page (what an app and a vault are), the terms explained where they first appear (Tresor, Beitrittscode, Wiederherstellungscode), "Versionen" instead of "Fassungen", no terminal instructions in the lay view (one sentence: Claude may ask for help with an optional test), the help links say which documents are for Claude (English), mentions of the expert area are links (`#vaults`, `#limits`, `#enrollment`, `#admins`) and the page script opens the folded area for a hash link; the test vault is deleted by Claude itself (prompt) and the person deletes only the ID Claude names.
- Docs: porting.md (skip, copies, failed results, damaged values, corrected map, shared keys, seed steps that prove something, notices above dialogs, own notices in dialogs, return values, the join-code file), integration.md (placeholders in repo files, unreleased library, `--scope-check`), llms.txt, tools/README.md, client/README.md, PLAN.md.

### Rejected or deferred, with reasons

- **No library change for toasts over app dialogs.** The corner cannot be right for every app dialog; the tool now dismisses a covering notice and says so, and the docs name position, lifetime and the dismiss step.
- **No step kinds for lock, unlock or a second client** in wds-verify: each needs a rule for what the person sees mid-run; porting.md shows how to test them against a mock in an own Playwright test (`startMock`).
- **drive-library still insists on mode 600 for the join-code file**: the test is optional, the lay view no longer sends anyone to a terminal, and a looser mode would make the check meaningless; porting.md names the file and the fix command.
- **The popover fallback for older engines** stays deferred; the minimum browsers are documented (Chrome/Edge 114, Firefox 125, Safari 17).
- Reviewer proposals to keep per-key deletes for skipped rows: not possible with one transaction per store; the confirmation and the backup are the guard.

## Round F: second clean-room trial

### Input

A Claude in a clean-room container ported an unrelated local-only app, the "Literaturliste" (IndexedDB stores `refs` and `pdfs` with auto-increment ids, PDFs as Blobs, a reference that points from the entry to its PDF, a localStorage key for settings), with only the public documents and a clone of the public repository (library 1.0.0, commit 0e0b0fd). The port passed wds-verify against the production sandbox: 31 passed, 0 failed, 1 warning (the flaky "Test run notes: dialog handling failed" warning, which also appeared for examples/zeit-notizen); with `--migration-delete` 31 passed, 0 failed, 0 warnings. Its FEEDBACK.md:

- Missing, with consequences: (1) a modal `<dialog>` of the app blocked the library's conflict dialog, so the page hung (found only in its own test; wds-verify creates no conflicts); (2) the migration recipe needed adapting in more places than its comment said, with texts fixed in English; (3) a reference in the other direction (entry to PDF) needed a reverse map, an id ending computable from both sides and a null for a dead reference; (4) how `ui.offerDownload` should look without a background download; (5) whether `collection.get(id, opts)` has `fresh`; (6) the language of a one-language app; (7) a contradiction in the join-code rule (an environment variable does not survive an agent's tool call, so it ended up on a command line); (8) whether an own test may set `__WDS_MIGRATION_TEST__`; (9) MiB in the prompt and dashboard, MB in the documents; (10) the popup blocker after `await getBlob()`.
- Guesses around wds-verify: a restored search filter empties the list after the reload; the order of a seed run; "1 other typed value" without naming the field; the "Deleting local data" heuristic that looked only at the innermost function (a `forEach` callback); the truncated and flaky dialog-handling note (an unready unlock dialog after the reload, once a dialog without a view).
- Smaller wishes: section 16 as its own file; a library helper instead of the 200-line recipe; a checklist for form apps; a `redeemInvite` helper in drive-library.
- What worked: llms.txt as the entry, script tag and CSP to copy, the scope check, the migration recipe once adapted, `seed` plus `--migration-delete` in the sandbox, `data-wds` attributes with drive-library, the "Not tested" list, the error objects.

The maintainer's wishes for this round: (1) a library helper `store.migrateLocal` replacing the copy-paste recipe; (2) dashboard jargon that lay faculty staff understand, or that is explained in plain words; (3) a simple default in the dashboard (a standard variant for normal use, few choices) and an expert view with the advanced options. Only test vaults were to be used.

### Decisions

The table in "Round F: library dialogs in the top layer, …" above maps every point to its decision; in short:

- **Top layer.** Every library dialog is a modal `<dialog>` opened with `showModal()`; toasts and the sandbox bar are `popover="manual"` hosted in the topmost modal; a library dialog is lifted again when an app modal opens later (MutationObserver on `open` plus an `elementFromPoint` check while a dialog is open). porting.md section 7 tells apps to close their own modals in `onLock`.
- **`store.migrateLocal`** replaces the recipe in every document (PLAN.md §8.5): `from` on every entry or `h.skip`, `map` run twice, create-only copies read back byte for byte, a marker per run, deletion only after a final byte comparison, bilingual dialogs owned by the library, `tagged`, `busy`/`skipped`/`declined`/`discarded`/`failed`/`partial`/`migrated`, `downloadBackup()`.
- **porting.md** (section 16 of integration.md moved and rewritten, two complete examples incl. the Literaturliste shape, the seed order, the test global for own automated tests, the join-code file, the checklist for forms). `collection.get(id, { fresh })` documented; every app calls `setLocale` once (a one-language app with its language); the popup block (open the window inside the click).
- **Join code for tests** in a file the person creates in their own terminal (`~/.wds/join-code` or `WDS_JOIN_CODE_FILE`, mode 600, outside the repository); the agent never reads or prints it; the real-scope test is optional.
- **wds-verify**: unready dialogs wait instead of failing, `fillWhenReady`, longer call logs, covered clicks dismissed and noted, the unnamed field named, the enclosing named function for the delete heuristic, `--script-tag` with `onerror`, `--scope-check off`, `--hashes` for an unreleased build, `redeemInvite` in drive-library (PLAN.md §9).
- **Dashboard**: a default view (create form with name, contact, description and a sentence that names the standard variant: join code, breach check on, default limits; scope page with next steps, usage, help) and a folded expert view (cookie `wds_expert`, open for the operator, hash links open it); every term explained where it first appears (the glossary of PLAN.md §10); no terminal instructions in the lay view; MB everywhere (1 MB = 1,048,576 bytes).

### Closing review: what was not done, and why

Not committed. Fixed all the critical and major points plus the cheap minor ones. Reasons for what I did not do:

1. No library change for toasts covering app dialog buttons: no corner suits every dialog, so wds-verify dismisses a covering toast and notes it, and porting.md names the position, lifetime and the dismiss step.
2. No lock/unlock/conflict step kinds in wds-verify (each needs a rule for what the person sees mid-run); porting.md documents `startMock` for own Playwright tests.
3. drive-library keeps the mode-600 rule for the join-code file (looser would make the check meaningless); the lay view no longer sends anyone to a terminal, and porting.md names the real file (`join-code`, plain text) and the `chmod` fix.
4. The popover fallback for older engines stays deferred; minimum browsers (Chrome/Edge 114, Firefox 125, Safari 17) are documented.
5. Per-key deletion of the claimed rows only was not possible (one clear per store in one transaction); the confirmation box or backup download is the guard instead.

Design notes:

- The old SRI of three files was replaced by the new build hash (`client/dist/hashes.json`; the build is not frozen).
- File hashes are no longer computed at every start (a cheap fingerprint instead), but file bytes are compared once right before the delete, and copies are still verified byte for byte.
- The migration marker format changed (v2; nothing is released).
- Added the `discarded` status and `result.downloadBackup()`.
- The WebKit tests run in a persistent profile because an ephemeral context aborts Blob writes to IndexedDB.
- The dashboard test for the link that opens the folded area was verified in a real browser by script, not added to a suite (the server tests have no browser).
- PLAN.md now describes the top-layer dialogs (§8.5), `migrateLocal` (§8.5), the join-code file (§8.5, §10), the tests of the top layer and the migration (§8.6), the wds-verify changes and drive-library as a test API (§9), the default and expert view and the glossary (§10), the units (§10.1) and porting.md (§13).
- Scratchpad: the dogfood port, the advisor and review folders were deleted; the latest dashboard screenshots stay.

### Test counts (final sequential run)

| Suite | Result |
|---|---|
| `scripts/test-server.sh` | 497 tests OK |
| `scripts/test-client.sh` | 129 node tests, 81 Playwright cases passed (Chromium) |
| `scripts/test-tools.sh` | 109 passed |
| `scripts/test-integration.sh` | 191 passed, 4 skipped (Chromium, Firefox, WebKit) |
| `scripts/test-examples.sh` | 38 passed (Chromium) |
| `scripts/check-public.sh` | clean (162 files) |

Nothing committed.


## Round G: third clean-room trial

### Input

A Claude in a clean-room container ported the local-only "Literaturliste" again, from the public documents and a clone of the public repository only (library 1.0.0, wds-verify from commit bf3a5cc; no Python, so every dynamic run went against the production sandbox). Its port passed wds-verify in the sandbox with **31 passed, 0 failed, 0 warnings, both with and without `--migration-delete`**. The trial was **not representative**: porting.md Example 1 had exactly the Literaturliste's shape (same database name, stores and localStorage key, a result of round F), so the trial took over its `map` almost unchanged and passed the first `--migration-delete` run. Its own 20-step Playwright test (built on drive-library) once in four runs timed out in `unlock()` after `page.reload()` after 30 s, with an empty `data-wds-view` on the topmost library dialog.

What worked, by its account: `store.migrateLocal` (about 30 lines, no `indexedDB` or `localStorage` in the app; the `from` rule), the `seed` block (eight steps, "kept" and "deleted" both checked), drive-library as the base of its own tests, and the checklist of porting.md section 7 (it found a toast hidden under the app's modal and `+dataset.id` / `b.id - a.id` breaking on migrated ids).

Its friction points and what was done:

| # | Point | Decision |
|---|---|---|
| 1 | May a German app translate the `onerror` text? | Yes: the message may be in the app's language, the code stays (integration.md section 2, llms.txt rule 5). wds-verify: exact handler pass, translated message info, missing or other handler warn. |
| 2 | Example 1 keeps an old filter that section 2 advises against | Example 1 is now a cookbook whose `map` leaves out the search field; section 2 refers to it. |
| 3 | Does `mime` default to the Blob's type? | Yes; the `items` row of porting.md says what is stored without `mime` and that only the `mime` field is compared. |
| 4 | Write order for a new file plus its entry | A recipe "note with a new attachment" in integration.md (file first, then the entry, then the old file; the new file is removed only when the note is certainly not stored; no clean-up of "unreferenced" files), covered by `examples/docs-recipes.spec.mjs`. |
| 5 | Who gets the Share button? | Every role (integration.md checklist and section 8): for a member it is the access dialog. |
| 6 | A PDF in a new tab cannot be checked in headless Chromium | integration.md section 12 says so and what to check instead (a `text/plain` blob, or the popup's `download` event); porting.md section 7 points there. |
| 7 | The report's headings clash with the README | `wds-verify --heading-level <1-5>`; the dashboard prompt, CLAUDE.md snippet and llms.txt name `--heading-level 3`. |
| 8 | "Leave room at the bottom right of dialogs" is vague | The toast box is given in numbers that follow the CSS (and a test measures them). |
| 9 | What is lost without Python 3.13 (mock)? | integration.md lists what the mock checks and the sandbox cannot, and the reverse. |
| 10 | `--wds-sandbox-bar` is easy to miss | A line in the integration checklist and a bullet in section 4. |
| 11 | integration.md is too long for one read | llms.txt has an index of both guides with line ranges, computed by the server from the served text (`docs.py`, tested), so it cannot go stale. |

### The hang: what is known

The cause of the trial's hang is still not proven. The empty-view report was not reproduced. The most plausible cause is in drive-library: `formError` waited on a locator for a dialog that had just closed, and "page did not answer" was read as "no dialog". Both are fixed and have tests.

In detail: `formError(d)` called `innerText()` on a locator that matches nothing once the dialog has closed (after a successful unlock), which waits for Playwright's own limit (30 s in plain Playwright, none under `@playwright/test` without `actionTimeout`); and `describeDialog`/`viewOf` read "the page did not answer within 2 s" (Argon2id blocks the main thread) as "no dialog", so `unlock()` and `waitForSheet` could report success or failure too early. Both fit the trial's symptoms (a 30 s timeout, a dialog that is not there, the next runs pass). The library itself was hardened against the related failures found on the way (no request timeout, swallowed exceptions while a view was built), below.

### Decisions

- **Library.** Client option `timeout` (default `Client.defaultTimeout`, 30 s, 0 = none; one more second per 10 KB of an upload, three times as long for `createVault` and `redeemInvite`; `OfflineError`, code `timeout`; the answer's body counts). A write that got no answer is looked at before it is reported (`_landed`: the server holds that version with that commitment: saved), and a conflict whose "theirs" is the value just written is no conflict (not only for lock snapshots). A dialog is never without a view (`loading`, busy, while it is built); a dialog that cannot go on shows `error` with `retry` (a fixed sentence for exceptions, the detail goes to the console; after a second build failure `reload` takes its place); the history dialog is `loading` until its list is there; the access sheet has a plain fallback so that a failure after a successful create never re-enables the create form. A scope answer that arrives late no longer replaces the view that is shown (generation counter); a key file dropped on the dialog is taken only in an idle `unlock` view (never over the access sheet, a loading view or a form in flight); the sandbox re-check after a failed unlock no longer holds the error back (5 s limit, error shown first). `status()` says "locked" while an unlock is still running.
- **drive-library and wds-verify.** `describeDialog` tells "no dialog" (`null`) from "the page did not answer" (`{ unresponsive: true }`); `viewOf` turns the latter into `''` (not ready: wait), never `null`; `formError` is one `evaluate` with a 1 s limit; `unlock`, `waitForSheet` and `answerMigration` accept "closed" only from a look that was answered, and read the view again before they throw; timeout messages name the time that really passed. `dialogSummary` names view, `aria-busy`, classes and text. wds-verify uses the same functions, presses `retry` in an `error` view (three times at most; a dialog that stays there is a failure, `dialog-error`) and notes the dialog state when it is not ready for 20 s. `onerror` that is exactly the documented handler now has a `pass` row.
- **Tests for it.** `client/test/dialog-stress.spec.mjs` (16 rounds with a seed; slow, failing and stalled requests; the watcher records more than one dialog, the longest time with no dialog while locked, the longest "loading" and the longest gap between ticks; a second test reloads and calls the drive `unlock()` as the trial's e2e did; a third drops a key file on a loading view, the access sheet and a form in flight; a fourth breaks the build of the form), `client/test/request-timeout.test.mjs` (timeout, body that never arrives, answer lost after the server stored a write), `tools/test/drive-library.test.mjs` (a main thread blocked for 3 s during a submit; `formError` of a closed dialog returns at once). The window hook `__WDS_TIMEOUT_TEST__` is gone: the stress page sets `WDSCore.Client.defaultTimeout`, a plain static that does not depend on `navigator.webdriver`.
- **Docs.** porting.md Example 1 is now a cookbook (string keys, nested photos array, references both ways, the search field is not migrated) and no longer the Literaturliste's shape; Example 2 is the reverse-reference example. The onerror text may be translated (wds-verify: info, a missing or other handler: warn). `mime` of `migrateLocal` items, a recipe for a note with a new attachment, Share for every role, mock versus sandbox, `--heading-level`, the toast box and `--wds-sandbox-bar` are documented. llms.txt gets an index of both guides that the server computes from the served text, so line ranges cannot go stale.
- **Note with a new attachment (recipe).** The review found that the catch of `saveNoteWithFile` removed the new file after an `OfflineError` or an `err.stored`, although the note may then be stored and name that file; and that "files no note names can be removed" invites a clean-up that deletes live files (a file is unreferenced between step 1 and step 2, a stale list makes live files look unreferenced, history needs old files). Now the new file is removed only when the note is certainly not stored; the clean-up advice is replaced by "do not write one"; the limits of the recipe (stale form, "mine", history restore) are stated; `examples/docs-recipes.spec.mjs` covers a quota failure, an `OfflineError`, a lost index write (`err.stored`) and a lost answer. The toast box numbers follow the CSS (below 36rem: window width minus 1rem, .5rem from the edges; measured in the test), the `mime` row says that only the `mime` field is compared, the client README example is the Cookbook shape, and llms.txt no longer carries hard-coded line counts (a test checks the section numbers of its reading advice).
- **Layout shift in the create form.** Found by the integration suite under load (Firefox, about 4 in 100 runs): the strength label appears 120 ms after typing and pushed the "Create vault" button 31 px down between mouse down and mouse up, so the click went to the fieldset. `.wds-strength` now keeps the height of one line while empty.
- **Stalls during the test runs.** In the first sequential run of this round (the Mac had just been restarted, Spotlight was re-indexing with load averages above 20) several unrelated tests stalled for a minute or more: a page timer gap of 83 s in the stress test, a create-vault click, a wds-verify settle of 60 s, an unlock in a docs-recipes test. None reproduced: the stress test passed five times in a row on Chromium (seeds 96878, 101, 202, 303 and a random one, longest tick gap 140 ms) and every suite passed in the two runs after the load was gone. The gap assertion (15 s) stays; it fails on a machine that stops a page for that long, which is what it is for.

### Rejected or limited, with reasons

- **Progress-based timeout for uploads:** fetch gives no upload progress. The budget is 1 s per 10 KB and the 80 kbit/s assumption is documented (core header, error table).
- **Time spent in the browser's connection queue still counts against the 30 s timeout.** That is far above what six connections and a concurrency of 16 need.
- **Clamp or build constant for the test hook:** the hook is gone. The stress page sets the plain static `WDSCore.Client.defaultTimeout` instead.
- **Argon2id still blocks the main thread.** A worker would need `worker-src` in the CSP.
- No `timeout` option on `connect()`.

### PLAN.md

Updated to the system as it now is: the clean-room trials and what is pending (status), the translatable `onerror` message (§8, §9), the client timeout and the never-viewless dialogs (§8.1), the new test files (§8.6), the round G drive-library behaviour and `--heading-level` (§9), the llms.txt index (§13), porting.md's two examples (§13), work package 8 (§15), and in §16 the unrepresentative trials and the unproven hang.

### Test counts (final sequential run)

| Suite | Result |
|---|---|
| `scripts/test-server.sh` | 501 tests OK |
| `scripts/test-client.sh` | 136 node tests, 81 Playwright cases passed (Chromium) |
| `scripts/test-tools.sh` | 113 passed |
| `scripts/test-integration.sh` | 203 passed, 4 skipped (Chromium, Firefox, WebKit) |
| `scripts/test-examples.sh` | 41 passed (Chromium) |
| `scripts/check-public.sh` | clean (164 files) |
| `wds-verify examples/zeit-notizen/index.html --target mock --hashes client/dist/hashes.json` | 32 passed, 0 failed, 0 warnings (without `--hashes` the published hash of the service is expected: the build is not released) |

One library SRI everywhere: `sha384-fmN0nQDEY+C5dimjydhbS0WkgIoFDxgwHjlNS9Iqm8+CoVz/5o+GXDEl6HDRFsdp` (`client/dist`, `tools/test-apps/{good,bad}`, `examples/zeit-notizen/index.html`; the docs use the `{{sri}}` placeholder).

### Next

A fourth clean-room trial with an app unrelated to `examples/zeit-notizen` and to both porting examples, so that the documents, not a copied example, carry the port.

Nothing committed. The two new test files, `client/test/dialog-stress.spec.mjs` and `client/test/request-timeout.test.mjs`, are still untracked.

## Round H: fourth clean-room trial, simplification

### Input

A Claude ported a local-only equipment inventory app (IndexedDB with composite keys, a localStorage JSON, photos, a JSON backup, modal dialogs) in a clean-room container from the public documents only (llms.txt, integration.md, porting.md, library 1.0.0 and wds-verify at commit 93781d8). It is the first trial with an app unrelated to `examples/zeit-notizen` and to both porting examples. Its port passed wds-verify with 31 passed, 0 failed, 0 warnings, including `--migration-delete`.

What worked, by its feedback: the section map of llms.txt; `store.migrateLocal` (the `from` rule, `h.ref` with array keys); the script tag, CSP and wds-verify as printed; porting.md section 7 (its own toast hidden under its own modal); drive-library for its own conflict, invite and lock tests.

Theme of the round (the owner's concern): the library and the documents may be over-engineered. The round fixes real bugs and makes things smaller and simpler: no new recipe, feature or option. The security properties stay: E2EE, revocation and rekey, escrow recovery, conflict detection, "every old row is claimed" in `migrateLocal`, create-only writes with read-back, a backup before any delete.

### The feedback points and what became of them

1. *Settings after "Not now"* (an app that autosaves a whole settings object blocks the old values, which are deleted at the next take-over anyway): the cause, the `settings` kind with its fill-only-gaps rule, is gone (the settings rule below). porting.md says what happens after `declined`, `partial` and `failed` and to write a record only when the person changed it.
2. *Settings in shared vaults* (one member's theme, filter and search text applied to everyone; a read member could store no preference): the settings rule below.
3. *Thumbnails in lists*, 4. *replace-all import*, 6. *unique keys across devices*: one sentence each, no recipe (porting.md: the mapping row "A unique index", the write-new-then-remove order of an import that replaces everything).
5. *The ZIP of `exportAll` cannot be imported*: said in integration.md section 9 and porting.md section 3.
7. *A reload of an item that is open in a form disables the conflict dialog*: its own point in the porting.md section 7 checklist; integration.md points there.
8. *Member with old data*: the owner imports a member's old export only if the old import adds and does not replace.
9. *Rate limit of the sandbox*: the limits come from the server (`{{sandbox_creation}}`), and the text says to wait, at most an hour.
10. *The invite role did not stick* (bug a below).
11. *`createVault` and `unlock` time out when the migration dialog follows* (bug b below).
12. *"Nothing to copy but settings asks nothing"* is moot: there is no `settings` kind.
13. *Length and repetition*: porting.md from 527 to 353 lines, integration.md from 829 to 760.

### The two bugs

- **(a) The share dialog reset the invite form.** A deferred `maintain()` re-render (the roster refresh after opening) rebuilt the dialog, so a role chosen right after opening came back as `write`. Fix: the role and the label live in `st` and survive every redraw (flash, revoke-back, error retry too); the refresh redraws only when the roster, the recovery request or the pending rekey changed, never while the focus is in a form of the dialog or a form is in flight (`st.submitting`), and otherwise only clears `aria-busy`, which is the readiness signal for tests. The test holds the roster request back (`server.gate` in fake-server.mjs) until after the input and asserts that value, focus and `aria-busy` survive.
- **(b) `createVault` and `unlock` of drive-library timed out when `migrateLocal` opened its question after the unlock.** Fix: both resolve with `next`, the view the dialog ended on (`"migrate"`, `"sheet"`, `null`, …); a look that finds no dialog is repeated once after a moment so that a dialog opening right after is not missed; `answerMigration` goes on from there. The single steps moved to `tools/lib/dialog-internals.mjs`; drive-library exports only the high-level functions.

### The settings rule

A personal preference chosen from a fixed list (theme, language, sort order, density, last tab) stays in that browser's localStorage under the app's own key; the app reads and writes it directly and never names it in `migrateLocal`. Typed view state (search text, free-text filters) lives in memory only. Anything a person typed or would miss on another device, and every value for everyone who shares the vault, is data: a record, written only when the person changed it. `settings` in the result of `map` is a `UsageError`; `WDS.fillGaps` is gone. A preference that the old app kept in IndexedDB or inside a data key is claimed with `h.skip` and reset. wds-verify fails `localStorage.setItem` with a value built by `JSON.stringify` or a template, or with a key under a prefix that `migrateLocal` names (data, not a preference); a plain string is no finding.

### What was cut, and why

- **migrateLocal:** `tagged` (ids are always `<tag>-<token>`), `texts` (40 overridable keys; the library words its own dialogs), the `settings` kind and `WDS.fillGaps` (a merge rule that silently drops old values), the discard path ("delete the old data without taking it over", `discarded`), the `migrate-differs` view with "keep vault"/"later" (an entry that exists with other content is written create-only as `<id>~<tag>-<hash>`, no dialog), `downloadBackup()` on the result and on `OfflineError` (the notices have the button), and the result fields `copied`, `total`, `tooLarge`, `differs`, `again`, `sandbox`: the result is `{ status, deleted?, copies?, why? }`. `migrate-large` has one ZIP download instead of one per entry, and deleting waits for that ZIP.
- **Store and handles:** `connect({ notify, watch })` (notices cannot be switched off), `getMany({ concurrency })` (fixed at 6), `col.add(value, { id })` (use `set`), `autosave({ onReplaced })` and `stopReason` (the `replaced` status went with them; `onResolved` covers it). The removed `id` and `onReplaced` throw a `UsageError` that names the replacement.
- **Share dialog:** the expiry choice of invites (2 days, in a sandbox until the nightly wipe; the core still takes `expiresIn` for `wds-recover`).
- **drive-library:** the exports `waitForView`, `enableMigrationDelete`, `newPassphrase` and the single steps (now internal in `dialog-internals.mjs`).
- **Docs:** porting.md Example 1 reduced to a forward reference, the options and result tables shortened to lists, one numbered list of what the person sees and four safety bullets, the join-code and test-vault subsections merged, "Without wds-verify" and "Without a clone" halved, the window.open recipe and the headless-PDF paragraph only once (integration.md section 6), integration.md section 16 two lines, the MB definition and the "theirs" advice in one place each.

### Further fixes found on the way

- **Copy name of migrateLocal.** The copy of an entry that exists with other content is `<id>~<tag>-<first 6 hex of the entry's hash>` (ids cut to 180 characters before it). The name can only hold that content, so a second change makes a second copy; the "unsettled" branch and `partial` with `why: "differs"` are gone. If the name holds other content anyway (a hash collision), the run fails and deletes nothing. Test: an entry that differs twice ends `migrated`.
- **Copies are reported.** `copies: [names]` in the result (only when there are some), a sticky toast when a record was copied, and porting.md says that a record copy is invisible to the app unless it reads `copies`. The copy of an item keeps its explicit meta. `migrate.done.copies` needs no plural.
- **wds-verify.** A failed download of the too-large files is the finding `migration-large` and ends the run instead of a click on the disabled delete button; the member count counts `.wds-person`.
- **Docs.** A prefix must not cover a key the app keeps writing; `seed.keep` is in porting.md; a member's notice comes at every start; the delete button of `migrate-large` waits for the built ZIP.

### Rejected or limited, with reasons

Proposals of the round's audits and of the trial:

- **auditF: collapse statuses into nothing | migrated | pending | failed with `why`.** Rejected: tests and wds-verify distinguish declined/partial/skipped/busy, and the rename saves no lines; the result is reduced to `{ status, deleted?, why? }` instead (auditO).
- **auditF: keep the migrate-differs view with "keep vault" and "later".** Rejected in favour of auditO's no-dialog rule (write the old version as `<id>~<tag>`): "keep vault" drops the old version from everything but an optional backup, and the view is the hardest part to apply and to test. With always-tagged ids the case is rare.
- **auditF: drop the skip-ack checkbox gate on "Take over".** Rejected: `h.skip` rows are deleted without a copy; the checkbox-or-backup confirmation is part of the migrateLocal safety core.
- **auditF: replace Example 2 with a pointer to examples/zeit-notizen.** Rejected: clean-room porters read only served docs, and Example 2 is the one complete tested map with records, `h.skip` and a reverse `h.ref`. Example 1 is shortened instead (auditO).
- **auditF: remove the real-scope join-code subsections and `joinCodeFile`/`readJoinCode`/`deleteVault` from drive-library.** Rejected: `server/wds_server/prompt.py` tells every porter to end real-scope tests with `deleteVault`, and the join-code rule (never read, print or ask for it) must stay unweakened; the three subsections are merged and shortened instead.
- **auditF: remove "Without wds-verify" and "Without a clone" from integration.md section 12.** Rejected: they are the only path for a porter without Node or a clone; shortened by half instead.
- **auditF: remove the window.open recipe and the headless-PDF paragraph entirely.** Partly rejected: kept once in integration.md section 6, porting.md points there in one line.
- **auditF: review the wds-verify options `--heading-level`, `--locale`, `--wait-ms`, `--hashes`, `--scope-check off`.** Not this round: no evidence they are unused, and each is one clause.
- **Keep search text in localStorage with the other personal UI state.** Rejected: search text is typed by the person, wds-verify types canaries into search fields and the leak search would (rightly) flag it in localStorage. Search text stays in memory only; only preferences chosen from a fixed list go to localStorage.
- **Keep the `settings` kind with `fillGaps` and add "write only changed settings" advice (feedback 1 as worded).** Rejected: it keeps a mechanism whose only purpose is a merge rule that silently drops old values; with personal preferences local and shared values as create-only records, the kind is not needed.
- **Feedback 3, 4 and 6 as recipes (thumbnail list, replace-all import, unique keys across devices).** Rejected per theme: one sentence each instead. Per-member settings (feedback 2) likewise: the settings rule answers it without a new place in the vault.
- **Dropping invite labels, the passphrase estimator, the top-layer handling, or anything in wds-core.js.** Rejected: labels are how an owner revokes the right person; the estimator guards weak passphrases when HIBP is off; top-layer handling prevents inert pages; the core carries the security properties.
- **Removing the deferred `maintain()` re-render entirely (auditO's subtraction fix for bug a).** Rejected as the only fix: other re-renders (flash, revoke-back, error retry) would still reset the form; values in `st` fix all of them, and `aria-busy` gives tests a readiness signal.

Items of the review of the round's implementation:

- **Enable the delete button of `migrate-large` after a backup too:** a second way to reach delete. The dead end (the ZIP cannot be built) is the safe direction, and it is documented.
- **A non-sticky toast or a remembered dismissal for members:** the remembered dismissal was removed on purpose; the behaviour is documented instead.
- **Moving the copy name's tail before the file ending:** more code for a cosmetic gain.
- **A node-identity assertion in the share test, as the reviewer proposed:** with the new design the dialog is not redrawn while the focus is in a form, so the test asserts that value, focus and `aria-busy` survive instead.
- **Re-rendering the share dialog while the person types, to keep the roster current:** the roster is fixed at the next opening; typing is never lost.

**A decision for the owner:** porting.md Example 2 still makes every migrating owner tick "1 entries not taken over" for the language row, because a preference in IndexedDB must be claimed. It is documented and the skip reason says so; removing the friction would need a library change (PLAN.md §16).

### Size (wc -l, at commit 93781d8 and after the round)

| File | Before | After |
|---|---|---|
| client/src/wds-core.js | 2039 | 2038 |
| client/src/wds-ui.js | 4442 | 4231 |
| docs/site/integration.md | 829 | 760 |
| docs/site/porting.md | 527 | 353 |
| tools/lib/*.mjs | 2604 (10 files) | 2575 (11 files) |
| **Total** | **10441** | **9957** |

The diff against the last commit: 47 files, about 1670 lines added and 2650 removed (tests and docs included). **Targets missed:** wds-ui.js 4231 against 4150, tools/lib 2575 against 2540. The late fixes (the content-addressed copy name, `result.copies`) added about as much as the last cuts (the `tt` wrapper, `leftFileName`, the unsettled branch, comment blocks in dialog-internals) removed; the move of the single steps to `dialog-internals.mjs` saved little by itself. Candidates for the next round: the "seen" storage of the share notice, the console hints of migrateLocal (`migrateInformed`), the backup ZIP converter, and the long finding texts of dynamic-checks.mjs.

### PLAN.md

Updated to the system as it now is: the round H trial in the status and the trials list (§15), §8.1 without `notify`, `watch`, `concurrency`, `id` of `add`, `onReplaced`, `stopReason` and `downloadBackup()`, §5.8 and §8.5 without the expiry choice, §8.5 `migrateLocal` without `tagged`, `texts`, `settings`, the discard path and `migrate-differs` (with the copy name and the reduced result), §8.6 the case count, §9 the drive-library exports with `next`, `dialog-internals.mjs`, the `setItem` check and `migration-large`, §13 porting.md, §14 Share without expiry, §16 the trial point replaced by the IndexedDB-preference friction.

### Test counts (final sequential run)

| Suite | Result |
|---|---|
| `scripts/test-server.sh` | 502 tests OK |
| `scripts/test-client.sh` | node tests OK, 82 Playwright cases passed (Chromium) |
| `scripts/test-tools.sh` | 114 passed |
| `scripts/test-integration.sh` | 191 passed, 4 skipped (Chromium, Firefox, WebKit) |
| `scripts/test-examples.sh` | 40 passed (Chromium) |
| `scripts/check-public.sh` | clean (165 files) |
| `wds-verify examples/zeit-notizen/index.html --target mock --hashes client/dist/hashes.json` | 32 passed, 0 failed, 0 warnings |

Library SRI unchanged by a rebuild: `sha384-zNTgKx5jm6ESzFb+xzoqPjMSbtWdS/DSbc5D/BBUIc4+J8zQViLK5TNk26/L3grZ` (client/dist, tools/test-apps/{good,bad}, examples/zeit-notizen/index.html).

### Next

Freeze library version 1.0.0 (`node client/build.mjs --freeze`) before the first app embeds its tag.

Nothing committed. `tools/lib/dialog-internals.mjs` is untracked.

## Round I: complexity reduction

### Principle

The owner asked for another creative, critical, adversarial pass: the datastore must be as simple as possible for the developer's Claude to use correctly, easy for the lay app developer to see through (what is stored where, who can read it, what happens on conflict, lock, share and migration), and client-app-agnostic. The principle: **a small, general core; edge cases and special cases go to the app's Claude**, which is an Opus-class model and adds them ad hoc in the app when an app needs them. What stays in the library is what an app cannot do safely itself: E2EE and key handling, the vault/membership/revocation/rekey protocol, escrow recovery, conflict detection (version checks), and the security-relevant dialogs (create vault, unlock, access sheet, share/revoke, recovery acknowledgement). Everything else was removed, shrunk, merged or moved into a docs recipe of a few lines. `wds-core.js` is untouched.

The round had two parts: the cut (advisors with a fresh, a minimal and a lay view proposed, a plan merged them) and a review of the result, whose findings were fixed in the same round.

### Public API, before and after

- **Before (round H, 26 names on the store plus 13 on a collection):** `connect({ scope, baseUrl, locale, label })`, `unlock`, `onLock`, `onUnlock`, `get(name, { fresh })`, `getMany`, `set`, `getRecord`, `getBlob`, `list`, `remove`, `autosave` (`onStatus, onError, onSaved, onResolved`; `status`, `error`), `collection` (`load, refresh, items, has, get, getAll, add, set, remove, autosave, flush, rebuild, onChange`), `onConflict` (global, prefix, name; `keepMine/keepTheirs/merge/ask`), `history`, `restore`, `showHistory`, `onStale`, `share`, `exportAll`, `lock`, `setLocale`, `status`, `isUnlocked`, `usage`, `migrateLocal` (with `h.id/ref/blob/created/skip`, `from`, copy names, result `{ status, deleted, copies, why }`).
- **After (14 names plus 8 on a collection):** `connect({ scope, baseUrl? })`, `unlock`, `status` (`{ unlocked, role, sandbox }`, and `<html data-wds-role>` while unlocked), `get` (a JSON value or a Blob), `set`, `remove`, `autosave(name, getState, { delayMs, onStatus })` -> `{ changed, flush, stop }`, `collection(prefix, { meta })` -> `{ load, items, get, getAll, add, set, remove, autosave }`, `onChange(({ names, remote }) => …)`, `onConflict(c => 'mine' | 'theirs' | { merged } | undefined)`, `showHistory`, `openVault`, `lock`, `migrateLocal({ id, indexedDB, localStorage, map })` -> `{ status: nothing | declined | migrated | failed, why? }`.

### What was cut, merged or moved, and why

- **Lock = reload.** `store.lock()`, a revoked access and a cancelled or foreign re-unlock flush pending writes (up to 8 s), empty the page body and reload, so no vault data stays in the page. Offline, a dialog offers the backup and "Lock anyway". Gone: `onLock`/`onUnlock`, snapshots and their replay, the "same collection object" rule. Why: an app had to clear its own screen correctly, and the lay developer could not see whether it did; a reload is visibly complete.
- **One conflict handler, one change event.** `onConflict(fn)` with a plain return value instead of a global, prefix and name router with four methods (routing is an `if` on `c.name`); `onChange({ names, remote })` after own writes and after the focus check instead of `collection.onChange`, `refresh` and `onStale`. The default "newer versions elsewhere" notice is gone: the app cannot act on it, and the version check already prevents every overwrite.
- **One vault dialog for every role.** `store.openVault()` (members and invites for owners, own access, change passphrase, the access sheet again, "Export everything (ZIP, unencrypted)", "Lock now") replaces `share()`, `exportAll()` and the separate app buttons for them. Export stays as the way out, in that dialog and at `/export/`.
- **Fewer read methods.** `get` returns a JSON value or a Blob and always asks the server; `getMany`, `getRecord`, `getBlob`, `list`, `usage`, `isUnlocked`, `history`/`restore` (the dialog `showHistory` stays) are gone. Sorting, files next to items, drafts and reloading lists are recipes of a few lines in integration.md.
- **Collections** write the item first and queue the list entry; `created`, `rebuild`, `flush`, `has`, `refresh`, `collection.onChange`, `prefix`, `indexName` and `err.stored` are gone. A failed list write stays queued (next write, focus, online, before lock or unload) and is part of the backup; the export repairs orphans.
- **Notices are status lines** (6 s, `pointer-events: none`, no buttons); whatever needs an answer is a dialog. The toast re-parenting into the top layer, the 400 ms interval, sticky toasts and the full-width sandbox bar with its page shift are gone; the sandbox has a corner badge.
- **Language from `<html lang>`** instead of `connect({ locale })`, `setLocale` and `label`; dialogs name a record by the `title` of its list entry or "this entry".
- **migrateLocal, what end users see:** one question dialog with a "Download a copy of the old data first" link, an outcome line, or a failure dialog. Gone: the `h` helpers, `from`, the double map run, the marker record, copy names for differing targets (the normal conflict path decides), `migrate-large`, the skip-ack checkbox, the copies toast, the members' notice at every start, the data: URL conversion, the test global; 56 text keys became 15. `map(old, ref)` runs once per row with `old = { source, key, value, id }`. After the review (below) the take-over has two steps: the first start copies (create-only) and deletes nothing; the next start asks once "Is everything in the app?" and deletes only rows whose hash still matches. Unclaimed rows are never deleted; the sandbox never asks the second question.
- **Guides.** integration.md 760 to 346 lines, porting.md 353 to 106, llms.txt 75 to 41 (the only copy of the rules; the line-range index and the code in `docs.py` that built it are gone). prompt.py and the CLAUDE.md snippet say "read llms.txt and follow its rules".
- **Tools.** One documented use: `node tools/wds-verify.mjs app.html [--config wds-verify.json]` against the sandbox (the default target); everything else is internal (tools/README.md). Three check families (static, canary leak, data after reload with the seed migration step). `lock()` is checked as "the page reloads and shows no vault data before the unlock". `drive-library.mjs` is merged into `dialog-internals.mjs` (internal); `--migration-delete`, the test global, `migration-large` and about 15 migration finding ids are gone. The new `tools/lib/report.mjs` holds the report writer.
- **Real-scope test path** (an owner decision, taken in the review on the recommendation of two reviewers): `~/.wds/join-code`, `readJoinCode`, `joinCodeFile`, `deleteVault` and their tests, the test-vault paragraphs of prompt.py (both languages, every enrollment mode), `test_vault_hint`, the paragraphs in porting.md and tools/README.md. App developers test only in the sandbox. The closing step replaced the last remnant, the dashboard's `join_code_test_hint` ("Claude may ask you for help with an optional test"), by `join_code_claude_hint` ("Claude does not need the code: Claude tests in the sandbox. Never write the code into the conversation with Claude."). The CLAUDE.md snippet keeps one sentence: the join code is a secret of the staff, never in the app, the files or the chat; `createVault` of the internal drive code takes `joinCode` as an option.

### Fixed in the review of the round

- **Critical: a re-read moved the base of the next save.** The base of a save is now the version this page last read or wrote (a map `seen` in the UI layer). A read of a record whose autosave handle holds unsaved text does not move it, so a `getAll` in an `onChange` handler no longer turns the next autosave into a silent overwrite (reproduced in `ui-store.spec.mjs`; the guide's example has a two-device test in `docs-recipes.spec.mjs`). Button saves keep the documented rule: the library cannot tell a `getAll` for totals from a `get` that feeds a form; the rule is in the `get` row of integration.md and in porting.md section 2.
- **Autosave after "theirs"/"merged"** arrives only through `onChange({ names, remote: true })`; `info.value` and `info.resolution` are gone from `onStatus`. `set`/`remove` keep `resolution` and `value` in their results.
- **Lock = reload, Firefox:** the body is emptied before `location.reload()` (Firefox restored typed text into static fields; an integration case fails in Firefox without the line).
- **A cancelled re-unlock, or another vault,** ends like the lock button, with the backup offer when something is unsaved.
- **Notices that must not be missed:** an `IntegrityError`/rollback and a redeemed invitation are dialogs with one OK button (`data-wds-view="notice"`). Side effect: an owner sees one OK dialog per redeemed invitation after unlock; the zeit-notizen test helper dismisses it.
- **migrateLocal in two steps** (above). Reason: the likely loss is a `map` that forgets a field, and no read-back finds that; the person who has seen the app with the copy is the only check that does. Gone with it: the read-back compare, the `deleted` field, the sandbox hook and the shared done-marker (the marker is per scope and vault). Writes are create-only even after a `get`.
- **Minor:** a second `onChange`/`onConflict` handler is a `UsageError` (`null` removes the first); the test hooks are only in the test bundles (`build.mjs` option `testHooks`); wds-verify's default target is the sandbox; docs gaps and stale statements fixed; the import recipe adds only what is missing; two tests are back (two tabs run `migrateLocal` at once; the session ends during the copy) plus one for create-only after a `get`.
- **Found while closing:** `client/test/protocol-members.test.mjs` failed about one run in ten (3 of 30): it altered the last symbol of an invite code to `0`/`1`, which changes a data bit and the four check bits, so about 1 in 16 altered codes still passed the check and reached the server (`not_found` instead of `UsageError`). The test now flips only the lowest bit of the last symbol, a check bit (0 failures in 40 runs). `wds-core.js` is unchanged.

### Owner decisions still open, with recommendations

Not applied. The two that the library plan assumed (the migration's end-user view, the vault button) are applied and listed for the record.

1. **Key file** (a user-visible concept): remove the key-file download from the access sheet and the share/vault dialog, the drop zone and file chooser in unlock, `err.keyfile.*`, and the key file on the `/export/` page. **Recommendation: remove.** It contains no secret, duplicates the access ID, and is a sixth thing users have to tell apart. The condition is met: the unlock dialog already remembers the last access ID per scope on the device (`wds:<scope>:access_id` in `wds-core.js`, prefilled by the unlock view; a sandbox wipe forgets it).
2. **Breach check (HIBP):** (a) route it through the datastore server (`/api/.../pwned-range/<5 hex>`, cached and rate-limited, falling back to the strict local estimator when unavailable): one fixed CSP, no second privacy sentence, no scope-dependent branches; (b) remove HIBP and the toggle and always use the strict estimator; (c) keep it. **Recommendation: (a); (b) if outbound access from the server is unwanted.** Either removes the scope check "breach check on but host missing from connect-src", the dashboard toggle text and every conditional privacy paragraph.
3. **Real-scope test path:** applied in the review (above). Round H's reason for keeping it (prompt.py demands `deleteVault`) was circular.
4. **Prompt form:** make the dashboard's "Text für Claude" one nearly constant English text that is also the CLAUDE.md/AGENTS.md snippet (scope ID, "read <base>/llms.txt first and follow its rules", the privacy sentence, "run wds-verify"), and drop the German prompt variant (the dashboard explains its purpose in German). **Recommendation: yes.**
5. **Enrollment modes:** remove the choice join code / open / nobody and keep the join code only; to stop new vaults the admin rotates the code or the operator pauses the app. **Recommendation: yes.** An app meant for anyone publishes its code (the code protects storage, not data). The sandbox stays open.
6. **Recovery contact e-mail:** remove the optional field and the code-less 7-day recovery path; the recovery code with the 72 h wait is the only path. **Recommendation: remove** (fewer choices while creating a vault, no plaintext personal data on the server).
7. **Manual key renewal** ("Meine Schlüssel erneuern" in the vault dialog): remove; automatic renewal at redemption stays. **Recommendation: remove;** the understandable remedy is that the owner revokes and invites again.
8. **Conflict dialog "Download both":** remove the button, leaving "keep mine" / "keep theirs" plus the line "the other version stays in the history". **Recommendation: remove** (it produces an unencrypted file the user did not ask for; the history holds both versions). Also drop the users.md clause "Apps may show their own dialog".
9. **Wording:** rename the user's "Wiederherstellungscode" (for example "Notfallcode") so that it is clearly distinct from the faculty's "Wiederherstellungsschlüssel", which then appears only in the official privacy sentence, and use one identical escrow sentence in create, sheet and vault dialog. **Recommendation: yes,** as part of a test and doc sweep; the official privacy sentence stays unchanged.
10. **Dashboard expert knobs:** remove the editable limits table (the operator raises limits on request), the admin's self-pause (only the operator pauses, so "pausiert" means one thing), the slug field (always derived from the name), the "expert settings always open" cookie, and the vault-table columns "Neu verschlüsseln läuft noch" and "Personen mit Zugang". **Recommendation: yes to all except the limits table;** keep that read-only (values shown, no editing), since the prompt and wds-verify print the limits anyway.
11. **Migration, what end users see:** one question dialog (with the "download a copy first" link) and an outcome line, or a failure dialog; no migrate-large view, skip-ack checkbox, copies toast or members' notice at every start. **Recommendation: yes; applied** (the library plan assumed it; the review added the second start's deletion question).
12. **Vault button:** one `store.openVault()` dialog for every role instead of separate share and export entry points in each app. **Recommendation: yes; applied** (it changes where end users find export and lock).

Size effect of the open library items (estimate of the round): key file about 50 lines of wds-ui.js, breach check about 45, recovery contact about 25, manual key renewal about 14, "Download both" about 15.

### Rejected proposals, with reasons

- **A collection item as one row inside the index** (no per-item record): it would move item conflicts from per-record version checks into index merges, which needs a new per-row conflict rule; it uploads the whole index on every edit and pushes long bodies into a two-step recipe anyway. The current model stays, without its extras.
- **`set` on an unread existing record as a plain write:** breaks "never silently overwrite", which is on the must-stay list. The rule is in the `set` row of the API table; the remedy (get first) is one line.
- **A thin `importLocal({ copy })` without verification and a backup ZIP on every migration:** without a map the library cannot tell what was claimed, and an unencrypted ZIP would land in Downloads every time. The milder variant (delete the old keys that copy read) fails too: "read" does not mean "copied correctly". (The review then replaced the read-back by the person's confirmation at the second start, for the reason given above.)
- **"Skip means the row stays, nothing is deleted unless everything copied" over all rows:** adopted with a change: deletion is all-or-nothing over the rows the map claimed, unclaimed rows are never deleted; otherwise a single preference row would block every migration.
- **Round H's `~tag-hash` copy names for differing targets:** removed; the normal conflict path decides, so there is no second mechanism.
- **`store.privacyText()`:** an API for a fixed sentence. With HIBP proxied or removed there is one sentence per language, kept once in the docs.
- **`createInvite` in the drive code and a generic "invite a read member and click everything" scenario in wds-verify:** pre-builds tests for an edge case; the server already rejects writes by read members, and `data-wds-role` plus one CSS line hides the controls.
- **`col.remove` deleting files named in `meta.files`:** a new feature that encodes one app's data shape; the recipe "delete the file, then the item" is two lines.
- **`onConflict(prefix|name, fn)` without the global form:** the single global handler was chosen; routing is an `if` on `c.name`.
- **Language via `connect({ locale })` plus `setLocale`:** `<html lang>` removes the duty entirely.
- **Keeping the default "newer versions elsewhere" notice:** with `store.onChange` the app renders the change and the version check prevents overwrites; a notice the app cannot act on adds clutter and needs top-layer re-parenting.
- **Removing `col.autosave`:** editing an item would no longer keep its list meta (title) current, and every app would rebuild that; it keeps the signature of `store.autosave`.
- **`autosave(name, getState)` without the second-live-handle check:** with lock = reload, start runs once, so a second handle is a bug and is a visible `UsageError`.
- **Removing `exportAll` and the export page, or keeping them as separate app buttons:** neither; export stays as the way out, in one place (the vault dialog and `/export/`).
- **Merging integration.md and porting.md:** only ports need the migration part, and two pages of at most 350 and 150 lines each fit one Read.
- **Dropping `showHistory` and keeping only the history API:** the opposite was chosen; the dialog stays, `history()`/`restore()` go.
- **Any change to `wds-core.js`, invite labels, the passphrase estimator or the top-layer handling of dialogs:** these carry the security properties (round H's reasoning holds).

### Review items rejected or not done

- Dialogs for `note.suspended`, `note.readOnly`, `note.newDevice`, `note.rekey.failed`: nothing to decide, and a write that fails says so itself (`forbidden`, `quota`).
- A pinned base for button saves: needs the app's knowledge (see the critical fix).
- `onChange` for the `theirs` result of `set`/`remove`: the app is inside the call and holds the value.
- The collection test "merge with a clock a day ahead": the merge no longer compares clocks.
- A table-driven rewrite of the form driving and the findings of `dynamic-checks.mjs` (984 lines): a large change with a wide net of tests; not attempted.

**Unmet and stated plainly:** the two binding size targets of the round are missed. wds-ui.js is 3245 lines against 3000 (3222 after the cut; the review's base map, integrity dialog and second migration step added what the read-back and the hook removed). tools/lib is 2379 against 1700. What would move them: the open owner decisions on dialogs (about 150 lines of wds-ui.js together, still not quite 3000), and a rewrite of `dynamic-checks.mjs` and its tests.

### Size (wc -l, HEAD = commit e2664dd against now)

| File | Before (HEAD, round H) | After |
|---|---|---|
| client/src/wds-core.js | 2038 | 2038 |
| client/src/wds-ui.js | 4231 | 3245 |
| docs/site/llms.txt | 75 | 41 |
| docs/site/integration.md | 760 | 346 |
| docs/site/porting.md | 353 | 106 |
| docs/site/users.de.md | 100 | 94 |
| docs/site/users.en.md | 96 | 90 |
| tools/wds-verify.mjs | 291 | 210 |
| tools/README.md | 268 | 99 |
| client/README.md | 247 | 195 |
| server/wds_server/docs.py | 573 | 498 |
| server/wds_server/prompt.py | 170 | 128 |
| server/wds_server/dashboard.py | 1214 | 1212 |
| server/wds_server/texts.py | 286 | 285 |
| PLAN.md | 1154 | 1130 |
| tools/lib/*.mjs | 2575 (11 files) | 2379 (11 files) |
| tests (client/test, tools/test, server/tests, examples; .mjs and .py) | 20410 | 19242 |

The tracked diff against HEAD at the close: 62 files changed, 4751 insertions(+), 9490 deletions(-) (tests and docs included; untracked files not counted).

### PLAN.md

Describes the system as it now is: the status list at the top has one round I entry with the review's fixes, §8.1 the 14-name API, §8.5 the vault dialog, notices, `migrateLocal` in two steps and no real-scope test path, §9 wds-verify with the sandbox as default target and `dialog-internals.mjs`, §10 the join-code hint without a test, §16 the open owner decisions of this round and the listing cost without `list()`. Features that are open owner decisions (key file, breach check, recovery contact, enrollment modes, manual key renewal, "Download both", dashboard knobs) are still described, because they still exist.

### Test counts (final sequential run)

| Suite | Result |
|---|---|
| `scripts/test-server.sh` | 500 tests OK |
| `scripts/test-client.sh` | 131 node tests OK, 81 Playwright cases passed (Chromium) |
| `scripts/test-tools.sh` | 107 passed |
| `scripts/test-integration.sh` | 158 passed, 4 skipped (Chromium, Firefox, WebKit) |
| `scripts/test-examples.sh` | 29 passed (Chromium) |
| `scripts/check-public.sh` | clean (166 files) |
| `wds-verify examples/zeit-notizen/index.html --target mock --hashes client/dist/hashes.json` | 32 passed, 0 failed, 0 warnings |

The first pass of the client suite stopped at the flaky invite-code test (fixed above); server and client were run again after the fix and after the dashboard text change, the others were not affected by either. A rebuild left `client/dist/hashes.json` unchanged.

Library SRI: see `client/dist/hashes.json` (`tools/test-apps/{good,bad}` and `examples/zeit-notizen/index.html` carry it).

Nothing committed. Untracked: `tools/lib/report.mjs`, `tools/test/dialog-internals.test.mjs`.


## Round J: the owner decisions of round I applied

### Input

The owner answered the open items of round I: 1 yes, 2 route through our own server, 3 yes, 4 yes, 5 the counter-position (the recommendation to keep only the join code), 6 to 9 yes. Order: commit, apply the simplifications, have the whole result reviewed again, fix, roll out. A reviewer then confirmed that the construct holds (no security regression; every suite green) and found three major text errors, which are fixed below.

### Decisions as applied

- **D1 No key file.** Gone from the access sheet, the vault dialog, the unlock dialog (drop zone, file chooser, `err.keyfile.*`) and `/export/`. The unlock dialog still remembers the last access ID per scope on the device.
- **D2 Breach check through our server.** `GET <base>/api/v1/pwned/<5 uppercase hex>` (`wds_server/pwned.py`): the browser sends the first five characters of the SHA-1 of the passphrase; the server asks `api.pwnedpasswords.com/range/<prefix>` with `Add-Padding` on its behalf (fixed URL from `pwned_url` in the configuration, so no open proxy), checks every answer line, caps it at 2 MB, 4 s per socket operation and, since the review, 8 s in total. LRU cache of 500 entries for 24 h; at most 8 upstream requests at once; after a failure 503 with `Retry-After: 60` and no new attempt for a minute; a per-client rate limit; no access log and no prefix in any log line. The library calls it on the datastore origin (so `connect-src` is the datastore only) and falls back to its strict local estimator on a 503 or any error. Gone: the dashboard toggle, the scope setting, the conditional CSP host, the scope and static checks about the HIBP host, every conditional privacy sentence. The server works with outbound access blocked (tests with a mock upstream, the 503 path, a refusing and a closed port, the client fallback).
- **D3 Prompt.** The dashboard's "Text für Claude" is one nearly constant English text and also the CLAUDE.md/AGENTS.md section (scope ID, read `<base>/llms.txt` and follow its rules, the privacy sentence, the join-code rule, run wds-verify against the sandbox). The German variant is gone; the dashboard explains the purpose in German.
- **D4 Enrollment.** Only the join code. The modes open and nobody are gone (server, dashboard, texts, docs, tests). The sandbox stays open (derived from the scope, not stored).
- **D5 Recovery.** No contact e-mail and no code-less 7-day path. The emergency code with the 72 h wait is the only way back.
- **D6 No manual key renewal.** The `/renewal` endpoint and the button are gone; the renewal at the redemption of an invitation stays.
- **D7 Conflict dialog.** "Keep mine" and "Keep theirs" and one line that the other version stays in the history; "Download both" is gone.
- **D8 Wording.** "Notfallcode" / "emergency code" wherever a person sees it; "Wiederherstellungsschlüssel" only in the official privacy sentence; one escrow sentence (`escrow.text`) in the create dialog, the access sheet and the vault dialog. Internal identifiers keep their names.
- **D9 Dashboard.** No admin self-pause (only the operator pauses), no slug field, no `wds_expert` cookie and no `POST /prefs/expert`, no vault-table columns "re-encryption pending" and "people with access"; the limits are shown read-only (the operator changes them with `cli limits` or `PATCH /admin/scopes`).

### Migration 5 (what the operator must know)

`db.py` migration 5 drops `scopes.enrollment`, `scopes.hibp`, `scopes.suspended_by`, `vaults.recovery_contact` and `recoveries.method`, and closes pending contact-based recoveries (the code-less path) as `cancelled`. It runs at the next start of the server (`PRAGMA user_version` goes to 5); nothing else is needed. Production has only test vaults. The configuration gets `pwned_url` (default the Pwned Passwords range URL; empty switches the breach check off, every answer is 503, the library then checks locally) and `rate_pwned`. The server needs outbound HTTPS to `api.pwnedpasswords.com:443` for the check, but works without it.

### For the data protection officer (DPO): changed text

The privacy pages (German and English; `server/wds_server/privacy.py`, sections 3, 4, 6 and 9) and `users.de.md`/`users.en.md` have a new single wording for the breach check: the browser sends the first five characters of a checksum of the passphrase to the faculty server, which asks Pwned Passwords (USA) on the person's behalf; the service sees neither the passphrase nor the person's IP address. Please check:

1. Section 6: the recipient is now the server-side request to Cloudflare/HIBP without the user's IP address and without the prefix next to any address in a log. Is the third-country paragraph (EU-US Data Privacy Framework, Art. 45) still needed, and is the wording on the 24 h cache right?
2. Section 4 and section 9: the only recovery path is the emergency code with the 72 h wait; whoever loses passphrase and emergency code loses the data (the review corrected an old sentence that promised help from the operator).
3. Section 9: the contact e-mail address of the app (dashboard) stays; the optional recovery contact of a vault is gone, so the server no longer holds a personal e-mail address of end users.
4. `[privacy] updated` still says "draft, DPO review".

### Fixed in the review of the round

- The privacy page said that whoever loses access ID and emergency code gets the data back with the operator's help (a leftover of the code-less path); integration.md section 8 promised a new owner when the founder lost passphrase and emergency code. Both now say: with the emergency code and the 72 h procedure; without it the data is lost. A docs test checks the guide.
- integration.md, `get` row: the one exception to "do not `get` a record that a form shows" (the reload of an open item named with `remote: true` when nothing was typed, section 12).
- Dashboard defaults text: "Neue Apps: Tresore werden mit dem Beitrittscode angelegt" (no choice any more) and "Höchstens N Tresore (eingeladene Personen brauchen keinen eigenen)".
- `share.recovered.text` points to the vault dialog (Vault / Tresor), where the button is.
- users.de.md and users.en.md make the same claim about the history ("Apps können einen Verlauf früherer Versionen zeigen" / "Apps may show a history of earlier versions").
- PLAN.md and operator.md: limits are read-only on the dashboard; the Pwned Passwords fact is a server-side fact; the text for Claude has no breach-check sentence; the script tag is in integration.md.
- pwned.py: a total time limit of 8 s for an upstream answer (a slow sender held a slot and a thread longer than the library waits), with a test.

### Rejected or not done

- Nothing of the reviewer's list was rejected. The size targets of round I (wds-ui.js 3000, tools/lib 1700) are still not claimed; the decisions of this round removed the key file, the breach-check branches, the recovery contact, the manual renewal and "Download both" from wds-ui.js, but the line count was not re-measured as a goal.

### Operator notes for the rollout

1. Schema: the new server runs migration 5 at its first start (`PRAGMA user_version` 4 to 5). It drops `scopes.enrollment`, `scopes.hibp`, `scopes.suspended_by`, `vaults.recovery_contact` and `recoveries.method` and cancels pending code-less recoveries. Nothing to run by hand; an older server refuses the new schema, so there is no rollback without the database backup taken before the deployment.
2. Every existing scope now enrolls by join code only (the sandbox stays open). Scopes that were open or nobody need a join code from their admin (dashboard) or the operator (`cli` / `PATCH /admin/scopes`) before new people can create vaults.
3. Outbound HTTPS from the VM to `api.pwnedpasswords.com:443` must be allowed (firewall, proxy). Without it the endpoint answers 503 and the library checks passphrases locally only; nothing else breaks. `pwned_url` in `[server]` (empty = off) and `pwned`/`pwned_window` in `[ratelimit]` are new, optional settings; the defaults fit.
4. The service runs with the access log off; check that the reverse proxy does not log `/api/v1/pwned/` paths next to client addresses either.
5. Library: rebuilt, not frozen; deploy `client/dist` together with the server so that the served SRI matches `hashes.json`.

### Test counts (final sequential run)

| Suite | Result |
|---|---|
| `scripts/test-server.sh` | 512 tests OK |
| `scripts/test-client.sh` | 129 node tests OK, 81 Playwright cases passed (Chromium) |
| `scripts/test-tools.sh` | 105 passed |
| `scripts/test-integration.sh` | 161 passed, 4 skipped (Chromium, Firefox, WebKit) |
| `scripts/test-examples.sh` | 29 passed (Chromium) |
| `scripts/check-public.sh` | clean (167 files) |
| `wds-verify examples/zeit-notizen/index.html --target mock --hashes client/dist/hashes.json` | 32 passed, 0 failed, 0 warnings |

The library was rebuilt (not frozen) after the last text fix; SRI `sha384-LTA6dE8HFduJSNkQxykdLMoy9ny4WPHx+MoS3SlKGuihQS2LSyYzM+96F4Sswe2e` (client/dist, tools/test-apps/{good,bad}, examples/zeit-notizen/index.html).

### Closing step

The whole-construct review (Opus) found that the result holds: no security regression, every suite green; its three major findings (text errors on recovery) and eight minor ones were all applied (above). PLAN.md was brought up to the state after round J (the breach-check endpoint path and its 503 fallback in §3, `pwned_url` and the `pwned` rate limit in the configuration, migration 5 in the table list, no key-file case in the dialog stress test, the open points). All suites were run once more, one after the other; the counts above are from that run and did not change.

### Next

A fifth clean-room trial against the API of round J (the sandbox, `llms.txt` and the guides only), then freeze library version 1.0.0 (`node client/build.mjs --freeze`) before the first app embeds its tag.

Nothing committed or deployed.
