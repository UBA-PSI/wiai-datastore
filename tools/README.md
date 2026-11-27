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
node tools/wds-verify.mjs app.html --heading-level 3 --out REPORT.md   # its title as ###, its sections as ####: to paste under "## Verification" of a README
node tools/wds-verify.mjs app.html --target sandbox   # run against the public sandbox: no Python, no build
node tools/wds-verify.mjs app.html --sandbox-copy app-sandbox.html   # a copy for a person to open in a browser
node tools/wds-verify.mjs app.html --static-only      # no browser, no Python
node tools/wds-verify.mjs --script-tag                # the complete script tag (with the onerror handler) and the CSP meta tag to paste into an app
node tools/wds-verify.mjs --script-tag --hashes client/dist/hashes.json   # the same for an unreleased build of your clone (its own integrity hash)
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
- What only the mock checks (the server's database, the real deletion of a migration, the default limits instead of the sandbox's, an unreleased library) and what only the sandbox shows (its bar and banners, `--wds-sandbox-bar`, the published library with the tag's hash): integration.md, section 12, "Targets".
- **auto**: mock when Python 3.13 with the server packages is found; otherwise the sandbox if its scope document is reachable and enabled; otherwise only the static checks run, with a warning that says why.

`--sandbox-copy <out.html>` writes a copy of the app with the scope of its `WDS.connect` call replaced by the sandbox ID and exits (the file name must contain
"sandbox"). Open that copy in a browser to try the app by hand against the sandbox. Never ship the copy and never put the sandbox ID into the app itself:
the static checks fail a file that contains it.

### Checks

Static: one script tag `https://wiai.uni-bamberg.de/datastore/client/wds-<version>.js` with `crossorigin="anonymous"` and the
`integrity` hash of that version, and the `onerror` fallback of integration.md, section 2: `document.body.textContent='<message>'`. The message may be in the language of the app (info **onerror fallback**: "not the English one"); no `onerror` or other code in it warns. The published hashes come from `https://wiai.uni-bamberg.de/datastore/client/hashes.json` first (3 s timeout),
then from `client/dist/hashes.json` of the clone; the report names the source and warns when they differ (the clone is outdated; `git pull`).
`--hashes <file>` overrides both. A CSP meta tag that is not broader than the recommended one (the policy of `docs.csp_policy`, printed in
integration.md; additions of `font-src data:`, `media-src blob: data:` and `img-src https://host` are accepted, `'self'` in `script-src` or a missing
`base-uri` / `form-action` fail), placed before the first script; no other scripts; no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` or form
action to the datastore host outside the library. New: the sandbox scope ID anywhere in the app fails; CSS that sets `display`, `visibility` or `opacity` on
`.wds-` classes or `[data-wds...]` elements fails (it would hide the library's dialogs or the sandbox label); `indexedDB.deleteDatabase` and
`localStorage.removeItem` / `.clear` in a named function that never mentions "sandbox" warn (the nearest enclosing *named* function counts: a declaration, a function or arrow assigned to a variable or property, a method; an anonymous callback such as `rows.forEach(function (r) { ... })` is skipped, so a guard in the function around it counts), `localStorage.clear()` always warns.
An app that calls `store.migrateLocal` is recognised (info **Old data: store.migrateLocal**): the library copies, checks and deletes, so an app that deletes nothing itself gets no warning. Code that uses `indexedDB`, or removes or sets a localStorage key or database that `migrateLocal` names, is a hand-made migration (warn **Old data taken over by hand**: use `store.migrateLocal`, see porting.md). Reading another localStorage key is no finding, and neither is writing one with a plain string: a personal preference chosen from a fixed list (theme, language, sort, density, last tab) may stay there under the app's own key (integration.md, section 5). A `setItem` whose value is built with `JSON.stringify` or a template, or whose key starts with a name or prefix of `migrateLocal`, is data in the browser (warn **Browser storage next to migrateLocal** or **Old data taken over by hand**); the dynamic leak search still catches typed text. `settings` in the return value of `map` is a `UsageError` of the library.
`showModal(` in the code gives the info **Modal dialogs of the app** (library dialogs open above your own modal dialogs; close yours in `store.onLock` and open none while a store call is pending).
Code that assigns `window.__WDS_MIGRATION_TEST__` fails (section "Testing a migration"). An info finding **Privacy sentence** says when neither the page nor the `README.md` next to it contains the official sentence of the service (English or German; use the English one for other languages).

Scope check (every target that has network): the public scope document of the app's own scope ID is fetched. Unknown scope: fail. The breach check
(`hibp`) on while `connect-src` lacks `https://api.pwnedpasswords.com`: fail (vault creation would show an error); off while the host is still allowed: warn.
The report prints the current enrollment, breach check and limits (sizes in MB, 1 MB = 1,048,576 bytes, as everywhere in the documentation). When the scope has the breach check on and neither the page nor the README next to it carries the official sentence about it word for word (naming the service is not enough), the info **Breach check: sentence for the privacy text** prints both sentences (English and German): add one, in the language of the text, right after the official privacy sentence. Offline: an info line "scope settings not checked".

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

**Library dialogs are waited for.** A dialog of the library is *ready* when it has a `data-wds-view` and no `aria-busy="true"` (the library sets the view after the controls are rendered, and marks the dialog busy while a submit runs, for example the key derivation of an unlock). The tool does nothing to a dialog that is not ready (it is not an "unexpected dialog"), presses `retry` in a dialog in the view `error` (three times at most), puts the state of the dialog (view, `aria-busy`, classes, text) into the note when it is not ready for 20 s, stays open or is not answered, fills a field only when it is visible and editable (up to three tries, checking what the field holds), and a failure note keeps up to 8 lines (800 characters) of the Playwright message, call log included. The library's dialogs are `<dialog>` elements in the top layer: the newest is on top and everything below it, the app included, is inert. The tool therefore answers every open library dialog before it types into the app or presses a button, and a field behind a modal dialog of the app itself is not typed into (the report says so when that left nothing to type into: add a first step that closes the app's dialog).

**Data after reload.** After the reload the tool looks at what a person can read (the page text and the values of the inputs on screen) once right after the unlock and once after **every**
`afterReload` step, and takes all of them together: an app with tabs passes when one `afterReload` step per tab opens each view. Pass: at least one typed value of every round
(the tool's first and second round, the steps) is visible in some of those views. Only values that the app showed as text before the reload (the tool looks at the page text after its first round and after every step) or wrote to the store (the page instrumentation sees what `set`, `autosave` and the collections' `add`, `set` and `autosave` are given) are expected back: input that the app rejected, such as a duration it cannot parse or an entry without a project, is neither and is left out, and the detail says how many values that were. A value that only ever sat in an autosaved field counts as written, so an editor that is not read back is reported. If there is no such value at all, every value counts. Fail: records were written, no typed value is visible and the file has no `afterReload` steps.
An `afterReload` fill step whose text contains a value typed before the reload fails (the tool reads field values too and would "find" the text it typed itself): use another text or `{canary}`.
Warn: otherwise ("x of y values visible after the reload; the others are in views the tool does not open"; add `afterReload` steps for those views).
Values that the app neither showed as text nor wrote to the store before the reload are not counted, and the detail names them (at most 5, then "and N more"): `1 other typed value was neither shown as text nor written to the store before the reload and is not counted: #eDoi ("10.1000/canary").` A value that sits only in a link's `href` is such a value.

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
| `afterReload` | Run after the reload and the unlock: open the tab, the list, the dialog that shows the data, close a modal dialog that the app opens at every start. The tool looks for the typed values after the unlock and after every step, and takes the union. |
| `seed` | Tests the migration of old local data (below): `{ "page": "<old local-only app, relative to this file>", "steps": [ ... ] }`. |

Steps (selectors are Playwright selectors: CSS, `:has()`, `:nth-match()`, `text=`, `role=`): `click` selector (a notice of the library that covers the element is dismissed and the click repeated, and the report notes it); `fill` [selector, text] (the text is searched for like a canary); `select` [selector, value]; `press` [selector, key], for example `Enter`;
`upload` [selector] (a generated PNG whose name and bytes are searched for like canaries) or [selector, path] (your own file, relative to `wds-verify.json`, not to the folder of `seed.page`; its name is searched for);
A typed text must come back as the same text (a tag field that splits `"a, b"`, a number or date field hides it from the search: one token per tag field). A fill text may contain `{canary}`, which becomes a unique generated token (letters and digits, so every field takes it) that the tool searches for like its own canaries. An empty fill text (`{"fill": ["#fSearch", ""]}`) clears a field and is not searched for.
`download` selector (clicks and expects a download; reported as "user-requested download" with "contains canaries: yes/no", never as a leak, while a download at any other
time stays a failure); `wait` milliseconds. An invalid file is a usage error that names the step and the allowed forms.

### Testing a migration (the `seed` block)

An app ported from a local-only version takes over the old data with `store.migrateLocal` (porting.md): the library asks the person, copies the data into the vault, checks it, and deletes
it from the browser (not in the sandbox). The `seed` block makes the tool play that story. The run goes in this order, and every library dialog is answered when it appears:

1. **The old app.** The tool opens the **old** page (`seed.page`) in the browser, runs the seed `steps` there (the same step forms; `{canary}` in a fill text gives a value the tool can search for), waits for a debounced save, and
   takes stock of the old storage: every localStorage key and every IndexedDB store with rows (the tool's baseline). Requests, console output and downloads of the old page are not counted.
2. **The new app.** The tool opens the app in the same browser context (`file://` pages share localStorage and IndexedDB, so the app finds the old data like a returning user's browser would).
3. **The library's dialogs.** Unlock dialog -> "create a vault" (a generated passphrase) -> access sheet (confirmed) -> **the migration question** (view `migrate`): the tool presses `migrate-backup` (and waits for the download), then
   `migrate-yes`; the progress view is waited for; entries that are too large for the vault (view `migrate-large`) are downloaded with the one button (`migrate-large-download`) and the old data is deleted anyway (`migrate-delete`). The app needs **no step** for these questions. (A prompt that the app draws itself is answered by a step, for example `{"click": "#migrate-yes"}`.)
4. **The steps** of `wds-verify.json`, each after the open library dialogs have been answered. With a seed they come first, right after the vault exists; the tool then types its own canaries only into fields that are still empty.
5. **Automatic filling and button presses** (the fields, then the save buttons), then a second round for fields the app emptied, then a pause for debounced saves.
6. **The reload**, the unlock dialog (the passphrase), the `afterReload` steps then all checks.

```json
{
  "seed":  { "page": "old/index.html", "steps": [ {"fill": ["#title", "old note {canary}"]}, {"click": "#save"} ] },
  "afterReload": [ {"click": "#tab-notes"} ]
}
```

What the report says (ids `seed`, `migration-visible`, `migration-encrypted`, `migration-old-data`, `migration-dialog`):

- **Seed: the old app**: after the seed steps the typed values must be in the old app's storage (localStorage, IndexedDB; Blobs and Files are read). Otherwise the migration has nothing to migrate: fail.
- **Migration: old data visible**: the seeded values are visible text in the app **after reloading the page and unlocking the vault** (the start view and every view an `afterReload` step opens, together), so they came out of the vault: a screen that shows the old storage directly, before the reload, does not count. None: fail (also when the app wrote no record at all, or never called `await store.migrateLocal({ ... })`); some: warn. In the sandbox the old data stays, so a screen that lists it cannot be told from the copy there: the deletion run (mock, or `--migration-delete`) is the proof.
- **Migration: old data only encrypted**: no seeded value appears in a request (URL, header, body), WebSocket frame, console line, Cache Storage, cookie or (mock) the server's database. The old app's own storage keeps them by design;
  a seeded value in any **new** place (another localStorage key, another IndexedDB store, an old place that **grew**) is a leak like any other canary. A download that the tool started with a button of the library's migration dialog (the backup, the files that are too large) holds the old data by design, whatever it contains, and is no leak. **Every other download of the old data is one, also a JSON file**: an app never downloads data in the background; only a download that a step asks for (`{"download": "#selector"}`) is information.
- **Migration: the library's dialog** (info): the tool saw the question, downloaded the backup (its file name) and pressed "Take over" (and that it downloaded the files of `migrate-large`).
- **Migration: rows that map leaves out** (`migration-skipped-rows`, warn): the question listed rows that `map` skips with `h.skip` and asked for a confirmation (the box `migrate-skip-ack`; the tool ticks it). They are deleted with the old data and never reach the vault: skip only caches, copy everything a person made.
- **Migration: old data deleted / kept in the sandbox**: with the **mock** target the migration runs as in production (`store.status().sandbox` is false) and **everything** that the old app stored must be gone afterwards: the tool lists what is left by name (a store or key that the options of `migrateLocal` do not name). Fail when the migration visibly ran, warn when it did not (see "old data visible"). `"seed": { ..., "keep": ["some-key", "db/store"] }` names what may stay on purpose (the app's own preference keys, say; the library's own tag key `wds:migrate:<id>:tag` is not in the old storage after the seed, so it needs no entry).
  A seed page with a file input and no `upload` step is pointed out (**Seed: files of the old app**, warn): the Blob stores are then not exercised.
  With the **sandbox** target `store.migrateLocal` keeps the old data, and the tool checks that it is **still there** (fail if the app deletes in the sandbox by hand). To exercise the deletion path in the sandbox as well, run again with
  **`--migration-delete`**: the tool then sets the global **`window.__WDS_MIGRATION_TEST__ = true`** in the page before any script of the app runs, and expects the old storage to be empty afterwards. The library honours the global only in an automated browser
  (`navigator.webdriver === true`); nothing else reads it. On the mock target the flag has no effect (an info finding says so). The report starts with a line that names the flag.
  **Your own automated tests may set the global too** (the developer's own Playwright browser, never the app file): `await context.addInitScript(() => { window.__WDS_MIGRATION_TEST__ = true; })`. The app must never set it: the static check **The app sets the migration test global** fails a file that assigns it, and the dynamic run fails a page that has it set although this run did not set it. In a person's browser such an assignment would delete the old data of a sandbox vault that is wiped tonight.

`--migration-delete` without a `seed` is a usage error, and so is a `seed.page` that is not a file. The "Not tested" list names what stays open: real-size data, the case that the old app is used while the migration runs, and the same-origin rule (Chromium: every `file://` page shares storage; Firefox and Safari: only the same file, so the new file needs the same name in the same folder).

### Options

Options: `--target`, `--locale`, `--sandbox-copy`, `--migration-delete`, `--static-only`, `--hashes <file>`, `--out <file>`, `--heading-level <1-5>` (the report's title gets that many `#`, its sections one more: 3 under a `## Verification` heading), `--strict` (warnings fail), `--headed`, `--wait-ms <n>` (time for debounced
saves, default 2800), `--script-tag [version]`, `--scope-check off` (no request for the scope document: for an app whose scope is not registered yet or a run of an unreleased library; the mock creates the scope it needs), `--json`. Exit codes: 0 passed, 1 a check failed, 2 the tool could not run (no Python venv for `--target mock`, no Playwright, bad arguments),
3 the sandbox is unavailable (rate limited, full, switched off): not an app finding; wait, at most an hour. The result is a smoke test, not a proof.

**An unreleased library** (you changed `client/src`, or your clone is newer than the service). The service publishes the hash of the released build; `node client/build.mjs` writes the hash of your own build to `client/dist/hashes.json`. Print the tag with `node tools/wds-verify.mjs --script-tag --hashes client/dist/hashes.json`, and run `wds-verify <app> --hashes client/dist/hashes.json`. The mock builds its own library and replaces the tag's hash in its copy of the page, so the dynamic checks do not depend on it. An app whose scope does not exist at the service yet needs `--scope-check off` (the mock creates the scope it needs by itself). `WDS_VERIFY_OFFLINE=1` switches off every online lookup (hashes and scope check) and makes the clone the source of the hashes. The report says "your clone has a library build that the service does not publish yet" when the clone is newer than the service, and "outdated; run git pull" only when it is older.

Environment: `WDS_JOIN_CODE_FILE` (the file with the join code for tests, see "The join code for tests"; the code itself is never taken from the environment). For tests and for pointing the tool at another service (not needed otherwise): `WDS_PYTHON` (the Python of the mock), `WDS_VERIFY_SERVICE` (base URL of the service,
default the production one), `WDS_VERIFY_HASHES_URL` (or `off`), `WDS_VERIFY_OFFLINE=1` (no optional online lookups: hashes and scope check), `WDS_VERIFY_LIBRARY` (a library file that the sandbox target serves instead of
the production one, for a local mock with a `[sandbox]` section).

## drive-library.mjs: the library's dialogs in your own Playwright tests

`tools/lib/drive-library.mjs` is what wds-verify uses to create a vault and to unlock it. It drives the dialogs of the library by their stable attributes (`data-wds-view` on the
dialog, `data-wds` on every control; the list is in integration.md, section 12), so it works in every language. The dialogs are `<dialog>` elements in the top layer; the helpers find the
newest one, which is the topmost. Import the helpers from a clone; Playwright is the copy in `tools/node_modules`
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

A dialog is **ready** when it has a `data-wds-view` and no `aria-busy="true"`. The library never leaves a dialog without a view and never waits for ever: a request that does not answer in 30 s fails (`OfflineError`, code `timeout`) and a dialog that cannot go on shows the view `error` with a `retry` button. Every fill waits for the field to be visible and editable and tries again (`fillWhenReady`), so a dialog that is still being built does not make a call fail.

| Export | |
|---|---|
| `createVault(page, { passphrase?, joinCode?, confirm = true, timeout })` | The unlock dialog is open: create a new vault (unlock, create, access sheet, confirmed). Resolves `{ accessId, passphrase, next }`; the passphrase is generated unless you give one. `next` is the view the dialog ended on (`null` when it is gone, else `notice`, `sheet`, `migrate`, `progress`, …), so a test whose app calls `migrateLocal` goes on with `answerMigration`. `confirm: false` stops at the access sheet. For a scope with the enrollment "join code" see "The join code for tests" below. |
| `unlock(page, { accessId?, passphrase, timeout })` | The unlock dialog is open: unlock an existing vault. Resolves `{ next }` as `createVault` does when the dialog has moved on (a notice, a sheet, the migration question that the caller answers); `accessId` is needed unless the library remembers it. |
| `redeemInvite(page, { code, passphrase?, confirm = true, timeout })` | The unlock dialog is open and a member has an invite code: "I have an invite", the code, the member's own passphrase (generated unless you give one), the access sheet. Resolves `{ accessId, passphrase }`; a wrong code is a `DriveError` with the dialog's text. |
| `answerMigration(page, { backup = true, timeout, downloads? })` | `store.migrateLocal` asked: download the backup (`migrate-backup`), press `migrate-yes`; for `migrate-large` press `migrate-large-download`, then `migrate-delete`. Resolves `{ backup, large }`. |
| `confirmSheet(page)` | The access sheet is open: read the access ID, tick "I have saved it", continue. Resolves the access ID. |
| `deleteVault(page, { accessId, passphrase, baseUrl?, scope?, store = "store" })` | Delete the test vault that `createVault` made, at the end of a test in a real scope (the library's store has no call for this: the helper opens a second client of the page's library, as the owner). Resolves `"deleted"`. Name the vault in your report so that nobody has to guess which one in the dashboard was the test. |
| `readJoinCode({ file? })`, `DriveError` | The join code from the file of "The join code for tests" (never printed); the error that every function throws, with the text of the dialog and, when a wait timed out, the state of the topmost dialog (view, `aria-busy`, classes, text). |

The single steps (the topmost dialog, its view, `fillWhenReady`, `submitCreate`, …) are internal to the tool (`lib/dialog-internals.mjs`, shared with the dynamic checks); a test that needs the test global writes the one line of "Testing a migration".

Do not `await store.unlock()` before calling the helper: that promise settles only after the dialogs are answered. Start it (`page.evaluate(() => { window.p = store.unlock(); })`), drive, then await it.

### The join code for tests

A scope with the enrollment "join code" asks for the code when a vault is created. The code is a credential: it never goes into an environment variable, an argument, the chat or a file in a repository, and **no function of the tool prints it or puts it into an error**.
`createVault` takes `joinCode` (a string, for a test that has the code by other means), else reads **a file** that the person who owns the scope creates in their own terminal:

```sh
mkdir -p ~/.wds && chmod 700 ~/.wds
(umask 077; cat > ~/.wds/join-code)        # paste the join code, press Enter, then Ctrl-D
```

On Windows create `%USERPROFILE%\.wds\join-code` with Notepad (file modes are not checked there). Afterwards the person deletes it (`rm ~/.wds/join-code`). The file is named by the environment variable `WDS_JOIN_CODE_FILE`, else it is `~/.wds/join-code`.
Before the file is read it must exist, be a regular file, not be readable by other users (`chmod 600`), and lie outside every git repository (a file that a repository ignores and does not track, in a repository other than the one of the working directory, is accepted); the content is trimmed.
A missing or unusable file is a `DriveError` that gives the commands above. **An agent never reads, prints, copies or lists that file and never asks for the code in the chat**: it gives the person the commands and waits until they say the file is there. A test against the real scope is optional:
`wds-verify --target sandbox --migration-delete` covers the whole path (vault, migration, deletion) without a code. **Every such test ends with `deleteVault`**, and the agent tells the person the ID of the test vault (`store.status().vaultId`) and the time; the person deletes an ID that is still listed in the dashboard, never a vault picked by its time.

## Test apps and tests

`test-apps/good` is a small correct app (profile record, autosaved note, one record per list item); `test-apps/bad` leaks the note to
localStorage, posts items to another host and calls the datastore API directly. The files carry the library hash of the build they were
written for; `wds-verify` reports the expected value when it is stale (`--script-tag` prints the current tag), and the tests substitute
the current hash. Run everything with `scripts/test-tools.sh` (`SKIP_BROWSER=1` skips the browser tests).

The tests of the migration check the tool against apps that migrate by hand (`verify-dynamic-migration.test.mjs`: the bad ways, whatever the app does) and against `store.migrateLocal` with the library's own dialogs (`verify-dynamic-roundf.test.mjs`, skipped with a reason when the library under test has no `migrateLocal`). That file also holds the regression tests for the readiness of the library's dialogs (a dialog that is built in steps), an app with a modal dialog of its own, and `examples/zeit-notizen` five times in a row without a note.
