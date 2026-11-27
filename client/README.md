# WIAI Datastore client library

Browser library for the WIAI Datastore, the end-to-end encrypted key-value store for single-file web apps. The design is in
[../PLAN.md](../PLAN.md) (section 8), the wire format in [../PROTOCOL.md](../PROTOCOL.md).

| File | Purpose |
|---|---|
| `src/wds-core.js` | Cryptography and protocol client (`WDSCore`), no UI. Runs in browsers and Node. |
| `src/wds-ui.js` | Dialogs and the high-level `WDS.connect()` API on top of the core. |
| `vendor/` | hash-wasm Argon2id build (MIT), with licence and checksums. |
| `build.mjs` | Concatenates vendor + core + UI into `dist/wds-<version>.js`, plus `.sri` and `hashes.json`. |
| `test/` | Node tests (`*.test.mjs`) and Playwright browser tests (`*.spec.mjs`). |

## Use in an app

```html
<script src="https://wiai.uni-bamberg.de/datastore/client/wds-1.0.0.js" integrity="sha384-…" crossorigin="anonymous"></script>
<script>
  const store = WDS.connect({ scope: "myapp-k7m2a9" });
  async function start() {
    await store.unlock();                         // dialog: create vault, unlock, redeem invite, key file
    const prefs = (await store.get("prefs")) || {};
    const draft = store.autosave("draft", () => state, { delayMs: 2000 });   // call draft.changed() after every edit
    document.getElementById("share").onclick = () => store.share();
  }
</script>
```

API summary: `unlock`, `onUnlock`, `onLock`, `lock`, `status`, `get`, `getMany`, `getRecord`, `getBlob`, `set`, `remove`, `list`, `collection`, `autosave`, `history`, `restore`,
`showHistory`, `onConflict`, `onStale`, `setLocale`, `share`, `exportAll`, `usage`, `migrateLocal`. Every async method unlocks first when the store is locked. The full
description is PLAN.md 8.1.

* Values: JSON values, or `Blob`/`File`/`ArrayBuffer`/`Uint8Array` (stored as bytes). Names: any non-empty string up to 1024 bytes;
  `.wds/` is reserved.
* `set(name, value, {mime?})` resolves with `{name, version, size, resolution, value?, deleted?}`. `resolution`: `saved`, `mine`, `theirs` or `merged`; `value` is
  present for `theirs` (the kept version, unless it was a deletion) and for `merged` (what was stored).
* `get(name, {fresh?})`, `getRecord(name, {fresh?})`: `fresh: true` reads from the server and ignores the copy that `list()` keeps for a moment.
  `getMany(names, {fresh = false})` resolves with the values in the order of `names` (`undefined` for a missing record; six requests at a time)
  and rejects with the first error that is not "missing", after the requests in flight settled.
