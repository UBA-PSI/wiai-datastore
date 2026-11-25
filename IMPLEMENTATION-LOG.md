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
