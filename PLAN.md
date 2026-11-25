# WIAI Datastore – design

End-to-end encrypted key-value storage for single-file web apps built by non-experts at the WIAI faculty
(Otto-Friedrich-Universität Bamberg). Apps run from `file://`, from a localhost web server or inside Electron and
store their data on a faculty server that only ever receives ciphertext. One exception by design: whoever holds the
faculty's escrow private key can decrypt every vault (§2, §5.9).

This document describes the system as built: the decisions, the threat model and how the code implements them. Decisions
and changes made during the implementation are recorded, in order, in [`IMPLEMENTATION-LOG.md`](IMPLEMENTATION-LOG.md).

**Status.**

- *Designed and reviewed:* three adversarial review rounds (two of the design, one of the client) and a final review of
  the implementation, see "Review log".
- *Built and tested in the repository:* wire protocol (`PROTOCOL.md`); server (`server/wds_server`: data API, operator API,
  dashboard with login.psi, privacy page, documentation and export routes, maintenance sweeps); client library
  (`client/src`, bundle `client/dist/wds-1.0.0.js`, real escrow pins); tools `wds-keygen`, `wds-recover`, `wds-verify`;
  documentation and export page (`docs/site`); example app `examples/zeit-notizen` (time tracking and notes with
  attachments); infrastructure (§12). Test suites: `scripts/test-server.sh`,
  `scripts/test-client.sh`, `scripts/test-integration.sh` (Chromium, Firefox, WebKit), `scripts/test-tools.sh`,
  `scripts/test-examples.sh`.
- *Deployed* behind the university's reverse proxy (https://wiai.uni-bamberg.de/datastore/): the current state – data API, dashboard,
  privacy page (marked as draft until the data protection officer has reviewed it), `llms.txt`, documentation, export
  page and the reviewed library build (its hash equals `client/dist/hashes.json`). Demo scope
  `zeitnotizen-demo-xn8kp9` for the example app. The login.psi application is registered, its key is on the VM, and login.psi
  forwards dashboard logins to the university IdP.
- *Round D, deployed 2026-11-25:* the public sandbox scope `sandbox-000000` (§17), collections, per-name conflict handlers, `getMany`,
  the `remove()` result, autosave handles with lock snapshots, stable `data-wds` attributes on every library control, the
  dashboard prompt with the scope's settings and a CLAUDE.md / AGENTS.md section, wds-verify with sandbox target and locale-proof
  dialogs, and the documentation sections on porting, collections, conflicts in code, lock and unlock, and `wds-verify.json`.
  The rebuilt library has a new hash (1.0.0 is not frozen).
  `wds-verify --target sandbox` on the example app passes against production. The repository is public at
  https://github.com/UBA-PSI/wiai-datastore (MIT, fresh history). The first dashboard login with a university account works.
- *Pending:* a porting trial by a Claude without access to the repository checkout; escrow private keys
  into KeePassXC (current and spare apart) and deletion of the generated files; review of the privacy page by the data
  protection officer; freezing library version 1.0.0; a pilot with one real app; the open points in §16.

**Normative wire format:** [`PROTOCOL.md`](PROTOCOL.md) specifies encodings, key derivations, envelopes, roster,
HTTP endpoints and error codes exactly. Where this document and `PROTOCOL.md` differ on byte-level or HTTP details,
`PROTOCOL.md` wins.

---

## 1. Decisions

| Topic | Decision |
|---|---|
| Clients | Single-file HTML apps via `file://`, localhost, Electron. No File System Access API. |
| Address | `https://wiai.uni-bamberg.de/datastore/` (path on an existing host the operator controls; operator decision: no own subdomain, a later move would be handled then, §16). |
| Unlock | Access ID + own passphrase (min. 12 characters, strength estimate, HIBP Pwned Passwords check done by the browser directly, never via our backend). Argon2id in the browser. |
| Key loss | Faculty escrow, always on. Escrow key set (plus a spare set) only in the operator's KeePassXC. |
| Scope creation | Self-service on the dashboard (§10), login via login.psi. Allowed: everyone whose login.psi e-mail ends in `@uni-bamberg.de` and who has no matriculation number (= staff of all faculties; confirmed), at most 5 active scopes per person (operators exempt). Co-admins listed on a scope may log in and manage it. Operator can suspend scopes and block users. |
| App users | Key only, no Uni login. |
| Vault model | One vault per user inside an app scope; the owner shares the whole vault via invite codes with role `write` or `read`; one human owner per vault in v1 (plus escrow). |
| Revocation | Access ends immediately; then all data, **including history**, is re-encrypted under a new key (resumable). |
| Records | Values up to a few MB (default limit 10 MB plaintext); text/JSON and binary. |
| History | Server keeps the last N versions per record. |
| Offline | Online only, with "download backup" on failure. |
| Library | Loaded with a single `<script src=… integrity=… crossorigin>` tag (Subresource Integrity), immutable versioned URLs. |
| Verification | Server accepts only well-formed envelopes; static and dynamic checks via `wds-verify`, run by the developer's Claude. No gate at scope creation. |
| Quotas | Operator sets global limits and per-scope ceilings (Ansible); scope admins set their scope's limits within the ceilings (dashboard). |
| Stack | Python 3.13 with `python3-starlette` 0.46.1, `python3-uvicorn` 0.32.0 and `python3-nacl` 1.5.0 **from Debian 13 packages**, no pip, no other third-party package; SQLite; own VM; unattended security upgrades. Node only on developer machines (build, tests, tools). |
| Languages | Code, identifiers, developer docs: English. Dashboard, privacy page and end-user texts: German and English (German addresses users with "Sie"). |

## 2. Threat model

**Protected against**

- *Honest-but-curious operator, database or backup copies:* see ciphertext and metadata (2.1). Exception by design:
  whoever holds the escrow private key can decrypt every vault (§5.9). User-facing texts must state this exception;
  "the server only sees ciphertext" must never appear without it.
- *Malicious server answering requests* (compromised VM, proxy or host): cannot read data; cannot move blobs between
  vaults, names or versions; cannot add its own key to a vault's member list (signed roster, §5.6); cannot substitute
  the escrow key (pinned in the library); cannot serve a modified library (SRI). It can delete data, withhold updates,
  serve stale data to a client on a device that has not seen newer state, and run offline guessing attacks against
  passphrases (§5.2).
- *Revoked members:* lose server access at once and cannot decrypt anything written later. After the re-encryption
  finishes they also cannot decrypt a later database copy – except backups taken before it finished, for their
  retention period. They keep what they already downloaded. On a device that has never seen the newer roster, a
  colluding server could replay an old roster (§5.5).
- *Lay developer mistakes:* no unencrypted path exists in the library; the server rejects non-envelopes; `wds-verify`
  smoke-tests the app.

**Not protected against:** a malicious app (it sees plaintext), XSS or foreign scripts in an app, malware on the user's
device, weak passphrases that pass the checks, the escrow key holder, read members writing data if the server colludes
(read-only is enforced by the server only, §5.7).

### 2.1 What the server learns

Scope and app name; number of vaults per scope; number of records, padded sizes, write times and which records change
together; vault members as anonymous slots with roles, and per slot whether an invite was used or redeemed; the optional
recovery contact (an e-mail address in plaintext, given with consent). IP addresses are held in memory for the rate limiter's
window only; neither the server nor the reverse proxy writes a request log (§11, §12). Unauthenticated callers learn whether an access ID
exists. It does not learn record names, contents or the persons behind slots.

For the dashboard (staff, not app users) the server stores the login.psi user ID, name and e-mail address in a session
(idle timeout 2 h, absolute 12 h), co-admin entries of scopes, and audit entries naming the user ID (kept one year, no IP
addresses). The matriculation number from login.psi is checked and never stored.

## 3. Concepts

- **Operator** – faculty service owner: global settings, ceilings, escrow, recovery. Listed in the server
  configuration (`[dashboard] operators`).
- **Scope admin** – staff member who registers an app on the dashboard (role `creator`); may add up to 20 co-admins by
  Uni ID or e-mail address (role `admin`).
- **Scope** – one registered app, public ID `<slug>-<6 random chars>`; settings, quotas, enrollment mode.
- **Vault** – the encrypted data of one user and the people they share it with. Self-certifying ID (§5.6).
- **Slot** – one access path into a vault: kind (`passphrase`, `invite`, `escrow`), role (`owner`, `write`,
  `read`), public **access ID** (96 random bits plus 4 check bits, Crockford base32, shown as `XXXX-XXXX-XXXX-XXXX-XXXX`),
  own key pairs.
- **Record** – one encrypted value under an app-chosen name; the server only sees an HMAC-derived record ID.
- **Access sheet** – printable page created with the vault: scope, access ID, **recovery code**, escrow notice. Also
  offered as a small "key file" (JSON with scope and access ID, no secrets) to drag into the app on a new device.

## 4. Network and browser facts (tested)

- `file://` pages can `fetch()` HTTPS APIs and are secure contexts (`crypto.subtle` available). Verified by hand in
  Chrome 158 with a preflighted `PUT` (`Authorization`, `If-Match`, binary body; server saw `Origin: null`).
- Automated since then (`client/test/integration.spec.mjs`, `client/test/docs.spec.mjs`): `file://` pages in Playwright
  Chromium, Firefox and WebKit load the real bundle from disk and from the server's `/datastore/client/` with SRI, run
  preflighted requests, Argon2id (WebAssembly) under the recommended CSP, and the `onerror` fallback when the hash does not
  match. Not tested: real Safari, Edge, Electron.
- HIBP (`api.pwnedpasswords.com`) answers `Access-Control-Allow-Origin: *` and allows the `Add-Padding` header in
  its preflight (checked).
- Our server answers `Access-Control-Allow-Origin: *` (never `null`), no credentials; exposes `ETag, Retry-After,
  WDS-Commit`; preflight allows `Authorization, Content-Type, If-Match, If-None-Match, WDS-Commit` and `GET, PUT, POST,
  DELETE`; `Access-Control-Max-Age: 600`. The client script is served with `Access-Control-Allow-Origin: *` and
  `Cross-Origin-Resource-Policy: cross-origin` so SRI works cross-origin.
- CORS is not a security boundary here; tokens, signatures and encryption are.
- Chrome gives all `file://` pages one shared origin: anything an app stores in localStorage/IndexedDB is readable by
  every other local HTML file; Firefox and Safari do not keep `file://` storage reliably. The library stores only
  non-secret data there (§8.4) and never keys.
- The server has a public address and name, so Chrome's Local Network Access prompts do not apply.

## 5. Cryptography

WebCrypto only (AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256, ECDH and ECDSA on P-256, SHA-256), plus Argon2id from the
vendored hash-wasm 4.13.0 build inside the client library (§8.6). No home-made primitives.

### 5.1 Keys per vault

```
Per slot
  passphrase ─Argon2id(salt, params)─► KEK (32 B)
      ├ HKDF "wds1/slot-wrap" ► K_wrap   decrypts the slot's private keys
      └ HKDF "wds1/slot-auth" ► token    bearer token; server stores SHA-256(token)
  slot private keys (wrapped under K_wrap, stored on server):
      E_slot  ECDH P-256  – receives keyring entries
      S_slot  ECDSA P-256 – every slot: signs its own key renewals; owner/escrow: also roster versions
  the wrapped blob's AAD binds scope, vault ID, access ID, salt and Argon2 parameters

Per vault
  VMK_e   content key of epoch e (32 B random)  ─HKDF "wds1/record-enc"     ► K_enc    (AES-GCM for records)
                                                ─HKDF "wds1/check/vmk"      ► C_e      (roster commitment)
  NK      name key (32 B random, never rotated) ─HKDF "wds1/record-id"      ► K_id     (HMAC for record IDs)
                                                ─HKDF "wds1/history-commit" ► K_commit (history commitments, §5.5)
                                                ─HKDF "wds1/local-state"    ► K_state  (local rollback state, §5.5)
                                                ─HKDF "wds1/check/nk"       ► C_nk     (roster commitment)
  keyring entry per slot = ECIES(E_slot.pub, {VMK of all live epochs, NK}), AAD binds scope, vault, slot,
                           roster version and the recipient's E.pub
  roster = slots with public keys and roles + key commitments (§5.6), hash-chained, signed by an owner slot
```

ECIES here means: ephemeral P-256 key, ECDH, HKDF-SHA-256 (salt `eph.pub ‖ recipient.pub`, info `wds1/ecies`),
AES-256-GCM. Invite slots get the key that wraps their private keys (and their token) from HKDF over the random 17-byte
invite secret instead of Argon2id; escrow is a slot whose public keys are the
pinned faculty keys (§5.9).

Consequences:

