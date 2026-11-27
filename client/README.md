# WIAI Datastore client library

Browser library for the WIAI Datastore, the end-to-end encrypted key-value store for single-file web apps. The design is in
[../PLAN.md](../PLAN.md) (section 8), the wire format in [../PROTOCOL.md](../PROTOCOL.md). How an app uses it: [../docs/site/integration.md](../docs/site/integration.md).

| File | Purpose |
|---|---|
| `src/wds-core.js` | Cryptography and protocol client (`WDSCore`), no UI. Runs in browsers and Node. |
| `src/wds-ui.js` | Dialogs and the high-level `WDS.connect()` API on top of the core. |
| `vendor/` | hash-wasm Argon2id build (MIT), with licence and checksums. |
| `build.mjs` | Concatenates vendor + core + UI into `dist/wds-<version>.js`, plus `.sri` and `hashes.json`. |
| `test/` | Node tests (`*.test.mjs`) and Playwright browser tests (`*.spec.mjs`). |

## The API (about 18 names)

```js
const store = WDS.connect({ scope: "myapp-k7m2a9" });    // baseUrl? names another service; escrowPins/retiredEscrow exist for tests only
await store.unlock();                                    // dialog: create vault, unlock, redeem invite (every other call unlocks first, too)
store.status();                                          // { unlocked, role: "read"|"write"|"owner", sandbox }; <html data-wds-role> while unlocked
await store.get(name);                                   // a Blob (with its type) for a stored file, else the JSON value; undefined when absent; asks the server every time
await store.set(name, value, { mime? });                 // JSON, Blob/File, ArrayBuffer, typed array -> { name, version, size, resolution, value?, deleted? }
await store.remove(name);                                // -> { name, deleted, resolution: "deleted"|"absent"|"mine"|"theirs", value? }; stops the autosave handle of the name
const notes = store.collection("notes/", { meta });      // load, items, get, getAll, add, set, remove, autosave
const saver = store.autosave(name, () => state, { delayMs?, onStatus? });   // changed(), flush(), stop(); onStatus(status, info)
store.onChange(({ names, remote }) => render());         // after own writes (remote: false) and when another device changed something (true)
store.onConflict((c) => "mine" | "theirs" | { merged: value } | undefined);   // undefined: the library's dialog decides
await store.showHistory(name);                           // dialog: versions, preview, restore
await store.openVault();                                 // dialog for every role: members and invites (owner), own access, access sheet, passphrase, export (ZIP), lock
await store.lock();                                      // saves what is pending (up to 8 s), then reloads the page
await store.migrateLocal({ id, indexedDB, localStorage, map });
```

