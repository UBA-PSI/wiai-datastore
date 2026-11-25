# WIAI Datastore: operator guide

For the person who runs the service (the operator). Design: PLAN.md, wire format: PROTOCOL.md, both in the repository. Public
address: {{base}}/. Public repository: {{repo_url}}. Server: one Python process on a virtual machine of the university behind its reverse proxy, SQLite database, no other services.

## 1. Places

| What | Where |
|---|---|
| Application | `/opt/wiai-datastore/app/` (`server/wds_server`, `client/dist`, `docs/site`) |
| Configuration | `/etc/wiai-datastore/config.ini` (written by the operator's configuration management) |
| Database | data disk, mounted at `/var/lib/wiai-datastore` |
| Local backups | backup disk, mounted at `/var/backups/wiai-datastore` (2 copies) |
| Health check | `{{base}}/healthz` answers `{"status":"ok","read_only":false}` |
| Operator token | on the operator's workstation in `~/.config/wiai-datastore/operator-token`; only its SHA-256 is in the config |

The server logs no requests (uvicorn access log off, Caddy `log_skip` for `/datastore/`); errors go to the journal.

## 2. Escrow keys

Every vault contains an escrow slot encrypted to the faculty's public escrow keys. Whoever holds the private keys can decrypt every
vault whose escrow slot names them. Two key sets exist: **current** and **spare**. Their key IDs are pinned in every library file
(build input `client/escrow-pins.json`) and in the server configuration. Pinned right now: `{{escrow_ids}}` (current, spare).

- Generate on an offline laptop, never on a server, one set per call:
  `node tools/wds-keygen.mjs --label current --out ~/wiai-datastore-escrow`, then `--label spare`. It writes
  `wds-escrow-<label>-private.json` (mode 0600) and `wds-escrow-<label>-public.json`. It refuses to overwrite files.
- **KeePassXC:** keep the private file of **current** as an attachment of an entry in your normal database and the private file of
  **spare** in a **separate database** on an offline medium (USB stick in a drawer). One leak must not take both. Back up both
  databases (two copies each, different places). Delete the private files from the laptop after importing.
- The public parts go into the server configuration (`[escrow]` with `current_e_pub`, `current_s_pub`, `spare_e_pub`, `spare_s_pub`) via
  the deployment configuration, and the two key IDs into `client/escrow-pins.json`.
- Use the private keys only for a recovery (section 3). Open the database, save the private file to a temporary directory on an
  encrypted volume or RAM disk, run the tool, then delete the file (`rm -P` is not reliable on SSDs; the point is that the file never
  lives in a synced or backed-up folder) and lock the database.
- Never put private keys into the repository, into chat, e-mail, tickets or onto a server.

## 3. Recovery of a vault

When a user has lost the passphrase. The founder's own recovery code or recovery contact starts it; **you** decide whether to
proceed. Check that the requester is who they claim (the person who runs the app can vouch; for a code-less recovery the stored
contact address is the proof) and write the reason down: every step is audited in the database (table `audit`).

1. **Collect:** the vault ID and either the 28-character recovery code or a request by the recovery contact. The vault ID is in the user's key file
   (field `vault`); from an access ID you find it on the server with
   `sqlite3 <database> "SELECT vault_id FROM slots WHERE access_id = '<20 characters without dashes>'"`.
2. **Start** with `wds-recover` on your laptop (never on the server). It reads the operator token from `~/.config/wiai-datastore/operator-token`
   (`--token-file`) and talks to `{{base}}` (`--base`):

   ```sh
   node tools/wds-recover.mjs start <vault-id>                  # asks for the recovery code (or: ... start <vault-id> - < code.txt); waiting period 72 hours
   node tools/wds-recover.mjs start <vault-id> --contact          # 7 days, only if the vault has a recovery contact; confirm the contact by mail yourself
   node tools/wds-recover.mjs status <vault-id>                   # vault, pending recovery, ready_at
   node tools/wds-recover.mjs cancel <vault-id>                   # cancel a pending recovery
   ```

   The recovery code is a credential: the tool asks for it on the terminal or reads it from stdin, because a code in the command line stays in the shell history and is visible in `ps`.
   The tool refuses a `--base` that is not https (localhost excepted), so the operator token never travels in clear text.
   A wrong code answers 403 and counts as a failure of the rate limiter. The same calls are `POST/DELETE {{api_url}}/admin/vaults/<vault>/recovery` and
   `GET {{api_url}}/admin/vaults/<vault>` with the operator token.
3. **Wait.** The founder sees the request at every unlock and can cancel it. Nothing is released before `ready_at`; `complete` exits with code 2 until then. A
   request the founder cancelled is over; start again only after talking to them.
4. **Complete** after the wait, still on your laptop. Open the KeePassXC entry, save `wds-escrow-current-private.json` (or the spare's, whichever the vault's escrow slot names) to a temporary
   file with mode 0600 and run:

   ```sh
   node tools/wds-recover.mjs complete <vault-id> --escrow-key /path/to/wds-escrow-current-private.json
   ```

   The tool fetches the escrow material and the roster with the operator token, checks the roster chain, opens the escrow keyring entry with the private key, builds a roster
   version that adds exactly one owner invite and changes nothing else, signs it with the escrow signing key, checks that the client library would accept it, asks for confirmation
   (`--yes` skips it, `--dry-run` stops before the upload), uploads it and prints the **invite code** of the new owner. The code is valid 72 hours unless you pass
   `--expires-in-hours n` (at most 359: the server counts 15 days on its own clock). Delete the temporary key file immediately. `node tools/wds-recover.mjs --help` lists everything.
5. **Hand the invite code** to the user over a channel different from the request. The user redeems it in the app, chooses a new passphrase and
   confirms the notice "recovered by the faculty". The old owner access stays until the user revokes it with Share.
6. **Record** date, vault ID, reason and the person in your own log. Remove the private key file.

A stolen access sheet cannot be used silently: the waiting period, the notice at each unlock and the escrow-signed entry in the signed roster chain
(clients show it) are the protection. Never shorten the waiting period.

## 4. Quotas and limits

Operator defaults and ceilings are in `[limits.defaults]` and `[limits.ceilings]` of the configuration; scope administrators set their scope's
limits on the dashboard within the ceilings.

| Limit | Default | Ceiling |
|---|---|---|
| `max_value_bytes` (plaintext value) | 10 MiB | 25 MiB |
| `vault_bytes` (including history) | 200 MiB | 1 GiB |
| `scope_bytes` | 2 GiB | 10 GiB |
| `max_vaults` per scope | 50 | 500 |
| `history_versions` per record | 10 | 50 |

- The sum of all scopes' byte limits must stay below 70 % of the data disk; the dashboard refuses limits beyond that. Grow the disk before
  raising ceilings.
- Every scope counts with its `scope_bytes` against that budget, suspended ones too, so one person could use it up by creating empty scopes. The dashboard therefore
  allows each person at most 5 active (not deleted) scopes; operators are exempt. If the budget is used up anyway, open the scope in the operator view and delete it
  (soft delete, as for its admins; the vaults are purged after 30 days).
- A scope that the operator suspended is locked: its admins can neither resume it nor change settings, limits, admins or delete it. If the admins suspended it themselves
  ("suspended by you or a co-admin"), the operator view offers "Take over the suspension", after which only the operator can resume it.
- The audit log (table `audit`, one year) also records `login` and `login_denied` (user ID only, no IP address) and, for `scope_updated`, what changed (the contact
  e-mail with its old and new value). Logins have no scope and show up in the operator's complete audit page only.
- Lowering `max_value_bytes` below a value that is stored is refused (`409 limit_below_stored_value`, with the smallest accepted value), so stored
  data never becomes unreadable.
- Rate limits (`[ratelimit]`): only failed authentication counts, 60 per IP per minute, 10 per access ID and IP per minute, 30 vault creations
  per IP per hour. Client IPs come from `X-Forwarded-For`, trusted from the reverse proxy only (`--forwarded-allow-ips`).
- Vaults without any record are purged after 7 days; deleted vaults after 30 days; the maintenance sweep runs inside the service every hour.

## 5. Read-only mode

At 85 % disk use (`read_only_threshold`) the server stops writes that grow data and answers `503 read_only`; `/healthz` reports
`"read_only": true` and the library shows a notice. Allowed: reads, exports, deletes, history purges, logins, dashboard and operations that do not grow data
(revocation, re-encryption, redeem, passphrase change, key renewal, recovery). Refused: vault creation, record writes, new invites.

To leave read-only mode free space (purge old vaults or histories, run `python -m wds_server.cli maintenance --db <database>`) or grow the data disk. The
state follows the disk figure; there is no switch. An alarm for the disk is part of the Ansible role.

## 6. Deploy

```sh
node client/build.mjs                  # client/dist/wds-<version>.js, .sri, hashes.json (version from client/package.json)
wiai-datastore-deploy                  # the operator's deployment script (not in this repository): server tests, upload of server, client/dist and docs/site, restart, health check
```

- Needs access to the VM (VPN or the university network) and the operator's management key. `--no-tests` skips the test suites (emergencies only).
- **Releasing a library version:** `node client/build.mjs --freeze` after the version has been tested. Frozen files are immutable: every app embeds their SRI hash.
  A change needs a new version number in `client/package.json`. Old versions stay in `client/dist` (and on the server) forever. `library_deprecated` in the
  configuration lists versions that should show the "outdated library" notice.
- The documentation and the export page read `docs/site` on every request and take the script tag and its hash from `client/dist/hashes.json`; a deploy is enough.
- After each deploy: open `{{base}}/`, `{{base}}/docs/integration` and `{{base}}/export/`, check the library hash on integration against `client/dist/hashes.json`.

## 7. Backups and restore

- The role installs a nightly `sqlite3 .backup` with an integrity check to the backup disk, keeping 2 copies. The VM itself is covered by the university's backup jobs.
- Backups contain what the database contains: ciphertext, signed rosters, wrapped keys, the audit log. A backup is as sensitive as the database.
  After a revocation or a deletion, old data stays readable to the old key holders in backups for the backup retention period; the privacy page states it.
- **Restore:** stop the service, copy the chosen backup over the database file, delete the `-wal` and `-shm` files next to it, set owner and mode as before, start the
  service, check `/healthz`. Clients notice a rollback of roster or records: apps that saw newer state refuse the older head (IntegrityError), so a restore is a last resort
  that you announce.

## 8. Incident: escrow key compromised

Suspect a key whenever the private file or the KeePassXC database may have leaked (lost laptop, unlocked session, malware). Assume the worst: the holder together with a copy
of the database (or control of the server) can read every vault whose escrow slot names that set, and with the **signing** key can add an owner to a vault.

1. **Contain.** Decide which set is affected. Set the scopes' enrollment to "closed" on the dashboard (or switch the service to read-only by lowering `read_only_threshold` temporarily)
   so no new vault is created under the compromised key. Review `audit` for recoveries you did not start.
2. **If current is affected, switch to the spare.** The spare is pinned in every library, so no app update is needed for the switch: in the configuration make the
   spare keys the `current_*` keys. Generate a **new** set with `wds-keygen` as the next spare, store it apart, and put it in `spare_*`. Roll out via Ansible.
3. **New library version.** In `client/escrow-pins.json` pin the two key IDs that are now current and spare and list the compromised ID as retired:
   `{"pins": ["<now current>", "<new spare>"], "retired": [{"id": "<compromised>", "until": <Unix seconds of now>}]}`. Bump the version, build, freeze, deploy,
   add the old versions to `library_deprecated` so that apps show the outdated-library notice. Apps that embed the old tag keep working until their authors update them.
4. **Migration of existing vaults** happens when an owner unlocks a vault with the new library: the escrow slot moves to the current set. Until then vaults still name the
   compromised key. Escrow-signed roster versions of a retired key count only up to `until`; a signature forged later with backdated time is refused on every device that has opened the
   vault since.
5. **Be honest about what migration does not do.** It moves the recovery slot; it does not change the content keys. Anyone who already holds the old private key and a
   copy of the ciphertext can still read what was stored up to now. Tell the scope administrators; for sensitive apps the owners should revoke access once (every revocation
   starts a new key epoch for later writes) or move to a fresh vault. Report the incident to the data protection officer.
6. If only the **spare** is affected: generate a new spare, update the configuration, publish a library version that pins current and the new spare (retire the old spare ID
   the same way).
7. An operator token leak is simpler: generate a new one with `python -m wds_server.cli operator-token`, put the new hash into the configuration, roll out, and check the audit log.

## 9. The public sandbox

A scope on the production service for testing apps end to end, so that no developer fills a real scope with test vaults. It is configured in the server configuration (Ansible writes it), not on the dashboard. The scope ID is **{{sandbox_scope}}**, the nightly wipe runs at {{sandbox_wipe}} (and finishes within the hour after),
the limits are {{sandbox_limits}}; the lines show "(no sandbox on this server)" and "-" on a server without a `[sandbox]` section. Developers and their Claude find it in llms.txt and use it through `wds-verify --target sandbox`; the library labels every dialog "Sandbox".

```ini
[sandbox]
scope_id = sandbox-000000          ; required; the presence of the section turns the sandbox on
enabled = true                     ; false: the scope stays, vault creation and invite redeeming answer 503 sandbox_disabled
name = WIAI Datastore sandbox
wipe_time = 03:30                  ; local time (timezone below) of the nightly wipe
timezone = Europe/Berlin
hibp = false                       ; breach check of passphrases (the verifier tolerates the missing one)
max_value_bytes = 524288
vault_bytes = 2097152
scope_bytes = 1073741824
max_vaults = 500
history_versions = 2
evict_min_age = 1800               ; seconds; a vault created or written to more recently than this is never evicted
create_per_ip = 20                 ; vault creations per IP bucket (IPv6 /56, see create_ipv6_prefix) in create_window, on top of [ratelimit] create
create_window = 3600
create_ipv6_prefix = 56            ; IPv6 clients count per prefix of this length (a home connection owns a /56)
create_global = 60                 ; vault creations of the whole sandbox per create_global_window; beyond it 503 sandbox_busy
create_global_window = 600
invite_slots = 3                   ; invites per vault (open plus redeemed)
```

- **The configuration owns the scope.** At start (and in `maintenance`) `ensure_sandbox` creates or updates the scope row from these values: status active, enrollment open without a join code, the limits, creator `config:sandbox`. A scope with the same ID that this section did not create stops the start with an error.
  Removing the section soft-deletes the scope. The dashboard shows the scope to operators read-only and never to staff; every change attempt, also through the operator API, is refused (`err_sandbox_config`, `403 sandbox_config`). Every limit must stay within the ceilings of `[limits.ceilings]`. The sum of `scope_bytes` counts against the 70 % disk budget (section 4).
- **Nightly wipe.** The maintenance sweep runs the wipe once the scheduled instant has passed (`sweep_interval`, default hourly, so up to an hour after `wipe_time`; DST-correct through the time zone): it purges every sandbox vault, soft-deleted ones included, that was **created before** that instant, one transaction per vault, then records the instant
  in the `meta` table (`sandbox_last_wipe`) and writes the audit entry `sandbox_wiped` with the count. Vaults created after the instant stay until the next night. Afterwards a bounded `incremental_vacuum` gives space back. `access_ids` rows stay (a random identifier of 20 characters per deleted vault, about 25 bytes; they say nothing about a person), so an access ID is never reused.
  The public scope document carries `sandbox: { enabled, wipe_at, timezone, next_wipe, last_wipe }` (`null` for every other scope); the library uses it to forget an access ID remembered before the last wipe.
- **When it is full or busy.** A vault creation or a write that would exceed `max_vaults` or `scope_bytes` purges the oldest vaults that were created and last written at least `evict_min_age` ago (audit `sandbox_evicted`); a vault somebody is writing to is never taken. If none qualifies the request answers 403 `vault_limit_reached`, like a normal scope (the verifier reports "sandbox unavailable").
  Creation is limited three ways: per IP bucket by `create_per_ip` per `create_window` (IPv6 clients by `create_ipv6_prefix`, default /56; 429 `rate_limited` with `Retry-After`), for the sandbox as a whole by `create_global` per `create_global_window` (503 `sandbox_busy` with `Retry-After`, so a burst never makes the sandbox evict everybody's vault), and by `[ratelimit] create`, which counts for every scope.
  A vault that its owner deletes within `create_window` gives its creation back to the first two counters, so a verifier run that cleans up after itself does not use up the budget. Behind a campus NAT or in a teaching room many people share one bucket: if developers report 429, raise `create_per_ip` (and `[ratelimit] create`). An owner who deletes a sandbox vault frees its space at once.
- **No recovery.** The recovery contact is accepted and discarded, the access sheet has no recovery code, and every recovery and escrow endpoint answers 409 `sandbox_no_recovery` for sandbox vaults. Technically the escrow key also applies (the sandbox uses the same pinned keys; there is no separate key set), but there is no recovery service for it and nothing in it is worth recovering.
- **Invites** are allowed so that read-only members can be tested: at most `invite_slots` per vault (409 `invite_limit`), expiring before the next wipe (the library's share dialog offers only "until the wipe" there, and says so when less than an hour is left; the server refuses a roster that outlives the wipe).
- **Switch it off** with `enabled = false` (503 `sandbox_disabled`, the scope document says `enabled: false`) or by removing the section, after an incident or abuse. `python -m wds_server.cli sandbox status --db <database> --config <config>` shows vaults, bytes, next and last wipe; `sandbox wipe` purges every sandbox vault now and sets the marker to now.
- **Abuse and logging.** There are no request logs. The audit log has `scope_created`, `sandbox_evicted` and `sandbox_wiped` rows without IP addresses; the IP bucket counters live in memory only. The privacy page has its own section "Testumgebung / The sandbox" (shown only when a sandbox is configured). Abuse (the sandbox used for real data, as free storage, or as a drop for files that are passed on) is limited by the nightly wipe, the quotas and the creation limits.
  **Procedure after a report:** set `enabled = false` and restart (503 `sandbox_disabled`, nothing can be created or redeemed), or run `python -m wds_server.cli sandbox wipe` (every sandbox vault is purged at once), and write down the date and the reason. The server never opens a sandbox vault: the recovery and escrow endpoints answer 409 `sandbox_no_recovery`, and the privacy page says that we do not open vaults. Content is encrypted; the answer to abuse is deleting, not reading.
  Switch it back on once the cause is dealt with (a lower `create_per_ip` or `create_global` for a while is the usual remedy).

## 10. The public repository

The source code, PROTOCOL.md, the documentation and the tools (wds-verify among them) are public at {{repo_url}}. The service serves the documents from `docs/site` of a deployed copy; llms.txt and the dashboard prompt point developers at the repository. A change in the repository does nothing to the running service until it is deployed (section 6). Never commit configuration, keys or tokens to it.