* `remove(name)` resolves with `{name, deleted, resolution, value?}`: `deleted` (removed now), `absent` (did not exist or was gone already), `mine` (conflict, deleted anyway),
  `theirs` (conflict, the other side's newer version was kept: `deleted: false`, `value` is that version).
* Errors: `WDS.errors.*` (`ConflictError`, `OfflineError`, `QuotaError`, `AuthError`, `IntegrityError`, `VersionError`, `UsageError`), only there.
  The notice of a failed save offers a backup download of what could not be saved.
* Options of `WDS.connect`: `scope` (required), `baseUrl` (service URL, default the faculty server), `locale` (default `navigator.language`), `label` (a function that turns a record name into what a person sees). The library's notices cannot be switched off. `escrowPins` and `retiredEscrow` (IDs of escrow key sets) exist for tests only: a library build that has escrow pins ignores both options, so app code cannot replace the faculty keys. There is deliberately no option to inject `fetch`, storage or an Argon2 function, and the production bundle has no `WDSCore.setRandom`, `setArgon2` or `internals`, so no hook can see the passphrase or weaken the randomness.
* `status()` has `sandbox: true` when the scope is the public sandbox (see below).

### Conflicts

The built-in dialog offers keep theirs, keep mine and download both. App code can decide in code:

```js
store.onConflict(c => c.keepTheirs());                      // every record
const off = store.onConflict("notes/", c => c.merge((mine, theirs) => ({ ...theirs, ...mine })));   // a prefix ending in "/"
store.onConflict("settings", c => c.keepMine());            // one name; returns an unsubscribe function
```

The handler for the exact name wins over the one for the prefix, which wins over the global one; a prefix that overlaps a registered prefix is a `UsageError`.
A handler that decides nothing (returns without calling a method), throws or rejects hands over to the built-in dialog (throwing also logs to the console).
The conflict object `c`: `name`, `op` (`"set"` or `"remove"`), `mine` `{value, kind, mime, deleted}`, `theirs` `{version, deleted, kind, mime, time, value}` or `null`,
`keepMine()`, `keepTheirs()`, `merge((mine, theirs) => value)` (`theirs` is `undefined` when it was deleted there), and `await c.ask()` (shows the built-in dialog now and resolves
`"mine"` or `"theirs"`). Returning `"mine"` or `"theirs"` works too.

### Autosave

`const saver = store.autosave(name, getState, {delayMs, onStatus, onError, onSaved, onResolved, mime})`; call `saver.changed()` after every edit. Statuses: `idle`, `dirty`, `saving`, `saved`,
`error`, `stopped` (after a lock, a removal, a newer handle or `stop()`). `await saver.flush()` resolves with the final status and never rejects; `saver.error` is the last error.

* One live handle per name: a new handle flushes and stops the old one, so running a start function twice is harmless.
* `getState` may return `undefined`: nothing is written. `changed()` on a stopped handle writes nothing and calls `onError` every time.
* `store.remove(name)` pauses the handles of that name during the request; they stop when the record is gone, resume when the request fails, and when the other
  side's version was kept they resume and `onResolved(res)` gets it (`res.value`, like after a save that ended with the other side's version).
* On lock (any reason) `getState()` of each unsaved handle is read once, before `onLock` handlers run (they may clear the screen), and saved (up to 8 s). What could not
  be saved is written after the next unlock of the same vault, before `onUnlock` handlers run; after unlocking another vault, or after a revocation, it is dropped
  with a notice.

### Lifecycle

```js
store.onLock(clearScreen);          // reason: "user", "revoked" or "expired"
store.onUnlock(start);              // after every successful unlock; registering the same function twice registers it once
store.unlock();
```

### Collections

`const notes = store.collection("notes/", { meta: (value, id) => ({ title: value.title }) })`: a list of records `notes/<id>` plus an index record
(`notes.index`, outside the prefix) that holds a little `meta` per item, so a list renders without loading the items. Several devices can add and
remove items without losing each other's changes: the index is merged by replaying the pending operations on the latest version, never by comparing clocks.
One collection object exists per prefix; a later call with the same prefix replaces its options. `meta` is at most 512 bytes of JSON per item.

| Call | Result |
|---|---|
| `await notes.load()` / `await notes.refresh()` | the items (`refresh` re-reads the index and fires `onChange` on a difference) |
| `notes.items()`, `notes.has(id)` | synchronous; a `UsageError` until `load()` ran (and again after a lock) |
| `await notes.get(id, {fresh?})`, `await notes.getAll({fresh})` | the value(s); records that are gone are skipped; `fresh: true` ignores the copy that `list()` keeps for a moment |
| `await notes.add(value, {meta?, mime?, created?})` | `{id, name, version, resolution}` with a new id of 10 characters `[0-9a-z]`; `created` (ms) only orders the list. Your own ids (1 to 200 characters, no `/`): `set(id, value)` |
| `await notes.set(id, value, {meta?, mime?, created?})`, `await notes.remove(id)` | the `set`/`remove` result. `set` is an upsert: a new id gets its index entry (`created`, or now), an existing entry keeps its date and gets the new meta. Like `store.set` it writes on top of the version this page has read or written: a record that exists but that this page has not read (listed in the index only) is a conflict, decided by `onConflict` or the dialog, never overwritten silently |
| `notes.autosave(id, getState, opts)` | an autosave handle that also keeps the index meta current (index writes at most every 10 s) |
| `await notes.flush()` | resolves when every queued list change is on the server, rejects while it cannot be written |
| `await notes.rebuild()` | explicit repair: lists the prefix, downloads every item for its meta (one request per item) and rewrites the index |
| `notes.onChange(fn)` | `fn({items, added, removed, changed})` when the list changed other than by your own calls (refresh, other devices, repairs); returns an unsubscribe function |