- The wrapped private keys are only released after the token is presented, so knowing an access ID is not enough to
  download material for guessing. The server itself can guess offline (§5.2).
- Owners never hold other members' secrets. Revocation and invites only need members' **public** keys from the signed
  roster.
- The name key is not rotated, so record IDs, history and conflict detection survive revocations. A revoked member
  knowing name-to-ID mappings learns nothing useful: they have no server access any more.

### 5.2 Argon2id

- Parameters: m = 64 MiB, t = 3, p = 1, 32-byte output, 16-byte random salt per slot.
- The client accepts parameters only between its built-in floor (= defaults) and a ceiling (m ≤ 256 MiB, t ≤ 10).
- Salt, parameters and access ID are bound into the AAD of the slot's wrapped-key blob, so a server that hands out a
  different salt or weaker parameters produces a blob that does not decrypt. No trust-on-first-use state in the
  browser (localStorage on `file://` is shared with every local file in Chrome and not kept in Firefox/Safari).
- Passphrases are normalised to Unicode NFC before Argon2id. Target unlock time on faculty hardware: under 2 s. The
  defaults have not been measured on faculty hardware yet (§16); the dialog paints a "deriving your key" line first because
  Argon2id blocks the page for about a second. Because the floor equals the defaults, a later library can only raise them.
- Because the server can attack passphrases offline, passphrase quality is the main defence against a server
  compromise; the user guide says so.

### 5.3 Passphrase rules

- Own passphrase (decision): at least 12 characters, a refused list of very common German and English passwords, a
  guessing estimate (below 40 bits refused; below 48 bits refused as well when no breach check could be made) and a HIBP check. The exact rules are in §8.5.
- HIBP: SHA-1 of the passphrase, send the first 5 hex characters to `https://api.pwnedpasswords.com/range/<prefix>`
  with `Add-Padding: true`, compare suffixes locally; a hit blocks the passphrase. Only on submit, never while typing,
  8 s timeout. If HIBP is unreachable (or switched off for the scope), warn and apply the stricter local limit of 48 bits. The scope admin can switch the HIBP check off for a scope on the
  dashboard (scope flag `hibp`, on by default; privacy: HIBP is a US service and sees IP + prefix).
- Never through our backend: our server also holds salts and wrapped keys, and the 20-bit SHA-1 prefix would let it
  discard about 99.9999 % of guesses with a cheap hash before running Argon2id.

### 5.4 Envelope `WDS1`

```
offset  size  field
0       4     magic "WDS1"
4       1     type   0x01 record · 0x02 slot private keys · 0x03 keyring entry (ECIES) · 0x04 reserved
5       1     flags  must be 0
6       4     key epoch (uint32 BE; the record's epoch for 0x01, 0 for every other type)
10      …     0x01, 0x02: nonce (12) ‖ AES-256-GCM ciphertext and tag (n+16)
              0x03:       eph.pub (65, uncompressed P-256) ‖ nonce (12) ‖ ciphertext and tag (n+16)
```

- The 10 header bytes start every AAD, so magic, type, flags and epoch are authenticated (PROTOCOL 4.2).
- Type `0x04` is reserved: rosters are not envelopes but signed plaintext JSON (§5.6).
- Length bounds: records 38 bytes up to the scope's `max_envelope_bytes` for writes, and up to the ceiling bound of
  26 738 726 bytes for reads and rekey (so lowering a limit never makes stored data unreadable, §8.3); slot blobs 38–4096;
  keyring entries 103–16 384.

Record plaintext: `u32 header length ‖ JSON header ‖ body ‖ zero padding`. The header (at most 2048 bytes, sorted keys)
holds `n` (record name), `k` (`"json"` or `"bytes"`), `l` (body length), `t` (client time, Unix milliseconds) and,
for `bytes`, optionally `m` (MIME type). For `json` the body is UTF-8 JSON; for `bytes` it is the raw bytes (no base64).
Readers check the name, the lengths and that every padding byte is zero. Padmé padding (`padme(4 + header + body)`) keeps
size overhead at most about 12 %. Size limits are defined on the plaintext value; the server's byte limit is derived from
it: `max_envelope_bytes = padme(4 + 2048 + max_value_bytes) + 38`.

### 5.5 Associated data and rollback

Record AAD: the 10 header bytes (magic, type, flags, epoch) `‖ lp(scope_id) ‖ lp(vault_id) ‖ lp(record_id) ‖ lp(u32(version))`
(`lp` = 4-byte length prefix, PROTOCOL 4.2).

- A write with `If-Match: "7"` must create version 8, the client puts 8 into the AAD, and the server stores exactly 8.
  Version numbers per record ID are never reused: after a delete (tombstone) the counter continues.
- On every read the client checks that the server-reported version equals the AAD version (else `IntegrityError`).
- The client keeps rollback state per access ID in localStorage (`wds:<scope>:<access_id>:state`): the roster head hash
  and version, the highest epoch, and the highest version seen per record, MAC'd with `K_state` (derived from NK) so other
  local files cannot forge it. The
  MACed state names scope, vault, access ID and slot ID, so a blob copied from another member or vault is refused. The MAC
  is not a freshness proof: code that can write this origin's localStorage (on `file://` pages every local file shares one
  origin in Chrome) can put back an older genuine state of the same slot, which lowers the pin. §2 states this.
  Missing or invalid state counts as "new device" (visible notice). On a new device the protection starts from
  zero: a server that serves an old roster head plus old keyring entries could then make new writes readable by a
  member revoked after that head. §2 states this.
- Keyring entries bind vault, slot, roster version and epochs. The client uses a key from a keyring entry only if it
  matches the commitment for that epoch in the verified roster (§5.6); anyone can create an ECIES entry, so this check
  is what stops a forged entry. The client refuses an epoch lower than the highest it has seen.
- **History integrity:** with the write of each version the client sends an immutable commitment
  `HMAC(K_commit, lp(record_id) ‖ lp(u32(version)) ‖ lp(SHA-256(padded plaintext)))` (`K_commit` from NK) in the
  `WDS-Commit` header. The server stores it per version and never changes it, also not on rekey; readers verify it, and the
  owner's client verifies it again before re-encrypting a blob. Tombstones have no commitment.
  An owner or the server rewriting "version 3" during rekey is detected.
- `list` responses and 404s are not authenticated: the server can hide records. Accepted (§2).

### 5.6 Vault identity and signed roster

- On creation the founder's client generates the owner slot's `S` key pair; **vault ID = base32(SHA-256(S_owner.pub))[:26]**.
  The vault ID is also stored inside every slot's wrapped blob and printed on the access sheet and key file, so a client
  starting from an access ID learns the vault ID from authenticated data, not from the server.
- A roster version is `{"body": …, "sig": …}` with a canonical-JSON body (`type`, `v`, `scope`, `vault`, `version`,
  `prev` = hash of the previous body, `epoch`, `commit`, `slots`, `signer`, `time`); the roster hash is
  SHA-256 of the canonical body, the signature is ECDSA P-256 over it (PROTOCOL 6.1).
  Commitments: `C_e = HKDF(VMK_e, "wds1/check/vmk")` for every live epoch and `C_nk = HKDF(NK, "wds1/check/nk")`.
- Version 1 is signed by the founder key matching the vault ID. Every later version is signed by a slot that has role
  `owner` in the previous version: the founder, an owner the faculty added during a recovery (once it has redeemed its
  invite, it signs its own versions, for example to adopt its new keys or to revoke the founder, §5.7), or the escrow slot.
  Escrow-signed versions are accepted only through the operator's recovery completion and may only add one owner invite
  (§5.9). The server checks structure and allowed changes but never verifies signatures; clients verify the whole chain
  (rosters are small), with the rules of PROTOCOL 6.2/6.3 and a few stricter ones, and pin the head hash.
- `POST /vaults/{v}/roster` is compare-and-swap on the previous version's hash, so two owner sessions cannot fork it.
- Growth is bounded: at most 64 slots and 64 KiB per version; per vault at most 1000 ordinary versions, and *protective*
  versions (removing a slot, dropping an epoch, adopting a renewal, switching escrow) up to 1100; the bytes of all versions
  are capped at 16 MiB and count toward the vault and scope quotas, but protective versions are never refused for quota.
- Server and clients reject a roster without a slot for the pinned escrow keys. The content of the escrow keyring entry
  cannot be verified by anyone except the escrow holder; documented.
- The roster lists, per slot: slot ID, kind (`passphrase`, `invite`, `escrow`), role, `E.pub`, `S.pub` and the invite
  expiry (`expires`, `null` for other kinds). Access IDs are deliberately **not** in the roster, so members cannot see
  each other's access IDs; the binding access ID → slot comes from the slot's own wrapped blob (AAD and plaintext). The
  server's view of each slot (used, redeemed, expired, pending renewal) comes unsigned next to the roster.
- When an owner encrypts new keyring entries (invite, revocation, re-encryption), it uses public keys only from the
  verified roster. The server therefore cannot slip in a key of its own.

### 5.7 Roles

- `owner` (founder, escrow, and an owner added by the faculty during a recovery): everything, including signing rosters, inviting, revoking, deleting the vault.
- `write`: read and write records. `read`: read records.
- Read-only is enforced by the server (token → slot → role). A read member holds the content key and could produce
  valid ciphertext if the server colluded; documented as a limitation.
- v1 has exactly one human owner (the founder) plus escrow. Invites are `write` or `read` only. This avoids
  owner-versus-owner attacks (an invited owner evicting the founder). Owner transfer happens only via recovery (§5.9),
  which is the only way a second human owner appears.
- **Who may revoke an owner slot** (decision, resolves the conflict with §5.9 step 4): an owner may revoke an owner slot that
  the faculty added (the clients derive "added by escrow" from the signed chain, §5.9), and an owner that the faculty added
  may revoke any other owner slot, so a user who recovers after losing a device can cut off the old credential and a founder
  can evict an owner they did not expect. Nobody can revoke the escrow slot or their own slot, and two owners that were
  never added by escrow do not exist. Revoking an owner slot is a revocation like any other: new epoch, new keyring
  entries, re-encryption (§5.8). Each owner's keys change only by that owner: another owner's key renewal is never signed in
  by someone else (PROTOCOL 6.3: the owner's own roster version, or none). Stated residual risk: someone who holds a stolen
  access sheet and starts a recovery becomes an owner after the waiting period and can revoke the founder if the founder
  neither cancels nor acknowledges in time; the 72-hour period and the notice at unlock are the protection.

### 5.8 Invites, revocation, re-encryption

**Invite**

1. Owner client creates an invite slot: fresh `E` and `S` key pairs, a random access ID and a random 17-byte (136-bit)
   invite secret; `K_wrap` and the token come from HKDF over the secret. It adds the slot to a new signed roster version
   and uploads it with keyring entries for every slot and the invite's server material (`new_slots`).
2. Invite code: the access ID (20 symbols) followed by the secret (28 symbols), 48 Crockford base32 symbols with check
   bits, shown in 12 groups of 4. Expiry: the share dialog offers 1, 2 (default), 7 or 14 days; the library accepts 1 hour
   to 14 days (`createInvite({expiresIn})`); the server accepts any expiry up to 15 days ahead of its own clock (the owner
   invites of `wds-recover` default to 72 hours). An invite cannot be extended. The dialog recommends handing the code over
   in person or through a channel other than the one the app's data is about.
3. Redeeming: the recipient enters the code and a passphrase; the client re-wraps the slot's private keys under the
   passphrase-derived key and replaces token hash, salt and parameters (`POST /slots/{id}/redeem`). The roster marks
   the slot redeemed at the next owner unlock, and owners see "Invite … was redeemed on …" with a revoke button.
   Unredeemed invites expire: the token is dead at once (`410 invite_expired`), and the share dialog shows "Invite expired".
   The slot stays in the roster until an owner unlocks: the owner's maintenance (`maintain()`, run by the library after
   every owner unlock) removes all unredeemed, expired `write` and `read` invites in one version, without a new epoch if
   none of them was used, as a revocation (below) if one was. Expired owner invites from a recovery are left alone.
   Decision: the server cannot remove them, because every roster version needs an owner's signature that clients verify
   (PROTOCOL 6.3, "Expired invites"); it never removes expired invites by itself.
   **Cancelling an invite:** an invite nobody has used is simply removed from the roster. Any request with the invite token
   marks it used, and the response already holds the keyring entry (VMK, NK) for whoever has the secret, so a used invite can
   only be withdrawn like a member: by a revocation. The share dialog offers "Cancel invite" only for unused invites and
   "Revoke" (with the revocation confirmation) otherwise; the library's `cancelInvite` falls back to the revocation itself.

