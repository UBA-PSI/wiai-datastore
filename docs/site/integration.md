# WIAI Datastore: integration guide for developers and their Claude

You build or port a single-file web app (one HTML file that runs from file://, from a local web server or in Electron) and want
its data stored end to end encrypted on the faculty server. This page is everything you need. Machine-readable index:
[llms.txt]({{base}}/llms.txt). Current library: version **{{version}}**. Source code, PROTOCOL.md and the verifier wds-verify: {{repo_url}}.

The server stores only ciphertext, with one exception by design: the faculty keeps a recovery (escrow) key and can restore
a vault after a documented procedure. Never write "only the user can read the data" in an app. Wherever an app describes its privacy, use this sentence, word for word, in the language of the text (for a text in any other language use the English sentence; wds-verify reports in an info finding when neither sentence is in the page or the README):

- English: **Data is end-to-end encrypted; the faculty holds a recovery key for emergencies.**
- German: **Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel.**

A longer text may follow it (section 13, users.en.md and users.de.md say more), but it never contradicts it and never leaves it out.

## Checklist for Claude

1. Ask the developer for the scope ID (section 1). Do not invent one. Never write the sandbox scope ID ({{sandbox_scope}}) into an app (section 17).
2. Does the app exist already, with data in IndexedDB, localStorage or a file format of its own? Read section 16, "Porting an existing app", first.
3. Put the Content-Security-Policy meta tag (section 3) into the head before every script and the script tag (section 2)
   at the end of the body, exactly as printed here. Keep the onerror handler.
4. Create the store with `WDS.connect({ scope })` and keep user data only there (section 5). Register `store.onLock` and `store.onUnlock` once, outside any start function (section 4, "Lock and unlock again").
5. Model data as one record per entity. Many items or files: `store.collection` (section 6, "Collections"). Editors with `autosave`.
6. Decide conflicts in code only where a merge helps; everything else gets the library's dialog (section 7, "Conflicts in code").
7. Add buttons for share and export (sections 8 and 9). Hide edit controls for read-only members.
8. Test with the sandbox (section 17): `node tools/wds-verify.mjs <app.html> --target sandbox` runs the real library against the real service.
9. Run wds-verify (section 12), write a wds-verify.json for an app with tabs, dialogs or file inputs ("Writing wds-verify.json"), fix the findings and put the report into the README.
10. Add the text for users to the README or start page (section 13), starting with the official privacy sentence. Put the CLAUDE.md / AGENTS.md section from the dashboard into the app's repository.

## 1. Register a scope

A scope is one registered app. Staff of the University of Bamberg open the dashboard at {{base}}/ and sign in with
login.psi. After the first sign-in they choose "Create scope", enter a name, a description, a contact address and an
optional privacy note, and get:

- the **scope ID**, like `notenrechner-k7m2a9` (slug plus six random characters);
- the **join code**, which new users type when they create their vault (default enrollment mode "join code"; the
  alternatives are "open", limited by the maximum number of vaults, and "closed");
- the script tag and a ready-made prompt for Claude. The prompt carries the scope's settings (enrollment, breach check, record size, vault quota; dated),
  a line "if the app already exists, follow the section Porting", and a section for the app's own CLAUDE.md and AGENTS.md. The dashboard shows that section on its own, with a copy button.

The scope settings (quotas, enrollment, breach check on or off) can be changed on the dashboard, so the prompt is a snapshot. `wds-verify` prints the current ones from the public scope
document. The scope ID is public and is written into the app. The join code is not: hand it out to the users, never put it in the app.

## 2. The script tag

Exactly this tag, at the end of the body. The integrity hash is checked by the browser, so a changed library file is refused.
Library files never change once released: this URL stays valid and keeps working with the server.

```html
{{script_tag}}
```

- `crossorigin="anonymous"` is required for the hash check on a cross-origin file.
- The `onerror` handler runs when the file cannot be loaded or its hash does not match (offline, blocked, tampered):
  the page shows a message instead of staying blank. It needs `'unsafe-inline'` in the policy below, which is included.
- The tag belongs after the page content, because the handler replaces the body text. Scripts of the app follow it.
- Do not copy the library into the HTML file, do not download and self-host it, do not wrap it. Never load any other
  third-party script.
- Hash and version are published by the build in client/dist/hashes.json in the repository and at {{base}}/client/hashes.json. Current values:
  version `{{version}}`, integrity `{{sri}}`.

## 3. Content-Security-Policy

Put this into the head, right after `<meta charset>`, before any script:

```html
<meta http-equiv="Content-Security-Policy" content="{{csp}}">
```

What it does: nothing loads except the library from {{base}}/client/, and the page may talk only to the API
({{base}}/api/) and to the Pwned Passwords range service (the breach check of the passphrase dialogs; it receives the first five characters of
a SHA-1 hash, never the passphrase). If the scope has the breach check switched off, remove `https://api.pwnedpasswords.com` (the dashboard prompt and `wds-verify` say which).

Verified, not guessed: the real library including the Argon2id WebAssembly was loaded from a file:// page with exactly this
policy in Chromium, Firefox and WebKit, and vault creation, unlock, set/get, key file and access sheet downloads and exportAll
worked without a single policy violation (client/test/docs.spec.mjs runs this against the real server for every release).
Without `'wasm-unsafe-eval'` the key derivation fails in all three browsers.

- `'unsafe-inline'` is needed because single-file apps have inline scripts and styles. `'self'` is left out on purpose: what it
  means on file:// differs between browsers.
- If the app needs more, add only inert sources, for example `font-src data:`, `media-src blob: data:` or `img-src https://…` for images the app shows.
  Never add hosts to `script-src` or `connect-src`, and never use `default-src *` or `'unsafe-eval'`. wds-verify accepts exactly those three additions (it lists image hosts as
  information, not as a failure) and fails on anything wider: `'self'` or a host in `script-src`, `img-src https:` or `*`, a policy without `base-uri 'none'` or `form-action 'none'`.
- **Forms.** `form-action 'none'` blocks a real form submission, nothing else. A form whose submit handler calls `event.preventDefault()` and reads the fields in script works as usual
  and needs no rewrite. A form without such a handler would navigate and is blocked.
- **Downloads** the person asks for (a CSV, an attachment, a PDF) work under this policy through a `blob:` link with the `download` attribute (section 11).
- An app that talks to other services (a weather API, say) needs a different design discussion; ask the developer.

## 4. API reference

```js
const store = WDS.connect({ scope: "notenrechner-k7m2a9" });
```

Options of `WDS.connect`: `scope` (required), `baseUrl` (default: the faculty service), `locale` (default `navigator.language`, so the dialogs follow the browser; they are
German or English; change it later with `store.setLocale`), `notify: false` (no toasts: the app shows state itself), `watch: false` (no check for newer versions when the window gets
focus; collections are then not refreshed on focus either), `label: name => "…"` (what the built-in dialogs show instead of a record name; the history heading, the conflict dialog and the "newer versions" notice would otherwise say `"books/179249e9"`). `label` runs at any time, also before the list is loaded and after a lock, so it must not throw: keep a plain `Map` of titles that you fill from `notes.load()` and `notes.onChange` (`label: (name) => titles.get(name) || "this entry"`), do not call `notes.items()` or `notes.has()` in it. There is deliberately no option to inject fetch, storage or a crypto function.

Every method below that touches data **unlocks first** when the vault is locked: it opens one shared dialog (create a
vault, unlock with access ID or key file, redeem an invite code). Call `await store.unlock()` once at start so the dialog appears
when the page opens and not in the middle of an action. For an app that can be locked and unlocked again use `store.onUnlock` (below).

| Call | Result |
|---|---|
| `await store.unlock({ cancelable })` | Opens the dialog. Resolves with the status object. With `cancelable: true` the user can close the dialog and the promise rejects with `code: "cancelled"`. |
| `store.onUnlock(fn)`, `store.onLock(fn)` | `fn(status)` after every successful unlock (the first and later ones); `fn(reason)` after a lock. Both return an unsubscribe function; registering the same function twice registers it once. See "Lock and unlock again". |
| `await store.get(name, { fresh })` | The value (JSON value, or `Uint8Array` for files) or `undefined`. A plain `get` asks the server every time, except that a record the page downloaded for `list()` in the last 30 seconds is served from that download (once, up to 1 MB). `fresh: true` always asks the server: use it to reload an open item after `onStale` or a collection `onChange`. |
| `await store.getMany(names, { concurrency, fresh })` | The values in the order of `names` (`undefined` for a missing record). `concurrency` 1 to 16, default 6. Rejects with the first error that is not "missing", after the requests in flight finished. |
| `await store.set(name, value, { mime })` | Saves. JSON-serialisable values, or `Blob`, `File`, `ArrayBuffer`, `Uint8Array` (stored as bytes, MIME type kept). Resolves `{ name, version, size, resolution, value?, deleted? }`; `resolution` is `saved`, `mine`, `theirs` or `merged` (section 7). `value` is present for `theirs` (the version that won, unless it was a deletion) and for `merged` (what was stored). |
| `await store.getRecord(name)` | `{ name, version, kind, mime, time, length, value }` or `null`. `kind` is `json` or `bytes`, `time` is Unix milliseconds. |
| `await store.getBlob(name)` | A `Blob` with the stored MIME type, for `URL.createObjectURL`; `undefined` when the record does not exist (like `get`; `getRecord` returns `null`). |
| `await store.list(prefix)` | `[{ name, version, kind, mime, length, time }]` sorted by name; `prefix` is optional (`"notes/"`). No values. **Expensive**: see section 6. |
| `await store.remove(name)` | `{ name, deleted, resolution, value? }`. `resolution`: `deleted` (deleted now), `absent` (did not exist or was gone already), `mine` (conflict, deleted anyway), `theirs` (conflict, the other side's newer version was kept: `deleted: false`, `value` is that version). The deletion stays in the history. |
| `store.collection(prefix, opts)` | A list of records with an index that several devices extend without losing each other's items. Section 6, "Collections". |
| `store.autosave(name, getState, opts)` | Handle for editors (below). |
| `await store.history(name)` | `{ name, current, versions: [{ version, size, created, deleted }] }`, newest first. |
| `await store.restore(name, version)` | Writes an old version as a new one. |
| `await store.showHistory(name, { title })` | The built-in version browser with a restore button (disabled for read members). `title` replaces the record name in the heading, which the library words itself: pass only the name a person knows (the note title), not a sentence. The heading then reads *History of "Shopping list"*. |
| `store.onConflict(handler)`, `store.onConflict(pattern, handler)` | Decide conflicts in code, for every record or for one name or prefix (section 7, "Conflicts in code"). Without a decision the library's dialog asks the person. |
| `store.onStale(rows => …)` | Replaces the notice "newer versions exist elsewhere"; `rows` is `[{ name, version, known, deleted }]`. |
| `await store.share()` | Members dialog (section 8). |
| `await store.exportAll({ filename })` | Downloads every record, decrypted, as a ZIP (section 9). Resolves `{ count, filename, bytes }`. |
| `await store.lock()` | Saves pending edits (up to 8 s), then forgets all keys and removes the library's notices from the screen. `onLock` handlers get the `reason`: `user`, `revoked` or `expired`. |
| `store.setLocale(lang)`, `store.locale` | Sets the language of dialogs and notices from now on (`"de"` or `"en"`; also `"de-AT"` and the like) and returns it. An app with its own language switch calls it with every change and once at start, so that the app and the library never speak two languages on one screen. |
| `store.isUnlocked()`, `store.status()`, `await store.usage()` | State and quota use. `usage()` resolves `{ bytes, records, versions, limits: { max_value_bytes, vault_bytes, history_versions, … } }`. |

An app with a language choice of its own keeps it in the store (`settings`), calls `store.setLocale` once it has loaded it and again on every change; before that the dialogs use the browser language. Do not force a language that the person did not choose.

Console lines: while a vault is created the browser prints a `404` for the vault lookup, and a lost write prints a `412` (section 7). Both are normal, not bugs of the app.

Names: any non-empty string up to 1024 bytes; slashes make folders in the export. Names starting with `.wds/` are reserved for the
library and refused. Names are encrypted: the server sees neither names nor values.

`store.status()` returns `{ unlocked: false }` or `{ unlocked: true, role, accessId, vaultId, newDevice, recoveredByFaculty, rekeyPending, warnings, sandbox, … }`.
`role` is `owner`, `write` or `read`. `sandbox` is `true` when the scope is the public sandbox (section 17). Never display or log the access ID in the app beyond what the library shows (the last four characters, to name a vault in a confirmation, are fine).

### Autosave

```js
const saver = store.autosave("draft", () => state, {
  delayMs: 2000,                                   // wait this long after the last change (default 2000)
  onStatus: (s, err) => { statusEl.textContent = s; },   // idle | dirty | saving | saved | error | replaced | stopped
  onError: (err) => {},                            // OfflineError, QuotaError, ... the library also shows a notice
  onResolved: (res) => {},                         // the save lost a conflict (theirs) or was merged: res.value is what is stored now
  onReplaced: (value) => {},                       // a store.remove(name) kept the other side's newer version: show this value
});
saver.changed();         // call after every edit; cheap
await saver.flush();     // save now; resolves with the final status string and never rejects
saver.stop();            // no more saves from this handle
saver.status; saver.dirty; saver.error; saver.stopReason; saver.name;
```

Autosave reads the state with `getState` when the timer fires, serialises writes to one name, retries after a connection
failure, and warns before the page is closed with unsaved changes. Use it for everything a person edits.

- **One live handle per name.** A second `autosave` for the same name flushes the first one and stops it (`stopReason: "superseded"`). Creating handles again in a start function that runs twice is harmless.
- `getState` may return `undefined`: there is nothing to save right now, nothing is written.
- `changed()` on a stopped handle writes nothing and calls `onError` with a `UsageError` every time, so a handler that outlived its screen shows up in the console.
- `saver.error` is the last error (also passed to `onError`) and `null` after a successful save; `flush()` never rejects, so read `saver.error` or `onError` for the reason.
- `stopReason`: `stop` (you called `stop()`), `lock` (the vault was locked), `removed` (the record was deleted by `store.remove`), `superseded` (a newer handle for the same name).
- `store.remove(name)` pauses the handles of that name during the request. They stop (`removed`) when the record is gone and resume when the request failed. When the person kept the other side's newer
  version, they resume with status `replaced` and `onReplaced(value)` is called, so the editor can show it. Without `onReplaced` the library warns once in the console.
- Stop the handle yourself before you delete the entity, if you want the editor closed in the same step: `saver.stop()`, then `store.remove(name)`.

### Lock and unlock again

`store.lock()` stops every autosave handle and forgets the keys; the person can unlock again in the same page (an "Unlock" button that calls `store.unlock()`). Register the handlers **once, outside** the function that builds the screen:

```js
store.onLock((reason) => clearScreen(reason));   // reason: "user", "revoked" or "expired"
store.onUnlock(start);                           // after every successful unlock, the first one too
unlockButton.onclick = () => store.unlock();
store.unlock();                                  // opens the dialog when the page opens

async function start() {                         // may run many times: create collections and autosave handles here, load, render
  const items = await notes.load();
  render(items);
}
```

- Clear **everything of the vault** from the DOM in the `onLock` handler (lists, editors, previews, object URLs) and show an Unlock button or message. `onLock` fires for `user` too.
- Before any `onLock` handler runs, the library reads `getState()` of every unsaved autosave handle once and saves it (up to 8 seconds, together with pending collection index changes), so a handler that clears the editor cannot lose text.
  What could not be saved (offline, for example) is kept for the same vault and written after the next unlock, **before** the `onUnlock` handlers run, so `start` reads the saved values. After unlocking another vault, or after a revocation, it is dropped with a notice of the library.
- `store.collection(prefix)` and `store.autosave(name, …)` are safe to call again in `start`: the collection object of a prefix is the same one (the latest options win), and an autosave handle supersedes the old one of the same name.
- Nothing in `start` may depend on a value from before the lock: reload it.

## 5. Where data lives

- User data lives only in the store. Not in `localStorage`, `sessionStorage`, IndexedDB, cookies, the URL or `console.log`. (On file://,
  Chrome gives every local HTML file the same storage: other files could read it.) The only exception is the one-time migration of data an older version of the app left in the browser (section 16).
- Harmless app settings that are not user data (a sort order) may live in the store too: `store.set("settings", …)`.
- The library keeps a few non-secret items in localStorage under `wds:<scope>:…` (the access ID with the time it was remembered, and safety records). Leave them alone, and never call `localStorage.clear()`.
- Keys and passphrases exist only in memory of the page and are never accessible to app code.
- The app needs a connection: the library works online only. When saving fails it shows a notice with a backup download
  of the unsaved values. Do not build an offline mode.

## 6. Data modelling

- **One record per entity**: a note, a project, an exam, a student. Names like `notes/3f9a1c2e` or `exams/2026-ws`. Never one record that holds
  the whole app state: it conflicts constantly, grows the history quickly and hits the size limit.
- **A list of entities: use a collection** (`store.collection`, below). It keeps the index record that the app needs for lists and handles the merge when several devices add or remove items.
- **Files as separate records**: a second collection (below), or `store.set("files/report.pdf", file)`. Keep a small JSON record (or the entity record) with the
  file name and metadata and load the bytes only when needed. Each value is limited (10 MB by default; the scope sets it,
  the ceiling is 25 MB). Put the file ending into the record name (`covers/<id>.jpg`, not `covers/<id>`): `exportAll` adds an ending
  that matches the MIME type to names without one, but a name that already says what it is stays clear in the export.
- **IDs**: generate them in the app (`crypto.randomUUID().slice(0, 8)`) or let a collection generate them; do not derive them from user text that can change.
- **Settings**: one small record `settings`.
- **Editors**: `autosave`, never `set` on every keystroke. wds-verify flags more than one `set` per second and name.
- **What things cost.** A `get` is one request and downloads that record (its size plus a small envelope). `getMany(names)` is one request per name, at most `concurrency` (default 6) at a time. The **first call of list() in a session downloads
  every record of the vault once, whatever the prefix**, file records included (the prefix only filters the result): one request per 1000 records for the list and one per record for the content; later calls download only changed
  records. A `get` right after `list` (within 30 seconds, once per record, for records up to 1 MB) is served from that download, so the app does not pay twice. One write of a collection index re-encrypts and uploads the **whole index**
  (about 60 bytes plus the meta per item: 1000 items with 100 bytes of meta are about 170 KB), and every version counts against the vault quota like any other. Fine for tens or a few hundreds of small records through `list`; for more,
  or whenever the vault holds files (images, PDFs), do **not** call `list` at start: use a collection, which reads one index record with `get`, and fetch the files one by one with `getBlob` when the user opens them.
- **History**: the server keeps the last 10 versions of every record (the scope may change this), counted against the
  vault quota. Offer `store.showHistory(name)` for documents people care about.
- **Quotas**: values and vaults are limited; `QuotaError` tells the user. `await store.usage()` reports use and limits.

### Collections

`store.collection("notes/", { meta })` is a list of records `notes/<id>` plus an index record `notes.index` (outside the prefix, so `store.list("notes/")` never returns it). The index holds a little **meta** per item
(a title, a file name, a date: at most 512 bytes of JSON) so that a list renders without loading the items. Several devices can add and remove items at the same time without losing each other's changes.

```js
const notes = store.collection("notes/", {
  meta: (note) => ({ title: String(note.title || "").slice(0, 80) }),   // what a list needs; called on every write through the collection
});

async function showList() {
  renderList(await notes.load());                    // [{ id, name, meta, created }] sorted by creation; one request, then served from memory
}                                                    // (notes.items() is the same list, synchronously, once loaded)
notes.onChange(({ items, added, removed, changed }) => renderList(items));   // other devices, refresh(), repairs - not your own calls

async function addNote(note) {
  try {
    const { id } = await notes.add(note);            // writes notes/<id> first, then the index
    return id;
  } catch (err) {
    if (err.stored) return err.id;                   // the note exists; only the index write failed and is retried later: do not add it again
    throw err;                                       // nothing was stored
  }
}

function editNote(id, note) {                        // note: the object the editor changes; call .changed() after every edit
  return notes.autosave(id, () => note, { onStatus: showStatus });   // saves the note and keeps its list entry (title) current
}

async function deleteNote(id) {
  const res = await notes.remove(id);                // the remove() result (section 4); the index entry goes too
  renderList(notes.items());                         // your own calls do not fire onChange
  return res.deleted;
}

async function allNotes() {
  return await notes.getAll();                       // [{ id, name, meta, value }], 6 requests at a time; records that are gone are skipped
}
```

- **Methods.** `load()` reads the index once; `refresh()` reads it again and fires `onChange` when it differs. `items()` and `has(id)` are synchronous and throw a `UsageError` ("call await notes.load() first") before `load()` and after a lock. `get(id)`, `getAll({ concurrency, fresh })`, `add(value, { id, meta, mime, created })` (resolves `{ id, name, version, resolution }`; `created` is a number of milliseconds that only decides the order of the list, for ported data with a date of its own; `add` with an id that exists is a conflict like any write to a record this page has not read, so the person or your handler decides: use `set` for updates, and see "`set` and `created`" below), `set(id, value, { meta, mime, created })`, `remove(id)`, `autosave(id, getState, opts)`, `flush()` (resolves when every list change that is still queued is on the server, rejects while it cannot be written: the check before something irreversible), `rebuild()`, `onChange(fn)` (returns an unsubscribe function), `prefix`, `indexName`.
  Ids are 10 characters of `[0-9a-z]` unless you pass your own (1 to 200 characters, no `/`; a dot is fine, so `add(file, { id: random + ".pdf" })` keeps the ending). The prefix must end with `/`. A read member can load and read; a write returns `AuthError` with `code: "forbidden"`.
- **`set` and `created`.** `col.set(id, value, { meta, mime, created })` is an **upsert**: it writes the record `<prefix><id>` and makes sure the index names it. An id that is not in the index yet gets an entry (with its meta and its place in the list: `created`, by default now, so the end of the list); an id that is there keeps its place and gets the new meta.
  So `set` with an id of your choice also creates an item, for example in an import that keeps the old ids and the old order (`col.set(oldId, value, { created: oldDate })`); `add` is `set` with a random id (or your `id`). **`created`** is a number of milliseconds in the **index entry** only, it exists nowhere else: `items()`, `load()` and the rows of `onChange` carry it, the record's value never does. `add` and `set` write it for an entry that the index does not have yet (default: now); **for an entry that exists it is ignored**: an existing entry keeps its date, whatever `created` says.
  Put a date that people see into the value or the meta.
- **`set` for a record this page has not read.** The library writes on top of the version it knows (read with `get`, `getMany`, `getRecord`, `list`, `col.get`, `col.getAll`, or written by this page since the unlock). For a record it knows nothing about, `set` writes only if the record does not exist: if it does (an old item, another device, an interrupted import),
  that is a conflict like any other, so your `onConflict` handler or the library's dialog decides and the result says `mine`, `theirs` or `merged` (section 7). A `set` that must replace what is there, as in "an import overwrites items with the same id", reads the item first (`await col.get(id)`) or runs under `store.onConflict("notes/", (c) => c.keepMine())`. The old value stays in the history.
- **Merge, in four sentences.** The collection remembers the last index it read from or wrote to the server and the changes it has not written yet (add this id, remove that id). An index write stores that last index plus the pending changes, on top of its version. If another device wrote in between, the library takes
  the other device's index as the new base, applies the pending changes again and retries (up to 10 rounds). Nothing is decided by a clock, so a device with a wrong clock cannot make items disappear, and an item that one device removed stays removed while the other device's additions stay. Each entry also remembers the version of the record it describes, so a delayed list update from a device that saved an older version never replaces the newer title of another device.
- **Write order.** `add` and `set` write the entity first and then queue the index change; `remove` deletes the entity first. The index therefore never names a record that does not exist yet. A record that the index names but that is gone is skipped by `getAll` and `get` returns `undefined`; it leaves the index with the next index write.
- **When the index write fails** (offline, ten conflict rounds, a closed tab) the entity is stored and the call rejects with the real error carrying `err.stored = true`, `err.id` and `err.record` (the record name). The change stays queued and goes out with the next index write, when the device is back online, on focus and on lock.
  Never `add` it again. A record under the prefix that the index does not list ("orphan") is queued for the index whenever the page calls `store.list()` or `store.exportAll()`. `rebuild()` is the explicit repair: it lists the prefix, **downloads every item** to compute its meta (one request per item) and rewrites the index; use it for a "Repair list" button, not at start.
- **Other devices.** When the window gets focus the library notices a changed index, reads it and fires `onChange` (no "newer versions" notice for the index). `onChange` does not fire for your own `add`, `set`, `remove` calls, so render after them yourself. Changes of an item's content on another device are
  the business of `onStale` and the conflict handling as for any record.
- **Meta and cost.** Meta changes that come from `collection.autosave` are written to the index at most every 10 seconds and on lock and page hide, so a list on another device may show a title that is up to ten seconds old. Every index write uploads the whole index: keep meta under 200 bytes and a collection to a few thousand items;
  split by year or project beyond that. The library warns in the console above 256 KB.
- **Files** are a second collection with the ending in the id: `const files = store.collection("files/")` and `await files.add(file, { id: random + "-" + safeName, meta: { name: file.name, note: noteId } })`. The value is the `File` or `Blob` (stored as bytes, MIME type kept);
  without an explicit `meta` the collection's `meta` function receives the file. Show the list from the meta and load the bytes with `files.get(id)` or `store.getBlob("files/" + id)` when the person opens one.
- **Several apps or collections in one vault** are fine: every collection has its own prefix and index.

### Two devices

The same person opens a vault on a second device with the **access ID and passphrase** (or the key file from the access sheet and the passphrase) in the library's unlock dialog: not with an invite, which is for another person. Nothing in your app changes. What the app then has to handle:

- **The list.** `notes.onChange` fires when the library noticed (on focus) that another device changed the index; render again from the payload. Your own `add`, `set`, `remove` calls do not fire it.
- **An open item.** When the other device saved a newer version of the note that is open here, `store.onStale(rows)` (or, without it, the library's notice) tells the page. Reload it with `await store.get(name, { fresh: true })` and replace the editor content only if the person has not typed since; if they have, do nothing: the next autosave conflicts and the library's dialog lets them choose (or your `onConflict` handler decides).
- **Offline.** `unlock()` without a network does not reject: the dialog stays open, shows the error with a retry button and resolves only when the person is in (or rejects with `code: "cancelled"` when it was opened with `cancelable: true`). Writes while offline reject with `OfflineError` and the library offers a backup download; autosave retries.

### Files

A file is a record of bytes. `files.add(file, { id, meta })` stores the `File` or `Blob` with its MIME type.

- `files.get(id)` returns a `Uint8Array` without the MIME type; for an `<img>` or a download use `await store.getBlob("files/" + id)` (a `Blob` with the stored type) and `URL.createObjectURL`; revoke the URL when the picture goes away. Keep the file name and size in the meta (512 bytes at most) so that the list needs no download.
- **`files.getAll()` downloads every file.** Never call it for a files collection (and not `store.list()` at start: its first call downloads every record of the vault); show the list from `files.items()` and load one file when the person opens it.
- **Delete a note with its attachments** files first, then the note, so that a failure in the middle leaves a note with fewer attachments that can be deleted again, never files that nothing points to:

```js
async function deleteNoteWithFiles(noteId) {
  for (const f of files.items().filter((f) => f.meta.note === noteId)) await files.remove(f.id);   // an error stops here: the note is still there, try again
  return (await notes.remove(noteId)).deleted;
}
```

- **Conflicts on files.** Two devices that replace the same file: the dialog shows type and size of both versions (no text) and offers the download of both; `c.theirs.value` is a `Uint8Array`, `c.mine.value` is what you passed. Most apps never overwrite a file: `add` a new one and `remove` the old one.

## 7. Conflicts

Two devices or two members can change the same record. The library remembers which version it read and writes only on top
of it. When the server has a newer one, the default dialog says "Another device or person saved a newer version" and offers
**keep theirs**, **keep mine** (saved on top, so theirs stays in the history) and **download both**. It never overwrites silently.
`store.set` resolves with `resolution` so the app knows what happened (`saved`, `mine`, `theirs`, `merged`); for `theirs` and `merged` the result carries `value`, the value that is stored now. `store.remove` reports the same (`mine`, `theirs`).

For most apps the default is right. The default dialog shows the record name and the two values as text; pass a `label` to `WDS.connect` (section 4) to show a readable name, or decide in code so the person never sees raw JSON. The browser console
shows a `412` for the lost write; that is the conflict, not an error of the app. When the window gets focus the library also checks whether records it holds have newer versions elsewhere and shows a notice (`onStale` replaces it).

### Conflicts in code

```js
store.onConflict("settings", (c) => c.merge((mine, theirs) => ({ ...theirs, ...mine })));   // two devices changed different settings: keep both
store.onConflict("timer", (c) => c.keepTheirs());                                            // one exact record name
store.onConflict("notes/", async (c) => {                                                    // a prefix ending in "/": every note
  if (c.mine.deleted || !c.theirs || c.theirs.deleted) return;                               // no decision: the library's dialog asks the person
  if (c.mine.value.text === c.theirs.value.text) return c.keepTheirs();                      // only other fields differ
  const choice = await c.ask();                                                              // the library's dialog, now; resolves "mine" or "theirs"
  console.log("the person kept", choice);
});
```

- **Which handler decides**, for a conflict on name N: (1) the internal handler of a collection index (not replaceable: the merge above); (2) the handler registered for exactly N, else the one whose prefix matches N; (3) the global handler `store.onConflict(fn)` (`store.onConflict(null)` removes it); (4) the library's dialog.
  `onConflict(pattern, fn)` returns an unsubscribe function. A prefix must end with `/`; registering a prefix that overlaps one already registered is a `UsageError`, so at most one prefix matches.
- **A handler that decides nothing** (returns without calling a method and without returning `"mine"` or `"theirs"`), **throws or rejects** hands over to the library's dialog (a throw is also logged with `console.error`). A handler for one record type therefore never takes the dialog away from the others.
  A handler may be async. It is asked at most four times for one write; after that the write rejects with `ConflictError`.
- **The conflict object c**: `c.name`; `c.op` (`"set"` or `"remove"`); `c.mine` `{ value, kind, mime, deleted }` (`deleted` is true when the local operation is a delete); `c.theirs` `{ version, deleted, kind, mime, time, value }` or `null` (the record never existed on the server);
  `c.keepMine()`, `c.keepTheirs()`, `c.merge((mine, theirs) => value)` (may be async; `theirs` is `undefined` when the other side deleted the record), `await c.ask()`, or return `"mine"` or `"theirs"`. Call exactly one of them.
- **Results.** `set()` resolves `{ name, version, size, resolution, value?, deleted? }`; `remove()` resolves `{ name, deleted, resolution, value? }`. Use `resolution` to update the screen: `theirs` means the other side's value is the truth now.
- Do not build your own conflict dialog unless the person needs words the library cannot give; `label` and `c.ask()` cover most cases.

## 8. Members and sharing

Every user has their own vault. The owner shares the whole vault with `store.share()`: the dialog creates invite codes (role
**write** or **read**, valid 1, 2, 7 or 14 days), shows who has access, revokes access and offers key file and passphrase change. Revoking
re-encrypts everything under new keys, with a progress bar; it resumes by itself after an interruption. Members see only their own access.

New items of the others: a **collection** picks up items that other members added or removed when the window gets focus (`onChange` fires), and `notes.refresh()` does it on demand. Records that are not in a collection are not announced:
`onStale` and the focus check only cover records the page already holds, and polling `list()` is forbidden (section 11). A shared app with records outside collections therefore shows new entries of the others after a refresh
button that the user presses and that reads the data again.

The app only needs a Share button. Adapt the interface to the role:

```js
const role = store.status().role;                 // "owner" | "write" | "read"
if (role === "read") { textarea.readOnly = true; saveButton.hidden = true; }
```

A read member that writes anyway gets an `AuthError` with `code: "forbidden"`. There is one owner per vault. If the founder loses
passphrase and recovery code, the faculty can add a new owner (users.en.md, "Recovery").

## 9. Export and backup

`await store.exportAll()` downloads a ZIP: one file per record (JSON records get `.json`, file records without an ending get one that matches their MIME type, folders from slashes in names), `wds-export.json`
(name to file, kind, MIME, version, time, size) and `README.txt`. The files are **not encrypted**. Offer an "Export" button in
every app; it is the user's backup and the way out if the app is retired. Independently of the app, anybody can export a
vault with {{base}}/export/ using the access ID (or key file) and the passphrase. Collection indexes appear in the export as `notes.index.json`.

## 10. Errors

Thrown errors have `name`, `message`, often `code` and `status`. Classes are in `WDS.errors` for `instanceof` (`WDSError` is the base class of all of them). The library already shows a notice for
most of them; app code decides only what happens to the app's own screen.

| Error | When | What to do |
|---|---|---|
| `OfflineError` | no connection, server down | Keep the screen; `err.downloadBackup()` saves the unsaved values. Autosave retries. After a failed index write of a collection `err.stored` says the item exists. |
| `ConflictError` | write lost against a newer version and four rounds of handlers did not settle it, or an index write kept conflicting | Section 7. |
| `QuotaError` | value too large, vault or scope full, server read-only (`code: "read_only"`) | Tell the user; reads and deletes still work. |
| `AuthError` | wrong passphrase, session expired, access revoked (`code: "revoked"`), write by a read member (`"forbidden"`) | The library locks the store on revoked or expired; use `onLock` to clear the screen. |
| `IntegrityError` | data fails a check (tampered or damaged) | Do not continue to use that record; tell the user. |
| `VersionError` | data written by a newer library | Ask the user to update the app. |
| `UsageError` | misuse: `undefined` value, reserved name, `cancelled` dialog, `items()` before `load()`, a stopped autosave handle | A bug in the app, or the user closed the dialog. |

## 11. Forbidden patterns

wds-verify catches many of these (direct datastore access, other scripts, a wider policy, plaintext in requests and storage, rapid saves, the sandbox ID in the file, CSS that hides the library); the rest is your job.

- Any `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon` or form action towards the datastore host. Only the library talks to it.
- Own cryptography, own key derivation, own "encrypt before upload", base64 tricks. The library does it.
- Scripts from a CDN or any other host, `eval`, `new Function`, `document.write`.
- User data in localStorage, sessionStorage, IndexedDB, cookies, the URL, `console.log` (the one-time migration of section 16 reads old data and deletes it; it does not store new data there).
- **Downloads.** Files that the person explicitly asks for are fine: one file per click, such as a CSV of the entries, an attachment, a generated PDF. Never download in the background, on load or as a storage workaround ("save a copy locally in case"). Say next to the button
  that the file is not encrypted. `exportAll` is the right way to give a person all their data.
- A custom passphrase, login, key or "remember me" dialog; storing or caching passphrases; reading the library dialogs' inputs.
- Replacing, copying, minifying, patching or re-hosting the library; a changed integrity hash; a different CSP that is wider than this one. Hiding the library's dialogs or its sandbox label with CSS or script.
- The sandbox scope ID in an app file; deleting local data in a migration while `store.status().sandbox` is true; `localStorage.clear()`.
- One giant record; `set` per keystroke; polling `list` in a timer.
- Catching errors and ignoring them; showing "saved" while a save failed (use `onStatus`).
- Telling users their data is unreadable for the faculty (section 13 has the correct wording).

## 12. wds-verify

`wds-verify` is a smoke test, not a proof. It lives in the public repository ({{repo_url}}, folder `tools/`) and is not served from this website. It runs the finished app from file:// in Chromium, drives the library's dialogs by their stable attributes (so any language works),
and looks for the usual mistakes. It does not replace reading the rules of this page.

**Setup, once** (Node 22 or newer):

```sh
git clone {{repo_url}} && cd wiai-datastore
(cd tools && npm install && npx playwright install chromium)
node tools/wds-verify.mjs --script-tag                  # sanity check: prints the script tag, its integrity value must equal section 2
```

Run it from the clone, with the path of the app:

```sh
node tools/wds-verify.mjs <app.html>                    # Markdown report on stdout, exit code 1 if a check failed
node tools/wds-verify.mjs <app.html> --out report.md    # also write the report to a file
node tools/wds-verify.mjs <app.html> --target sandbox   # run against the public sandbox of the real service: no Python, no build
node tools/wds-verify.mjs <app.html> --sandbox-copy app-sandbox.html   # a copy for a person to open in a browser and try by hand
node tools/wds-verify.mjs <app.html> --static-only      # only the static checks: needs just Node, no browser
```

- **Targets** (`--target auto|mock|sandbox`, default `auto`; the first line of the report names the target and why). `mock`: the real server runs locally with a temporary database and everything is inspected, including the server's database; it needs Python 3.13 with the server packages
  (`python3.13 -m venv .venv && .venv/bin/pip install -r server/requirements.txt` in the clone). `sandbox`: the app opens against the public sandbox scope of the real service (section 17); no Python, no client build; the server's database is not inspected, but every request body still is.
  `auto` takes `mock` when Python is found, else `sandbox` when the sandbox is reachable, else only the static checks run (with a warning that says so).
- **Static checks** need only Node and the clone: the script tag names a published library version with the matching integrity hash and `crossorigin` (the hashes come from {{base}}/client/hashes.json first, then from `client/dist/hashes.json` of the clone; the report names the source and warns when they differ, then `git pull`);
  the Content-Security-Policy is present and not broader than the one above; no other script is loaded; nothing but the library talks to the datastore host; the sandbox scope ID is not in the file; no CSS hides the library; local data is not deleted without a sandbox guard.
- **Scope check** (every run with network access): the public scope document of the app's own scope ID is fetched. An unknown scope fails. The breach check on while `connect-src` lacks `https://api.pwnedpasswords.com` fails; off while the host is still allowed warns. The report prints the current enrollment, breach check and limits. Offline: "scope settings not checked".
- **Dynamic checks.** It opens the app, creates a vault through the library dialog, types unique canary strings into every visible input, textarea and contenteditable, presses the app's save-like buttons (text containing save, speichern, add, hinzufügen, anlegen, create, ok and similar, never delete, export, download, import, lock; plus every element marked `data-wds-verify="save"`),
  runs the steps of `wds-verify.json`, waits, then **reloads the page, unlocks again and looks for the typed values** ("Data after reload": an app has to read its data back when it starts). Canaries and the vault passphrase are searched for in every request (URL, header, body), page URL, localStorage, sessionStorage, IndexedDB, cache storage, cookies, console output,
  downloads and, with `mock`, the server's database (raw, URL-encoded, base64, hex and UTF-16). It also flags a record written three or more times within a second without a button press in between (use autosave), a record that holds the data of several items or the whole app state, and apps that store nothing during the run (then the run proved nothing: that fails).
- Options: `--strict` (warnings fail too), `--migration-delete` (with a `seed`), `--headed`, `--json`, `--locale <bcp47>`, `--wait-ms <n>` (time for debounced saves, default 2800), `--hashes <file>`, `--script-tag [version]`. Exit codes: 0 passed, 1 a check failed, 2 the tool could not run (missing Python for `--target mock`, no Playwright, bad arguments), 3 the sandbox is unavailable (rate limited, full or switched off: not an app finding, try again later).
- **Without a clone** there is no download of the static checks alone: they need the same small clone and Node. If you cannot clone, or have no Node at all, use "Without wds-verify" below and say in the README that wds-verify did not run.

### Without wds-verify

When the tool cannot run (no Node, no network to the repository), check by hand and write in the README what you did:

1. The script tag and the CSP are copied from sections 2 and 3 without change, the CSP comes before every script, and the hash in your file equals `{{sri}}`.
2. Search the file: no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource`, `eval`, `new Function`, no `<script src>` except the library, no `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie` for user data (section 16 for a one-time migration), the sandbox scope ID ({{sandbox_scope}}) is not in the file.
3. Make a copy of the file whose name contains "sandbox", replace the app's scope ID with the sandbox scope ID **in the copy only**, open the copy in a browser and walk through it: create a vault (the dialog says Sandbox), enter data in every view, reload, unlock again and check that the data is back; lock and unlock in the same page;
   open the same vault in a second window and change the same item in both (conflict); invite a read-only member and check that the app offers no edit controls; click every download and check what is in the file. Open the developer tools: the network tab shows only requests to `{{base}}/api/` and the Application tab only `wds:*` keys in localStorage. Delete the copy afterwards.
4. Say in the README which of these you did and which not.

### Writing wds-verify.json

The tool presses only what it recognises. An app whose input is hidden until the user acts, that has tabs, dialogs of its own or a file input needs **steps**. Put a file `wds-verify.json` next to the app. It is an object (a bare array is an error that says so); every key is optional:

```json
{
  "steps": [
    { "click": "#new" },
    { "fill": ["#text", "verify canary text for the notes example"] },
    { "wait": 3000 }
  ]
}
```

- `steps` run after the tool pressed the buttons it recognised, in order, after the vault was created. `click` takes a CSS selector. `fill` takes a selector and a text of at least 6 characters, unique (it is searched for like a canary), and valid for the field: a duration field needs a text it accepts, such as `"1,5 Stunden"`. `select` takes `[selector, value]`. `press` takes `[selector, key]`, for example `Enter` to submit a form.
  `upload` takes the selector of a file input and, optionally, a path relative to wds-verify.json: `{ "upload": ["#cover"] }` selects a generated PNG whose name and bytes are searched for like canaries, `{ "upload": ["#cover", "sample.jpg"] }` your own file (its name is searched for, not its content). **The tool never touches a file input by itself.**
  `download` takes the selector of a button that the person would press to get a file: the tool clicks it, expects a download and reports "user-requested download, contains canaries: yes/no" as information, never as a leak; a download at any other time stays a failure. `wait` takes milliseconds (at most 60000).
- `afterReload` (same step kinds) runs after the reload and the unlock, before the tool looks for the typed values. A tabbed app starts on its first tab, so open the tabs that show the data, one click per tab: `"afterReload": [{ "click": "#tab-projects" }, { "click": "#tab-notes" }]`. The tool looks at the page right after the reload and after every step and takes everything it saw together, so the values may be on different tabs. Result: "Data after reload" passes when at least one typed value of every round is visible again (values that the app neither showed as text nor wrote to the store before the reload, for example input it rejected, are not expected back; a value that only ever sat in an autosaved field counts as written, so an editor that is not read back is reported). An `afterReload` fill whose text contains a value typed before the reload fails, because the tool reads the values of fields too and would "find" it without the app reading anything; use another text or `{canary}`. It **fails** when records were written, nothing is visible and there are no `afterReload` steps;
  otherwise it warns ("x of y values visible; an app with tabs needs afterReload steps").
- `seed` tests the migration of old local data of a ported app. It is an object `{ "page": "old/index.html", "steps": [ ... ], "keep": [ ... ] }`: `page` is the old, local-only version of the app (a file next to `wds-verify.json`, otherwise a usage error), `steps` has the same forms as `steps` and needs at least one `fill` or `upload` (an old page with a file input and no `upload` step is pointed out: the files are then not exercised), `keep` (optional) names localStorage keys and `database/store` names that the migration leaves in the old storage on purpose; everything else that the old app filled must be gone afterwards. The tool opens the old page, runs the seed steps (a `{canary}` in a fill text becomes a unique generated value; it also works in `steps` and `afterReload`),
  opens the new app in the **same browser** (`file://` pages share localStorage and IndexedDB), creates the vault and runs `steps` first, so their first steps answer the app's migration question: `{ "seed": { "page": "old/index.html", "steps": [ { "fill": ["#title", "old note {canary}"] }, { "click": "#save" } ] }, "steps": [ { "click": "#migrate-yes" } ], "afterReload": [ { "click": "#tab-notes" } ] }`.
  Findings: "Seed: the old app" (the old app stored none of the typed values: fail), "Migration: old data visible" (looked for **after reloading and unlocking**, so only what came out of the vault counts: none visible: fail, some: warn), "Migration: old data only encrypted" (a seeded value in a request, the console, a cookie, the mock database, a new storage place or a download that is not the JSON backup, or in the old place when it grew: fail; the old app's own storage and the JSON backup are exempt) and "Migration: old data deleted" (mock target: **everything** the old app stored, every key and every store with rows, must be gone, not only the places that hold a typed value; fail when the migration visibly ran, with the names that are left) or "kept in the sandbox" (sandbox target: it must still be there). A prompt or a screen that lists the old storage cannot be told from the copy in the sandbox, where the old data stays: the deletion run (mock, or `--migration-delete`) is the proof.
  `--migration-delete` (needs a `seed`) sets `window.__WDS_MIGRATION_TEST__ = true` (and makes `navigator.webdriver` true) in the sandbox run, so that the recipe deletes there as well (section 16, Step 6); on the mock target it changes nothing and the report says so. The report names the flag in a line at the top. The app never sets the global itself: wds-verify fails a file that assigns it, and a page that sets it at run time. The run is fully described in `tools/README.md` of the repository.
- `locale` is the language of the browser (BCP 47, default `en-US`; `--locale` overrides). The library's dialogs follow the browser unless the app calls `store.setLocale`. The tool finds the library's controls by their `data-wds` attributes, so a German app works; only the app's own buttons are found by their text.
  Mark an app button with a name the word list does not know with `data-wds-verify="save"` (for example a button called "Weiter" that saves).
- Dialogs of the app itself need stable selectors (an id) for steps to reach them. A validation error names the step and the allowed forms.

An example for an app with four tabs (projects, time entries with a form, notes with attachments, a weekly view with a CSV button); it is the file of the example app in `examples/zeit-notizen/`:

```json
{
  "locale": "de-DE",
  "steps": [
    {"click": "#tab-projects"},
    {"fill": ["#project-name", "Projekt Canary Kolibri"]},
    {"click": "#project-add"},
    {"wait": 1500},
    {"fill": ["#project-name", "Zweites Projekt Canary Dachs"]},
    {"press": ["#project-name", "Enter"]},
    {"wait": 1500},
    {"click": "#tab-time"},
    {"fill": ["#entry-duration", "1,5 Stunden"]},
    {"fill": ["#entry-desc", "Zeiteintrag Canary Pelikan"]},
    {"click": "#entry-add"},
    {"wait": 1500},
    {"click": "#tab-notes"},
    {"click": "#note-new"},
    {"fill": ["#note-title", "Notiz Canary Wiesel"]},
    {"fill": ["#note-tags", "canary-tag-otter, zweiter-tag"]},
    {"fill": ["#note-text", "Notiztext Canary Biber mit mehreren Woertern"]},
    {"wait": 3500},
    {"upload": ["#note-file"]},
    {"wait": 3000},
    {"click": "#tab-week"},
    {"download": "#csv-all"}
  ],
  "afterReload": [
    {"click": "#tab-projects"},
    {"click": "#tab-time"},
    {"click": "#tab-notes"}
  ]
}
```

**What the run does not test** (the report ends with a "Not tested" section that says it): a second device and conflicts, read-only members, lock and unlock again in one page, buttons the tool does not press (delete, export, download, import, lock, anything the word list, `data-wds-verify` and the steps do not name), file inputs without an `upload` step,
fields hidden in views no step opens, dialogs of the app itself without stable selectors. Test these by hand, as in "Without wds-verify". Paste the report into the README of the app under "Verification". A warning that is a false positive is explained there in one sentence; it is not removed.
Until a library version is marked released (frozen) the tool warns that its hash may still change.

### Driving the library's dialogs in your own end-to-end tests

Every dialog of the library has `data-wds-view="<view>"` (it changes when the dialog switches to another view), every button, input, select, textarea and summary inside it has `data-wds="<name>"`, and the texts follow the language, so a test never selects by text.
Wait for a view with `page.locator('[data-wds-view="unlock"]')`, act on `[data-wds="passphrase"]` inside it. The attributes are part of the library's contract. wds-verify uses the same ones.

| `data-wds-view` | Shown when | Controls (`data-wds`) |
|---|---|---|
| `loading` | the scope is being read | none |
| `error` | the scope or the service cannot be reached | `retry`, `form-error` |
| `unlock` | the first screen of `store.unlock()` | `access-id-input`, `passphrase`, `show-passphrase`, `unlock-submit`, `keyfile` (the hidden file input) and `keyfile-button`, `to-create`, `to-redeem`, `form-error` |
| `create` | "Create a vault" (also the notice that creating is closed or paused) | `join-code` (not in the sandbox), `passphrase`, `passphrase-repeat`, `show-passphrase`, `recovery-contact-toggle` and `recovery-contact` (not in the sandbox), `create-submit`, `back`, `form-error` |
| `redeem` | "Use an invite code" | `invite-code-input`, `passphrase`, `passphrase-repeat`, `show-passphrase`, `redeem-submit`, `back`, `form-error` |
| `sheet` | the access sheet after creating a vault or redeeming an invite | `access-id`, `recovery-code` (owner, not in the sandbox), `sheet-keyfile`, `sheet-print`, `sheet-download`, `sheet-confirm` (a checkbox), `sheet-continue` (enabled once `sheet-confirm` is checked), `form-error` |
| `conflict` | the conflict dialog | `conflict-theirs`, `conflict-mine`, `conflict-download` (when both sides can be downloaded), `form-error` |
| `history` | `store.showHistory(name)` | `history-version` (one per version, with `data-wds-version="<n>"`), `history-preview`, `history-restore`, `form-error`, `close` |
| `share` | `store.share()`, the members dialog | `person` and `person-escrow` (one row per member), `member-role`, `cancel-invite`, `revoke`, `invite-role`, `invite-expiry`, `invite-label`, `invite-create`, `invite-code`, `invite-copy`, `invite-another`, `me-keyfile`, `me-renew`, `me-lock`, `me-passphrase-toggle`, `passphrase`, `passphrase-repeat`, `show-passphrase`, `me-passphrase-submit`, `recovery-request` (with `recovery-cancel`, `recovery-keep`), `recovered-notice` (with `recovered-ack`), `rekey-continue`, `form-error`, `close` |
| `revoke` | the confirmation inside the members dialog | `revoke-id`, `revoke-confirm`, `revoke-cancel` |
| `progress` | a revocation re-encrypts the vault | none (a progress bar; the dialog goes back to `share` when done) |
| `notice` | after unlocking: a recovery was requested, or the faculty added an owner access | `recovery-request` with `recovery-cancel` and `recovery-keep`, `recovered-notice` with `recovered-ack`, `form-error`, `close` |

Everywhere: `close` (only in dialogs that can be cancelled), `sandbox-banner` (a message in every dialog while the scope is the sandbox). On the page, outside any dialog: `sandbox-bar`, and notices of the library are toasts with `data-wds-toast="<key>"`
(keys such as `stale`, `offline`, `quota`, `forbidden`, `session`, `newdevice`, `readonly`, `unsaved`) and the buttons `toast-action` and `toast-dismiss`. The comment at the top of `client/src/wds-ui.js` in the repository is the source of this table.

A vault in a test, in four steps (Playwright; the same works in any driver): open the page and call `store.unlock()`, or wait for the app to; in `unlock` click `to-create`; in `create` fill `join-code` (not in the sandbox), `passphrase` and `passphrase-repeat` and click `create-submit` (the Argon2id key derivation takes several seconds: wait up to 60 s for `sheet`);
in `sheet` read `access-id`, check `sheet-confirm`, click `sheet-continue`. Unlocking again: `access-id-input`, `passphrase`, `unlock-submit`.
`tools/lib/drive-library.mjs` in the clone does exactly this for wds-verify and for your own scripts: `import { createVault, unlock } from "<clone>/tools/lib/drive-library.mjs"`, then `const { accessId, passphrase } = await createVault(page)` (the app calls `store.unlock()`, the function answers the dialogs) and, after a reload, `await unlock(page, { accessId, passphrase })`; its header comment lists the single-step functions too. You may use the Playwright of the clone (`tools/node_modules/playwright` after `cd tools && npm install && npx playwright install chromium`) for your own test scripts, for example to seed old data and open the new app (section 16, Step 6); no second copy is needed.
Use the sandbox (section 17) for such tests, or a test vault in your own scope (the join code is a secret of the staff: ask for it, never write it into a file).

## 13. What to tell users

Put this in the app's README or on its start page, adapted to the app. English first, German below; the German text uses "Sie". **The first sentence of each language is the official wording of the faculty** (it stands at the top of this page, and the dashboard prompt gives it too):
keep it word for word at the start. The rest may be shortened or reworded, but the app must not claim more ("only you can read your data") or less than this.
An app with a language switch shows the sentence in the language that is set; for a third language use the English sentence.

```text
Data is end-to-end encrypted; the faculty holds a recovery key for emergencies.
Your data is stored on a faculty server. You need:
1. The join code from the person who runs this app (only for creating a vault).
2. A passphrase of your own, at least 12 characters. It cannot be reset: the server does not know it.
3. Your access sheet (access ID and recovery code). Print it or save it somewhere apart from this device.
With your recovery code the faculty can restore access after a documented procedure. Details: {{base}}/docs/users.en

Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel.
Ihre Daten liegen auf einem Server der Fakultät. Sie brauchen:
1. Den Beitrittscode von der Person, die diese App betreibt (nur zum Anlegen Ihres Tresors).
2. Eine eigene Passphrase mit mindestens 12 Zeichen. Sie lässt sich nicht zurücksetzen: Der Server kennt sie nicht.
3. Ihr Zugangsblatt (Zugangskennung und Wiederherstellungscode). Drucken oder speichern Sie es getrennt von diesem Gerät.
Mit Ihrem Wiederherstellungscode kann die Fakultät nach einem dokumentierten Verfahren den Zugang wiederherstellen. Details: {{base}}/docs/users.de
```

If the app offers downloads (a CSV, an attachment, a PDF), say next to the button that the file is **not encrypted**. If the app says "saved locally" or "stays on this device" anywhere, that sentence is wrong now: replace it with the text above.

## 14. Complete minimal example

A notes app: list, create, edit with autosave, delete, share, export, lock and unlock again. Replace the scope ID. It was run in Chromium, Firefox
and WebKit from file:// against the real server with exactly this policy and script tag (client/test/docs.spec.mjs extracts
this block from the rendered page and tests it). With the first `wds-verify.json` of section 12 next to it, it passes wds-verify.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="{{csp}}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notes</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  textarea { width: 100%; box-sizing: border-box; }
  li.current .open { font-weight: bold; }
</style>
</head>
<body>
<h1>Notes</h1>
<p>
  <button id="new" disabled>New note</button>
  <button id="share">Share</button>
  <button id="export">Export</button>
  <button id="unlock" hidden>Unlock</button>
  <span id="status" role="status"></span>
</p>
<ul id="list"></ul>
<textarea id="text" rows="10" disabled aria-label="Note text"></textarea>

{{script_tag}}
<script>
"use strict";
const store = WDS.connect({ scope: "myapp-k7m2a9" });   // the scope ID from the dashboard
const notes = store.collection("notes/");               // the list of notes; a notes app of this size loads all of them (with a lot of notes, keep a title in the meta instead)
const $ = (id) => document.getElementById(id);
const texts = new Map();   // id -> { text }
let current = null;        // the open note: { id, saver }

function render() {
  $("list").replaceChildren(...[...texts].map(([id, note]) => {
    const li = document.createElement("li");
    if (current && current.id === id) li.className = "current";
    const open = document.createElement("button");
    open.className = "open";
    open.textContent = note.text.split("\n")[0] || "(empty)";
    open.onclick = () => openNote(id);
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.onclick = () => deleteNote(id);
    li.append(open, " ", del);
    return li;
  }));
}

async function closeNote() {
  if (current && current.saver) { await current.saver.flush(); current.saver.stop(); }
  current = null;
  $("text").value = "";
  $("text").disabled = true;
}

async function openNote(id) {
  await closeNote();
  const note = texts.get(id);
  const readOnly = store.status().role === "read";
  const saver = readOnly ? null : notes.autosave(id, () => note, {
    onStatus: (s) => { $("status").textContent = s; },
    onResolved: (res) => {                              // another device saved first and its version won
      if (res.resolution !== "theirs") return;
      note.text = res.value.text;
      if (current && current.id === id) $("text").value = note.text;
      render();
    },
  });
  current = { id, saver };
  $("text").value = note.text;
  $("text").readOnly = readOnly;
  $("text").disabled = false;
  $("text").focus();
  render();
}

async function deleteNote(id) {
  if (current && current.id === id) { if (current.saver) current.saver.stop(); await closeNote(); }
  await notes.remove(id);
  texts.delete(id);
  render();
}

$("text").oninput = () => {
  texts.get(current.id).text = $("text").value;
  render();
  if (current.saver) current.saver.changed();
};
$("new").onclick = async () => {
  const id = crypto.randomUUID().slice(0, 8), note = { text: "" };
  texts.set(id, note);
  await openNote(id);                                   // open first, so that the person can type at once
  notes.add(note, { id }).catch((err) => { if (!err.stored) console.error(err); });   // creates the record and its list entry now; autosave keeps them current
};
$("share").onclick = () => store.share();
$("export").onclick = () => store.exportAll();
$("unlock").onclick = () => store.unlock();

notes.onChange(async ({ added, removed }) => {          // notes that another device added or removed
  removed.forEach((id) => texts.delete(id));
  if (store.isUnlocked()) for (const id of added) { const note = await notes.get(id); if (note) texts.set(id, note); }
  render();
});
store.onLock(() => {                                    // nothing of the vault may stay on screen
  texts.clear();
  current = null;
  $("text").value = "";
  $("text").disabled = true;
  $("new").disabled = true;
  $("list").replaceChildren();
  $("unlock").hidden = false;
});
store.onUnlock(async () => {                            // after every unlock, the first one too
  texts.clear();
  for (const { id, value } of await notes.getAll()) texts.set(id, value);
  $("unlock").hidden = true;
  $("new").disabled = store.status().role === "read";
  render();
});
store.unlock();                                         // the dialog: create a vault or unlock
</script>
</body>
</html>
```

## 15. Deployment of the app

The finished app is one HTML file. Users open it from their disk, from any web server or in Electron. Nothing else is needed:
no build step, no server of your own. If you move the app to a new address, the data stays: it belongs to the vault, not to the
address. To retire an app, ask the scope administrator to keep the scope for a while so users can export (users.en.md).

## 16. Porting an existing app

An app that exists already keeps its screens and its logic. What changes is where its data lives. Work through the steps in order. Every code block below was run in Chromium, Firefox and WebKit against the real server (examples/docs-recipes.spec.mjs).

### Step 1: inventory

Find every place where the app keeps or reads data that outlives the page: `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, the Cache API, file handles, `fetch` to a server of its own, and its own export and import (a JSON or CSV file).
For each, write down what kind of entity it holds, how many there are, how large they get, and who changes them. Then map each kind:

| What the app has | In the datastore |
|---|---|
| A list of things: notes, entries, projects, students | A **collection**: `store.collection("notes/", { meta })`, one record per thing (section 6) |
| A single small thing: settings, the running timer, a draft | One record: `store.set("settings", …)` and `store.get("settings")`; a draft or editor through `autosave` |
| Files: images, PDFs, attachments | A second collection of bytes, ending in the id (`"files/"`, ids like `a1b2c3-report.pdf`); the list entry in the owning item or in the meta |
| References between things | The other thing's id inside the value (or the meta) |
| Computed data (totals, search results, week tables) | Not stored: compute it from the records |

### Step 2: replace the storage calls

| Before | After |
|---|---|
| Read everything at start | `await store.unlock()` (or `onUnlock`), then `await col.load()` for the list, `col.getAll()` when every value is needed, `col.get(id)` when one is opened |
| Save after an edit | `col.autosave(id, () => item)` and `saver.changed()` for editors, `col.set(id, item)` for button saves, `col.add(item)` for new items |
| Delete | `await col.remove(id)`; check the result (section 4) |
| "Save as backup" / JSON export of everything | `store.exportAll()` |
| Import of the old file format | keep it (Step 3) |
| A save on `beforeunload` or `visibilitychange` | remove it: the library warns before closing and saves on lock |
| A "saved" label | the autosave `onStatus` (never show "saved" before the write returned) |

The app now needs the vault to be open before it shows data: register `store.onLock` and `store.onUnlock` once and build the screen in `start` (section 4, "Lock and unlock again").

### Step 3: own export and import

Replace the app's own "export everything" with `store.exportAll()`; it is the backup and the way out. **Keep an import** for the old export format, so that people who exported from the old version can move their data over: they export in the old version and import in the new one.
Reading a file the person chose is not storing data, so it is allowed:

```js
const notes = store.collection("notes/", { meta: (n) => ({ title: n.title }) });

async function importOldExport(file) {                // file: a File from <input type="file">; old format: { "notes": [{ "id": 1, "title": "…", "text": "…" }] }
  const data = JSON.parse(await file.text());
  if (!data || !Array.isArray(data.notes)) throw new Error("This is not an export of the old version.");
  let count = 0;
  for (const old of data.notes) {
    await notes.add({ title: String(old.title || ""), text: String(old.text || "") });   // new random ids: importing the same file twice makes copies
    count++;
  }
  return count;
}
```

That variant gives every note a new random id, so references between items are lost and a second import of the same file makes copies. An app whose items refer to each other (a PDF belongs to a note by its number, the old ids are counters) keeps the old ids and rewrites every reference through the same function: a second import then overwrites instead of doubling, `created` keeps the old order of the list (it counts for an id that the list does not have yet), and the ids are the ones that Step 4 builds with `tagged: false`, so data that arrives once by this import and once by the migration of another browser is one copy, not two.
Use it instead of the first variant (it needs `notes` from above):

```js
const files = store.collection("files/");
const newId = (oldId) => (typeof oldId === "string" ? "s" : "j") + encodeURIComponent(typeof oldId === "string" ? oldId : JSON.stringify(oldId));   // 12 becomes "j12"; the same function for ids and references

async function importOldExportKeepingIds(file) {      // old format: { "notes": [{ "id": 1, "title": "…", "text": "…", "created": 1700000000000 }], "files": [{ "id": 7, "noteId": 1, "name": "plan.pdf", "type": "application/pdf", "base64": "…" }] }
  const data = JSON.parse(await file.text());
  if (!data || !Array.isArray(data.notes)) throw new Error("This is not an export of the old version.");
  for (const old of data.notes) {
    await notes.get(newId(old.id));                   // read first: an item that exists is overwritten, not a conflict
    await notes.set(newId(old.id), { title: String(old.title || ""), text: String(old.text || "") }, { created: +new Date(old.created) || undefined });
  }
  for (const f of data.files || []) {
    const id = newId(f.id) + (/\.\w{1,8}$/.exec(f.name) || [""])[0];                 // the ending stays in the id
    await files.get(id);
    await files.set(id, new Blob([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], { type: f.type || "" }), { meta: { name: f.name, note: newId(f.noteId) } });
  }
  return data.notes.length + (data.files || []).length;
}
```

### Step 4: data that is still in the browsers of existing users

Existing users have data in IndexedDB or localStorage. Dropping it would lose it. The rule "no user data in IndexedDB or localStorage" means the app never **stores** data there; **reading the old data once, writing it into the store and deleting it afterwards is the intended way** (and the only exception to the rule).
Do not leave the old copy behind: it would be unencrypted data on the device for ever. The recipe below does it with the safeguards that matter. Both sources are first-class: IndexedDB stores and named localStorage keys (many lay-built apps have only the latter; a data URL in a key becomes a file).

- **The new app must be opened from the same origin as the old one.** A page reads only the storage of its own origin. An app served over `http(s)` needs the same scheme, host and port. A file opened from disk depends on the browser: Chromium shares localStorage and IndexedDB between all `file://` pages, Firefox gives every file its own storage. So replace the old file in place (same path, same name) and tell the users to open the new version the way they opened the old one.
  wds-verify runs Chromium and opens the old page and the new app in one browser, so it cannot show this problem; its "Not tested" list names it when a `seed` is present.
- **Only the owner, never in the sandbox.** Only `store.status().role === "owner"` migrates; a member's vault is not the place for someone else's old data. When `store.status().sandbox` is true (you are testing against the sandbox), the data is copied and **the old data is not deleted**: the sandbox is wiped tonight and the old data would be gone for good.
  The sandbox takes small seed data only ({{sandbox_limits}}): test the migration with a few small items there, and with real-size data against a test vault in the app's own scope (Step 6).
  The one exception is the test global `window.__WDS_MIGRATION_TEST__ === true`, which `wds-verify --migration-delete` sets in its own throw-away browser; the recipe also asks for `navigator.webdriver`, so it does nothing in a person's browser. **Never write the global into the app**, not even to see the deletion by hand: wds-verify fails a file that assigns it.
- **A tag per browser.** Old ids are only unique inside one browser. Two browsers of the same person that both hold a note with the id `1` would overwrite each other in one vault. The recipe creates a random tag once per browser and keeps it in the old storage (the one permitted write there: it is no user data; it **stays** when the old data is deleted, because it names this browser in the vault).
  The tag names the browser's own records in **both** modes: the migration marker `migration/<tag>` and the settings records `migrated/<tag>/…`, so one browser's marker never allows another browser to delete, and two browsers never share a settings record. With `tagged: true` (the default) it also names every new item `<tag>-<oldId>`.
  The old key is encoded so that two different keys never give the same id (`"a/b"` and `"a_b"`, `1` and `"1"`), references between entities go through the same function, and the old creation date becomes `created` (the order of the list). A second run in the same browser writes the same ids and skips what is there already.
  **The new ids contain `-` and `%`** (`<tag>-j12`, `<tag>-soldapp%3Aavatar`; a file keeps its ending, `<tag>-j7.pdf`). Code that splits an id at `-`, takes the part before it as the "real" id, reads a number out of it or builds a file name from it must be checked and changed before the first migrated item is shown: take the whole id, and look the rest up in the meta.
  The same holds wherever an id goes into something with a syntax of its own: `querySelector("#item-" + id)` and other CSS selectors (use `CSS.escape(id)`, or keep the id in `data-id` and read `dataset.id`), `id="…"` attributes, `location.hash` routes (the browser may rewrite `%3A`: use `encodeURIComponent`), and arithmetic on ids (`Number(id)` sorts, a counter `nextId = max + 1` gives `NaN` once a migrated id is in the list).
  **Do you need the tag in the item ids? Decide by the old ids.**

  | The old ids are | Choose | Why |
  |---|---|---|
  | counters, short or typed by people (`1`, `"settings"`, a title) | `tagged: true` (the default) | the same id in two browsers means two different things; without the tag they would overwrite each other |
  | random and long enough that two different items never share one (a UUID; eight random hex characters are fine for some hundred items, not for thousands) | `tagged: false` is possible | the item ids stay short and the code that reads them needs no change except for the `%` of an encoded key; the marker and the settings stay per browser |

  The two choices fail differently when the same data reached two browsers (the person exported and imported it, or copied the profile) and both are migrated. **With the tag you get duplicates**: every item exists twice, once per tag. Nothing is lost and nothing is overwritten, the person deletes the copies. **Without the tag you can get conflicts**: the second browser finds the ids in the vault.
  Items that are identical count as copied (one item remains). Items that differ are never overwritten: that run ends `failed`, names the items that differ and keeps the old data of that browser. The person (or you) has to settle them, then the next start finishes. When in doubt, keep the tag: duplicates cost a click, a conflict stops a migration.
- **One run at a time.** The Web Locks API (`navigator.locks`) keeps a second tab of the new app from migrating at the same moment.
- **The person decides, with the vault named.** The confirmation names the vault by the last four characters of its access ID (the full ID is on the access sheet; never show it in full in the app).
- **It must fit, and big items are not lost.** The sizes are checked against `store.usage()` first; a migration that would run into the quota stops before it writes. An item larger than the limit of one record is not copied: the recipe lists such items in the question, offers each as a download, copies the rest,
  and deletes the old data only if the person confirms a second time (otherwise the result is `partial` and nothing is deleted).
- **Verify before deleting.** Everything is read back with `fresh: true` (from the server, not from the page's memory) and compared byte for byte, and `col.flush()` makes sure that every list entry is on the server.
  A record that an interrupted earlier run stored without its list entry is found (`has()` is false) and repaired with `col.rebuild()`.
- **A download of the old data** is offered before it is deleted (a download the person asks for). A `Blob` or `File` in it is listed as `{ size, type, name }` (a plain `JSON.stringify` would write `{}`; the bytes are in the vault); `ArrayBuffer` and typed arrays as `{ size }`.
- **Blobs and Files.** An old store may keep a `Blob` or `File` (`value.blob`, or the Blob itself as the row value) instead of bytes (`value.data`). `blobOf()` takes any of the three and **throws** for a row that has none (a field named `pdf` or `content` is not guessed), and the vault gets a `Blob` with the old type; the file name goes into the meta.
- **Key-value stores and settings.** A key-value store in IndexedDB (a store `meta` with rows like `"timer"` and `"lang"`, written with `put(value, key)`) is read like any store; its rows are `{ key, value }`. `toNewRecords` writes them into one record `migrated/<tag>/meta`, and the keys of localStorage (not data URLs) into `migrated/<tag>/local`, **as the strings that localStorage held** (the app parses them as it did before; a string such as `"12345"` or `"true"` stays a string).
  They are settings of the old app, not items, and the recipe treats them differently: they are **snapshots that a rerun overwrites** (a timer that changed in the old app meanwhile does not make the next run fail, as an item that differs does), and once the app has taken them over they are not copied again.
  **Taking them over exactly once** is state in the vault, not the return value of one run: `migratedSettings()` returns `{ tag, local, meta }` as long as this browser's marker says `settings: "pending"` (so also after the page closed between the migration and the save, after a rerun, and in the sandbox where the old data stays) and `null` otherwise, without a request when this browser never migrated. The app saves its settings and then calls `settingsDone(old)`, which marks them `"applied"` for good: a timer that the person stopped does not come back running.
  `fillGaps(current, old)` takes an old value only where the vault has none (`undefined` or `null`: a language that is set stays, a running timer is not replaced). Call all of this **before the app writes defaults of its own** (a start that writes `{ lang: "en", timer: null }` first leaves only the `null` to fill), and decide per field whether `null` means "not set" (the old value may fill it) or "set to none" (then store `false` or `0` for that).
  A browser that migrated costs one small read per start (the marker); the other browsers cost nothing.
- **Delete only what was copied.** The recipe fingerprints the old data: a count and a checksum per store and key; for a `Blob` or `File` its size, type, name, `lastModified` **and a checksum of its bytes**. Reading a Blob is asynchronous and an IndexedDB transaction ends as soon as the code waits for anything but a request, so the delete works in two steps: the recipe reads all old rows again and checksums every Blob (outside any transaction), and a difference to what was copied ends the run with `deleted: "changed"`. Then one transaction reads the stores once more, compares them with that second reading by count, size, type, name and `lastModified`, and empties them only when they are the same.
  What stays undetected is a Blob that another tab replaces by one with the same size, type, name and modification time in the few milliseconds between the second reading and the transaction. localStorage keys are removed only when their value is still the copied one. If the old app was used in between (another tab), the result is `deleted: "changed"` and nothing is deleted; the next start copies what is new. An item that was **changed** in the old app after its copy (not added) is never overwritten in the vault: the next run ends `failed`, names it and keeps the old data, and the person decides which version stays. There is no `deleteDatabase` and no pending request that a closing tab could complete later,
  and never `localStorage.clear()` (the library keeps its keys there).
- **A migration record**, `migration/<tag>` (date, tag, counts, fingerprint, `settings`), marks a verified copy: the person confirmed it and everything was read back and compared. A start that finds the old data unchanged since then does not ask again, but it reads the copy from the vault once more before it deletes: the fingerprint is a 32-bit checksum, not a proof, and a record can be gone since. If that comparison fails, the whole flow runs again.
  On any failure the old data is kept and the app says so; the app never writes application data to the old storage again.
- If the browser offers no IndexedDB to the page, `openOldDb` answers `null` and only the localStorage keys are looked at. On a fresh test vault (what wds-verify uses) there is no old data, so the recipe shows no dialog; test the migration with a seeded old database (`examples/docs-recipes.spec.mjs` in the repository does).
- Members and non-owners with old local data are skipped: tell them to export in the old version, and let the owner import that file (Step 3). An old export with files embedded as base64 needs its own small import function; the recipe's `dataUrlToBlob` is the decoder.

```js
// Adapt: the names of the old database, its object stores and its localStorage keys, and toNewRecords().
// "meta" is a key-value store (put(value, "timer")): its rows become { key: "timer", value }. tagged: false drops the per-browser tag from the item ids only (see "A tag per browser").
const OLD = { db: "oldapp", stores: ["notes", "files", "meta"], keys: ["oldapp:prefs", "oldapp:avatar"], tagKey: "oldapp:migration-tag", lock: "oldapp-migration", tagged: true };
const notes = store.collection("notes/", { meta: (n) => ({ title: n.title }) });
const files = store.collection("files/");

const idb = (req) => new Promise((ok, fail) => { req.onsuccess = () => ok(req.result); req.onerror = () => fail(req.error); });

function openOldDb() {                                // resolves null when there is no such database (a plain open would create an empty one)
  return new Promise((ok, fail) => {
    let req;
    try { req = indexedDB.open(OLD.db); } catch (err) { return ok(null); }        // no IndexedDB here: no old data there either
    req.onupgradeneeded = () => req.transaction.abort();
    req.onsuccess = () => ok(req.result);
    req.onerror = () => (req.error && req.error.name === "AbortError" ? ok(null) : fail(req.error));
  });
}

async function readOldRows(db) {                      // { local: [{ key, value }], notes: [{ key, value }], files: [...] }; db may be null
  const rows = { local: OLD.keys.filter((k) => localStorage.getItem(k) !== null).map((key) => ({ key, value: localStorage.getItem(key) })) };
  for (const name of OLD.stores) {
    rows[name] = [];
    if (!db || !db.objectStoreNames.contains(name)) continue;
    const os = db.transaction(name).objectStore(name);
    const [keys, values] = await Promise.all([idb(os.getAllKeys()), idb(os.getAll())]);
    rows[name] = keys.map((key, i) => ({ key, value: values[i] }));
  }
  return rows;
}

// A short fingerprint of a list of { key, value }: it tells whether the old data changed since it was copied; it is not a security measure.
// A Blob or File counts with its size, type, name, lastModified and a checksum of its bytes. The bytes are read before (hashBlobs, asynchronous); the check inside the
// transaction of clearIfUnchanged cannot wait for a read, so it uses cheap = true (everything but the bytes).
function fnv(bytes, h = 2166136261) { for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0; return h; }
const bytesOf = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
const blobHash = new WeakMap();                       // Blob -> checksum of its bytes
async function hashBlobs(v, seen = new Set()) {       // every Blob or File inside the rows, also one nested in a row's fields
  if (v instanceof Blob) { if (!blobHash.has(v)) blobHash.set(v, fnv(new Uint8Array(await v.arrayBuffer()))); }
  else if (v && typeof v === "object" && !(v instanceof ArrayBuffer) && !ArrayBuffer.isView(v) && !seen.has(v)) { seen.add(v); for (const x of Object.values(v)) await hashBlobs(x, seen); }
}
function fingerprint(list, cheap) {
  const text = JSON.stringify(list, (k, v) => {
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { bytes: v.byteLength, fnv: fnv(bytesOf(v)) };
    if (!(v instanceof Blob)) return v;
    if (!cheap && !blobHash.has(v)) throw new Error("fingerprint: the bytes of a Blob were not read (hashBlobs)");
    return { blob: v.size, type: v.type, name: v.name, modified: v.lastModified, fnv: cheap ? undefined : blobHash.get(v) };
  });
  return list.length + ":" + fnv(new TextEncoder().encode(text));
}
const digestOf = (rows, cheap) => JSON.stringify(Object.fromEntries(Object.keys(rows).map((name) => [name, fingerprint(rows[name], cheap)])));

function dataUrlToBlob(url) {                         // "data:image/png;base64,..." to a Blob (fetch() is not allowed by the policy)
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
  const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return new Blob([bytes], { type: m[1] });
}

// The part that belongs to the app: old rows to [{ col, id, value, meta?, created? }] (items of a collection) and [{ name, value, settings: true }] (single records).
// It throws for a row it cannot map: a silent guess here would copy a wrong file and then delete the right one.
function toNewRecords(rows, tag) {
  // [<tag>-]<s|j><encoded key>: different keys never give the same id; no "/". The ids contain "-" and "%": code that splits an id must be checked.
  const nid = (oldKey) => (OLD.tagged ? tag + "-" : "") + (typeof oldKey === "string" ? "s" : "j") + encodeURIComponent(typeof oldKey === "string" ? oldKey : JSON.stringify(oldKey));
  const fail = (key, why) => { throw new Error("old row " + JSON.stringify(key) + ": " + why + " (adapt toNewRecords)"); };
  const binary = (x) => (x instanceof Blob ? "Blob" : x instanceof ArrayBuffer || ArrayBuffer.isView(x) ? "binary data" : x instanceof Map ? "Map" : x instanceof Set ? "Set" : null);
  const json = (key, v) => {                                                        // exactly what the store hands back later; refuses what JSON would silently turn into {}
    (function look(x, seen) { if (x && typeof x === "object" && !seen.has(x)) { seen.add(x); if (binary(x)) fail(key, "the value holds a " + binary(x) + ", which JSON cannot carry; make it an item of its own"); Object.values(x).forEach((y) => look(y, seen)); } })(v, new Set());
    return JSON.parse(JSON.stringify(v) ?? "null");
  };
  const blobOf = (key, v) => (v instanceof Blob ? v : v && v.blob instanceof Blob ? v.blob                          // the old app kept a Blob/File (the row, or v.blob) or bytes (v.data)
    : v && (v.data instanceof ArrayBuffer || ArrayBuffer.isView(v.data)) ? new Blob([v.data], { type: v.type || "" }) : fail(key, "neither a Blob nor bytes in .data"));
  const isUrl = (value) => /^data:/.test(value);
  const prefs = {};
  for (const { key, value } of rows.local) if (!isUrl(value)) prefs[key] = value;     // the strings as localStorage held them; the app parses them as it did before
  return [
    ...rows.notes.map(({ key, value }) => ({ col: notes, id: nid(key), value: json(key, { title: value.title, text: value.text }), created: +new Date(value.created) || undefined })),   // a Date, a number or a date string
    ...rows.files.map(({ key, value }) => ({ col: files, id: nid(key) + (/\.\w{1,8}$/.exec(value.name) || [""])[0],       // the ending stays in the id
      value: blobOf(key, value), meta: { ...(value.name ? { name: value.name } : {}), ...(value.noteId !== undefined ? { note: nid(value.noteId) } : {}) } })),
    ...rows.local.filter(({ value }) => isUrl(value)).map(({ key, value }) => ({ col: files, id: nid(key), value: dataUrlToBlob(value), meta: { name: key } })),
    ...(Object.keys(prefs).length ? [{ name: "migrated/" + tag + "/local", value: prefs, settings: true }] : []),     // settings: see migratedSettings()
    ...((rows.meta || []).length ? [{ name: "migrated/" + tag + "/meta", value: json("meta", Object.fromEntries(rows.meta.map(({ key, value }) => [String(key), value]))), settings: true }] : []),
  ];
}
const nameOf = (it) => (it.col ? it.col.prefix + it.id : it.name);
const sizeOf = (v) => (v instanceof Blob ? v.size : JSON.stringify(v).length);
async function sameValue(read, wrote) {
  if (!(wrote instanceof Blob)) return JSON.stringify(read) === JSON.stringify(wrote);
  return read.byteLength === wrote.size && fnv(read) === fnv(new Uint8Array(await wrote.arrayBuffer()));
}

// One transaction: compare the stores with what was read a moment ago (cheap fingerprint) and empty them only if nothing changed.
function clearIfUnchanged(db, rows) {
  return new Promise((ok, fail) => {
    const names = OLD.stores.filter((n) => db.objectStoreNames.contains(n));
    if (!names.length) return ok(true);
    const tx = db.transaction(names, "readwrite");
    let waiting = names.length, same = true;
    for (const name of names) {
      const os = tx.objectStore(name), keys = os.getAllKeys(), values = os.getAll();
      let have = 0;
      const check = () => {
        if (++have < 2) return;
        if (fingerprint(keys.result.map((key, i) => ({ key, value: values.result[i] })), true) !== fingerprint(rows[name], true)) same = false;
        if (--waiting) return;
        if (same) names.forEach((n) => tx.objectStore(n).clear()); else tx.abort();
      };
      keys.onsuccess = check; values.onsuccess = check;
    }
    tx.oncomplete = () => ok(true);
    tx.onabort = () => ok(false);
    tx.onerror = () => fail(tx.error);
  });
}

// Never in the sandbox: the copy there is gone tonight, the old data would be lost. Only wds-verify --migration-delete sets the global, in an automated browser.
const keepInSandbox = (st) => st.sandbox && !(window.__WDS_MIGRATION_TEST__ === true && navigator.webdriver === true);

// rows: exactly what was copied and verified. Resolves "deleted", "changed" (the old app was used meanwhile: nothing is deleted) or "kept" (sandbox).
async function removeOldData(rows, st) {
  if (keepInSandbox(st)) return "kept";
  const same = (key, value) => localStorage.getItem(key) === value;
  if (!rows.local.every(({ key, value }) => same(key, value))) return "changed";
  const db = await openOldDb();
  if (db) {
    try {
      const fresh = await readOldRows(db);              // read again, outside a transaction, the bytes of every Blob included
      await hashBlobs(fresh);
      if (digestOf(fresh) !== digestOf(rows)) return "changed";
      if (!(await clearIfUnchanged(db, fresh))) return "changed";   // the last look, inside the transaction that empties the stores
    } finally { db.close(); }
  }
  let changed = false;
  for (const { key, value } of rows.local) { if (same(key, value)) localStorage.removeItem(key); else changed = true; }   // only our own keys, never localStorage.clear(); the tag stays
  return changed ? "changed" : "deleted";
}

async function migrate(ui) {
  const st = store.status();
  if (st.role !== "owner") return { status: "skipped", why: "only the owner of a vault migrates" };
  try {
    const db = await openOldDb();
    const rows = await readOldRows(db);
    if (db) db.close();
    if (!Object.values(rows).some((list) => list.length)) return { status: "nothing" };
    await hashBlobs(rows);                                                          // the bytes of every Blob count for "unchanged"
    const tag = localStorage.getItem(OLD.tagKey) || crypto.randomUUID().slice(0, 8);
    localStorage.setItem(OLD.tagKey, tag);   // the one write to the old storage: a random tag per browser, no user data; it stays after the delete (it names this browser's marker and settings)
    const digest = digestOf(rows);
    const done = await store.get("migration/" + tag, { fresh: true });

    const all = toNewRecords(rows, tag);
    const items = done && done.settings === "applied" ? all.filter((it) => !it.settings) : all;       // settings that the app has taken over are not copied again
    const use = await store.usage(), room = use.limits.vault_bytes - use.bytes;
    const big = items.filter((it) => sizeOf(it.value) > use.limits.max_value_bytes), small = items.filter((it) => !big.includes(it));
    const names = small.map(nameOf);

    if (done && done.digest === digest) {                                           // copied and confirmed earlier, the old data is unchanged since: read the copy once more, then delete
      const back = await store.getMany(names, { fresh: true });
      const ok = await Promise.all(small.map((it, i) => back[i] !== undefined && sameValue(back[i], it.value)));
      if (ok.every(Boolean)) return { status: "migrated", tag, deleted: await removeOldData(rows, st), again: true };
    }

    if (small.reduce((n, it) => n + sizeOf(it.value), 0) * 1.3 > room) return { status: "failed", why: "the old data does not fit into the vault (" + room + " bytes free); nothing was changed" };
    const question = "Copy " + small.length + " items into the vault whose access ID ends in " + st.accessId.slice(-4) + (keepInSandbox(st) ? " (sandbox: the old data stays)?" : " and delete them from this browser?")
      + (big.length ? " " + big.length + " items are too large for the vault (" + big.map(nameOf).join(", ") + "); you get them as downloads." : "");
    if (!(await ui.confirm(question))) return { status: "declined" };

    await Promise.all([notes.refresh(), files.refresh()]);                          // the lists as they are on the server now
    const have = await store.getMany(names, { fresh: true });                       // an interrupted run continues where it stopped
    const todo = small.filter((it, i) => have[i] === undefined || (it.settings && JSON.stringify(have[i]) !== JSON.stringify(it.value)));   // settings are snapshots: a rerun overwrites them
    let listFailed = false;
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map((it) => (it.col ? it.col.add(it.value, { id: it.id, meta: it.meta, created: it.created }) : store.set(it.name, it.value))
        .catch((err) => { if (!err.stored) throw err; listFailed = true; })));      // stored: the item is in the vault, only its list entry is queued
    }
    for (const col of [notes, files]) {
      await col.refresh();
      if (listFailed || small.some((it, i) => it.col === col && have[i] !== undefined && !col.has(it.id))) await col.rebuild();   // entries an interrupted run never wrote
      await col.flush();                                                            // every list entry is on the server
    }
    const back = await store.getMany(names, { fresh: true });                       // verify: read from the server, compare byte for byte
    const bad = [];
    for (let i = 0; i < small.length; i++) if (back[i] === undefined || !(await sameValue(back[i], small[i].value)) || (small[i].col && !small[i].col.has(small[i].id))) bad.push(names[i]);
    if (bad.length) return { status: "failed", why: bad.length + " items did not come back (" + bad.slice(0, 3).join(", ") + "); the old data was kept" };

    const backup = JSON.stringify(rows, (k, v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? { size: v.byteLength }
      : v instanceof Blob ? { size: v.size, type: v.type, name: v.name } : v));   // the files are in the vault by now; a plain stringify would write a Blob as {}
    await ui.offerDownload(new Blob([backup], { type: "application/json" }), "oldapp-backup.json");
    for (const it of big) await ui.offerDownload(it.value instanceof Blob ? it.value : new Blob([JSON.stringify(it.value)]), "oldapp-" + nameOf(it).replace(/\W+/g, "-"));
    if (big.length && !(await ui.confirm(big.length + " items are only in the downloads: " + big.map(nameOf).join(", ") + ". Delete the old data anyway?"))) {
      return { status: "partial", tooLarge: big.map(nameOf), deleted: "kept" };     // nothing deleted; the question comes again at the next start
    }
    const settings = done && done.settings === "applied" ? "applied" : small.some((it) => it.settings) ? "pending" : "none";
    await store.set("migration/" + tag, { date: new Date().toISOString(), tag, digest, settings, counts: Object.fromEntries(Object.entries(rows).map(([name, list]) => [name, list.length])), tooLarge: big.map(nameOf) });
    return { status: "migrated", tag, deleted: await removeOldData(rows, st), count: small.length, tooLarge: big.map(nameOf) };
  } catch (err) {
    return { status: "failed", why: String((err && err.message) || err), note: "the old data was kept" };
  }
}

// Resolves { status: "nothing" | "skipped" | "declined" | "failed" | "partial" | "migrated", tag, ... }. Call it from start().
// ui: { confirm(text) -> Promise<boolean>, offerDownload(blob, filename) -> Promise } are the app's own dialogs.
function migrateOldData(ui) {
  return navigator.locks ? navigator.locks.request(OLD.lock, () => migrate(ui)) : migrate(ui);   // two tabs of the new app do not migrate at the same time
}

// The old settings, until the app has taken them over: { tag, local, meta } while the marker of this browser says "pending", otherwise null (also when this browser never migrated: no request then).
// local: the old localStorage keys as strings; meta: the rows of the key-value store, as an object. It does not depend on the result of migrateOldData, so a crash between the migration and the save loses nothing.
async function migratedSettings() {
  const tag = localStorage.getItem(OLD.tagKey);
  if (!tag) return null;
  const marker = await store.get("migration/" + tag, { fresh: true });
  if (!marker || marker.settings !== "pending") return null;
  const [local, meta] = await store.getMany(["local", "meta"].map((part) => "migrated/" + tag + "/" + part), { fresh: true });
  return { tag, local: local || {}, meta: meta || {} };
}
// Call it after the app has saved the settings: they are never offered again (a rerun does not bring a stopped timer back).
async function settingsDone(old) {
  const marker = await store.get("migration/" + old.tag, { fresh: true });
  if (marker) await store.set("migration/" + old.tag, { ...marker, settings: "applied" });
}
// Takes old values only where the current ones have none (undefined or null): a copy of current plus the keys of old that current lacks.
const fillGaps = (current, old) => { const out = { ...current }; for (const k of Object.keys(old)) if (out[k] === undefined || out[k] === null) out[k] = old[k]; return out; };

// In start(), before the app writes a setting of its own:
//   const result = await migrateOldData(ui);
//   const old = await migratedSettings();                            // null unless this browser's old settings are waiting
//   if (old) {
//     const prefs = JSON.parse(old.local["oldapp:prefs"] || "null") || {};              // localStorage values are the old strings
//     await store.set("settings", fillGaps((await store.get("settings")) || {}, { lang: old.meta.lang, theme: prefs.theme }));
//     await settingsDone(old);                                      // after the save
//   }
```

**Adapting `toNewRecords()` to the old schema.** The recipe throws for a row it cannot map (the result is `failed` with the key of the row, the old data is kept) instead of guessing. The usual differences:

- A row with fields **and** a file (`{ id, title, pdf: Blob }`) becomes **two items**: the note without the Blob, and a file item (`blobOf` takes `v.blob`, `v.data` or the Blob itself; rename the field in `blobOf`), linked by the note's id in the file's meta. A Blob inside a value would be written as `{}`; `json()` refuses it.
- A Blob stored as the row value (`put(blob, id)`) is a file item with that key. Its name comes from the key or `value.name`.
- A `Date` in `created` is fine (a number or a date string too); other Date fields become ISO strings in the JSON. `Map`, `Set` and `ArrayBuffer` inside a value are refused: convert them (`[...map]`, a file item).
- Auto-increment keys: `nid(12)` gives `<tag>-j12`; every reference goes through `nid` too.
- Settings kept as scalar strings in localStorage stay strings in `migrated/<tag>/local`.

After a migration: replace "saved locally" and similar texts (section 13), show the result of `migrateOldData` in one sentence (in the sandbox "the old data was kept"; for `deleted: "changed"` "the old data was used again meanwhile and is still there; open the app again"), take over the old settings with `migratedSettings`, `fillGaps` and `settingsDone` (once, only where the vault has no value), and do not write application data to the old storage again.

### Step 5: what stays as it is

- Forms whose submit handler calls `preventDefault()` (section 3). Downloads the person asks for (a CSV, an attachment, a PDF), with a note that the file is not encrypted (section 11). Printing. Reading a file the person chose.
- The app's own screens, texts, validation and calculations. Search and filters over values the page holds in memory.
- Remove: `localStorage` and `indexedDB` code for new data, background saves, own export of "everything" (use `exportAll`), own passphrase or login screens, "saved locally" texts.

### Step 6: test

Run `wds-verify <app.html> --target sandbox` (section 17), then walk through the "Not tested" list by hand: a second window, a conflict, a read-only member, lock and unlock, and **the migration with real old data**: seed the old IndexedDB or localStorage of a copy of the old app and open the new app in the sandbox (old data copied, kept). The sandbox takes only small seed data (its limits are in section 17: a few notes and a small picture); an app with attachments is tested at full size against a **test vault in the app's own scope**
(old data copied and deleted; use a scope of yours that you may fill, and have the test vault deleted afterwards).

- **The join code for that test.** Creating a vault in a scope with the enrollment "join code" needs the code, which only the staff member who registered the scope has. **Ask the person for it** when you reach this step and say what it is for (one test vault, to see the deletion path that the sandbox never runs). There is one place for it, the environment variable **`WDS_JOIN_CODE`**, set in the shell that runs your test (the person types `export WDS_JOIN_CODE=…` there, or you do after they told you the code; a space in front keeps the line out of the shell history).
  `createVault(page)` and `submitCreate(d, …)` of `tools/lib/drive-library.mjs` (section 12, "Driving the library's dialogs") read it by default and fill the create dialog; they never print it and no error message of them contains it. wds-verify does not use it: it tests against the mock and the sandbox, never against a real scope.
  Never write the code into the app, the README, a test script, a `wds-verify.json`, CLAUDE.md or AGENTS.md, never put it on a command line, and `unset` the variable afterwards. It stays in the transcript of the conversation: if that is shared, ask the staff member to rotate the join code (dashboard). With the enrollment "open" no code is needed, with "closed" no test vault can be made: then say that the deletion path was not tested.
- **Delete the test vault afterwards.** The library has no call that deletes a vault. The staff member deletes it in the dashboard (the page of the scope lists its vaults, newest first, with "Delete"; name the time of your test run): the vault is blocked at once and removed for good after 30 days, and a deleted vault no longer counts against the scope's vault limit.
- **What to check in the test vault.** After the run the old IndexedDB stores are empty, the old localStorage keys are gone (only the tag stays), `migrateOldData` resolved `deleted: "deleted"`, and every old item is in the vault (count, a file byte for byte, a reference between two items, the creation order). A second start resolves `nothing`. Then seed again and let a second tab write to the old store during the confirmation: the result must be `deleted: "changed"` and the old data still there.
- **Migration test in wds-verify.** Put the old, local-only version of the app next to the new one and add a `seed` block to `wds-verify.json` (section 12, "Writing wds-verify.json"): the tool opens the old page, types the seed values, opens the new app in the same browser and checks that the old data is visible after reloading and unlocking (so it came out of the vault), never appears unencrypted in a request, a download or a new storage place, and that all of it is deleted (mock target) or kept (sandbox target).
  `--target sandbox` keeps the old data, as the recipe does in the sandbox. `node tools/wds-verify.mjs <app.html> --target sandbox --migration-delete` sets `window.__WDS_MIGRATION_TEST__ = true` before any script of the page runs (in its throw-away browser, which is automated: `navigator.webdriver` is true); `keepInSandbox` of the recipe honours it only when both are true (`window.__WDS_MIGRATION_TEST__ === true && navigator.webdriver === true`), so the deletion path runs in the sandbox too, and the tool expects the old storage to be empty afterwards. Keep those lines as they are in the recipe; nothing else reads the global and the library does not know it. **Never write the global into the app**, not to "see the deletion": in a real browser the old data would be deleted while its only copy is in a sandbox vault that is wiped tonight (wds-verify fails a file that assigns it).

## 17. The sandbox

A public scope on the real service for testing: **{{sandbox_scope}}**. Anyone can create a vault there without a join code. Limits: {{sandbox_limits}}. Everything is deleted every night between {{sandbox_wipe}} and one hour later (vaults created after that time stay until the next night).
The library says "Sandbox" (dialog titles, the create button, a banner in every dialog and a bar at the top of the page after unlocking; the library moves the page down by its height, so a sticky header with `top: 0` slides under it only when scrolling; while the bar is shown the library sets the CSS custom property `--wds-sandbox-bar` on `:root` to its height, so a sticky header can use `top: var(--wds-sandbox-bar, 0)`), there is no recovery contact and no recovery code, at most three invites per vault (they expire before the next wipe), and the breach check of passphrases is off.
When many people test, the oldest vaults that nobody has written to for 30 minutes are deleted to make room, creation is limited per network and for the sandbox as a whole, and an unavailable sandbox answers with an error that wds-verify reports as "sandbox unavailable, not an app finding". Records are limited to {{sandbox_limits}} here: seed data of a migration test must be small.

- **Use it** through `node tools/wds-verify.mjs <app.html> --target sandbox` (real library, real service, the tool replaces the scope IDs in a copy of your page) or `--sandbox-copy app-sandbox.html` (a copy that a person opens in a browser). By hand: a copy of the file with "sandbox" in its name (section 12, "Without wds-verify").
- **Never write the sandbox scope ID into the app file.** The app would store its users' data where it is deleted every night; wds-verify fails a file that contains it. Never enter real data. A migration copies and keeps the old data while `store.status().sandbox` is true (section 16).
- When `{{sandbox_scope}}` reads "(no sandbox on this server)" this server has none: test against a scope of your own and a mock (`--target mock`).