The entity is written first, then the index. If the index write fails (offline, conflicts for 10 rounds), the call rejects with the underlying error carrying
`err.stored = true`, `err.id` and `err.record` (the record name): the item exists, do not add it again; the change stays queued and goes out with the next index write, when the
device is back online, on focus, and on lock. Records under the prefix that the index does not list are queued for the index whenever the page calls `store.list()`;
`rebuild()` repairs everything. Up to a few thousand items with meta under 200 bytes; split by year or project beyond that.

### Stable attributes (for tests and wds-verify)

Every button, input, select, textarea and summary inside the library's dialogs carries `data-wds="<name>"`, and every dialog carries `data-wds-view="<view>"`, set when the view is rendered.
The views and their controls are listed in [docs/site/integration.md](../docs/site/integration.md), section 12 (views and controls), and covered by `test/ui-attrs.spec.mjs`; the names do not change with the language.
A dialog is never without a view: it opens as `loading` (busy) and gets its real view when the controls are in place. A request that does not answer within 30 s fails like a lost
connection (`OfflineError`, code `timeout`), and a dialog that cannot go on (a failed request, a view that cannot be built) shows the view `error` with a `retry` button, so a dialog never waits for ever
(`test/dialog-stress.spec.mjs` reloads and unlocks with slow, failing and stalled requests). A dialog that waits (view `loading` or `progress`, the share dialog until its roster is refreshed, or a submit in flight such as Argon2id and the request) carries `aria-busy="true"`: view present and no `aria-busy` means ready for input. Toasts have `data-wds-toast="<key>"` (the migration uses `migration`) and the buttons `toast-action` and `toast-dismiss`.

### Dialogs, toasts and your own modal dialogs

Every library dialog is a modal `<dialog class="wds-root wds-dialog">` (the browser makes the rest of the page inert and draws the backdrop), and the toast region
and the sandbox bar are `popover="manual"` elements. They all live in the browser's top layer, so they appear above a modal dialog that the app opened with `showModal()`:

* A conflict, the unlock dialog after an expired session, the migration question and every toast (also with buttons) work above an open app modal. While a toast is shown
  the library keeps it inside the topmost modal dialog (the app's or its own) so that it stays clickable; clicks, key presses and submits inside the toast region do not reach
  the dialog that hosts it. A toast whose host dialog the app removes comes back on its own.
* An app dialog that is opened with `showModal()` *after* a library dialog does not cover it: the library puts its dialog on top again (within a moment; also when the app reuses one `<dialog>` element
  that was open before). It notices the `open` attribute of any dialog and checks what is on top at the middle of its own dialog, never which element opened. The app should still not
  open modals while a store call is pending. The 400 ms check runs only while a library dialog or a modal dialog of the app is open.
* A toast sits at the bottom right (at the bottom on a narrow screen) in the top layer and can cover a button of an app dialog: short ones (info, ok) go after about 9 seconds, warnings and errors (also the migration notices)
  stay until dismissed. wds-verify dismisses a toast that covers the element of a `click` step and says so; a person has to use `toast-dismiss` as well. Put the app's own notices inside its dialogs: a fixed element of the page lies under a modal dialog.
* `lock()`, `expired` and `revoked` close every library dialog (a pending question settles as cancelled: a conflict rejects the write, the unlock promise rejects with
  `code: "cancelled"`). The app closes its own modals in `onLock`. To find only your own dialogs use `dialog:not(.wds-dialog)`; do not close the library's.
* Escape closes a library dialog only when it is cancelable (the close button `×` exists); mandatory dialogs (unlock, the access sheet, progress) stay. Escape is handled
  with a `keydown` listener on the document, so it also works when no control has the focus.
* CSS of the app for `dialog` (padding, `max-width`, a transform for centring, an opacity transition, `display:flex`, a transparent backdrop) does not change the library's dialogs: the
  box is reset with `all: initial` and explicit rules. Minimum browsers: Chrome/Edge 114, Firefox 125, Safari 17 (modal `<dialog>` and `popover`); older engines show the toasts with
  the former fixed layout, which an app modal can cover.

### Taking over old local data: `store.migrateLocal`

```js
const recipeCol = store.collection("recipes/", { meta: (r) => ({ title: String(r.title || "").slice(0, 80) }) });
const result = await store.migrateLocal({
  id: "cookbook",                                            // names this migration (lock, tag, marker): 1-40 characters [a-z0-9-]
  indexedDB: { name: "cookbook", stores: ["recipes"] },      // one object or an array; only these stores are read and emptied
  localStorage: { keys: [], prefixes: [] },                  // keys of old DATA only; a personal preference (theme, language) stays in localStorage and is not named
  map(old, h) {
    return { items: old.rows("recipes").map((row) => ({ col: recipeCol, id: h.id(row.key), value: row.value, from: row })) };
  },
});
```

Call it once in `start()`, before `load()`; the app no longer touches `indexedDB` or `localStorage` for the old data. It reads the old data (nothing is written there except the tag below),
runs `map` twice (the results must be identical: ids from `h.id`, no random numbers, no clock), checks the result, asks the person once (dialog view `migrate`), copies with
create-only writes, writes the index of every collection, reads everything back and compares byte for byte, writes a marker record inside the vault and only then deletes the old rows
(never in a sandbox). Every old row has to be accounted for: each entry carries `from` (the row, or the localStorage key) and rows that are no entries are listed with `h.skip(row, why)`;
one row that is neither copied nor skipped stops the run and nothing is deleted. `h.skip` deletes the row with the old data (the backup has it): the question then asks for a confirmation (a box, or the backup
download) before it copies anything, so use it only for rows that are no user data (a cache). The marker (`.wds/migration/<id>/<tag>`, hidden from `list()` and `exportAll()`) remembers, per entry, a short hash of
what `map` made of it (name, value, meta, date, type; files by size, type, name and date): a later start with the old data still there (sandbox, kept, crash before the delete) never compares with the vault again, asks nothing, and does not bring back what the
person edited or deleted since; only an entry that `map` now makes differently (a new or changed old row, or a corrected `map`) is new. Rows and files are compared by a cheap fingerprint at every start (no file is
read); every copy is checked byte for byte, and the bytes of every file are compared once more right before the delete.

* **Result** `{ status, deleted?, copies?, why? }`. `status`: `nothing` (no old data: no dialog, no request), `busy` (another tab runs it; load normally), `skipped` (`why: "not-owner"`; a member's vault is not
  a place for private old data; a notice with a backup button is shown once per page), `declined` (Not now / Escape / close; nothing written, asked again next start), `failed`
  (`why` for developers; nothing deleted; also offline, quota, locked, and every mistake in `map` or in one user's data: the message is in the console, the person gets a notice with a backup button), `partial` (`why: "too-large"`: entries were left out and the old data was kept), `migrated` (`deleted`: `"deleted"`, `"kept"` in a sandbox, `"changed"` when the old data changed meanwhile and stays). It rejects only with `UsageError` for wrong
  options (before anything is read) and with a cancelled unlock; a mistake that map or one user's data causes (a missing `from`, a bad id) is a `failed` result, so the page still starts for that user.
* **Old data** `old`: `rows(name)` (`[{key, value}]`; the store name, or `"db/store"` when two databases have the same store name; `[]` for a missing database), `local` (`{key: text}` of every
  configured key and prefix match), `json(key)`. `map` gets copies of the rows: it may change them (also in a classic script) without touching the old rows; Blob/File and binary buffers are shared, do not change their bytes. `old.rows(name)` is `[]` for every configured store that does not exist in this browser.
* **Helpers** `h`: `id(oldKey, ending?)` (the id of an entry: `<tag>-<token>` with the random 8-character tag of this browser, `localStorage["wds:migrate:<id>:tag"]`, kept after the delete, so two browsers with the same old numeric ids do not overwrite each other; the token is `s…` for a string key,
  `j…` for anything else, `b…` for binary keys; different keys never give the same id; at most 200 characters; `ending` like `".pdf"`; a reference computes the id of its target with the
  same call), `ref(storeName, oldKey, ending?)` (the target's id, or `null` when the row is gone), `blob(value, field?)` (a `Blob` from a Blob/File, `value[field]`, `value.blob`, `value.data` or a
  `data:` URL), `created(x)` (ms from a Date, number or date string), `skip(row, why)`.
* **map returns** `{ items, records }`: `items: [{ col, id, value, meta?, created?, mime?, from }]` (written like `col.set`), `records: [{ name, value, mime?, from }]` (like `store.set`;
  not inside a collection's prefix, not `.wds/`; for a value that is meant for everyone who shares the vault, such as the units of a shared collection). `settings` is a `UsageError`: personal preferences stay in localStorage and are not named in `migrateLocal`, shared values are a record.
  A JSON value must not hold a Blob, buffer, Map or Set (JSON would write `{}`), Dates become ISO strings. Every `h.ref` result must
  be the id of an item of this run. A reference to an entry that was left out (too large, no room) becomes `null`.
* **Names that exist already**: an entry whose id (or record name) is in the vault with other content is written next to it as `<id>~<tag>-<hash>` (`<name>~<tag>-<hash>` for a record; the hash is the start of the entry's own hash), create-only and read back like every copy; it counts as copied, `copies` lists the names and the toast says how many there were. A copy of a record is invisible to the app unless it reads `copies`. Equal content counts as copied without a write.
  Nothing is overwritten, never a conflict dialog or an `onConflict` handler.
* **Size**: entries over `max_value_bytes` and, when the vault is too full, the largest entries are left out and listed in view `migrate-large` with one button, `migrate-large-download`, that saves them in one ZIP file; the old data is deleted
  only after that ZIP was built and saved and the person chose Delete; Keep (or Escape) gives `status: "partial"`.
* **Backup**: view `migrate` offers a ZIP file (`data.json` and every Blob under `files/`, not encrypted) that works without the vault.
* **Safety**: tab locks (`navigator.locks`, `ifAvailable`: a second tab gets `busy` at once), the old database is opened without creating it (a blocked one fails after 5 s), `wds:` keys are never
  read or removed, nothing but the configured stores and keys is deleted (never `localStorage.clear()`, never `deleteDatabase`), and the delete re-reads everything: one changed row (also a file of
  the same size with other bytes) and nothing is deleted (`"changed"`). The test global `window.__WDS_MIGRATION_TEST__ = true` makes a sandbox delete too, but only in an automated browser
  (`navigator.webdriver === true`); set it only in your own test setup (`context.addInitScript`), never in the app. A toast with key `migration` reports the outcome; the library's wording (German and English) is not configurable.

### Sandbox

When the scope is a sandbox (the scope document's `sandbox` field is not `null`: open enrollment, small limits, all data deleted every night) the library says so:
dialog titles start with "Sandbox:" / "Testumgebung:", the create button reads "Create sandbox vault", every dialog shows a banner (`data-wds="sandbox-banner"`), and after unlocking
a fixed bar (`data-wds="sandbox-bar"`) stays on the page for the whole session; while it is shown, the library adds its height to the `padding-top` of `<html>` (inline, restored at lock), so the bar covers none of the app. Both use inline `!important` styles. There is no recovery contact and no recovery code
in the sandbox. A remembered access ID older than the last wipe is forgotten, and a session whose vault vanished after the wipe time locks with reason `expired` and the message that
the sandbox was emptied.

### Theming

Set CSS custom properties on `:root` (or any ancestor of `<body>`): `--wds-bg`, `--wds-fg`, `--wds-muted`, `--wds-border`, `--wds-accent`, `--wds-accent-fg`,
`--wds-danger`, `--wds-warn`, `--wds-ok`, `--wds-soft`, `--wds-radius`, `--wds-font`, `--wds-mono`, `--wds-font-size`, `--wds-backdrop`. Dark
mode follows `prefers-color-scheme` unless the variables are set. All classes start with `wds-`; there is no Shadow DOM.

## Build

```sh
node build.mjs                     # dist/wds-<version>.js, .sri, hashes.json
node build.mjs --freeze            # mark the version as released: later builds with different bytes fail
node build.mjs --escrow-pins=ID1,ID2   # or client/escrow-pins.json, or WDS_ESCROW_PINS
node build.mjs --retired-escrow=ID:UNTIL,...   # escrow sets of earlier library versions, see below
```

`client/escrow-pins.json` is a JSON array of the two pins, or `{"pins": [...], "retired": [{"id": "...", "until": <Unix seconds>}]}`.
Retiring an escrow key (PLAN 5.9): ship a new library version whose pins are the spare and the new key, and list the old
current key as retired with the time of the retirement. Vaults whose roster chain names a retired set still open; their escrow
slot is replaced by the current pinned set the next time an owner unlocks them, and escrow-signed roster versions (recoveries) of
a retired key count only up to `until`.

The bundle is a single function scope: the vendored hash-wasm runs in a private scope (no global `hashwasm`, no clash with a
page's AMD loader or its own hash-wasm), `wds-core.js` is built with `PRODUCTION = true`.

The version comes from `package.json`. Until `wds-keygen` has produced the escrow keys there are no pins in the bundle, and vault creation needs the
`escrowPins` option (the tests pass it).

## Tests

```sh
../scripts/test-client.sh          # node tests, build, Playwright (Chromium). SKIP_BROWSER=1 runs only the node tests.
npx playwright test -g "share"     # one browser test; screenshots land in test-results/shots/
```

The browser tests load a pinless test build of the bundle (`test-results/bundle`, built by `test/global-setup.mjs`; `dist/` keeps the
production build with the escrow pins) from a `file://` page and talk to `test/fake-server.mjs` (an in-memory implementation of the API)
over HTTP (`test/ui-server.mjs`). The Playwright version is pinned to the Chromium build in `~/Library/Caches/ms-playwright`.

### Integration tests (real server, real bundle)

```sh
../scripts/test-integration.sh                       # every installed browser: Chromium, Firefox, WebKit
../scripts/test-integration.sh --project=chromium -g "revocation"
WDS_BROWSERS=chromium,firefox,webkit ../scripts/test-integration.sh   # fail instead of skipping a missing browser
```

`test/migrate.spec.mjs` (same config; real server and a sandbox server, a seeded old IndexedDB/localStorage in the same page, served over `http://127.0.0.1` because WebKit keeps no IndexedDB for `file://` pages; WebKit runs in a persistent profile because an ephemeral one cannot keep Blobs) covers `store.migrateLocal` in all three engines.

`test/docs.spec.mjs` (same config) checks what the server serves as documentation: the example app of `docs/site/integration.md` under the documented Content-Security-Policy in all three engines (with a negative control and the `onerror` fallback), the static checks of `tools/wds-verify.mjs` against that example, and `docs/site/export.html` served and saved to disk.

`test/integration.spec.mjs` starts the Python server from `../server` with a temporary database and generated escrow keys
(`test/integration-env.mjs`), builds a bundle that pins exactly those keys, and drives it from `file://` pages. It has its own
config (`playwright.integration.config.mjs`); `playwright.config.mjs` runs only the `ui*.spec.mjs` files (`ui.spec`, `ui-visual.spec`, `ui-store.spec`, `ui-attrs.spec`, `ui-layers.spec`: dialogs, toasts and the sandbox bar above modal dialogs of the app). Missing browsers: `npx playwright install firefox webkit`.
If the installed WebKit build is not the one this Playwright version expects, an older `webkit-*` build is used (or name one with
`WDS_WEBKIT_EXECUTABLE=/path/to/pw_run.sh`).