Key renewal is automatic at redemption: the redeeming client creates new `E`/`S` key pairs and submits them in a
renewal statement signed with the slot's previous `S` key (the invite's). The owner's client verifies that signature
against the roster before signing the new keys in and re-encrypting the member's entry; until then the member uses the
invite keys. This closes the window in which an intercepted invite code plus a database copy would decrypt future
epochs, and the server cannot substitute keys (it has no `S` private key). Members can renew again at any time the same
way. Passphrase changes only re-wrap.

**Revocation (owner)**

1. One atomic call (`POST /vaults/{v}/roster`, compare-and-swap; there is no separate revocation endpoint): a signed roster
   version without the slot(s), epoch e+1 with a fresh VMK and its commitment, and new keyring entries for all remaining
   slots including escrow (containing the VMKs of all live epochs). The server marks the removed slots revoked: token
   hash and wrapped blob are wiped, the row stays so that access IDs and slot IDs are never reused. From this moment the
   revoked token answers `401 revoked` and the server accepts record writes only under epoch e+1.
2. Re-encryption: the owner client re-encrypts every current record **and every history version** still under an epoch
   ≤ e, in place, via `PUT …/versions/{n}/rekey` (version numbers and history unchanged; no new history entries,
   no extra space). Each rekey carries `If-Match` on the old blob's epoch, so two sessions resuming at once cannot
   clobber each other, and the immutable history commitments (§5.5) make content changes detectable. The server
   reports how many blobs still use old epochs (`remaining` in the rekey list, `old_epoch_blobs` in usage, a column on the
   dashboard); the share dialog shows a progress bar. Rekey writes are allowed in read-only mode and in a suspended scope
   (§10.1).
3. If the tab closes, nothing is lost: the new keys are already on the server; after the next owner unlock the library
   resumes the re-encryption (`status().rekeyPending`, `resumeRekey()`, with a progress notice). Readers accept all epochs
   present in their keyring entry.
4. When the client's own listing shows no blob under an old epoch (it does not trust the server's count), the owner posts
   a further roster version that drops the old epochs' commitments, with keyring entries without their keys (the server
   answers `409 epoch_in_use` while a blob still uses one).
5. Clients with an open session whose write is rejected for a stale epoch get `409 epoch_changed`; the library reloads
   roster and keyring and retries once.

Remnants: old-epoch ciphertext can survive in backups (2 local copies on the backup disk, plus the virtual-machine backup jobs, §12) for their retention period;
SQLite runs with `PRAGMA secure_delete=ON` so freed pages are overwritten. §2 states the backup window.

### 5.9 Escrow

- Escrow keys: one ECDH P-256 and one ECDSA P-256 key pair (a *set*, key ID = `b64u(SHA-256(E.pub ‖ S.pub))`), plus a
  **spare** set, generated offline on the operator's laptop with `tools/wds-keygen.mjs` (WebCrypto only, one set per call,
  `--label current|spare --out <dir>`, private file mode 0600, never overwrites). Current private keys only in KeePassXC
  (decision: one share, no splitting); the spare in a separate KeePassXC database on an offline medium, so one leak does
  not take both. The production sets exist (current `jPpQPgYBsi1_jbhpXomvO_qDGg6B_oqL8t8qCEU7AAg`, spare
  `tVvmpc-8Du0iPnpniKhKa3vmXgL4uJ0atqDP6dOY1ic`); their public keys are in the server configuration (the deployment
  configuration), their IDs in `client/escrow-pins.json`, from which `build.mjs` pins them in the bundle.
- Compromise of an escrow signing key affects every deployed app, because libraries are immutable: the attacker
  together with the server can sign roster versions. Response: switch to the spare, publish a library version that pins
  the spare and a new key and lists the old current key as **retired** (below), and the advisory banner (§8.3) tells users of
  old apps to ask for an update.
- The library pins the SHA-256 of both current and spare public keys. Vault creation adds an escrow slot with the
  current keys; if the server offers keys that are not pinned, the client refuses. Switching to the spare needs no
  library update; a later key pair comes with a new library version, and old vaults are moved over when an owner
  unlocks them.
- **Retired escrow keys** (implemented in `wds-core.js`, `build.mjs`): a library lists the IDs of earlier pinned key sets that were
  retired, each with a retirement time (`until`). The pin is enforced where it matters and relaxed for history:
  - Every roster version of a chain must name an escrow set that is pinned (current or spare) or retired; any other set is
    refused. So a library that drops an old key still opens vaults created under it, including vaults already moved.
  - A version signed by a retired escrow key (a recovery) counts only if its `time` is not after `until`. Residual risk: `time` is
    chosen by the signer, so a leaked retired key plus a colluding server can backdate a version on a vault that was never
    opened since the retirement and whose head still names the retired set, on a device that has not pinned a newer head; the
    pinned head (§5.5) protects every device that has opened the vault before.
  - **Migration:** when the head names a retired set, members open the vault as before (status `escrowRetired`), and an owner's
    `maintain()` writes an owner-signed roster version that switches the escrow slot to the current pinned set the server offers
    (PROTOCOL 6.3 (c)); an escrow-signed version never changes existing slots. Until then the client refuses every roster edit
    (`escrow_retired`) so no keyring entry is encrypted to a retired key. If the recovery notice is still unacknowledged, the
    migration waits for it.
  - Both lists are fixed by the build. A build that has pins ignores the `escrowPins` and `retiredEscrow` options (tests only).
- The escrow slot has no token and is never used online by clients.

**Recovery procedure (manual, logged)**

1. The user asks the operator. Normal case: they still have the access sheet with the **recovery code** (17 random bytes =
   136 bits, 28 symbols; its SHA-256 is stored per vault at creation). Because the sheet is a bearer credential, even a correct code starts a
   **72-hour waiting period** during which the founder sees "A recovery of this vault was requested – cancel?" on
   unlock; the access sheet tells users to keep it apart from their device.