* Values: JSON, or `Blob`/`File`/`ArrayBuffer`/typed arrays (stored as bytes). Names: any non-empty string up to 1024 bytes; `.wds/` is reserved.
* `set` on an existing record that this page has not read is a conflict (decided by `onConflict` or the dialog), never a silent overwrite; `get` first to replace it.
  `resolution`: `saved`, `mine`, `theirs` (the other side's version stays; `value` is it) or `merged` (`value` is what was stored).
* Errors: `WDS.errors.*` (`ConflictError`, `OfflineError`, `QuotaError`, `AuthError`, `IntegrityError`, `VersionError`, `UsageError`). A save that fails while the page is offline
  opens one dialog per offline episode (download of the unsaved values, or try again).
* There is deliberately no option to inject `fetch`, storage or an Argon2 function, and the production bundle has no `WDSCore.setRandom`, `setArgon2` or `internals`.
* Language: dialogs and notices follow `<html lang>` (`de*` is German, anything else English), without it `navigator.language`; read at every use, so the next dialog after a change speaks the new language.

### Lock is a reload

`store.lock()`, a revoked access and a cancelled re-unlock end the same way: pending autosaves and queued list changes are saved (up to 8 s), then the page is emptied and reloads, so no vault data stays in it and no browser puts typed text back into a field
(the reload is not blocked by the unload warning). When saving fails (offline) a dialog offers "Download unsaved values (backup)" and "Lock anyway"; a revoked access shows "Your access was removed"
(with the backup when something is unsaved). An expired session (the passphrase was changed elsewhere) opens the unlock dialog above the page without clearing it, with the same access ID; on success the pending
writes go on from memory; after a different vault or a cancel the same end follows as for the lock button: the backup dialog when something is unsaved, then the reload.

### Conflicts

```js
store.onConflict((c) => {
  if (c.name.startsWith("notes/")) return { merged: { ...c.theirs.value, ...c.mine.value } };
  return "theirs";
});
```

One handler; a second call is a `UsageError`, `onConflict(null)` removes it. `c`: `name`, `mine` `{value, kind, mime, deleted}`, `theirs` `{version, deleted, kind, mime, time, value}` or `null`.
A handler that decides nothing, throws or rejects hands over to the dialog (throwing also logs to the console); `{ merged }` does not apply to a delete. The dialog names a record by the `title` of
its entry in the collection's meta (string, list loaded), else "this entry", never by the record name.

### Autosave

`onStatus(status, info)`: `idle`, `dirty`, `saving`, `saved`, `error`. `info` carries `error` for `error`. A save that lost a conflict (the other version won) or was merged is `saved` and fires `onChange({ names: [name], remote: true })`: the one way the app learns that the open entry holds another text. The first save after a clean state writes against the version this page last read or wrote; a re-read while the editor holds unsaved text does not move that base (the save then meets the other version in the dialog).
`await saver.flush()` resolves with the final status and never rejects. One live handle per name: a second one throws a `UsageError` (`stop()` first); `changed()` after `stop()` is a no-op;
`store.remove(name)` stops the handle of that name. `getState` may return `undefined`: nothing is written. Pending saves are flushed on lock, when the page is hidden and before it is closed (with the browser's warning).

### Collections

`const notes = store.collection("notes/", { meta: (value, id) => ({ title: value.title }) })`: records `notes/<id>` plus an index record (`notes.index`) with a little `meta` (at most 512 bytes of JSON) per item,
so a list renders without loading the items. Several devices can add and remove items without losing each other's changes: the index is merged by replaying the pending operations on
the latest version, never by comparing clocks. Call `collection` once per prefix.

| Call | Result |
|---|---|
| `await notes.load()` | the items `[{ id, name, meta }]`, in the order they were added to the index |
| `notes.items()` | synchronous; a `UsageError` until `load()` ran |
| `await notes.get(id)`, `await notes.getAll()` | the value(s) (six requests at a time); records that are gone are skipped |
| `await notes.add(value, { meta?, mime? })` | `{ id, name, version, resolution }` with a new id of 10 characters `[0-9a-z]` |
| `await notes.set(id, value, { meta?, mime? })`, `await notes.remove(id)` | like `store.set` / `store.remove`. `set` is an upsert (a new id gets its list entry; your own ids: 1 to 200 characters, no `/`) |
| `notes.autosave(id, getState, opts)` | an autosave handle that also keeps the list meta current (index writes at most every 10 s, and on lock) |

`add` and `set` resolve as soon as the item record is stored; the list entry is queued (`items()` shows it at once) and written in the background. A failed index write stays queued and is retried with the next
write, on focus, when the connection is back and before lock or unload; it is part of the offline backup. Records under the prefix that the index does not list are queued for it when the vault is exported.

### onChange

`store.onChange(({ names, remote }) => ...)` fires after this page's own successful writes (`remote: false`; record names, for a collection item `notes/<id>`) and when the check on focus (at most every 15 s)
finds records or a list changed elsewhere (`remote: true`). One handler, `onChange(null)` removes it. A write inside the handler fires it again.

### Stable attributes (for tests and wds-verify)

Every button, input, select, textarea and summary inside the library's dialogs carries `data-wds="<name>"`, and every dialog carries `data-wds-view="<view>"`, set when the view is rendered; the names do not change
with the language (`test/ui-attrs.spec.mjs`). A dialog is never without a view: it opens as `loading` (busy) and a dialog that cannot go on shows `error` with a `retry` button; a dialog that waits carries
`aria-busy="true"`. A request that does not answer within 30 s fails like a lost connection (`OfflineError`, code `timeout`). Notices are status lines with `data-wds-notice="<key>"`; they have no controls.
Views: `unlock`, `create`, `redeem`, `sheet`, `notice`, `conflict`, `history`, `share` (the vault dialog), `revoke`, `offline`, `lock-unsaved`, `revoked`, `migrate`, `migrate-failed`, `progress`, `loading`, `error`.

### Dialogs, notices and your own modal dialogs

Every library dialog is a modal `<dialog class="wds-root wds-dialog">` (the browser makes the rest of the page inert and draws the backdrop). Notices (a top-centre status line, gone after about 6 s,
`pointer-events: none`) and the sandbox badge are `popover="manual"` elements; all live in the top layer and are shown again above every new modal dialog.

* A conflict, the unlock dialog after an expired session, the migration question and the offline dialog work above an open app modal. A dialog that the app opens with `showModal()` *after* a
  library dialog does not cover it: the library puts its dialog on top again (it notices the `open` attribute of any dialog). Select your own dialogs with `dialog:not(.wds-dialog)`.
* Escape closes a library dialog only when it is cancelable (the close button `×` exists); mandatory dialogs (unlock, the access sheet, progress) stay.
* CSS of the app for `dialog` (padding, `max-width`, a transform for centring, an opacity transition, `display:flex`, a transparent backdrop) does not change the library's dialogs.
  Minimum browsers: Chrome/Edge 114, Firefox 125, Safari 17 (modal `<dialog>` and `popover`).

### Taking over old local data: `store.migrateLocal`

```js
const result = await store.migrateLocal({
  id: "cookbook",                                  // names this migration: 1-40 characters [a-z0-9-]
  indexedDB: { cookbook: ["recipes", "photos"] },  // { database: [stores] }
  localStorage: ["cookbook.items", "cookbook.k.*"],  // keys of old DATA; "prefix*" matches every key with that prefix; a personal preference stays in localStorage and is not named
  map(old, ref) {                                  // once per old row; old = { source, key, value, id }
    if (old.source === "cookbook/photos") return { collection: "photos/", id: old.id, value: old.value.blob, meta: { recipe: ref(old.value.recipeId, "cookbook/recipes") } };
    return { collection: "recipes/", id: old.id, value: old.value };   // nothing (undefined) leaves the row alone: it is never deleted
  },
});   // -> { status: "nothing" | "declined" | "migrated" | "failed", why? }
```

Call it once in `start()` after `unlock()`, before `load()`. `source` is `"database/store"` or `"localStorage"`; `old.id` is a stable id (the random tag of this browser, the store, the key),
`ref(key, source?)` is the id that another row gets (`source` defaults to the row's own store). `map` returns zero or more writes: `{ collection: "prefix/", id, value, meta? }` (like
`col.set`, using the app's collection for that prefix) or `{ name, value }` (like `store.set`); `value` is JSON or a Blob/ArrayBuffer (a file inside a JSON value is refused: store it as its own record and refer to its id; a `data:` URL is converted by the app).

The safety core:

1. Only the owner is asked, once per start (a member gets `{ status: "declined", why: "not-owner" }` and one console line; the data stays). The question (dialog view `migrate`) has a link "Download a copy of the old data first": a ZIP with `data.json` and every file, not encrypted. "Not now" is `declined`: nothing changes, it is asked again at the next start.
2. The first start only copies. Writes are create-only, even for a record this page has read: a name that the vault holds with other content is a conflict (`onConflict` or the dialog decides; "keep theirs" counts as handled). Nothing is deleted, and a failure (`failed` with `why` in the result and in the console, and a dialog with the backup link) leaves everything where it is. The copied rows are remembered per vault as hashes of key and content (`localStorage["wds:<scope>:<access>:migrated-<id>"]`).
3. The second start asks once (dialog view `migrate-delete`): "Is everything in the app? Delete the old entries from this browser", again with the copy link. "Not now" keeps them and asks again. Only rows whose hash matches the copy are deleted (a row that changed since is not), per database in one transaction that compares each row again; a row that `map` turned into several writes or only a part of a row is deleted whole. Rows for which `map` returns nothing are never deleted. Never `localStorage.clear()`, never `deleteDatabase`.
4. Never in the sandbox: the old data stays, and a later start asks nothing.

It rejects only with `UsageError` for wrong options (before anything is read); everything that `map` or the old data cause is a `failed` result, so the page still starts. A second call with the same `id` in one page returns the same result.

### Sandbox

When the scope is a sandbox (open enrollment, small limits, all data deleted every night) the library says so: dialog titles start with "Sandbox:" / "Testumgebung:", the create button reads "Create sandbox vault", every dialog shows a banner
(`data-wds="sandbox-banner"`) and a small badge in the bottom-left corner (`data-wds="sandbox-badge"`, `pointer-events: none`) stays on the page; both use inline `!important` styles. There is no recovery code in the sandbox.
A remembered access ID older than the last wipe is forgotten, and a session whose vault vanished after the wipe time reloads the page, whose unlock dialog says that the sandbox was emptied.

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
config (`playwright.integration.config.mjs`); `playwright.config.mjs` runs only the `ui*.spec.mjs` files (`ui.spec`, `ui-visual.spec`, `ui-store.spec`, `ui-attrs.spec`, `ui-layers.spec`: dialogs, notices and the sandbox badge above modal dialogs of the app). The browser tests reach the check that runs on focus through `WDS.internals.testHooks.checkNow()`. Missing browsers: `npx playwright install firefox webkit`.
If the installed WebKit build is not the one this Playwright version expects, an older `webkit-*` build is used (or name one with
`WDS_WEBKIT_EXECUTABLE=/path/to/pw_run.sh`).
