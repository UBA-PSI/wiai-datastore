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
    const settings = (await store.get("settings")) || {};
    const draft = store.autosave("draft", () => state, { delayMs: 2000 });   // call draft.changed() after every edit
    document.getElementById("share").onclick = () => store.share();
  }
</script>
```

API summary: `unlock`, `onUnlock`, `onLock`, `lock`, `status`, `get`, `getMany`, `getRecord`, `getBlob`, `set`, `remove`, `list`, `collection`, `autosave`, `history`, `restore`,
`showHistory`, `onConflict`, `onStale`, `setLocale`, `share`, `exportAll`, `usage`. Every async method unlocks first when the store is locked. The full
description is PLAN.md 8.1.

* Values: JSON values, or `Blob`/`File`/`ArrayBuffer`/`Uint8Array` (stored as bytes). Names: any non-empty string up to 1024 bytes;
  `.wds/` is reserved.
* `set(name, value, {mime?})` resolves with `{name, version, size, resolution, value?, deleted?}`. `resolution`: `saved`, `mine`, `theirs` or `merged`; `value` is
  present for `theirs` (the kept version, unless it was a deletion) and for `merged` (what was stored).
* `get(name, {fresh?})`, `getRecord(name, {fresh?})`: `fresh: true` reads from the server and ignores the copy that `list()` keeps for a moment.
  `getMany(names, {concurrency = 6, fresh = false})` resolves with the values in the order of `names` (`undefined` for a missing record; concurrency 1 to 16)
  and rejects with the first error that is not "missing", after the requests in flight settled.
* `remove(name)` resolves with `{name, deleted, resolution, value?}`: `deleted` (removed now), `absent` (did not exist or was gone already), `mine` (conflict, deleted anyway),
  `theirs` (conflict, the other side's newer version was kept: `deleted: false`, `value` is that version).
* Errors: `WDS.errors.*` (`ConflictError`, `OfflineError`, `QuotaError`, `AuthError`, `IntegrityError`, `VersionError`, `UsageError`).
  `OfflineError.downloadBackup()` downloads what could not be saved.
* Options of `WDS.connect`: `scope` (required), `baseUrl` (service URL, default the faculty server), `locale` (default `navigator.language`),
  `notify: false` (no toasts), `watch: false` (no check for newer versions on window focus; collections are then not refreshed on focus either). `escrowPins` and `retiredEscrow` (IDs of escrow key sets) exist for tests only: a library build that has escrow pins ignores both options, so app code cannot replace the faculty keys. There is deliberately no option to inject `fetch`, storage or an Argon2 function, and the production bundle has no `WDSCore.setRandom`, `setArgon2` or `internals`, so no hook can see the passphrase or weaken the randomness.
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

`const saver = store.autosave(name, getState, {delayMs, onStatus, onError, onReplaced, mime})`; call `saver.changed()` after every edit. Statuses: `idle`, `dirty`, `saving`, `saved`,
`error`, `replaced`, `stopped`; `saver.stopReason`: `lock`, `removed`, `superseded`, `stop`. `await saver.flush()` resolves with the final status and never rejects; `saver.error` is the last error.

* One live handle per name: a new handle flushes and stops the old one (`superseded`), so running a start function twice is harmless.
* `getState` may return `undefined`: nothing is written. `changed()` on a stopped handle writes nothing and calls `onError` every time.
* `store.remove(name)` pauses the handles of that name during the request; they stop (`removed`) when the record is gone, resume when the request fails, and when the other
  side's version was kept they resume with status `replaced` and `onReplaced(value)`.
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
| `await notes.get(id)`, `await notes.getAll({concurrency, fresh})` | the value(s); records that are gone are skipped |
| `await notes.add(value, {id?, meta?, mime?, created?})` | `{id, name, version, resolution}`; ids are 10 characters `[0-9a-z]`, or yours (1 to 200 characters, no `/`); `created` (ms) only orders the list |
| `await notes.set(id, value, {meta?, mime?})`, `await notes.remove(id)` | the `set`/`remove` result |
| `notes.autosave(id, getState, opts)` | an autosave handle that also keeps the index meta current (index writes at most every 10 s) |
| `await notes.flush()` | resolves when every queued list change is on the server, rejects while it cannot be written |
| `await notes.rebuild()` | explicit repair: lists the prefix, downloads every item for its meta (one request per item) and rewrites the index |
| `notes.onChange(fn)` | `fn({items, added, removed, changed})` when the list changed other than by your own calls (refresh, other devices, repairs); returns an unsubscribe function |

The entity is written first, then the index. If the index write fails (offline, conflicts for 10 rounds), the call rejects with the underlying error carrying
`err.stored = true`, `err.id` and `err.record` (the record name): the item exists, do not add it again; the change stays queued and goes out with the next index write, when the
device is back online, on focus, and on lock. Records under the prefix that the index does not list are queued for the index whenever the page calls `store.list()`;
`rebuild()` repairs everything. Up to a few thousand items with meta under 200 bytes; split by year or project beyond that.

### Stable attributes (for tests and wds-verify)

Every button, input, select, textarea and summary inside the library's dialogs carries `data-wds="<name>"`, and every dialog carries `data-wds-view="<view>"`
(`loading`, `error`, `unlock`, `create`, `redeem`, `sheet`, `conflict`, `history`, `share`, `revoke`, `progress`, `notice`), updated on every view switch. Examples:
`unlock-submit`, `to-create`, `passphrase`, `passphrase-repeat`, `create-submit`, `sheet-confirm`, `sheet-continue`, `conflict-mine`, `conflict-theirs`, `invite-create`,
`revoke-confirm`. Toasts have `data-wds-toast="<key>"` and the buttons `toast-action` and `toast-dismiss`. The names do not change with the language; they are listed in the
header comment of `src/wds-ui.js` and covered by `test/ui-attrs.spec.mjs`.

### Sandbox

When the scope is a sandbox (the scope document's `sandbox` field is not `null`: open enrollment, small limits, all data deleted every night) the library says so:
dialog titles start with "Sandbox:" / "Testumgebung:", the create button reads "Create sandbox vault", every dialog shows a banner (`data-wds="sandbox-banner"`), and after unlocking
a fixed bar (`data-wds="sandbox-bar"`) stays on the page for the whole session; while it is shown, the library adds its height to the `padding-top` of `<html>` (inline, restored at lock), so the bar covers none of the app. Both use inline `!important` styles. There is no recovery contact and no recovery code
in the sandbox. A remembered access ID older than the last wipe is forgotten, and a session whose vault vanished after the wipe time locks with reason `expired` and the message that
the sandbox was emptied.

### Theming

Set CSS custom properties on `:root` (or any ancestor of `<body>`): `--wds-bg`, `--wds-fg`, `--wds-muted`, `--wds-border`, `--wds-accent`, `--wds-accent-fg`,
`--wds-danger`, `--wds-warn`, `--wds-ok`, `--wds-soft`, `--wds-radius`, `--wds-font`, `--wds-mono`, `--wds-font-size`, `--wds-z`. Dark
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

`test/docs.spec.mjs` (same config) checks what the server serves as documentation: the example app of `docs/site/integration.md` under the documented Content-Security-Policy in all three engines (with a negative control and the `onerror` fallback), the static checks of `tools/wds-verify.mjs` against that example, and `docs/site/export.html` served and saved to disk.

`test/integration.spec.mjs` starts the Python server from `../server` with a temporary database and generated escrow keys
(`test/integration-env.mjs`), builds a bundle that pins exactly those keys, and drives it from `file://` pages. It has its own
config (`playwright.integration.config.mjs`); `playwright.config.mjs` runs only the `ui*.spec.mjs` files (`ui.spec`, `ui-visual.spec`, `ui-store.spec`, `ui-attrs.spec`). Missing browsers: `npx playwright install firefox webkit`.
If the installed WebKit build is not the one this Playwright version expects, an older `webkit-*` build is used (or name one with
`WDS_WEBKIT_EXECUTABLE=/path/to/pw_run.sh`).