2. Without the recovery code, recovery is only possible if the founder set an optional **recovery contact** (e-mail
   address, stored on the server in plaintext with the user's consent) at creation: the operator mails that address and
   the waiting period is 7 days. Without code and contact: no recovery (slots are anonymous; there is nothing to
   verify a claim against).
3. The operator runs `wds-recover` on their laptop (never on the server): fetch escrow keyring entry and roster with
   an operator API token, decrypt with the escrow key from KeePassXC, add a new owner invite slot to a roster version
   signed with the escrow signing key, hand the invite code to the user. `tools/wds-recover.mjs` has the subcommands
   `start` (vault ID; the recovery code is asked for or read from stdin, not taken from the argument list; or `--contact`), `status`, `cancel` and `complete` (`--escrow-key <private key file of
   wds-keygen>`, read and never stored). `complete` verifies the roster chain and the keyring entry against the signed commitments,
   builds the escrow-signed version with exactly one added owner invite, runs the client's chain verifier over the result before
   uploading, and prints the invite code. Options: `--expires-in-hours` (default 72, at most 359, because the server accepts
   at most 15 days), `--dry-run`, `--yes`, `--json`, `--base` (https only, localhost excepted), `--token-file` (default
   `~/.config/wiai-datastore/operator-token`). All cryptography comes from `client/src/wds-core.js`; the tool writes no file
   and never prints the token or the key. Exit codes: 0 done, 1 failed, 2 usage error or waiting period not over. Tested end
   to end against the real server in `tools/test/recover.test.mjs`.
4. The old owner slot is **not** revoked automatically; the user can revoke it after regaining access (rule in §5.7: an
   owner added by the faculty may revoke the other owner slots, and the founder may revoke an owner the faculty added).
5. Every operator call is audited, failed ones too (`<action>_failed`), with scope and vault but no IP address; the entries
   appear in the scope's audit list for the scope admins and on the operator page (recovery requests and recovery audit).
   The "recovered by the faculty" notice is derived by clients from
   the roster chain (a version signed by the escrow key), not from a server flag, so it cannot be suppressed. Before a
   client encrypts anything to a slot that escrow added, the founder (if they still have access) must acknowledge it. The
   acknowledgement is remembered per access ID and slot in localStorage (not secret), so the modal appears once per added slot
   and device, while the library refuses roster edits in every new session until it knows the notice was confirmed.

## 6. Authentication, authorisation, rate limits

| Actor | Credential | Transport |
|---|---|---|
| App user | Per-slot token derived from passphrase (or invite secret) | `Authorization: Bearer wds1.<access_id>.<token>` |
| Scope admin, operator (dashboard) | login.psi session | Cookie `__Host-wds_session` (`Path=/; Secure; HttpOnly; SameSite=Strict`) |
| Operator tools | API token `wdsop.<random>`; the server configuration holds only its SHA-256 (`[operator] token_hashes`, from the deployment configuration; a hash is not secret, so no vault) | `Authorization: Bearer wdsop.…` |

- `__Host-` cookie with `Path=/` because a path is not a security boundary within an origin. The whole origin
  `wiai.uni-bamberg.de` belongs to the trusted base: today it only serves the static faculty report draft; anything
  deployed there later can act with the dashboard session. Dashboard forms carry a per-session CSRF token, requests that
  the browser marks as cross-site (`Sec-Fetch-Site`) or that carry a foreign `Origin` are refused, and dashboard pages
  have a nonce-based CSP. The API never reads the cookie.
- login.psi: `next` targets must be paths below `/datastore/` (not the login routes or the API; as `ziel()` in
  psi-web-comments); the nonce cookie `__Host-wds_login` holds `<time>.<random>` and is valid for ten minutes and one
  response (§10).
- Staff rule: `email` ends with `@uni-bamberg.de` (not a subdomain like `stud.`) **and** no `matriculation_number`
  in the login.psi response. Operators are listed by Uni ID or e-mail in `[dashboard] operators` (from Ansible).
- Rate limits: requests with a correct token are never throttled; the token hash is checked first. Only
  authentication failures count: 60 per IP per minute and 10 per access ID per minute from the same IP (so a stranger
  cannot exhaust a victim's budget from elsewhere). Vault creation per IP 30 per hour (eduroam and NAT). IPv6 clients
  count per /64. Lookups of existing access IDs on `/slots/{id}/kdf` are never throttled or counted. While an IP is over
  its budget, even a correct join code or recovery code from it is refused with `429`. Client IPs from
  `X-Forwarded-For` trusted from the reverse proxy only (`--forwarded-allow-ips` set to its address in production; the default is
  `127.0.0.1`). `409`, `412` and other non-authentication errors never count. Limits are configurable
  (`[ratelimit]`).
- Token check happens before the request body is read: authentication, state and role checks run before the body is
  read, and the compare-and-swap then runs in one `BEGIN IMMEDIATE` transaction that re-verifies the slot.
- Enrollment per scope: `join code` (**default**; users type a code the scope admin hands out, not embedded in the
  app; 8 Crockford symbols, rotatable on the dashboard), `open` (bounded by "max vaults"), `closed`. Vaults without any
  record 7 days after creation are purged.

## 7. HTTP API v1

Base `https://wiai.uni-bamberg.de/datastore/api/v1`. JSON unless noted; binary bodies `application/octet-stream`.
Errors: `{"error": "<code>", "message": "<English text>"}`.

### 7.1 Without token

| Method + path | Purpose |
|---|---|
| `GET /scopes/{scope}` | Name, status, enrollment mode, `hibp` flag, read-only flag, public limits, Argon2 defaults, escrow public keys (current, spare), library version (`latest`, `deprecated`), privacy URL. |
| `GET /slots/{access_id}/kdf` | Salt and Argon2 parameters (404 for unknown IDs). |
| `POST /scopes/{scope}/vaults` | Create vault: roster v1, owner slot, escrow slot, keyring entries, recovery-code hash, optional recovery contact, join code if required. |

`GET /datastore/healthz` answers `{"status":"ok","read_only":bool}` (outside the API base).

### 7.2 With token

| Method + path | Role | Purpose |
|---|---|---|
| `GET /slots/{access_id}` | any | Own wrapped private keys and keyring entry, vault ID. |
| `PUT /slots/{access_id}` | any | Change passphrase (new salt, params, token hash, wrapped keys); `If-Match` on slot version. |
| `POST /slots/{access_id}/redeem` | invite | Turn an invite into a passphrase slot. An unredeemed invite token may only read its own slot and the roster and redeem; everywhere else it is `403` (PROTOCOL.md 8.2). |
| `GET /vaults/{v}/roster` | any | All roster versions (or since a given version). |
| `POST /vaults/{v}/roster` | owner | New signed roster version + keyring entries (invite, key renewal, role change, escrow move, **revocation** = epoch + 1 with slots removed); compare-and-swap on the previous hash. There is no separate revocation endpoint (PROTOCOL.md 6.3). |
| `POST /slots/{access_id}/renewal` | any | Submit new public keys, signed with the slot's current `S` key. |
| `GET /vaults/{v}/rekey` | owner | Blobs still under old epochs (paged). |
| `PUT /vaults/{v}/records/{rid}/versions/{n}/rekey` | owner | Replace one blob with the same version under the current epoch. |
| `GET /vaults/{v}/records` | any | List (paged, `after`, `limit` ≤ 1000): record ID, version, padded size, updated, epoch; tombstones included. |
| `GET /vaults/{v}/records/{rid}` | any | Current version, `ETag: "n"`. |
| `PUT /vaults/{v}/records/{rid}` | write | Needs `If-Match: "n"` or `If-None-Match: *`. |
| `DELETE /vaults/{v}/records/{rid}` | write | Needs `If-Match`; tombstone in history. |
| `GET /vaults/{v}/records/{rid}/versions[/{n}]` | any | History. |
| `DELETE /vaults/{v}/records/{rid}/versions` | owner | Purge history of a record (frees quota). |
| `DELETE /vaults/{v}/recovery` | owner | Cancel a pending recovery (the founder's notice, §5.9). |
| `DELETE /vaults/{v}` | owner | Delete vault (soft, purged after 30 days). |
| `GET /vaults/{v}/usage` | any | Bytes used (record envelopes), records, versions, blobs under old epochs, read-only flag, limits. |

Operator API (token hash in the configuration from Ansible, PROTOCOL.md 9): `POST /admin/scopes`, `PATCH /admin/scopes/{scope}` (suspend, enrollment, join code,
limits), `GET /admin/vaults/{v}`, `POST`/`DELETE /admin/vaults/{v}/recovery` (recovery-code proof: 72 hours; recovery contact:
7 days), `GET /admin/vaults/{v}/escrow` (only when the waiting period is over), `POST /admin/vaults/{v}/recovery/complete`.
Every call is audited, failed ones too.

### 7.3 Conflicts

- `PUT`/`DELETE` without precondition → `428`. Outdated `If-Match` or `If-None-Match: *` on an existing record →
  `412` with the current version number in the body; the client then fetches "theirs".
- Compare-and-swap inside one SQLite `BEGIN IMMEDIATE` transaction.
- No server-side force flag: "overwrite anyway" in the client means re-reading the current version and writing with
  `If-Match` on it, so the overwritten state is always in history.
- History depth: last N versions, but versions younger than 10 minutes are not dropped by count (a burst of saves
  cannot wipe all history); they count against the quota.

### 7.4 Envelope checks on every write

Content type; magic `WDS1`; type valid for the endpoint; flags 0; epoch equals the vault's current epoch (records,
rekey); version in path matches the expected next version; length ≥ 38; size ≤ derived limit (rekey: the ceiling bound
and exactly the stored blob's length); a well-formed `WDS-Commit` header (32 bytes) on record writes. No entropy heuristics:
they misfire on valid ciphertext (random data contains NUL bytes about 0.4 % of the time), and accidental plaintext
cannot carry a valid header and epoch anyway because only the library produces them.

## 8. Client library `wds-<version>.js`

One classic script file (ES2020) built from the vendored hash-wasm Argon2id build, `wds-core.js` and `wds-ui.js` (§8.6).
Current version: 1.0.0, not frozen yet. Served at `https://wiai.uni-bamberg.de/datastore/client/wds-<version>.js` and
`…/wds-<version>.js.sri` (immutable, `Cache-Control: public, max-age=31536000, immutable`, `Access-Control-Allow-Origin: *`,
`Cross-Origin-Resource-Policy: cross-origin`). Apps include exactly:

```html
<script src="https://wiai.uni-bamberg.de/datastore/client/wds-1.0.0.js"
        integrity="sha384-…" crossorigin="anonymous"></script>
```

The dashboard shows this line ready to copy (taken from `client/dist/hashes.json` next to the server). Because SRI defends
against this very server, the hashes are also published in this repository (`client/dist/hashes.json`), and `wds-verify`
checks the tag against that file. The tag in the developer documentation (`{{script_tag}}`, filled in at request time)
adds an `onerror` fallback that shows "Storage service unreachable" instead of a blank page.

### 8.1 API (the only thing app code uses)

Implemented in `client/src/wds-ui.js` on top of `wds-core.js` (the protocol client, no UI).

```js
const store = WDS.connect({ scope: "notenrechner-k7m2a9" });   // options: baseUrl, locale, notify (false = no toasts), watch, label
// (escrowPins / retiredEscrow exist for tests only: a library build with pinned escrow keys ignores them)
store.onLock(reason => clearScreen());      // register once, outside start(); reasons: user, revoked, expired
store.onUnlock(status => start());          // after every successful unlock (first and later); start() may run many times
await store.unlock({ cancelable: false });  // dialog: create vault / unlock / redeem invite / key file; resolves with the status
await store.get("settings", { fresh });     // value or undefined; every method below unlocks first when the store is locked
await store.getMany(names, { concurrency: 6, fresh: false });   // values in the same order, undefined for missing names
await store.set("settings", obj);           // conflict-safe; JSON values; {name, version, size, resolution, value?}
await store.set("files/report.pdf", blob);  // Blob/File/ArrayBuffer/Uint8Array -> stored as bytes (MIME type kept)
await store.getRecord("files/report.pdf");  // {name, version, kind, mime, time, length, value}; store.getBlob(name) -> Blob
await store.list("files/");                 // [{name, version, kind, mime, length, time}], client-side prefix filter
await store.remove("settings");             // {name, deleted, resolution: "deleted" | "absent" | "mine" | "theirs", value?}
const as = store.autosave("draft", () => state, { delayMs: 2000, onStatus, onError, onReplaced });
as.changed(); await as.flush(); as.stop(); as.status; as.error; as.stopReason;   // idle | dirty | saving | saved | error | replaced | stopped
const notes = store.collection("notes/", { meta: v => ({ title: v.title }) });   // §8.7
await notes.load(); notes.items(); await notes.add(value, { id, created }); await notes.set(id, value, { created }); await notes.remove(id);
notes.autosave(id, getState); notes.onChange(fn); await notes.refresh(); await notes.getAll(); await notes.flush(); await notes.rebuild();
store.onConflict(c => c.keepMine() /* | c.keepTheirs() | c.merge((mine, theirs) => value) | await c.ask() */);  // global
store.onConflict("notes/", handler); store.onConflict("settings", handler);       // prefix or exact name; returns unsubscribe
await store.history("settings"); await store.restore("settings", version); await store.showHistory("settings");
store.onStale(rows => …);                   // replaces the "newer versions elsewhere" notice
await store.share();                        // members dialog: invite, roles, revoke, renew keys, passphrase, key file
await store.exportAll();                    // ZIP download of everything decrypted (backup), see 8.5
await store.lock(); store.setLocale("de"); store.status() /* incl. sandbox: boolean */; store.isUnlocked(); store.usage();
```

- No method takes raw wire bytes; app code never calls `fetch` against the datastore; there is no way to switch off
  encryption. Record names starting with `.wds/` are reserved for the library (member labels, 8.5).
- Typed errors (`WDS.errors`): `ConflictError`, `OfflineError` (with `downloadBackup()`), `QuotaError`, `AuthError`,
  `IntegrityError`, `VersionError` (plus `UsageError` for misuse). `downloadBackup()` saves the values that could not be
  saved (single file, or a ZIP together with the last JSON values read in this session). The library also shows a notice with
  the same button; `notify: false` switches its notices off.
- Writes to one record name are serialised, so rapid saves never conflict with themselves. `set()` returns `value` for the
  resolutions "theirs" and "merged" (what is now stored). `getMany` runs at most `concurrency` (1 to 16) reads at a time and rejects
  with the first error other than "missing"; `fresh: true` bypasses the page's cache (used to verify a migration).
- `remove()` pauses the autosave handles of the name during the request; "deleted" or "absent" stop them (`stopReason`
  "removed"), "theirs" (the other side's newer version was kept) resumes them with status `replaced` and calls `onReplaced(value)`.
- **Autosave** handles are unique per name: a new handle for the same name flushes and stops the old one (`stopReason` "superseded"),
  so running `start()` again after every unlock is harmless. `flush()` never rejects; `getState` returning `undefined` writes nothing.
- **Lock** (any reason): before the `onLock` handlers run, the library takes a snapshot (`getState()`, deep copy) of every dirty
  autosave handle and saves the snapshots and pending collection operations (best effort, 8 s); then every handle stops and the
  `onLock` handlers may clear the page. Snapshots that could not be saved are written after the next unlock of the **same** vault,
  before the `onUnlock` handlers run; unlocking a different vault drops them with a notice. Then the library forgets all keys;
  unsaved backups stay downloadable. `onLock`, `onUnlock` and `onChange` registrations are idempotent per function.
- Dialogs: German/English by `navigator.language` (German formal "Sie"), themeable via CSS custom properties (`--wds-bg`, `--wds-fg`,
  `--wds-accent`, `--wds-font`, `--wds-radius`, …) and the `wds-` class prefix, no Shadow DOM, light and dark by `prefers-color-scheme`.
  Accessibility: `role="dialog"`, `aria-modal`, labelled by the title, focus trap, the rest of the page is `inert` while a dialog is open, focus
  returns to the previous element, every input has a label, errors are `role="alert"`. The API offers no hook that hands over
  the passphrase. (The dialogs run in the app's JavaScript realm, so a malicious app could still read the input; this
  protects against careless code, not hostile code.)

### 8.2 Conflicts in the library

The library remembers the version of every record it read or wrote and sends it with `If-Match` (or
`If-None-Match: *` for names it believes are new). On `412` it loads "theirs", decrypts it and calls the conflict
handler; the default dialog says "Another device or person saved a newer version" and offers keep theirs, keep mine
(saved on top, theirs stays in history) or download both. It never retries silently.

Handlers are looked up in this order: the internal handler of a collection index (§8.7, not overridable), the handler registered
for exactly that name, the one whose prefix (ending in `/`) matches (overlapping prefixes are refused at registration, so at most one
matches), the global handler, the built-in dialog. The handler gets `c` with `name`, `op` ("set" or "remove"), `mine`
(`{value, kind, mime, deleted}`), `theirs` (`{version, deleted, kind, mime, time, value}` or `null`), and decides with
`keepMine()`, `keepTheirs()`, `merge(fn)` or `await c.ask()` (the dialog now). A handler that decides nothing, throws or rejects
falls through to the **built-in dialog**, never to a thrown `ConflictError`; up to 4 rounds. On window focus it checks the
list endpoint and warns when records it holds have newer versions.

### 8.3 Versions and compatibility

- Library URLs never change content. The server stays compatible with every published v1 library for **reads and
  exports**, forever; new features may require a newer library, but a server update never locks old apps out of
  their data. This holds for operator changes too: reads and re-encryption never depend on the scope's current
  `max_value_bytes` (they are bounded by the ceiling), and the operator API and the dashboard refuse to lower
  `max_value_bytes` below the largest value stored in the scope (PROTOCOL 7.1).
- **Export tool** (`docs/site/export.html`): a standalone page that loads the library with the same SRI tag, unlocks any
  vault of any scope (scope ID and access ID typed in or taken from a key file) and downloads everything decrypted as the
  ZIP of §8.5 – for apps whose author is gone. Served at `/datastore/export/` and as a download
  (`/datastore/export/wds-export.html`) that also runs from `file://`; linked from `llms.txt`, the documentation index and
  the user guides. It decrypts in the browser; the server only serves the file.
- **Advisory banner:** `GET /scopes/{scope}` tells the library whether its version is deprecated; the library then
  shows a dismissible "this app uses an outdated storage library" notice. It never blocks.

### 8.4 What stays in the browser

localStorage (namespaced `wds:<scope>:<access ID>:`): access ID, the MAC'd rollback state (§5.5) and the list of slot IDs
whose redemption the owner has already seen (`seen`) and of recovered owner slots the user confirmed (`acked`). Nothing secret. Keys only in memory: the
slot wrapping key, K_commit, K_state and the record-ID key are non-extractable `CryptoKey`s; the NK, the VMKs (keyring building) and the private
scalars (re-wrapping) stay raw because the library has to export or rewrite them. No "remember my passphrase" in v1. The rollback state is MACed
but not fresh (§5.5). The production bundle has no `setRandom`, `setArgon2` or `internals` on `WDSCore`, runs the vendored hash-wasm in a private
scope and captures its Argon2id function once at load time (no global is read later, a page's own hash-wasm or AMD loader neither
interferes nor receives passphrases).


### 8.5 Dialogs, notices and what the library does on its own

- **Unlock dialog** (one dialog, several views): unlock (access ID or dropped/chosen key file, passphrase), create vault (join
  code when the scope requires one, passphrase twice, optional recovery contact, the escrow notice of §5.9 and the privacy
  link), redeem invite. A pasted invite code in the ID field switches to "redeem"; a recovery code is recognised and refused.
  Argon2id blocks the page for about a second; the dialog paints a "deriving your key" line first.
- **Passphrase rules** (§5.3) are in `wds-ui.js`: at least 12 characters (code points); a refused list of very common
  passwords (exact, with look-alike digits and trailing digits stripped); a guessing estimate in bits built from the cheapest
  decomposition into literals, ~600 common English/German words and phrases ("ichliebedich", "meinschatz", club names and the like;
  umlauts also as ae/oe/ue, separators and digits ignored for the exact list), years, repeats, sequences and keyboard walks (below 40 bits
  is refused, the meter has five levels); then the HIBP range query (`Add-Padding: true`, only the 5-character prefix, never during typing,
  only on submit, 8 s timeout). A hit blocks; an unreachable service is reported and does not block by itself. Without a breach check (the
  scope's `hibp` flag from `GET /scopes/{scope}` is off, or the service is unreachable) the limit is 48 bits: a well-known passphrase
  would otherwise pass unseen.
- **Access sheet** after creating a vault (and a reduced one after redeeming an invite): access ID and recovery code, key file download,
  print (hidden iframe) and a standalone HTML download with the escrow notice; "Continue" stays disabled until the user confirms.
- **After unlock** the library runs `maintain()` (after the notices below, because an unacknowledged faculty recovery blocks owner
  roster edits) and then, as needed: a modal for a pending recovery request with "cancel" (`DELETE /vaults/{v}/recovery`); a modal for
  an owner access added by the faculty with "I know about this" (calls `acknowledgeRecovery()`); toasts for a new device (or a
  reset local safety record), outdated library version, suspended scope, read-only server, redeemed invites ("Review" opens the share
  dialog) and, for owners, the automatic resumption of an interrupted re-encryption with progress.
- **Share dialog**: people (you first, escrow last; role select, revoke, cancel invite; badges "New: invite redeemed" and "Added
  by the faculty"; owner slots get a revoke button only where §5.7 allows it, with a separate confirmation text), invite form (role, 1/2/7/14 days, optional label) with the code in groups, own access (key file, renew keys,
  change passphrase with the same rules, lock). Revocation asks for confirmation, then shows a progress bar over the rekey loop; the
  dialog cannot be closed meanwhile. Members who are not owners see only their own access.
- **Member labels** ("Anna") are kept in the vault as the encrypted record `.wds/labels` (slot ID → text); `list` and `exportAll` hide it.
  Only the owner's UI writes it, but the server and the library let every write member write any record, so labels are
  **unverified notes**: a malicious write member could swap labels. The share dialog therefore shows the first eight characters of the
  slot ID next to every member, says so under the list, and repeats the ID in the revoke confirmation. (Signing the labels with the
  owner's S key would make them verifiable; not done in v1.)
- **Export** (`exportAll`): store-only ZIP written without a dependency; every record is a file (JSON records get `.json`, files without an ending get one that matches their MIME type, folders from
  `/` in names are kept, collisions get " (2)"), plus `wds-export.json` (name → file, kind, MIME, version, time, size) and `README.txt`.
  `list()` has to download every record once to learn its name, so an export reads every record twice (open point: an
  encrypted index record would avoid it).
- **Stable attributes.** Every button, input, select, textarea and summary inside `.wds-root` carries `data-wds="<name>"`, every
  dialog `data-wds-view="<view>"` (updated on every view switch), toasts `data-wds-toast="<key>"`. The names are listed in the header
  of `wds-ui.js`; a unit test walks every view and fails on a control without a name. Tests and wds-verify click these, so they work
  in any locale. integration.md (section 12, "Driving the library's dialogs") lists every view with its controls (a test compares the table with
  the header of `wds-ui.js`), and `tools/lib/drive-library.mjs` (`createVault`, `unlock`, `confirmSheet` and the single steps) drives them for
  wds-verify and for a developer's own Playwright tests; it reads a join code only from `WDS_JOIN_CODE`, never prints it, and no error contains it.
- **Sandbox** (§17): when the scope document has a `sandbox` field, every dialog title is prefixed ("Sandbox: " / "Testumgebung: "),
  every dialog shows a banner and, after unlocking, a fixed bar at the top of the page says that the data is deleted tonight (both with
  inline `!important` styles; while the bar is shown the library adds its height to the inline `padding-top` of `<html>` and restores
  it at lock). The create view has no recovery-contact field, the access sheet no recovery code, the invite expiry is "until tonight".
- **Server data shown by the dialogs** (scope name, privacy URL) is rendered as text; the privacy link is only used for `http(s)` URLs.

### 8.6 Build and tests

`client/build.mjs` concatenates the vendored hash-wasm Argon2id build, `wds-core.js` and `wds-ui.js` (in that order, classic script, no
bundler) into `client/dist/wds-<version>.js` (version from `client/package.json`; the bundle is one function scope, see §8.4), writes `wds-<version>.js.sri` (`sha384-<base64>`) and
`dist/hashes.json` (per version: file, SRI, SHA-256, size, escrow pins, retired escrow sets, frozen). The escrow key IDs (current and spare, §5.9) come from
`client/escrow-pins.json`, `WDS_ESCROW_PINS` or `--escrow-pins=` and are written into the bundle, retired sets from the `retired` list of that file,
`WDS_RETIRED_ESCROW` or `--retired-escrow=ID:UNTIL,…`; without pins vault creation fails unless the app passes
`escrowPins` (tests only; a bundle with pins ignores the option). The browser tests build their own pinless bundle into `client/test-results/bundle`, so `dist/` always holds the production build. `--freeze` marks a released version: later builds with different bytes fail. `scripts/test-client.sh` runs the node tests
(protocol, vectors, UI helpers, build) and the Playwright UI tests (`client/test/ui.spec.mjs`, Chromium only, `file://` page,
in-memory fake server over HTTP): create,
passphrase rules, unlock, key file, records, conflict, autosave, share/redeem/revoke, export, offline, history, recovery notices,
German texts, accessibility, SRI.

**Integration tests** (`scripts/test-integration.sh`, `client/test/integration.spec.mjs`, config `client/playwright.integration.config.mjs`).
They start the REAL server (project venv, temporary database, scope made with the dev CLI, escrow keys generated for the run) and
load a REAL bundle built from the current sources with exactly those escrow keys pinned (so the production path for pinned
keys is the one tested), from a `file://` page (the bundle comes either from disk or from the server's `/datastore/client/` with
SRI). One Playwright project per engine; a browser that is not installed is skipped with a notice, `WDS_BROWSERS` forces a list
(`WDS_WEBKIT_EXECUTABLE` or any installed `webkit-*` build is used when the expected WebKit build is missing). They cover: vault
creation (join code), JSON and 5 MB binary records, list (also across list pages), history and restore, conflicts (412 paths and
the dialog in two contexts), invite with read role and the server refusing its writes, an unredeemed invite token being useless,
automatic and manual key renewal, revocation with interrupted and resumed re-encryption (checked through the API: no old-epoch
blob remains, every version still passes its history commitment), passphrase change, non-envelope bodies, join code,
enrollment/suspension, quotas and limits, read-only mode (a second server process on the same database with a threshold that is
always exceeded), vault deletion, rate limits, the complete faculty recovery (escrow keys decrypt the keyring entry, escrow-signed
roster, recovered owner redeems, founder acknowledges, recovered owner revokes the founder; the 72 hour wait is skipped by
editing the recovery row of the temporary database; the operator side is done by the test environment with the core internals,
`client/test/integration-env.mjs`), and a canary check: no request body, URL or database file contains any canary
text, passphrase or attachment marker (with positive controls for the detector). The same config runs
`client/test/docs.spec.mjs`: the example app of `integration.md` taken from the rendered page and run from `file://` with the
documented script tag and CSP (plus a negative control without `'wasm-unsafe-eval'`), the `onerror` fallback, and the export
page both as served and as a saved copy opened from `file://`.

### 8.7 Collections (index record, op replay)

A list of records needs an index, and two devices must not lose each other's items. `store.collection(prefix, { meta })` keeps, next to the item records `prefix + id`, one index record
`<prefix>.index` (outside the prefix, so `list(prefix)` does not return it) with `{ wds: "collection/1", items: { id: { c, v, m } } }`: `c` creation time (sorting only), `v` the version of the item record
the entry describes, `m` a small meta object (at most 512 bytes) so that lists render without loading items.

**Merge by operation replay.** The collection holds `base` (the last index read from or written to the server, with its version) and a queue of pending operations (`upsert`, `remove`). What the app sees is
`apply(pending, base)`. An index write stores that value with `If-Match: base.version` (`If-None-Match: *` when the index did not exist; the write never falls back to what the client happens to know). On a version conflict the
library takes the server's index as the new base, applies the pending operations again and retries (10 rounds, 50 to 500 ms of jitter). Operations leave the queue only when a write containing them succeeded. Writes are
coalesced; each call resolves when a write with its operation succeeded, and every waiting call rejects with the error (and `err.stored = true`) when a write fails, the operations staying queued for a retry.
An `upsert` that carries a record version lower than the entry's `v` is ignored (a delayed update of an older save never replaces the newer title of another device). No client clock decides anything and there are no
tombstones: an id removed on one device stays removed, additions of other devices stay. Reads and writes of the index take turns, so a slow read cannot overwrite a newer base.

**`set` is an upsert.** `set(id, value, { meta, mime, created })` writes `prefix + id` and queues an `upsert`: an id the index does not have gets an entry (`created`, by default now, decides only its place in the list), an id it has keeps its `c` and gets the new meta. `add` with an id that exists is a conflict like any write to a record the page has not read; `set` on a record that exists but that the page has not read (it is only in the index) is the same conflict (§8.2), never a silent overwrite. `created` exists on both so that an import or a migration keeps the old order (round E; before, `set` ignored it).

**Write order and repair.** `add` and `set` write the entity first and then queue the index operation; `remove` deletes the entity first. A failure between the two leaves a record without index entry (an
"orphan"): it is queued whenever the page lists the vault anyway, `rebuild()` repairs explicitly (downloads every item, one request each), and `flush()` resolves when everything queued is on the server.
Meta changes from autosave are written at most every 10 s. Cost: every index write re-encrypts and uploads the whole index (keep meta small, a few thousand items per collection at most).

The alternative that was rejected: last-writer-wins with timestamps and tombstones (needs trustworthy clocks and tombstone pruning; one device with a wrong clock would delete items of the others).

## 9. "No plaintext reaches the server": verification

1. **By construction:** only the library talks to the server, and it has no unencrypted path.
2. **SRI:** the browser refuses a library file that differs from the published hash.
3. **CSP** recommended in every app (exact text in the developer doc):
   `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' https://wiai.uni-bamberg.de/datastore/client/;
   style-src 'unsafe-inline'; img-src data: blob:; connect-src https://wiai.uni-bamberg.de/datastore/api/
   https://api.pwnedpasswords.com; base-uri 'none'; form-action 'none'` (`'wasm-unsafe-eval'` is needed for Argon2id). `'self'` is
   left out because its meaning on `file://` differs between browsers. The text is built by `docs.csp_policy`; `wds-verify` carries the
   same string (a test compares them) and accepts only the inert additions `font-src data:`, `media-src blob: data:` and `img-src https://host`.
4. **Server envelope checks** (§7.4).
5. **Integration test with canaries** (`client/test/integration.spec.mjs`): every request body a browser sends to the real server over a whole run is searched for canary plaintexts (raw, hex, base64 at every alignment, and base64url blobs inside JSON), and so are the server's database files and log.
6. **`wds-verify`** (`tools/wds-verify.mjs`) – a smoke test, not a proof. Node + Playwright, run by the developer's Claude
   from a clone of the public repository (https://github.com/UBA-PSI/wiai-datastore) against a local copy of the real server (the
   "mock", needs Python 3.13) or the public sandbox of the real service (no Python, no build; §17):
   - static: script tag present with a known version and the matching integrity hash; CSP present and no broader than
     the template; no external scripts; no `fetch`/`XMLHttpRequest`/`WebSocket`/`sendBeacon`/form actions to the
     datastore host outside the library;
   - dynamic: open the app via `file://` (library URL mapped to the mock), create a vault, put unique canary strings
     into every input, textarea and contenteditable, trigger save actions (heuristics plus optional steps in
     `wds-verify.json`), then fail if a canary appears raw, URL-encoded, base64, hex or UTF-16 in any request URL,
     header or body, **or** in localStorage, sessionStorage, IndexedDB, cookies, console output or downloads (except
     those created by `exportAll`);
   - also flags: `set` called three or more times within a second per name without a button press in between (suggest `autosave`), one
     record holding the data of several items or the whole app state (suggest splitting); steps can also select files (`upload`);
   - the library's dialogs are driven by their `data-wds` / `data-wds-view` attributes (§8.5), so any locale works (`--locale`,
     `locale` in `wds-verify.json`); the app's own buttons are found by text or by `data-wds-verify="save"`;
   - after the save round the tool reloads the page, unlocks again and checks that the typed values are visible. It looks right after the
     unlock and after **every** `afterReload` step (tabs, lists) and takes the union. Expected back are only values the app showed as text
     before the reload or wrote to the store (`set`, `autosave`, the collections' `add`, `set`, `autosave`), so rejected input is left out
     and an autosaved editor that is never read back is a warning; an `afterReload` fill that repeats a typed value fails (the tool reads
     field values and would find its own text);
   - **migration test** (`seed` in `wds-verify.json`: the old local-only page and steps that fill it): the tool runs the old page in the same
     browser context, snapshots the whole old storage, then runs the new app. Findings: "Seed: the old app" (the old storage holds the values),
     "Migration: old data visible" (only screens after reload and unlock count; nothing written fails), "Migration: old data only encrypted"
     (seed values only in a JSON backup download or in an old place that did not grow), "Migration: old data deleted / kept in the sandbox"
     (mock: everything gone, leftovers fail when the migration visibly ran, `seed.keep` names what may stay; sandbox: kept). `--migration-delete`
     sets `window.__WDS_MIGRATION_TEST__` and `navigator.webdriver` so that the recipe deletes in the sandbox too (the recipe checks both); an
     app that assigns the global fails statically, a page that has it set without the flag fails dynamically. The sandbox run cannot prove that
     visible values came from the vault (the old data stays there); the mock or `--migration-delete` run is that proof;
   - "Library version released" (version not frozen) is information, not a warning; "Privacy sentence" (info) says when neither the page nor
     the README next to it has the official sentence;
   - scope check: the app's own scope document is fetched; breach check on without `https://api.pwnedpasswords.com` in
     `connect-src` fails; the report prints enrollment, breach check and limits;
   - output: Markdown report for the app's README, ending with a "Not tested" section.

   Implementation (`tools/wds-verify.mjs`, `tools/lib/`): the "mock" is the real server (`.venv` or `WDS_PYTHON`; without Python 3.13
   and its packages the tool stops with a message, `--static-only` skips the dynamic part). The mock gets fresh escrow keys, so
   it serves a library built from `client/src` with exactly those keys pinned, and the page under test is a copy whose
   integrity attribute is that bundle's hash (the production hash cannot match a mock that does not hold the faculty's keys).
   Chromium maps `https://wiai.uni-bamberg.de/datastore/` to the mock, blocks every other host and records every request; the
   scope the app names is created in the mock on first use. In-page hooks log `fetch`, `XMLHttpRequest`, `WebSocket`,
   `sendBeacon` and form calls with their caller (library or app) and the `set`/`autosave`/`exportAll` calls of the store.
   Canaries are searched in every encoding listed above plus base64url, hex of UTF-16LE and base64 at three alignments, also in the
   mock's database files. The run fails when it cannot make the app store anything (no vault, no record write): a pass must
   mean that data was written and searched. Library hashes come from `client/dist/hashes.json` (`--hashes` overrides).
   The published hashes are read from `https://wiai.uni-bamberg.de/datastore/client/hashes.json` first and from the clone's
   `client/dist/hashes.json` otherwise. `wds-verify.json` is an object `{ locale?, steps?, afterReload?, seed? }` (`seed: { page, steps, keep? }`) with the steps `click`,
   `fill` (a `{canary}` in the text becomes a generated token), `select`, `press`, `upload`, `download` (a download the person asks for is reported, not counted as a leak) and `wait`.
   Targets: `--target auto|mock|sandbox` (auto: mock when Python is there, else the sandbox if reachable, else static checks only);
   `--sandbox-copy <out.html>` writes a copy whose `WDS.connect` scope is the sandbox, for trying the app by hand. Static checks also fail
   the sandbox ID in an app file and CSS that hides library elements, and warn about deleting old local data without a sandbox guard.
   Further options: `--migration-delete` (needs a `seed`; no effect on the mock, which deletes anyway; the report names it in its first lines), `--strict` (warnings fail), `--out`, `--json`, `--script-tag` (prints the current tag and CSP).
   Exit codes: 0 passed, 1 a check failed, 2 the tool could not run, 3 the sandbox is unavailable (not an app finding). Tests: `scripts/test-tools.sh` with a correct and a
   deliberately leaky example app (`tools/test-apps/good`, `bad`).

## 10. Dashboard

Path `/datastore/` (`/datastore` redirects there), login via login.psi (app `wiai-datastore`, callback
`https://wiai.uni-bamberg.de/datastore/_lpmiddleware/login`). Server-rendered HTML, German by default with an English
switch, light and dark scheme, no external assets, no inline event handlers (one style and one script element with a
per-response CSP nonce). Built in `server/wds_server/dashboard.py` (routes and pages), `loginpsi.py` (login.psi protocol),
`access.py` (sessions, staff rule, roles), `scopes.py` (scope logic shared with the operator API), `ui.py` and `texts.py`
(layout, bilingual texts), `prompt.py` (the prompt for Claude and the CLAUDE.md / AGENTS.md section), `privacy.py`.

- **Staff (scope admins):** "My scopes" (name, scope ID, status, vaults, size) and the form to create a scope (name,
  optional slug, description, contact e-mail (required), enrollment mode, HIBP check on/off). Per scope: overview, the
  script tag, a ready-made prompt for Claude and a section for the app's own CLAUDE.md and AGENTS.md (each copyable; see below), settings (name, description, contact, HIBP), enrollment
  mode and join code (rotate), limits within the ceilings (byte limits entered in MiB, empty = default), co-admins (up
  to 20, Uni ID or e-mail address; the creator cannot be removed), vaults (ID, created, last write, size, members,
  blobs still to re-encrypt, state; delete vault, no contents), suspend and resume, the last audit entries and the full
  audit page, and "delete scope" after typing the scope ID.
- **Operator:** server state (disk use, read-only mode, the disk budget of §10.1), all scopes with creator, size and
  scope limit (the sandbox with a badge; its scope page is read-only and shows the wipe schedule, because the `[sandbox]` section of
  the configuration owns it); global defaults and ceilings read-only (they come from the configuration management); blocked Uni IDs (block, unblock; blocking
  ends the person's sessions); escrow status (number of vaults whose head names the current, the spare or another set);
  recovery requests and the recovery audit; the full audit log (`/operator/audit`). The operator can open and act on
  every scope.

**Prompt for Claude** (dashboard language) carries everything the developer's Claude needs and nothing it has to ask for: what the
service is and the official privacy sentence to repeat word for word, in English and German ("Data is end-to-end encrypted; the faculty holds a recovery key for emergencies." / "Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel."; `PRIVACY_EN` / `PRIVACY_DE` in `prompt.py`; llms.txt, integration.md and users.*.md carry the same words, `test_docs.py` checks; a text in a third language uses the English one, a longer text may follow); the scope's settings with an "as of" date (scope ID, enrollment with the
warning never to put a join code into the app, breach check mapped to "keep / remove `https://api.pwnedpasswords.com` in
`connect-src`", limits); the pointer to `llms.txt`; the exact script tag; the `WDS.connect` line and the forbidden patterns; a porting
line ("If the app already exists, follow 'Porting an existing app'"); for a test vault in the real scope (the deletion path of a migration) how to get the join code (ask the person when the step is reached and say what it is for; pass it only through the environment variable `WDS_JOIN_CODE`, which `tools/lib/drive-library.mjs` reads; never into a file or a command line; tell the person when the test ran so that they delete the test vault in the dashboard; the prompt does not name the dashboard, the hint texts next to the prompt and the join code tell the staff member that Claude may ask) or, for an open or closed scope, what to do instead; when the server has a sandbox, how to test against it and never to
write its ID into the app; running wds-verify from the public repository; and the instruction to add the **CLAUDE.md / AGENTS.md
section** (English, shown separately too) to the app's folder, keeping existing content. That section keeps the rules in the app's
repository for later sessions: the scope, read `llms.txt` before changing storage, keep the tag, no own storage or crypto, never the
sandbox ID, the join-code rule (only for a scope with the enrollment "join code"), current settings via wds-verify, rerun wds-verify after every change. Each sentence is one line, so the copy box wraps cleanly.

Built as follows:

- Routes under `/datastore/`: `/` (login page or my scopes), `/login` (start), `/_lpmiddleware/login` (callback),
  `/logout` (POST), `/scopes` (POST, create), `/scopes/{id}` and `/scopes/{id}/audit`, the form posts below a scope
  (`settings`, `enrollment`, `join-code`, `limits`, `admins`, `admins/remove`, `vaults/{v}/delete`, `suspend`,
  `resume`, `delete`), `/operator`, `/operator/audit`, `/operator/block`, `/operator/unblock`, `/privacy`. Forms
  are `application/x-www-form-urlencoded` (at most 64 KiB, parsed with the standard library) with a per-session CSRF
  token; requests marked cross-site (`Sec-Fetch-Site`) or with a foreign `Origin` are refused. Dashboard pages send
  `Referrer-Policy: same-origin` (with `no-referrer` browsers put `Origin: null` on our own forms).
- Login: the nonce cookie (`__Host-wds_login`, `SameSite=Lax` because it must survive the cross-site return) holds
  `<time>.<random>`, is valid for ten minutes and for one response. The callback answers with a small page that navigates
  on by meta refresh instead of a 303, because a redirect continuing the cross-site navigation would not carry the
  `SameSite=Strict` session cookie. Without a configured login.psi key file the dashboard says that login is not
  configured; the data API is not affected. `[dashboard] dev_login` replaces login.psi by a form for tests and local
  development only (the server logs a warning).
- Who gets in: operators; staff by the rule of §6; anyone listed as co-admin of a scope (by Uni ID or e-mail). Blocked IDs
  never get a session. Only staff and operators can create scopes, staff at most 5 active ones each. The matriculation
  number is checked and never stored. Denied logins are audited with the user ID.
- Sessions: `sessions` table, the cookie `__Host-wds_session` holds 32 random bytes (only the SHA-256 is stored), idle
  timeout 2 h and absolute timeout 12 h (`[dashboard] session_idle/session_absolute`). Authorisation is computed per
  request from the tables and the configuration, never cached in the session.
- A scope an admin suspended can be resumed by an admin; one the operator suspended (or suspended through the operator API)
  only by the operator, who can also take over an admin's suspension. Suspended apps can still read and export but not
  write (`403 scope_suspended`). Deleting a scope soft-deletes its vaults (purged after 30 days), wipes description, contact
  and join code, and the scope row goes with the last vault. The byte limits of all scopes together are checked against
  70 % of the data disk when a scope is created or a limit raised; limits below the largest stored value are refused.
- Audit entries of the dashboard are `user:<id>` or `operator:<id>`; all audit entries are deleted after one year by the
  maintenance sweep.
- `/datastore/privacy` is the Art. 13 GDPR page for both groups, app users and dashboard users (German by default,
  English with `?lang=en` or an English `Accept-Language`). Controller: the university; operation: the PSI chair. Its date
  and the sentence on VM backups come from `[privacy]` in the configuration; both are still placeholders ("wird
  festgelegt", §16). The create dialog of the library links to it through `privacy_url` of `GET /scopes/{scope}`
  (default `<public_base>/privacy`).

### 10.1 Quotas

| Limit | Operator default | Ceiling per scope | Set by scope admin |
|---|---|---|---|
| Max value size (plaintext) | 10 MB | 25 MB | ≤ ceiling |
| Bytes per vault (incl. history) | 200 MB | 1 GB | ≤ ceiling |
| Vaults per scope | 50 | 500 | ≤ ceiling |
| History versions | 10 | 50 | ≤ ceiling |
| Bytes per scope | 2 GB | 10 GB | ≤ ceiling |

- Defaults and ceilings come from `[limits.defaults]` and `[limits.ceilings]` in the configuration; scope admins set
  values within the ceilings on the dashboard, the operator API (`PATCH /admin/scopes`) can do the same.
- Data and local backups live on separate virtual disks (50 GB data disk, 50 GB backup disk, §12). The sum of all scopes'
  byte limits must stay below 70 % of the data disk (35 GB, i.e. 17 scopes at the default 2 GB); the dashboard refuses
  limits beyond that (operator can grow the disk). Disk use is measured with `statvfs` on the database directory.
- At 85 % disk use (`read_only_threshold`) the server enters read-only mode (`503 read_only`, `Retry-After: 3600`).
  Still allowed: reads, deletes, history purges, exports, dashboard logins and pages (creating a scope is refused), and the
  operations that do not grow data – protective roster versions (revocation, renewal adoption, escrow switch, epoch
  drop), rekey, redeem, passphrase change, key renewal, recovery (PROTOCOL 8.6).

## 11. Server

- Debian 13 packages only: `python3-starlette` (0.46.1), `python3-uvicorn` (0.32.0), `python3-nacl` (1.5.0, used for
  the login.psi SecretBox); no `python-multipart` (dashboard forms are `application/x-www-form-urlencoded`, parsed with
  the standard library), no other third-party package. Security fixes arrive through unattended-upgrades. No venv, no pip
  on the server; local development uses `.venv` with exactly these versions.
- Started as `/usr/bin/python3 -m wds_server --db <path> --config /etc/wiai-datastore/config.ini --host … --port 8000
  --forwarded-allow-ips <proxy address>`; uvicorn with access log off, no `Server` header, no WebSockets. One process; the
  Starlette app (`app.py`) has one module per endpoint group (`api_public`, `api_vaults`, `api_slots`, `api_records`,
  `api_admin`, `api_static`, `docs`, `dashboard`). Database work runs in a thread pool.
- Configuration (INI): `[sandbox]` (the public sandbox, §17), `[server]` (public base, client and docs directories, disk path, read-only threshold, sweep
  interval, privacy URL, library latest/deprecated), `[loginpsi]` (key file, app, URL), `[dashboard]` (operators,
  session timeouts, `dev_login`), `[privacy]` (date, backup sentences), `[limits.defaults]`, `[limits.ceilings]`,
  `[ratelimit]`, `[escrow]` (current and spare public keys, both required), `[operator]` (token hashes).
- SQLite in WAL mode, blobs inside SQLite, `synchronous=FULL`, `auto_vacuum=incremental`, `secure_delete=ON`,
  `foreign_keys=ON`; a pool of 16 connections. Schema migrations keyed on `PRAGMA user_version`; an older server refuses
  a newer schema.
- Tables: migration 1 `scopes`, `vaults`, `rosters`, `slot_ids` (every slot ID ever used per vault), `slots`,
  `keyring`, `records`, `record_versions` (history and tombstones), `recoveries`, `audit`; migration 2 `access_ids`
  (every access ID ever used; never purged) and `vaults.roster_bytes`; migration 3 the dashboard columns of `scopes`
  (description, contact e-mail, creator, suspended by), `scope_admins`, `sessions`, `blocked_users`; migration 4 the `meta` table (key/value, e.g. the last sandbox wipe). Vault byte usage is
  cached in `vaults.bytes` and adjusted in the same transaction as every write. Rate limits are in memory.
- Maintenance runs inside the service every `sweep_interval` (default 3600 s; also `python -m wds_server.cli
  maintenance`): purge vaults without records 7 days after creation and deleted vaults after 30 days, history pruning,
  removal of deleted scope rows without vaults, audit entries older than one year, expired sessions, incremental vacuum,
  WAL checkpoint. There is no separate timer.
- Serves, besides the API: `/datastore/` (dashboard, §10), `/datastore/privacy`, `/datastore/llms.txt`,
  `/datastore/docs/` (index), `/datastore/docs/<name>` (rendered HTML) and `/datastore/docs/<name>.md` (raw Markdown),
  `/datastore/client/…` (including `/datastore/client/hashes.json`, `no-cache`), `/datastore/export/` and `/datastore/export/wds-export.html`, `/datastore/healthz`; `/datastore`,
  `/datastore/docs` and `/datastore/export` redirect with `308`. The documentation is read from `docs/site` on every request;
  placeholders such as `{{script_tag}}`, `{{csp}}` and `{{escrow_ids}}` are filled from `client/dist/hashes.json` and the
  configuration, so a deploy is enough to update them. A small built-in Markdown renderer escapes all raw HTML.
- Response headers set by the app itself: HSTS, `X-Content-Type-Options`, `Referrer-Policy: no-referrer` (dashboard:
  `same-origin`); a nonce CSP on dashboard pages and `default-src 'none'` on documentation pages.
- No access log. Audit log for dashboard actions, operator calls, vault creation, roster changes (including
  revocations) and recoveries (no IPs).
- Command line: `python -m wds_server.cli create-scope` (development), `maintenance`, `sandbox status|wipe`, `operator-token` (generates a token
  and its hash).
- Tests: unittest for the server (`scripts/test-server.sh`, `server/tests`, including the dashboard, login.psi, privacy
  page and documentation routes); node and Playwright tests for the library and the dialogs against an in-memory fake of
  the API (`scripts/test-client.sh`); Playwright integration tests of the real server and the real bundle in Chromium,
  Firefox and WebKit (`scripts/test-integration.sh`, §8.6); tests of `wds-recover` and `wds-verify`
  (`scripts/test-tools.sh`).
- Client build: the vendored hash-wasm 4.13.0 Argon2id build (MIT; checksum in `client/vendor/SHA256SUMS`, npm tarball
  integrity in `client/vendor/README.md`); the library does not depend on a native Argon2 in WebCrypto, which browsers do
  not offer uniformly.

## 12. Infrastructure

The service runs on one virtual machine of the university (Debian 13) behind the university's reverse proxy, which serves
https://wiai.uni-bamberg.de/datastore/ (prefix not stripped, redirect from `/datastore`, body limit 32 MB) and writes no request
log for that path. The details of the installation (host names, addresses, firewall, backup jobs) are internal and not part of this repository.
What the design relies on:

1. **Packages and process.** Debian packages only (starlette 0.46.1, uvicorn 0.32.0, nacl 1.5.0), one hardened systemd unit
   running `python3 -m wds_server` as an unprivileged service user, with `--forwarded-allow-ips` set to the proxy's address
   (client IPs for the rate limiter come from `X-Forwarded-For` of that peer only).
2. **Disks.** A data disk for the SQLite database (XFS) and a separate backup disk; a nightly `sqlite3 .backup` with an integrity
   check keeps 2 copies. The in-service sweeps (§11) replace a separate maintenance timer. The virtual machine itself is covered by
   the university's backup jobs; the privacy page takes its backup sentence from the configuration (§16).
3. **Configuration.** `/etc/wiai-datastore/config.ini` is written by the configuration management of the operator. It holds the
   public keys of the escrow sets, the SHA-256 of the operator token and the other settings (see `server/config.example.ini`).
4. **Deploy.** A script runs the server tests, uploads `server/wds_server`, `client/dist` and `docs/site` to the VM and
   calls an install script (backup, restart, health check). Nothing in this repository is deployed by itself.
5. **login.psi.** The dashboard logs in through the university's login.psi; the application is registered there and its key file
   is installed on the VM (`[loginpsi] key_file`). Without the key the dashboard says that login is not configured; the data API runs regardless.
6. **Monitoring.** `/datastore/healthz` is checked by the university's uptime monitoring; a disk alarm is planned.

## 13. Documentation

Sources in `docs/site`, served by the app (§11), always for the deployed library version (the script tag, hash and CSP are
filled in at request time). Their public source is the repository https://github.com/UBA-PSI/wiai-datastore.

- `/datastore/llms.txt` – index for LLMs: what this is, the escrow exception, the rules that matter, links to the pages
  below, facts to quote correctly, the public repository for wds-verify, and the sandbox scope ID with its limits and wipe time (only when
  the server has a `[sandbox]` section).
- `/datastore/docs/integration.md` (also as HTML at `/datastore/docs/integration`) – for the developer's Claude: register a
  scope; the script tag and CSP; the API; where data lives; data modelling (one record per entity, files as separate
  records, `autosave` for editors); conflicts; members and sharing; export; errors; forbidden patterns (own crypto, own
  `fetch` to the datastore, CDN scripts, app data in browser storage, custom passphrase dialogs); running `wds-verify` and
  putting the report into the README and writing `wds-verify.json`; what to tell users; a complete minimal example app; deployment of the app;
  "Porting an existing app" (inventory, mapping, an import of the old export file that keeps ids and rewrites references, a tested one-time
  migration of old IndexedDB/localStorage data that the owner runs once and that deletes the old data only after a verified copy, never in the
  sandbox unless wds-verify sets its test global; round E added Blobs and key-value stores, a fingerprint over the bytes of every Blob,
  settings that are applied exactly once (`migratedSettings()`, `settingsDone()`, `fillGaps` before the app writes defaults), the tag per
  browser with a decision table for `tagged: false`, a strict `toNewRecords`, ids with `-` and `%`, the same-origin condition, and the test
  of Step 6 with a `seed` block and a test vault in the developer's own scope); collections, two devices, files, conflicts in code,
  lock and unlock again; the sandbox; the table of the library's dialogs and `drive-library.mjs` for own end-to-end tests. Downloads the person asks for and forms with `preventDefault` under `form-action 'none'` are
  allowed and say so. The code recipes run in three engines against the real server (`examples/docs-recipes.spec.mjs`).
- `/datastore/docs/users.de.md` and `users.en.md` – for app users: passphrase, access ID, key file and recovery code, new
  device, sharing, conflicts, what the faculty can see (escrow), recovery, export.
- `/datastore/docs/operator.md` – places, escrow key handling, recovery, quotas, read-only mode, deploy and releasing a
  library version, backups and restore, escrow key compromise.
- `/datastore/docs/` – index of these pages; `/datastore/export/` – the export tool (§8.3).
- The privacy notice is not a Markdown page but the server-rendered `/datastore/privacy` (§10).

## 14. User processes

- **Developer:** dashboard → create scope → copy the prompt for Claude (it contains the script tag and the CLAUDE.md /
  AGENTS.md section) → Claude integrates (or ports an existing app) using `llms.txt` and `integration.md` → Claude runs
  `wds-verify` (mock or sandbox) and puts the report into the README → share the HTML file and the join code.
- **Trying the service without a scope:** any developer's Claude can run an app against the public sandbox (`wds-verify --target
  sandbox` or `--sandbox-copy`); data there is deleted every night.
- **New user:** open app → "Create my vault" (join code if required) → passphrase → download/print access sheet and
  key file → work.
- **Other device / cleared browser:** drag in the key file or type the access ID → passphrase.
- **Share:** owner → Share → role, expiry → invite code → recipient enters it, chooses a passphrase → owner sees
  "redeemed".
- **Revoke:** owner → Share → revoke → progress bar while re-encrypting (resumes later if interrupted).
- **Forgotten passphrase:** recovery procedure (§5.9).
- **App retired:** scope admin deletes the scope after warning; vaults soft-deleted, purged after 30 days; users can
  export via the app (`exportAll`) or `/datastore/export/` (before the deletion).

## 15. Work packages

| # | Package | State |
|---|---|---|
| 1 | Spike: crypto core (envelope, Argon2id, slots, roster signatures, keyring, ECIES) with test vectors; `file://` behaviour | Done: `PROTOCOL.md`, `client/test/vectors.json`; `file://` behaviour covered by the integration tests in Chromium, Firefox, WebKit (§4). Open: Argon2 timing on faculty hardware, real Safari and Edge. |
| 2 | Server API, SQLite, envelope checks, rate limits, quotas; unittest | Done (`server/wds_server`, `server/tests`). `wds-verify` uses a local copy of the real server instead of a mock mode. |
| 3 | Library: dialogs, conflicts, sharing, revocation and re-encryption, export; browser tests | Done (`client/src`, `client/test`). Version 1.0.0 not frozen yet. |
| 4 | `wds-verify` | Done (`tools/wds-verify.mjs`, `tools/lib`, `tools/test`). |
| 5 | Dashboard (login.psi, de/en), audit, privacy page | Built, tested and deployed; login.psi application registered; first real login pending. |
| 6 | Escrow tools `wds-keygen`, `wds-recover`; operator documentation | Done; production escrow keys generated and pinned. |
| 7 | Infrastructure (§12) | VM, proxy, deployment role and script done; monitoring open. |
| 8 | Documentation, example app, pilot with one real app | Documentation, export page and example app done and deployed; porting trial of an existing app done (round D); clean-room porting trial done (round E); public sandbox deployed; pilot with one real app open. |

## 16. Open points

- **A clean-room trial with an unrelated app.** The clean-room trial of round E (a Claude with only the public documents and repository)
  passed wds-verify in the public sandbox, but its app was the predecessor of `examples/zeit-notizen`, so it copied the example and wrote only
  scope, privacy text, import and migration. It says little about how far the documents carry an app that does not derive from the example
  (conflict UI, roles, lock were not thought through anew). Next trial: an app with its own structure.
- **Deferred from round D:** `wds-verify --role read` (testing an app as a read-only member) and a Claude skill/plugin for the service.
- **Freeze library version 1.0.0** (`node client/build.mjs --freeze`) before the first app embeds its tag; every later
  change then needs a new version number.
- **Monitoring:** a disk alarm and the uptime check (§12).
- **Data protection:** entry in the processing register; the privacy page's date (`[privacy] updated`) and the sentence on
  VM backups (`backup_retention_de/en`) are placeholders; a backup retention for the virtual machine versus the 30-day purge and the revocation promise of §2; wording of the escrow notice.
  Still open: who is controller for app data (faculty vs. scope admin). The privacy page names the
  university as controller for the storage service and tells app developers that they need their own notice for the
  content of their app.
- **Argon2id timing** on faculty hardware (target under 2 s, §5.2) has not been measured; real Safari, Edge and Electron
  are untested (§4).
- **`list()` and export cost:** names exist only inside the encrypted records, so `list()` downloads every new or changed
  record once per session and an export reads every record twice. An encrypted index record would avoid it (spec change).
- **Member labels are unverified** (§8.5); signing them with the owner's `S` key would make them verifiable. Not in v1.
- Multiple human owners per vault: deferred beyond v1 (needs rules for owner removal).
- **Hostname is permanent in practice:** every distributed app hard-codes the library and API URL, and library URLs are
  immutable. `wiai.uni-bamberg.de/datastore/` must therefore stay valid (or be redirected, including CORS and SRI
  behaviour) for as long as apps exist. The operator decided to keep this address; a later move would need such a
  redirect.

Resolved since the design: scope creation is open to staff of all faculties (confirmed by the operator); the address is
fixed (above); the `file://` questions of work package 1 (CSP without `'self'`, SRI from `file://`) are answered by the
integration tests and did not change §9.3.

## 17. The public sandbox

**Decision (operator).** The service offers one public scope, `sandbox-000000`, so that any developer's Claude can run an app end to end against the real service without Python and without filling a real scope
with test vaults. It is configured in the server configuration (`[sandbox]`), not on the dashboard: enrollment open without a join code, small quotas (default 512 KB per record, 2 MB per vault, 2 versions, 500
vaults), every vault deleted every night after the configured wipe time (03:30 Europe/Berlin; the maintenance sweep runs it, so up to an hour later), the breach check off.

- **Wipe.** At the first sweep after each scheduled instant T the server purges every sandbox vault with `created < T`, soft-deleted ones included, one transaction per vault, then records T in a `meta` table.
  `access_ids` rows stay (random, no personal data; an access ID is never reused). The scope document carries `sandbox: { enabled, wipe_at, timezone, next_wipe, last_wipe }`.
- **No recovery, and no separate escrow key set.** A vault of the sandbox is created with the faculty's pinned escrow keys like every other vault, because the client library has one fixed set of pins and a second set would
  need a second build or a runtime exception in the library that every app would have to trust. The decision: technically the escrow key opens sandbox vaults, but the server refuses every recovery and escrow request for them
  (`409 sandbox_no_recovery`), the contact address is discarded, the access sheet shows no recovery code, and the privacy page says that abuse is answered by switching off or wiping, never by opening a vault.
- **Labelling.** The library prefixes every dialog title ("Sandbox: ..."), shows a banner in every dialog (with inline `!important` styles, so that app CSS cannot hide it) and a persistent bar after unlocking; wds-verify
  fails an app that hides it. A remembered access ID older than the last wipe is forgotten with a notice. Invites are limited to 3 per vault and expire before the next wipe; the share dialog offers only that choice.
- **Capacity and abuse.** When the sandbox is full, the oldest vaults that were created and last written at least 30 minutes ago are evicted. Creation is limited per IP bucket (IPv6 /56), for the sandbox as a whole
  (503 `sandbox_busy`), and by the normal creation limit; a vault its owner deletes gives its creation back. The operator can switch it off (`enabled = false`) or wipe it (`sandbox wipe`).
- **Never in an app.** The sandbox ID must not appear in an app file (the data would vanish nightly): wds-verify fails such a file; `--target sandbox` and `--sandbox-copy` replace the app's own scope ID (the one
  `WDS.connect` uses) in a copy.

## Review log

Adversarial review (Fable), first round. Findings and what changed:

| # | Finding | Resolution |
|---|---|---|
| 1, 4 | Crash during rotation loses data; revoked member keeps access until commit | Revocation is one atomic call that stores new keys first and deletes the slot; re-encryption afterwards, resumable (§5.8) |
| 2 | Recovery could be requested for someone else's public access ID | Recovery code on the access sheet; without it, written confirmation plus 7-day waiting period with owner notice; old owner slot not auto-revoked (§5.9) |
| 3 | Entropy checks reject valid ciphertext | Removed; structural checks only (§7.4) |
| 5 | Eager rotation of current records only leaves history readable and costs history slots and quota | Rekey in place for current and history versions, no new history entries (§5.8); decision "re-encrypt all" |
| 6 | Recovery and multi-owner could not update other members' keyring entries | Keyring entries encrypted to members' public keys; escrow owner-class with signing key; multi-owner defined (§5.1, §5.6, §5.7) |
| 7 | login.psi has no groups | Staff rule via e-mail domain + no matriculation number (decision); `next` validation and single-use nonce (§6) |
| 8 | Cookie path is no boundary | `__Host-` cookie, origin documented as trusted base (§6) |
| 9 | Proxy logging, path pattern, redirect, headers | No request log for the path, `path: /datastore/`, redirect, headers set by the app (§11, §12) |
| 10 | Lockouts enable denial of service; IP behind proxy; NAT; junk vaults | Flat rate limits, forwarded IPs from the proxy, 30/h, enrollment modes (§6) |
| 11 | Pinning and version kill switch strand old apps | Pinned spare escrow key; reads/exports never blocked; standalone export page (§5.9, §8.3) |
| 12 | CSP blocks WASM | `'wasm-unsafe-eval'` (§9.3) |
| 13 | Rollback claims too strong | Persisted version state, no version reuse after tombstones, signed rosters, AAD on keyring; limits stated (§5.5) |
| 14 | Downgrade floor too low, server-chosen salt | Floor = defaults; salt/params pinned per access ID (§5.2) |
| 15 | 12-character passphrases vs. offline attack | Kept own passphrases (decision); stronger checks; risk stated in user guide (§5.2, §5.3) |
| 16 | Disk arithmetic, history purge, blocking I/O, pip deps without updates | 2 local backups, disk cap on quota sum, purge endpoint, read-only mode at 85 %, thread pool, Debian packages (§10.1, §11) |
| 17 | Typical mistakes in Claude-built apps | Storage/console/download scanning, `autosave`, no dialog replacement, SRI script tag instead of inlining (§8, §9) |
| 18 | Invite interception, unknown redeemer | 48 h default expiry, redemption shown to owners, "renew my keys" (§5.8) |
| 19 | Fake KDF responses | Removed; 96-bit access IDs (§3, §7.1) |
| 20 | Read-only limits, base64 size blow-up, rapid saves wipe history | Documented; binary records; 10-minute history floor (§5.4, §5.7, §7.3) |
| 21 | GDPR, HIBP to US service | Open point; HIBP switchable per scope (§5.3, §16) |
| 22 | Access ID lost with browser storage | Key file and access sheet (§3) |

### Round 2

Second adversarial review of the revised plan. Findings and what changed:

| # | Finding | Resolution |
|---|---|---|
| 1 | Server could forge keyring entries with its own content key, or present a self-made vault | Roster signs key commitments per epoch and for NK; clients check keyring keys against them; vault ID inside every wrapped slot blob and on the access sheet (§5.5, §5.6) |
| 2 | Unauthenticated public keys at renewal/redemption | Every slot has an `S` key; renewals signed with the previous key; automatic at redemption (§5.8) |
| 3 | Rekey could rewrite history undetectably; concurrent rekeys | Immutable per-version commitments; `If-Match` on old epoch (§5.5, §5.8) |
| 4 | Roster chain without hash link, numeric pins | Hash-chained, head hash pinned, compare-and-swap on POST; fresh-device limit stated (§5.6, §2) |
| 5 | Owner-vs-owner eviction; escrow omittable | One human owner in v1; rosters without escrow slot rejected (§5.6, §5.7) |
| 6 | Recovery code is a bearer credential; code-less fallback baseless; notice suppressible | 72 h waiting period even with code; code-less only via optional recovery contact; notice derived from roster chain; founder acknowledgement (§5.9) |
| 7 | Escrow key compromise permanent for immutable libraries | Spare stored separately; response procedure; advisory banner (§5.9, §8.3) |
| 8 | localStorage pins forgeable/absent on `file://` | No TOFU; salt/params/access ID bound in AAD with floor and ceiling; rollback state MAC'd and keyed by access ID (§5.2, §5.5, §8.4) |
| 9 | Disk arithmetic; which operations work read-only | Separate backup disk, 70 % cap, explicit allow-list (§10.1, §12) |
| 10 | Per-ID limit is a lockout again; open enrollment default | Correct tokens never throttled, per-ID limit only per source IP; join code default; empty vaults purged (§6) |
| 11 | Remnants after revocation | `secure_delete`, backup window stated, client-side check before dropping old keys (§5.8) |
| 12 | Stale-epoch writers | `409 epoch_changed` with one automatic retry (§5.8) |
| 13 | Hostname permanence, dashboard as hash source, export without SRI, blank page offline, dialog overclaim | Open point on hostname; hashes in repo and `wds-verify`; export as a file; `onerror` fallback; wording fixed (§8, §16) |

Cut after review: fake KDF responses, lockouts, rotation lock (`423`), "theirs" inside `412`, gzip flag, "remember on
this device", versioned doc paths, NUL/chi-squared checks.

### Round 3 (client review)

Adversarial review of `client/`. Findings and what changed:

| # | Finding | Resolution |
|---|---|---|
| 1 | A founder adopting the key renewal of a faculty-added owner bricks the vault (chain rule rejects, server accepted) | Only an owner adopts its own renewal; the server refuses other owners' key changes on owner slots (PROTOCOL 6.3 (b) is for non-owner slots) (§5.7) |
| 2 | Owner slots could never be revoked, contradicting §5.9 step 4 | Decision in §5.7: an owner may revoke faculty-added owner slots, a faculty-added owner may revoke other owner slots; API, share dialog and tests |
| 3 | The escrow pin was enforced on every historical roster version; an escrow-key rotation would strand every old vault | Retired escrow sets valid for history, time limit for escrow-signed versions, owner-side migration in `maintain()` (§5.9) |
| 4 | Local rollback state not bound to scope, vault, access ID, slot; "cannot lower" overstated | State names its owner; wording weakened (§5.5) |
| 5 | Bundle exposed test hooks and the global hash-wasm; AMD loaders broke Argon2id | Bundle in one scope, private hash-wasm, hooks stripped (§8.4, §8.6) |
| 6 | `escrowPins` option could replace the pinned escrow keys in production | Ignored by builds that have pins (§5.9) |
| 7 | Session keys kept as raw bytes although WebCrypto could hold them | Non-extractable CryptoKeys for K_wrap, K_commit, K_state, K_id (§8.4) |
| 8 | Member labels trusted although any write member can write them | Shown as unverified, with slot IDs (§8.5) |
| 9 | Recovery acknowledgement asked again at every unlock | Remembered per access ID and slot (§5.9) |
| 10 | Vendor README pointed at a test that does not exist | Fixed, tarball integrity recorded |

### Final review of workflow A

Review of server, client and integration tests together. Findings handed to workflow B and how the code resolves them:

| # | Finding | Resolution |
|---|---|---|
| 1 | `cancelInvite()` removed an unredeemed but used invite without an epoch bump; the server answered `409 revocation_required` | A used invite is withdrawn by a revocation; `cancelInvite` falls back to it (§5.8) |
| 2 | The client checked fetched record envelopes against the scope's current `max_envelope_bytes` (reads and rekey) | Reads and rekey are bounded by the ceiling only (§5.4, §8.3) |
| 3 | In recovery mode the server checked only that one owner invite is added and nothing removed | The server accepts exactly what the client verifier accepts: same epoch and commitments, existing slots unchanged (§5.6, §5.9) |
| 4 | Record `PUT` compared only record bytes with `vault_bytes` and `scope_bytes` | Roster bytes count toward both quotas (§5.6) |
| 5 | The chain verifier accepted the escrow slot being replaced by a slot with a new ID | The escrow slot keeps its slot ID; server and client refuse a replacement (§5.6) |

`PROTOCOL.md` was brought in line with the code (unredeemed invite tokens, roster growth limits, escrow retirement, local
state fields, rekey answers).
