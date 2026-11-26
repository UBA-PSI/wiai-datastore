# WIAI Datastore: integration guide for developers and their Claude

You build or port a single-file web app (one HTML file that runs from file://, from a local web server or in Electron) and want
its data stored end to end encrypted on the faculty server. This page is everything you need. Machine-readable index:
[llms.txt]({{base}}/llms.txt). Current library: version **{{version}}**. Source code, PROTOCOL.md and the verifier wds-verify: {{repo_url}}.

*Reading this file from the repository (docs/site/)?* The words in double braces (script tag, CSP, base URL, version, integrity) are filled in by the server when it serves the page. In a clone, print the complete script tag and the CSP with `node tools/wds-verify.mjs --script-tag` (section 12) and use the base URL of the service that you were given.

The server stores only ciphertext, with one exception by design: the faculty keeps a recovery (escrow) key and can restore
a vault after a documented procedure. Never write "only the user can read the data" in an app. Wherever an app describes its privacy, use this sentence, word for word, in the language of the text (for a text in any other language use the English sentence; wds-verify reports in an info finding when neither sentence is in the page or the README):

- English: **Data is end-to-end encrypted; the faculty holds a recovery key for emergencies.**
- German: **Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel.**

A longer text may follow it (section 13, users.en.md and users.de.md say more), but it never contradicts it and never leaves it out.

If the scope has the breach check of passphrases switched on (the default; the dashboard prompt and `wds-verify` say which), the privacy text of the app also carries this sentence, right after the official one and in the same language, because every user's browser sends data to a service in the USA when a passphrase is chosen
(`wds-verify` reports in an info finding when the breach check is on and this sentence is not in the page or the README, word for word):

- English: **When you choose a passphrase, your browser checks it against known data breaches with the Pwned Passwords service (USA); the service receives your IP address and the first five characters of a checksum of the passphrase, never the passphrase itself.**
- German: **Wenn Sie eine Passphrase wählen, prüft Ihr Browser sie beim Dienst Pwned Passwords (USA) auf bekannte Datenlecks; der Dienst erhält Ihre IP-Adresse und die ersten fünf Zeichen einer Prüfsumme der Passphrase, nie die Passphrase selbst.**

## Checklist for Claude

1. Ask the developer for the scope ID (section 1). Do not invent one. Never write the sandbox scope ID ({{sandbox_scope}}) into an app (section 17).
2. Does the app exist already, with data in IndexedDB, localStorage or a file format of its own? Read [porting.md]({{base}}/docs/porting.md) first (section 16 points there): the old data is taken over with one call, `store.migrateLocal`, not with code of your own.
3. Put the Content-Security-Policy meta tag (section 3) into the head before every script and the script tag (section 2)
   at the end of the body, exactly as printed here. Keep the onerror handler.
4. Create the store with `WDS.connect({ scope })` and keep user data only there (section 5). Register `store.onLock` and `store.onUnlock` once, outside any start function (section 4, "Lock and unlock again"). An app in one language calls `store.setLocale("de")` (or `"en"`) once right after `WDS.connect`.
5. Model data as one record per entity. Many items or files: `store.collection` (section 6, "Collections"). Editors with `autosave`.
6. Decide conflicts in code only where a merge helps; everything else gets the library's dialog (section 7, "Conflicts in code").
7. Add buttons for share and export (sections 8 and 9). Hide edit controls for read-only members. An app with forms or modal dialogs of its own follows the checklist in porting.md, section 7: the library's dialogs open above yours.
8. Test with the sandbox (section 17): `node tools/wds-verify.mjs <app.html> --target sandbox` runs the real library against the real service.
9. Run wds-verify (section 12), write a wds-verify.json for an app with tabs, dialogs or file inputs ("Writing wds-verify.json"), fix the findings and put the report into the README.
10. Add the text for users to the README or start page (section 13), starting with the official privacy sentence (and the breach-check sentence when the scope has that check on). Put the CLAUDE.md / AGENTS.md section from the dashboard into the app's repository.

## 1. Register a scope

A scope is one registered app. Staff of the University of Bamberg open the dashboard at {{base}}/ and sign in with login.psi. After the first sign-in they choose "Create a new app" and fill in three fields: the app's **name**, a **contact e-mail address** (prefilled with their own) and, optionally, a **description**.
That is all a standard app needs. The dashboard uses the **standard variant** for everything else, and "Expert settings" is folded:

- **Vaults only with the join code**: new users type the code when they create their vault. The code is handed to the users in person, by e-mail or in class and is never part of the app; it does not protect data, it only keeps strangers from filling the storage. The alternatives (anyone who has the app, up to the maximum number of vaults; nobody) are in the expert settings.
- **Passphrases from known data breaches are refused** (the breach check, on). It makes every user's browser ask the service Pwned Passwords in the USA, so the app's privacy text carries one more sentence (the top of this page).
- **The default limits**: 10 MB per value, 200 MB per vault (with older versions), 10 older versions per entry, 50 vaults. The ceilings are in operator.md.
- **The app ID** from the name: a short name plus six random characters, like `notenrechner-k7m2a9`. The dashboard calls it "app ID"; this guide and the code call it the scope ID. It is public and is written into the app.

The page of the new app then shows the next steps, in this order:

1. **The text for Claude** (to copy into the conversation with the developer's Claude). It carries the scope's settings (enrollment, breach check, record size, vault quota; dated), a line "if the app already exists, read {{base}}/docs/porting.md first", the rule for the join code in tests (porting.md, "The join code for tests") and a section for the app's own CLAUDE.md and AGENTS.md.
2. **The join code** (with "Create a new code" for the case that it leaked) or, for another enrollment, one sentence that says who can create a vault.
3. **What the users need to know**: a link to users.en.md or users.de.md.

What staff see of the vaults of their app: number, size and dates, never contents (the privacy sentence at the top of this page says what the faculty can and cannot do). The dashboard explains its terms next to the fields (app ID, vault, join code, breach check, checksum).

The script tag and the CLAUDE.md / AGENTS.md section are in the expert settings (developer area); the CLAUDE.md section is also in the prompt. The scope settings (quotas, enrollment, breach check on or off) can be changed there too, so the prompt is a snapshot: `wds-verify` prints the current ones from the public scope document.
The scope ID is public. The join code is not: hand it out to the users, never put it in the app. A test vault that a Claude made in the scope is deleted afterwards (porting.md, "The test vault, afterwards").

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
({{base}}/api/) and to the Pwned Passwords range service (the breach check of the passphrase dialogs; it receives the user's IP address and the first five characters of
a checksum of the passphrase, never the passphrase itself, which is why the privacy text names it: see the top of this page). If the scope has the breach check switched off, remove `https://api.pwnedpasswords.com` (the dashboard prompt and `wds-verify` say which).

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
| `await store.migrateLocal(opts)` | Takes over what an earlier, local-only version of the app left in this browser (IndexedDB, localStorage): asks the person, copies into the vault, checks, deletes the old data (not in the sandbox). Resolves `{ status, sandbox, … }`. One call instead of code of your own: porting.md, section 4. |
| `store.autosave(name, getState, opts)` | Handle for editors (below). |
| `await store.history(name)` | `{ name, current, versions: [{ version, size, created, deleted }] }`, newest first. |
| `await store.restore(name, version)` | Writes an old version as a new one. |
| `await store.showHistory(name, { title })` | The built-in version browser with a restore button (disabled for read members). `title` replaces the record name in the heading, which the library words itself: pass only the name a person knows (the note title), not a sentence. The heading then reads *History of "Shopping list"*. |
| `store.onConflict(handler)`, `store.onConflict(pattern, handler)` | Decide conflicts in code, for every record or for one name or prefix (section 7, "Conflicts in code"). Without a decision the library's dialog asks the person. |
| `store.onStale(rows => …)` | Replaces the notice "newer versions exist elsewhere"; `rows` is `[{ name, version, known, deleted }]`. |
| `await store.share()` | Members dialog (section 8). |
| `await store.exportAll({ filename })` | Downloads every record, decrypted, as a ZIP (section 9). Resolves `{ count, filename, bytes }`. |
| `await store.lock()` | Saves pending edits (up to 8 s), then forgets all keys and removes the library's notices from the screen. `onLock` handlers get the `reason`: `user`, `revoked` or `expired`. |
| `store.setLocale(lang)`, `store.locale` | Sets the language of dialogs and notices from now on (`"de"` or `"en"`; also `"de-AT"` and the like) and returns it. See below: every app calls it, so that the app and the library never speak two languages on one screen. |
| `store.isUnlocked()`, `store.status()`, `await store.usage()` | State and quota use. `usage()` resolves `{ bytes, records, versions, limits: { max_value_bytes, vault_bytes, history_versions, … } }`. All sizes are bytes; in texts for people the documentation says MB, and 1 MB = 1,048,576 bytes (KB = 1024 bytes, GB = 2^30 bytes): the scope document gives exact bytes, for example `max_value_bytes` 10485760 for 10 MB. |

**One screen, one language.** An app in one language only (German, say) calls `store.setLocale("de")` once right after `WDS.connect`, so that its texts and the library's dialogs speak the same language whatever the browser says (without it a German-only app shows English dialogs in an English browser). An app with a language choice of its own keeps the choice in the store (`settings`) and calls `store.setLocale` at start with the browser language, again when it has loaded the choice and on every change.

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

### The library's dialogs and your own modal dialogs

The library's dialogs are modal `<dialog class="wds-root wds-dialog">` elements in the browser's top layer, and its notices (toasts) and the sandbox bar sit in the top layer too. A conflict, the unlock dialog after a session expired, the share dialog, the migration question and every notice therefore open **above** a modal dialog that the app opened with `showModal()`; the page below is inert while the library's dialog is open, and the person can answer it.

- **Close your own modal dialogs in `store.onLock`** (it runs for `user`, `revoked` and `expired`; the library closes its own dialogs on a lock) and **open none while a store call is pending.** If a modal dialog of yours opens after a library dialog came up, the library puts its dialog on top again, but the person has to answer it first.
- Select your own dialogs with `dialog:not(.wds-dialog)` and never close the library's. CSS for `dialog` (padding, `max-width`, a centring transform, an opacity transition, a transparent backdrop) does not change them.
- Escape closes a library dialog only when it has a close button; the unlock dialog, the access sheet and the progress view stay. Minimum browsers: Chrome and Edge 114, Firefox 125, Safari 17 (modal `<dialog>` and `popover`).
- Forms and modal dialogs of your own have a checklist: porting.md, section 7.

## 5. Where data lives

- User data lives only in the store. Not in `localStorage`, `sessionStorage`, IndexedDB, cookies, the URL or `console.log`. (On file://,
  Chrome gives every local HTML file the same storage: other files could read it.) The only exception is the one-time take-over of data an older version of the app left in the browser, and the library does that: `store.migrateLocal` (porting.md, section 4).
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
  the ceiling is 25 MB; 1 MB = 1,048,576 bytes). Put the file ending into the record name (`covers/<id>.jpg`, not `covers/<id>`): `exportAll` adds an ending
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

- **Methods.** `load()` reads the index once; `refresh()` reads it again and fires `onChange` when it differs. `items()` and `has(id)` are synchronous and throw a `UsageError` ("call await notes.load() first") before `load()` and after a lock. `get(id, { fresh })` (`fresh: true` always asks the server: use it to reload an item after `onChange` or `showHistory`), `getAll({ concurrency, fresh })`, `add(value, { id, meta, mime, created })` (resolves `{ id, name, version, resolution }`; `created` is a number of milliseconds that only decides the order of the list, for ported data with a date of its own; `add` with an id that exists is a conflict like any write to a record this page has not read, so the person or your handler decides: use `set` for updates, and see "`set` and `created`" below), `set(id, value, { meta, mime, created })`, `remove(id)`, `autosave(id, getState, opts)`, `flush()` (resolves when every list change that is still queued is on the server, rejects while it cannot be written: the check before something irreversible), `rebuild()`, `onChange(fn)` (returns an unsubscribe function), `prefix`, `indexName`.
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

- **Show a file in a new tab inside the click.** `window.open(blobUrl)` after `await store.getBlob(…)` is no longer part of the click, and over a slow connection the popup blocker refuses it. Open the (empty) window first and fill it when the bytes arrive; offer a download link when the window is refused:

```js
openButton.onclick = async () => {
  const w = window.open("", "_blank");                 // inside the click, so that the popup blocker allows it (after an await it would not)
  if (w) w.opener = null;
  try {
    const blob = await store.getBlob("pdfs/" + id);    // the network may take a while
    if (!blob) throw new Error("This file does not exist any more.");
    const url = URL.createObjectURL(blob);
    if (w) w.location.href = url;                      // the window that was opened empty now shows the file
    else offerDownloadLink(url, name);                 // w is null when the blocker refused even the empty window: show <a href download> for the person to click
    setTimeout(() => URL.revokeObjectURL(url), 60000); // revoke it after a minute
  } catch (err) {
    if (w) w.close();
    showError(err);
  }
};
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
- **The conflict dialog opens above a modal dialog of your own** (the library's dialogs are in the top layer), so a form that is open while a save conflicts stays usable for the person; keep what was typed until the save worked (porting.md, section 7, the checklist for apps with forms).

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
- User data in localStorage, sessionStorage, IndexedDB, cookies, the URL, `console.log` (`store.migrateLocal` reads old data and deletes it; it does not store new data there). Reading or deleting the old browser storage by hand instead of calling it.
- **Downloads.** Files that the person explicitly asks for are fine: one file per click, such as a CSV of the entries, an attachment, a generated PDF. Never download in the background, on load or as a storage workaround ("save a copy locally in case"). Say next to the button
  that the file is not encrypted. `exportAll` is the right way to give a person all their data.
- A custom passphrase, login, key or "remember me" dialog; storing or caching passphrases; reading the library dialogs' inputs.
- Replacing, copying, minifying, patching or re-hosting the library; a changed integrity hash; a different CSP that is wider than this one. Hiding the library's dialogs or its sandbox label with CSS or script.
- The sandbox scope ID in an app file; `window.__WDS_MIGRATION_TEST__` anywhere in the app (only an automated test sets it, porting.md, section 6); `localStorage.clear()`.
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
node tools/wds-verify.mjs --script-tag                  # prints the complete script tag (with the onerror handler) and the CSP; the integrity value must equal section 2
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
  the Content-Security-Policy is present and not broader than the one above; no other script is loaded; nothing but the library talks to the datastore host; the sandbox scope ID is not in the file; no CSS hides the library; no hand-made migration (reading or deleting old browser storage without `store.migrateLocal`, a warning) and no assignment of `window.__WDS_MIGRATION_TEST__` (a failure).
- **Scope check** (every run with network access): the public scope document of the app's own scope ID is fetched. An unknown scope fails. The breach check on while `connect-src` lacks `https://api.pwnedpasswords.com` fails; off while the host is still allowed warns. The report prints the current enrollment, breach check and limits (sizes in MB). When the breach check is on and neither the page nor the README carries the breach-check sentence of the top of this page (word for word; naming the service is not enough), an info finding prints both sentences. Offline, or with `--scope-check off`: "scope settings not checked". An unknown scope fails; for an app whose scope is not registered yet, or a run of an unreleased library, use `--scope-check off`.
- **Dynamic checks.** It opens the app, creates a vault through the library dialog, types unique canary strings into every visible input, textarea and contenteditable, presses the app's save-like buttons (text containing save, speichern, add, hinzufügen, anlegen, create, ok and similar, never delete, export, download, import, lock; plus every element marked `data-wds-verify="save"`),
  runs the steps of `wds-verify.json`, waits, then **reloads the page, unlocks again and looks for the typed values** ("Data after reload": an app has to read its data back when it starts). Canaries and the vault passphrase are searched for in every request (URL, header, body), page URL, localStorage, sessionStorage, IndexedDB, cache storage, cookies, console output,
  downloads and, with `mock`, the server's database (raw, URL-encoded, base64, hex and UTF-16). It also flags a record written three or more times within a second without a button press in between (use autosave), a record that holds the data of several items or the whole app state, and apps that store nothing during the run (then the run proved nothing: that fails).
- Options: `--strict` (warnings fail too), `--migration-delete` (with a `seed`), `--headed`, `--json`, `--locale <bcp47>`, `--wait-ms <n>` (time for debounced saves, default 2800), `--hashes <file>`, `--script-tag [version]`, `--scope-check off`. Exit codes: 0 passed, 1 a check failed, 2 the tool could not run (missing Python for `--target mock`, no Playwright, bad arguments), 3 the sandbox is unavailable (rate limited, full or switched off: not an app finding, try again later).
- **An unreleased library** (you changed `client/src`, or your clone is newer than the service). The service publishes the hash of the released build; `node client/build.mjs` writes the hash of your own build to `client/dist/hashes.json`. Print the tag with `node tools/wds-verify.mjs --script-tag --hashes client/dist/hashes.json`, and run `wds-verify <app> --hashes client/dist/hashes.json`. The mock builds its own library and replaces the tag's hash in its copy of the page, so the dynamic checks do not depend on it. The scope of the app does not exist at the service yet? Add `--scope-check off` (the mock creates the scope it needs by itself). `WDS_VERIFY_OFFLINE=1` switches off every online lookup (hashes and scope check) and makes the clone the source of the hashes. The report says "your clone has a library build that the service does not publish yet" when it is newer than the service, and "outdated; run git pull" only when it is older.
- **Without a clone** there is no download of the static checks alone: they need the same small clone and Node. If you cannot clone, or have no Node at all, use "Without wds-verify" below and say in the README that wds-verify did not run.

### Without wds-verify

When the tool cannot run (no Node, no network to the repository), check by hand and write in the README what you did:

1. The script tag and the CSP are copied from sections 2 and 3 without change, the CSP comes before every script, and the hash in your file equals `{{sri}}`.
2. Search the file: no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource`, `eval`, `new Function`, no `<script src>` except the library, no `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie` for user data (`store.migrateLocal` for a one-time take-over of old data, porting.md), the sandbox scope ID ({{sandbox_scope}}) is not in the file.
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

- `steps` run after the tool pressed the buttons it recognised, in order, after the vault was created. `click` takes a CSS selector. `fill` takes a selector and a text of at least 6 characters, unique (it is searched for like a canary), and valid for the field: a duration field needs a text it accepts, such as `"1,5 Stunden"`. `select` takes `[selector, value]`. `press` takes `[selector, key]`, for example `Enter` to submit a form. Selectors are Playwright selectors (CSS, `:has()`, `:nth-match()`, `text=`, `role=`). **A `fill` text must come back as the same text**: a field that turns it into something else (a tag field that splits `"a, b"`, a number or date field) hides the value from the search; type one token per tag field. A `click` that a notice of the library covers is retried after the tool dismissed the notice (it says so); a person has to press the notice's "Dismiss" (`[data-wds="toast-dismiss"]`) too. More in porting.md, section 6, "Writing seed steps that prove something".
  `upload` takes the selector of a file input and, optionally, a path relative to wds-verify.json: `{ "upload": ["#cover"] }` selects a generated PNG whose name and bytes are searched for like canaries, `{ "upload": ["#cover", "sample.jpg"] }` your own file (its name is searched for, not its content). **The tool never touches a file input by itself.**
  `download` takes the selector of a button that the person would press to get a file: the tool clicks it, expects a download and reports "user-requested download, contains canaries: yes/no" as information, never as a leak; a download at any other time stays a failure. `wait` takes milliseconds (at most 60000).
- `afterReload` (same step kinds) runs after the reload and the unlock, before the tool looks for the typed values. A tabbed app starts on its first tab, so open the tabs that show the data, one click per tab: `"afterReload": [{ "click": "#tab-projects" }, { "click": "#tab-notes" }]`. The tool looks at the page right after the reload and after every step and takes everything it saw together, so the values may be on different tabs. Result: "Data after reload" passes when at least one typed value of every round is visible again (values that the app neither showed as text nor wrote to the store before the reload, for example input it rejected, are not expected back, and the detail names them: ` 1 other typed value was neither shown as text nor written to the store before the reload and is not counted: #eDoi ("10.1000/canary-wiesel").` A value that only ever sat in an autosaved field counts as written, so an editor that is not read back is reported). An `afterReload` fill whose text contains a value typed before the reload fails, because the tool reads the values of fields too and would "find" it without the app reading anything; use another text or `{canary}`. It **fails** when records were written, nothing is visible and there are no `afterReload` steps;
  otherwise it warns ("x of y values visible; an app with tabs needs afterReload steps").
  **An app that restores a search or a filter after the reload** (the last filter is kept in a `settings` record, say) needs an `afterReload` step that resets it, for example `{"fill": ["#search", ""]}` (an empty text clears the field and is not searched for) or a click on its reset button: the tool types a canary into the search field, and the restored filter would hide the data it looks for. As a last resort the tool clears search fields itself (`type="search"`, `role="searchbox"`, or a field whose id, name, placeholder or label says search or filter) and the info finding "Restored search field" names the field.
- `seed` tests the migration of old local data of a ported app (`store.migrateLocal`, porting.md). It is an object `{ "page": "old/index.html", "steps": [ ... ], "keep": [ ... ] }`: `page` is the old, local-only version of the app (a file next to `wds-verify.json`, otherwise a usage error), `steps` has the same forms as `steps` and needs at least one `fill` or `upload` (an old page with a file input and no `upload` step is pointed out: the files are then not exercised), `keep` (optional) names localStorage keys and `database/store` names that the migration leaves in the old storage on purpose; everything else that the old app filled must be gone afterwards.
  The tool opens the old page, runs the seed steps (a `{canary}` in a fill text becomes a unique generated value; it also works in `steps` and `afterReload`), opens the new app in the **same browser** (`file://` pages share localStorage and IndexedDB in Chromium), creates the vault and **answers the library's migration dialogs itself** (the question: backup, then "Take over"; files that are too large: each download, then delete; differing entries: "decide later"), so the app needs no step for them. The exact order of a seed run (old page, new app, dialogs, steps, automatic filling, reload, unlock, `afterReload`, checks) is in porting.md, section 6.
  Findings: "Seed: the old app" (the old app stored none of the typed values: fail), "Migration: old data visible" (looked for **after reloading and unlocking**, so only what came out of the vault counts: none visible: fail, some: warn), "Migration: old data only encrypted" (a seeded value in a request, the console, a cookie, the mock database, a new storage place or a download other than the library's backup and file downloads, or in the old place when it grew: fail), "Migration: the library's dialog" (info) and "Migration: old data deleted" (mock target: **everything** the old app stored, every key and every store with rows, must be gone, not only the places that hold a typed value; fail when the migration visibly ran, with the names that are left) or "kept in the sandbox" (sandbox target: it must still be there).
  `--migration-delete` (needs a `seed`) sets `window.__WDS_MIGRATION_TEST__ = true` (the tool's browser is automated, so `navigator.webdriver` is true) in the sandbox run, so that the library deletes there as well and the tool expects the old storage to be empty; on the mock target it changes nothing and the report says so. The report names the flag in a line at the top.
  **The app never sets the global itself**: wds-verify fails a file that assigns it, and a page that sets it at run time. A developer's own automated test may set it in its own browser (`context.addInitScript`), see porting.md, section 6. The run is fully described in `tools/README.md` of the repository.
- `locale` is the language of the browser (BCP 47, default `en-US`; `--locale` overrides). The library's dialogs follow the browser unless the app calls `store.setLocale`. The tool finds the library's controls by their `data-wds` attributes, so a German app works; only the app's own buttons are found by their text.
  Mark an app button with a name the word list does not know with `data-wds-verify="save"` (for example a button called "Weiter" that saves).
- Dialogs of the app itself need stable selectors (an id) for steps to reach them. A validation error names the step and the allowed forms.

An example for an app with four tabs (projects, time entries with a form, notes with attachments, a weekly view with a CSV button); it is the file of the example app in `examples/zeit-notizen/`, with the `seed` block for the migration test of its older, local-only version (`old/index.html`; porting.md, section 6):

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
  ],
  "seed": {
    "page": "old/index.html",
    "steps": [
      {"fill": ["#project-name", "Altes Projekt {canary}"]},
      {"click": "#project-add"},
      {"fill": ["#entry-desc", "Alter Eintrag {canary}"]},
      {"click": "#entry-add"},
      {"fill": ["#note-title", "Alte Notiz {canary}"]},
      {"fill": ["#note-text", "Alter Notiztext {canary}"]},
      {"upload": ["#note-file"]},
      {"click": "#note-add"},
      {"fill": ["#timer-desc", "Alter Timer {canary}"]},
      {"click": "#timer-start"},
      {"wait": 800}
    ]
  }
}
```

**What the run does not test** (the report ends with a "Not tested" section that says it): a second device and conflicts, read-only members, lock and unlock again in one page (there is no step for them; porting.md, section 6, shows how to test them in your own Playwright test against a mock), buttons the tool does not press (delete, export, download, import, lock, anything the word list, `data-wds-verify` and the steps do not name), file inputs without an `upload` step,
fields hidden in views no step opens, dialogs of the app itself without stable selectors. Test these by hand, as in "Without wds-verify". Paste the report into the README of the app under "Verification". A warning that is a false positive is explained there in one sentence; it is not removed.
Until a library version is marked released (frozen) the tool warns that its hash may still change.

### Driving the library's dialogs in your own end-to-end tests

Every dialog of the library is a modal `<dialog>` in the top layer with `data-wds-view="<view>"` (set when the view is rendered, and changed when the dialog switches to another view), every button, input, select, textarea and summary inside it has `data-wds="<name>"`, and the texts follow the language, so a test never selects by text.
Wait for a view with `page.locator('[data-wds-view="unlock"]')`, act on `[data-wds="passphrase"]` inside it. **A dialog is ready when it has a view and no `aria-busy="true"`**: the library marks it busy while it loads, while a progress view runs and while a submit is in flight (the Argon2id key derivation of an unlock, create or redeem). The attributes are part of the library's contract. wds-verify uses the same ones.

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
| `progress` | a revocation re-encrypts the vault, or `store.migrateLocal` copies and checks (no buttons, `aria-busy`) | none (a progress bar; the dialog goes back to `share` when done) |
| `notice` | after unlocking: a recovery was requested, or the faculty added an owner access | `recovery-request` with `recovery-cancel` and `recovery-keep`, `recovered-notice` with `recovered-ack`, `form-error`, `close` |
| `migrate` | `store.migrateLocal` found old data: the question | `migrate-yes` (disabled while rows are left out with `h.skip` until `migrate-skip-ack` is ticked or the backup was downloaded), `migrate-skip-ack` (a checkbox, only then), `migrate-backup` (downloads a ZIP; click only), `migrate-no`, `migrate-discard`, `close` |
| `migrate-discard` | the person chose to delete the old data without taking it over | `migrate-discard-confirm`, `migrate-discard-back`, `close` |
| `migrate-differs` | entries that exist in the vault with other content | `migrate-differs-keep-vault`, `migrate-differs-keep-both`, `migrate-differs-later`, `close` |
| `migrate-large` | entries that do not fit into the vault | `migrate-large-download` (one per entry, with `data-wds-index="<i>"`), `migrate-large-ack` (a checkbox), `migrate-delete` (disabled until every download was used or the box is ticked), `migrate-keep`, `close` |

Everywhere: `close` (only in dialogs that can be cancelled), `sandbox-banner` (a message in every dialog while the scope is the sandbox). On the page, outside any dialog: `sandbox-bar`, and notices of the library are toasts with `data-wds-toast="<key>"`
(keys such as `stale`, `offline`, `quota`, `forbidden`, `session`, `newdevice`, `readonly`, `unsaved`, `migration`: the outcome of `store.migrateLocal`, with a `toast-action` that downloads the backup on every notice that leaves the old data in place) and the buttons `toast-action` and `toast-dismiss`. The comment at the top of `client/src/wds-ui.js` in the repository is the source of this table.

A vault in a test, in four steps (Playwright; the same works in any driver): open the page and call `store.unlock()`, or wait for the app to; in `unlock` click `to-create`; in `create` fill `join-code` (not in the sandbox), `passphrase` and `passphrase-repeat` and click `create-submit` (the Argon2id key derivation takes several seconds: wait up to 60 s for `sheet`);
in `sheet` read `access-id`, check `sheet-confirm`, click `sheet-continue`. Unlocking again: `access-id-input`, `passphrase`, `unlock-submit`.
`tools/lib/drive-library.mjs` in the clone does exactly this for wds-verify and for your own scripts: `import { createVault, unlock } from "<clone>/tools/lib/drive-library.mjs"`, then `const { accessId, passphrase } = await createVault(page)` (the app calls `store.unlock()`, the function answers the dialogs) and, after a reload, `await unlock(page, { accessId, passphrase })`; its header comment lists the single-step functions too. You may use the Playwright of the clone (`tools/node_modules/playwright` after `cd tools && npm install && npx playwright install chromium`) for your own test scripts, for example to seed old data and open the new app (porting.md, section 6); no second copy is needed. Besides `createVault` and `unlock` the file has `redeemInvite(page, { code })` for a member's test, `answerMigration(page)` for the migration dialogs, `deleteVault` and `enableMigrationDelete(context)`; the header comment lists them all.
Use the sandbox (section 17) for such tests, or a test vault in your own scope. The join code of a scope is a secret of the staff: the helper reads it only from a file that the person creates in their own terminal, you never read or print that file and never ask for the code in the chat (porting.md, section 6, "The join code for tests").

## 13. What to tell users

Put this in the app's README or on its start page, adapted to the app. English first, German below; the German text uses "Sie". **The first sentence of each language is the official wording of the faculty** (it stands at the top of this page, and the dashboard prompt gives it too):
keep it word for word at the start. The second sentence is the breach-check sentence: keep it when the scope has the breach check on (the default), delete it when the check is off. The rest may be shortened or reworded, but the app must not claim more ("only you can read your data") or less than this.
An app with a language switch shows the sentences in the language that is set; for a third language use the English ones.

```text
Data is end-to-end encrypted; the faculty holds a recovery key for emergencies.
When you choose a passphrase, your browser checks it against known data breaches with the Pwned Passwords service (USA); the service receives your IP address and the first five characters of a checksum of the passphrase, never the passphrase itself.
Your data is stored on a faculty server. You need:
1. The join code from the person who runs this app (only for creating a vault).
2. A passphrase of your own, at least 12 characters. It cannot be reset: the server does not know it.
3. Your access sheet (access ID and recovery code). Print it or save it somewhere apart from this device.
With your recovery code the faculty can restore access after a documented procedure. Details: {{base}}/docs/users.en

Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel.
Wenn Sie eine Passphrase wählen, prüft Ihr Browser sie beim Dienst Pwned Passwords (USA) auf bekannte Datenlecks; der Dienst erhält Ihre IP-Adresse und die ersten fünf Zeichen einer Prüfsumme der Passphrase, nie die Passphrase selbst.
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
store.setLocale("en");                                  // this app speaks English only: so do the library's dialogs, whatever the browser says
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

An app that exists already keeps its screens and its logic; what changes is where its data lives. The guide for that is its own page: **[porting.md]({{base}}/docs/porting.md)** (HTML: {{base}}/docs/porting). It has the inventory and the mapping of the old storage to records and collections, the import of an old export file,
the library call that takes over the data that older versions left in the browsers of existing users (`store.migrateLocal`: ids, references, files, settings, the dialogs the person sees, what the app does with the result), two complete examples, the tests (wds-verify with a `seed`, the test global, the join code for tests, the test vault)
and a checklist for apps with forms and modal dialogs. Read it before you change anything in an existing app.

The rules that stay valid here: user data lives only in the store (section 5), the app never reads or deletes the old browser storage itself, and the old data is never deleted in the sandbox (section 17).

## 17. The sandbox

A public scope on the real service for testing: **{{sandbox_scope}}**. Anyone can create a vault there without a join code. Limits: {{sandbox_limits}}. Everything is deleted every night between {{sandbox_wipe}} and one hour later (vaults created after that time stay until the next night).
The library says "Sandbox" (dialog titles, the create button, a banner in every dialog and a bar at the top of the page after unlocking; the library moves the page down by its height, so a sticky header with `top: 0` slides under it only when scrolling; while the bar is shown the library sets the CSS custom property `--wds-sandbox-bar` on `:root` to its height, so a sticky header can use `top: var(--wds-sandbox-bar, 0)`), there is no recovery contact and no recovery code, at most three invites per vault (they expire before the next wipe), and the breach check of passphrases is off.
When many people test, the oldest vaults that nobody has written to for 30 minutes are deleted to make room, creation is limited per network and for the sandbox as a whole, and an unavailable sandbox answers with an error that wds-verify reports as "sandbox unavailable, not an app finding". Records are limited to {{sandbox_limits}} here: seed data of a migration test must be small (1 MB = 1,048,576 bytes).

- **Use it** through `node tools/wds-verify.mjs <app.html> --target sandbox` (real library, real service, the tool replaces the scope IDs in a copy of your page) or `--sandbox-copy app-sandbox.html` (a copy that a person opens in a browser). By hand: a copy of the file with "sandbox" in its name (section 12, "Without wds-verify").
- **Never write the sandbox scope ID into the app file.** The app would store its users' data where it is deleted every night; wds-verify fails a file that contains it. Never enter real data. A migration (`store.migrateLocal`, porting.md) copies and keeps the old data while `store.status().sandbox` is true.
- When `{{sandbox_scope}}` reads "(no sandbox on this server)" this server has none: test against a scope of your own and a mock (`--target mock`).
