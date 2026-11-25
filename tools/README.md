# Tools

Operator and developer tools of the WIAI Datastore (public repository: <https://github.com/UBA-PSI/wiai-datastore>). Node >= 22 (developed on Node 26), no runtime
dependencies; the only library code is `../client/src/wds-core.js`. Playwright is a devDependency (`npm install` in this directory, or the copy in
`../client/node_modules`), used only by the dynamic part of `wds-verify`.

| Tool | For | Needs |
|---|---|---|
| `wds-keygen.mjs` | Operator: create an escrow key set (`--label current\|spare --out <dir>`). | nothing |
| `wds-recover.mjs` | Operator: recover a vault for a user (PLAN 5.9, PROTOCOL 9). | operator token, escrow private key file |
| `wds-verify.mjs` | Developer (and the developer's Claude): smoke test of an app before it is shared. | static: Node. dynamic: Chromium, and Python 3.13 venv (mock) or the public sandbox |

## wds-recover

```sh
node tools/wds-recover.mjs start    <vault-id>                      # asks for the recovery code; starts the 72 hour waiting period
node tools/wds-recover.mjs start    <vault-id> -                    # the code from stdin: echo CODE | node tools/wds-recover.mjs start <vault-id> -
node tools/wds-recover.mjs start    <vault-id> --contact            # recovery contact: 7 days (the operator checks the contact by mail first)
node tools/wds-recover.mjs status   <vault-id>
node tools/wds-recover.mjs cancel   <vault-id>
node tools/wds-recover.mjs complete <vault-id> --escrow-key ~/wiai-datastore-escrow/wds-escrow-current-private.json
```

The recovery code is a credential that starts a recovery, so it is not taken from the argument list (shell history, `ps`): the tool asks for it, or reads stdin.
A code given as an argument still works and triggers a warning. The tool refuses to send the operator token to a `--base` that is not https (localhost, 127.0.0.1 and [::1] excepted).

Common options: `--base <url>` (default `https://wiai.uni-bamberg.de/datastore`), `--token-file <file>` (default
`~/.config/wiai-datastore/operator-token`), `--json`. `complete` also takes `--expires-in-hours` (default 72, at most 359: the server refuses invites that expire more than 15 days after its own clock, so one hour is left as margin),
`--dry-run` (everything except the upload) and `--yes` (no question; required when there is no terminal).

`complete` fetches the escrow material, checks the roster chain, opens the escrow keyring entry with the escrow private key and
checks it against the signed commitments, builds a roster version that adds exactly one owner invite and nothing else, signs it
with the escrow signing key, verifies the whole chain with the client library's own verifier, uploads it and prints the invite
code. The user redeems it in their app; the old owner slot stays until the user revokes it. The escrow private key file is read
into memory only. The tool writes no file, and it never prints the token or the key. Exit codes: 0 done, 1 failed, 2 usage error or
the waiting period is not over.

Which escrow key file? The roster of the vault names the key set of its escrow slot; `complete` says so when the file does not
match. Vault IDs are on the key file of the user (`"vault"`), and in the dashboard.

## wds-verify

```sh
git clone https://github.com/UBA-PSI/wiai-datastore && cd wiai-datastore       # the tool lives in the public repository
node tools/wds-verify.mjs path/to/app.html            # or a directory with index.html
node tools/wds-verify.mjs app.html --out REPORT.md    # the Markdown report goes into the app's README
node tools/wds-verify.mjs app.html --target sandbox   # run against the public sandbox: no Python, no build
node tools/wds-verify.mjs app.html --sandbox-copy app-sandbox.html   # a copy for a person to open in a browser
node tools/wds-verify.mjs app.html --static-only      # no browser, no Python
node tools/wds-verify.mjs --script-tag                # the script tag and CSP meta tag to paste into an app
```

Setup: Node >= 22, then `(cd tools && npm install && npx playwright install chromium)`. For `--target mock` also
`python3.13 -m venv .venv && .venv/bin/pip install -r server/requirements.txt` (or `uv venv --python 3.13 .venv`) in the clone;
the mock builds the library from `client/src`. The sandbox target needs neither Python nor a client build; the static checks need
only Node.

### Targets

`--target auto|mock|sandbox` (default auto). The first line of the report names the target and why.

- **mock**: the real server runs locally with a temporary database (`../.venv`, or `WDS_PYTHON`), the datastore host is mapped to it
  and the library bundle is built from `client/src` with the mock's escrow keys pinned. Everything is inspected, including the server's database.
- **sandbox**: the app opens against the public sandbox scope of the real service (`sandbox-000000`: open enrollment, small quotas,
  all data deleted every night). The page copy keeps the production library tag; the scope that `WDS.connect({ scope })` uses (a string literal, or a constant of the same script that holds one) is replaced
  by the sandbox ID, and nothing else that merely looks like a scope ID (element IDs, class names); without such a call the run stops with a message; datastore requests go through, everything else is blocked. The server's database is not inspected (request bodies still are).
  Differences to the mock: the breach check is off in the sandbox (`pw.hibp.unavailable` is not a finding); records are limited to
  the sandbox size (a quota error becomes "sandbox limit, not tested"); the library's sandbox banner and bar must stay visible to a person
  (an app that hides them fails); at the end the tool deletes its vault if the library offers a way (else it is left for the nightly wipe).
  When the sandbox is rate limited, full or switched off, the run stops with "sandbox unavailable, not an app finding" and exit code 3: try again later.
- **auto**: mock when Python 3.13 with the server packages is found; otherwise the sandbox if its scope document is reachable and enabled; otherwise only the static checks run, with a warning that says why.

`--sandbox-copy <out.html>` writes a copy of the app with the scope of its `WDS.connect` call replaced by the sandbox ID and exits (the file name must contain
"sandbox"). Open that copy in a browser to try the app by hand against the sandbox. Never ship the copy and never put the sandbox ID into the app itself:
the static checks fail a file that contains it.

### Checks

Static: one script tag `https://wiai.uni-bamberg.de/datastore/client/wds-<version>.js` with `crossorigin="anonymous"` and the
`integrity` hash of that version. The published hashes come from `https://wiai.uni-bamberg.de/datastore/client/hashes.json` first (3 s timeout),
then from `client/dist/hashes.json` of the clone; the report names the source and warns when they differ (the clone is outdated; `git pull`).
`--hashes <file>` overrides both. A CSP meta tag that is not broader than the recommended one (the policy of `docs.csp_policy`, printed in
integration.md; additions of `font-src data:`, `media-src blob: data:` and `img-src https://host` are accepted, `'self'` in `script-src` or a missing
`base-uri` / `form-action` fail), placed before the first script; no other scripts; no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` or form
action to the datastore host outside the library. New: the sandbox scope ID anywhere in the app fails; CSS that sets `display`, `visibility` or `opacity` on
`.wds-` classes or `[data-wds...]` elements fails (it would hide the library's dialogs or the sandbox label); `indexedDB.deleteDatabase` and
`localStorage.removeItem` / `.clear` in a function that never mentions "sandbox" warn (a one-time migration must not delete the old local data in the
sandbox), `localStorage.clear()` always warns. Code that assigns `window.__WDS_MIGRATION_TEST__` fails (section "Testing a migration"). An info finding **Privacy sentence** says when neither the page nor the `README.md` next to it contains the official sentence of the service (English or German; use the English one for other languages).

Scope check (every target that has network): the public scope document of the app's own scope ID is fetched. Unknown scope: fail. The breach check
(`hibp`) on while `connect-src` lacks `https://api.pwnedpasswords.com`: fail (vault creation would show an error); off while the host is still allowed: warn.
The report prints the current enrollment, breach check and limits. Offline: an info line "scope settings not checked".

Dynamic: the app runs in Chromium from a `file://` URL. The library's dialogs are driven by their stable attributes (`data-wds-view` on the dialog,
`data-wds` on every control), so a German or any other locale works; only the app's own buttons are found by their text. The tool creates a vault
through the library's dialog, fills every input, textarea and contenteditable with a unique canary string (the first free-text field key by key),
presses the buttons whose text contains save, speichern, add, hinzufügen, ok (and similar) and every element marked `data-wds-verify="save"`, runs the steps of
`wds-verify.json`, then **reloads the page, unlocks again with the passphrase and checks that the typed values are visible again** (the app has to read its data
back on start). Canaries and the vault passphrase are searched for in every request URL, header and body, page URLs, WebSocket frames, localStorage,
sessionStorage, IndexedDB, Cache Storage, cookies, console output, downloads (except those of `exportAll` and the ones a `download` step asks for) and,
in the mock, the server's database: raw, URL-encoded, base64 (three alignments), base64url, hex, UTF-16LE. It warns about a record written three or more times within a
second without a button press in between (use `store.autosave`) and about one record that holds the data of several items or the whole app state. It fails
when nothing was stored at all, because then it proved nothing.

**Data after reload.** After the reload the tool looks at what a person can read (the page text and the values of the inputs on screen) once right after the unlock and once after **every**
`afterReload` step, and takes all of them together: an app with tabs passes when one `afterReload` step per tab opens each view. Pass: at least one typed value of every round
(the tool's first and second round, the steps) is visible in some of those views. Only values that the app showed as text before the reload (the tool looks at the page text after its first round and after every step) or wrote to the store (the page instrumentation sees what `set`, `autosave` and the collections' `add`, `set` and `autosave` are given) are expected back: input that the app rejected, such as a duration it cannot parse or an entry without a project, is neither and is left out, and the detail says how many values that were. A value that only ever sat in an autosaved field counts as written, so an editor that is not read back is reported. If there is no such value at all, every value counts. Fail: records were written, no typed value is visible and the file has no `afterReload` steps.
An `afterReload` fill step whose text contains a value typed before the reload fails (the tool reads field values too and would "find" the text it typed itself): use another text or `{canary}`.
Warn: otherwise ("x of y values visible after the reload; the others are in views the tool does not open"; add `afterReload` steps for those views).

**Library version released** (info) says that the published hash of the library version your page uses is not frozen yet. It is about the library, not about your app, and never fails `--strict`.

The report ends with **Not tested**: what a run cannot see (a second device and conflicts, read-only members, lock and unlock again in one page, buttons the tool does not
press, file inputs without an upload step, fields in views no step opens, dialogs of the app itself). Test those by hand.

### wds-verify.json

Put it next to the app. An object; a bare array is an error. Everything is optional.

```json
{
  "locale": "de-DE",
  "steps": [
    {"click": "#tab-notes"},
    {"fill": ["#title", "a unique text of at least six characters"]},
    {"select": ["#project", "p1"]},
    {"press": ["#title", "Enter"]},
    {"upload": ["#cover"]},
    {"download": "#csv"},
    {"wait": 500}
  ],
  "afterReload": [ {"click": "#tab-notes"}, {"click": "#tab-files"} ],
  "seed": {
    "page": "old-app.html",
    "steps": [ {"fill": ["#title", "old note {canary}"]}, {"click": "#save"} ]
  }
}
```

| Key | Meaning |
|---|---|
| `locale` | Language of the browser (BCP 47), default `en-US`; `--locale` overrides. The library's dialogs follow it unless the app sets one. |
| `steps` | Run after the tool pressed the buttons it recognised. |
| `afterReload` | Run after the reload and the unlock: open the tab, the list, the dialog that shows the data. The tool looks for the typed values after the unlock and after every step, and takes the union. |
| `seed` | Tests the migration of old local data (below): `{ "page": "<old local-only app, relative to this file>", "steps": [ ... ] }`. |

Steps: `click` selector; `fill` [selector, text] (the text is searched for like a canary); `select` [selector, value]; `press` [selector, key], for example `Enter`;
`upload` [selector] (a generated PNG whose name and bytes are searched for like canaries) or [selector, path] (your own file, relative to `wds-verify.json`; its name is searched for);
A fill text may contain `{canary}`, which becomes a unique generated token (letters and digits, so every field takes it) that the tool searches for like its own canaries.
`download` selector (clicks and expects a download; reported as "user-requested download" with "contains canaries: yes/no", never as a leak, while a download at any other
time stays a failure); `wait` milliseconds. An invalid file is a usage error that names the step and the allowed forms.

### Testing a migration (the `seed` block)

An app ported from a local-only version has to carry the old data over (integration.md, section 16). The `seed` block makes the tool play that story: it opens the **old** app in the same
browser context as the new one (`file://` pages share localStorage and IndexedDB, so the new app finds the old data like a returning user's browser would), runs the seed
`steps` there (the same step forms; `{canary}` in a fill text gives a value the tool can search for), opens the new app, creates a vault, and then runs the app's normal
`steps`. In a run with a seed the `steps` come first (right after the vault exists), so their first steps answer the migration prompt of the app, for example
`{"click": "#migrate-yes"}`; the tool types its own canaries only into fields that are still empty. Requests, console output and downloads of the old page are not counted.

```json
{
  "seed":  { "page": "old/index.html", "steps": [ {"fill": ["#title", "old note {canary}"]}, {"click": "#save"} ] },
  "steps": [ {"click": "#migrate-yes"} ],
  "afterReload": [ {"click": "#tab-notes"} ]
}
```

What the report says (ids `seed`, `migration-visible`, `migration-encrypted`, `migration-old-data`):

- **Seed: the old app**: after the seed steps the typed values must be in the old app's storage (localStorage, IndexedDB; Blobs and Files are read). Otherwise the migration has nothing to migrate: fail.
- **Migration: old data visible**: the seeded values are visible text in the app **after reloading the page and unlocking the vault** (the start view and every view an `afterReload` step opens, together), so they came out of the vault: a prompt that lists the old titles, or a screen that shows the old storage directly, before the reload does not count. None: fail (also when the app wrote no record at all); some: warn. In the sandbox the old data stays, so a prompt or a screen that lists it cannot be told from the copy there: the deletion run (mock, or `--migration-delete`) is the proof.
- **Migration: old data only encrypted**: no seeded value appears in a request (URL, header, body), WebSocket frame, console line, Cache Storage, cookie or (mock) the server's database. The old app's own storage keeps them by design;
  a seeded value in any **new** place (another localStorage key, another IndexedDB store, an old place that **grew**) is a leak like any other canary. A backup download of the old data that the app offers is not a leak **when it is a JSON file**; any other download of the old data is.
- **Migration: old data deleted / kept in the sandbox**: with the **mock** target the migration runs as in production (`store.status().sandbox` is false) and **everything** that the old app stored must be gone afterwards: the tool takes the whole old storage after the seed steps (every localStorage key, every IndexedDB store with rows, not only the places that hold a typed value) and lists what is left by name. Fail when the migration visibly ran (a store that the recipe adaptation forgot in `OLD.stores`, a settings key); warn when it did not (see "old data visible"). `"seed": { ..., "keep": ["some-key", "db/store"] }` names what may stay on purpose (the migration's own tag key is not in the old storage after the seed, so it needs no entry).
  A seed page with a file input and no `upload` step is pointed out (**Seed: files of the old app**, warn): the Blob stores are then not exercised.
  With the **sandbox** target the recipe keeps the old data, and the tool checks that it is **still there** (fail if the app deletes in the sandbox). To exercise the deletion path in the sandbox as well, run again with
  **`--migration-delete`**: the tool then sets the global **`window.__WDS_MIGRATION_TEST__ = true`** (and makes `navigator.webdriver` true) in the page before any script of the app runs, and expects the old storage to be empty afterwards. The migration of
  the docs honours the global only together with an automated browser (`keepInSandbox`: `st.sandbox && !(window.__WDS_MIGRATION_TEST__ === true && navigator.webdriver === true)`); nothing else reads it, and the library does not know it. The report starts with a line that names the flag; on the mock target the flag has no effect (an info finding says so).
  The app must never set the global itself: the static check **The app sets the migration test global** fails a file that assigns it, and the dynamic run fails a page that has it set although this run did not set it. In a person's browser such an assignment would delete the old data of a sandbox vault that is wiped tonight.

`--migration-delete` without a `seed` is a usage error, and so is a `seed.page` that is not a file. The "Not tested" list names what stays open: real-size data, and the case that the old app is used while the migration runs.

### Options

Options: `--target`, `--locale`, `--sandbox-copy`, `--migration-delete`, `--static-only`, `--hashes <file>`, `--out <file>`, `--strict` (warnings fail), `--headed`, `--wait-ms <n>` (time for debounced
saves, default 2800), `--script-tag [version]`, `--json`. Exit codes: 0 passed, 1 a check failed, 2 the tool could not run (no Python venv for `--target mock`, no Playwright, bad arguments),
3 the sandbox is unavailable (rate limited, full, switched off): not an app finding, try again later. The result is a smoke test, not a proof.

Environment (for tests and for pointing the tool at another service; not needed otherwise): `WDS_PYTHON` (the Python of the mock), `WDS_VERIFY_SERVICE` (base URL of the service,
default the production one), `WDS_VERIFY_HASHES_URL` (or `off`), `WDS_VERIFY_OFFLINE=1` (no optional online lookups: hashes and scope check), `WDS_VERIFY_LIBRARY` (a library file that the sandbox target serves instead of
the production one, for a local mock with a `[sandbox]` section).

## drive-library.mjs: the library's dialogs in your own Playwright tests

`tools/lib/drive-library.mjs` is what wds-verify uses to create a vault and to unlock it. It drives the dialogs of the library by their stable attributes (`data-wds-view` on the
dialog, `data-wds` on every control; the list is in `client/README.md`), so it works in every language. Import it from a clone; Playwright is the copy in `tools/node_modules`
(`npm install` in `tools/`) or your own. The app (a copy that talks to the sandbox or a local mock, see `--sandbox-copy`) calls `store.unlock()` as usual; the helper answers the dialogs.

```js
import { chromium } from 'playwright';
import { createVault, unlock } from '/path/to/wiai-datastore/tools/lib/drive-library.mjs';

const page = await (await chromium.launch()).newPage();
await page.goto('file:///path/to/app-sandbox.html');
const { accessId, passphrase } = await createVault(page);   // the app has called store.unlock() at start: answer the dialogs
// ... the test uses the app ...
await page.reload();
await unlock(page, { accessId, passphrase });         // the unlock dialog of the second visit
```

| Export | |
|---|---|
| `createVault(page, { passphrase?, joinCode?, confirm = true, timeout })` | The unlock dialog is open: create a new vault (unlock, create, access sheet, confirmed). Resolves `{ accessId, passphrase }`; the passphrase is generated unless you give one. `confirm: false` stops at the access sheet. For a scope with the enrollment "join code" the code is `joinCode` or, by default, the environment variable **`WDS_JOIN_CODE`** (set it in the shell that runs the test, never in a file; it is never printed and no error contains it); without a code the call throws a `DriveError` that names the variable. |
| `unlock(page, { accessId?, passphrase, timeout })` | The unlock dialog is open: unlock an existing vault. Resolves when the dialog is gone (or shows a notice or sheet the caller answers); `accessId` is needed unless the library remembers it. |
| `confirmSheet(page)` | The access sheet is open: read the access ID, tick "I have saved it", continue. Resolves the access ID. |
| `dialog(page)`, `viewOf(page)`, `waitForView(page, view \| [views] \| null, { timeout })` | The topmost dialog (a locator), its `data-wds-view` (`null` when none), and waiting for a view (`null`: for no dialog). |
| `formError(d)`, `chooseCreate(d)`, `submitCreate(d, { passphrase, joinCode? })`, `submitUnlock(d, { accessId?, passphrase })` | The single steps (`d` is the dialog locator) that wds-verify calls one by one, because it also reacts to other dialogs in between. |
| `newPassphrase()`, `DriveError` | A passphrase that passes the library's rules; the error that every function throws, with the text of the dialog (`unlocking failed: ...`, `the access sheet could not be confirmed: ...`). |

Do not `await store.unlock()` before calling the helper: that promise settles only after the dialogs are answered. Start it (`page.evaluate(() => { window.p = store.unlock(); })`), drive, then await it.

## Test apps and tests

`test-apps/good` is a small correct app (profile record, autosaved note, one record per list item); `test-apps/bad` leaks the note to
localStorage, posts items to another host and calls the datastore API directly. The files carry the library hash of the build they were
written for; `wds-verify` reports the expected value when it is stale (`--script-tag` prints the current tag), and the tests substitute
the current hash. Run everything with `scripts/test-tools.sh` (`SKIP_BROWSER=1` skips the browser tests).
