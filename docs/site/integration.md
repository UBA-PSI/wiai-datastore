# WIAI Datastore: integration guide for developers and their Claude

You build or port a single-file web app (one HTML file that runs from file://, a local web server or Electron) whose data is stored end to end encrypted on the faculty server. This page is everything you need to write the app; read it in one go. The rules are in [llms.txt]({{base}}/llms.txt). Library version **{{version}}**; source, PROTOCOL.md and the verifier wds-verify: {{repo_url}}.

The finished app is one HTML file with no build step and no server of your own; its data belongs to the vault, not to the address it is opened from.

*Reading this from the repository (docs/site/)?* Words in double braces (tag, policy, base URL, hash) are filled in by the server when it serves the page; `node tools/wds-verify.mjs --script-tag` prints tag and policy.

## Checklist for Claude

The rules that matter are in llms.txt; they are not repeated here. What this guide adds:

1. Ask the developer for the scope ID (section 1); never invent one. Never write the sandbox scope ID ({{sandbox_scope}}) into an app.
2. An app that exists already: read [porting.md]({{base}}/docs/porting.md) before you change anything.
3. Copy the script tag and the policy exactly (sections 2 and 3). Start the app with `await store.unlock()`, then load (section 12 shows the shape).
4. Add one "Vault" button that calls `store.openVault()` for every role; hide edit controls for read members (section 4, "Role and language").
5. Never: `eval`, `new Function`, `document.write`; catching an error and carrying on as if it had worked; showing "saved" while a save failed (use `onStatus`); reading the store in a timer; hiding the library's dialogs or the sandbox badge with CSS or script; telling people the faculty cannot read their data (section 11).
6. Run wds-verify (section 10), fix what it reports, put the report into the README, and add the text for users (section 11) and the CLAUDE.md / AGENTS.md section from the dashboard.

## 1. Register a scope

Staff of the University of Bamberg open the dashboard at {{base}}/, sign in with login.psi and choose "Create a new app" (a name, a contact e-mail address, optionally a description). The dashboard then shows the **scope ID** (the "app ID": a short name plus six random characters, like `notenrechner-k7m2a9`), the **text for Claude** (it is also the section for the app's CLAUDE.md and AGENTS.md) and the **join code**.
The scope ID is public and is written into the app. The join code is not: hand it to the users, never put it into the app. Staff see number, size and dates of the vaults, never contents.

## 2. The script tag

Exactly this tag, at the end of the body. The browser checks the integrity hash, so a changed library file is refused. Library files never change once released.

```html
{{script_tag}}
```

- `crossorigin="anonymous"` is required for the hash check. The `onerror` handler shows a message when the file cannot be loaded or its hash does not match; it needs `'unsafe-inline'` in the policy below, which is included.
- **Only the message may be in the app's language**, for example `onerror="document.body.textContent='Der Speicherdienst ist nicht erreichbar. Bitte prüfen Sie die Verbindung und laden Sie die Seite neu.'"` (no quote marks, backslash, `<`, `>` or `&` in it). `src`, `integrity` and `crossorigin` stay as printed.
- The tag belongs after the page content (the handler replaces the body text); the app's scripts follow it. Never copy, inline, minify, self-host or wrap the library, and load no other third-party script.
- Current values: version `{{version}}`, integrity `{{sri}}` (also in {{base}}/client/hashes.json).

## 3. Content-Security-Policy

One fixed policy. Put it into the head, right after `<meta charset>`, before any script:

```html
<meta http-equiv="Content-Security-Policy" content="{{csp}}">
```

Nothing loads except the library from {{base}}/client/; the page may talk only to the API ({{base}}/api/); that includes the breach check of the passphrase dialogs, which the server answers (section 11). `'wasm-unsafe-eval'` is needed by the Argon2id key derivation, `'unsafe-inline'` by inline scripts and styles; `'self'` is left out because it means something else on file:// in each browser.

- You may add inert sources only: `font-src data:`, `media-src blob: data:`, `img-src https://…`. Never add hosts to `script-src` or `connect-src`, never `default-src *` or `'unsafe-eval'`. An app that talks to other services needs a different design: ask the developer.
- `form-action 'none'` blocks a real form submission only. A form whose submit handler calls `event.preventDefault()` works as usual.

## 4. API

```js
const store = WDS.connect({ scope: "notenrechner-k7m2a9" });   // baseUrl: only for tests against another service
```

Every call that touches data unlocks first (the library's dialog: create a vault, unlock with the access ID, redeem an invite). Call `await store.unlock()` once at the start, so that the dialog appears when the page opens. Names are any non-empty string up to 1024 bytes; slashes make folders in the export; `.wds/` is reserved. The server sees neither names nor values.

| Call | What it does |
|---|---|
| `await store.unlock()` | Opens the dialog if needed; resolves `status()`. |
| `store.status()` | `{ unlocked, role, sandbox }`; `role` is `owner`, `write` or `read`. Never show or log the access ID. |
| `await store.get(name)` | The JSON value, or a `Blob` (stored MIME type kept) for bytes; `undefined` when missing. Asks the server every time. The version it returns is what the next save of that record builds on: render lists from `items()`, and do not `get` a record that a form shows from `onChange` (the one exception is the reload of an open item named with `remote: true` when nothing was typed, section 12). An autosave editor with unsaved text keeps its base: its next save meets the other version in the dialog. |
| `await store.set(name, value, { mime })` | Saves a JSON value, `Blob`, `File`, `ArrayBuffer` or `Uint8Array` (bytes). Resolves `{ name, version, size, resolution, value? }`; `resolution` is `saved`, `mine`, `theirs` or `merged` (section 7), `value` is what is stored now for `theirs`/`merged`. `set` on an existing record this page has not read is a conflict (dialog or `onConflict`): read the record, show it, then save; replacing blind is the exception. |
| `await store.remove(name)` | `{ name, deleted, resolution, value? }`; the deletion stays in the history. |
| `store.collection(prefix, { meta })` | A list of records with an index (section 6); `add` and `set` take `{ meta, mime }`, an explicit `meta` replaces the `meta` function. |
| `store.autosave(name, getState, opts)` | The handle for editors (below). |
| `store.onChange(fn)` | `fn({ names, remote })` after this page's own successful writes (`remote: false`) and when the vault holds something other than this page shows (`remote: true`): the window got focus and the library found records or list entries changed elsewhere, or an autosave lost a conflict (the other version won, or you merged). `names` are record names (`notes/<id>`). Render from it. One handler per page: a second `onChange(fn)` is a `UsageError`, `onChange(null)` removes it. A write inside the handler fires it again: do not write there. An item that is open in an editor and named with `remote: true`: reload and show it unless the person has typed since (the saver's status is not `dirty` or `saving`); section 12 shows it. |
| `store.onConflict(fn)` | Decide conflicts in code (section 7); one handler per page. |
| `await store.showHistory(name)` | The version browser with a restore button (disabled for read members). |
| `await store.openVault()` | The vault dialog (section 8), for every role. |
| `await store.lock()` | See "Lock". |
| `await store.migrateLocal(opts)` | Takes over the old data of an earlier local version ([porting.md]({{base}}/docs/porting.md)). |

**Lock.** `store.lock()`, a revoked access and an expired session all end the same way: the library saves what is pending (up to 8 s) and reloads the page, so the app starts again at the top and nothing of the vault stays on screen. An expired session first shows the unlock dialog above the page; pending writes continue after it. Offline, a dialog offers a backup download of the unsaved values, then "Lock anyway". The page is emptied before it reloads, so no typed text can come back into a field. What does not run through `autosave` or a collection (a form with a Save button) is lost when the page locks: let forms save through `autosave`. There is nothing to register for lock or unlock, and no state to clear.

**Role and language.** While unlocked, `<html data-wds-role="read|write|owner">` is set: hide edit controls with `[data-wds-role="read"] .edit { display: none }`; a read member that writes anyway gets an `AuthError` (`forbidden`). The dialogs follow `<html lang>` (`de…` German, else English): set it to the app's language.

**The library's dialogs and yours.** Library dialogs are modal `<dialog class="wds-dialog">` elements that open above your own modal dialogs; select yours with `dialog:not(.wds-dialog)` and never style or close the library's.

### Autosave

```js
const saver = store.autosave("draft", () => state, {
  delayMs: 2000,                                            // after the last change (default 2000)
  onStatus: (status, info) => { statusEl.textContent = status; },   // idle | dirty | saving | saved | error; info.error for error
});
saver.changed();         // after every edit; cheap
await saver.flush();     // save now; never rejects, resolves with the final status
saver.stop();            // no more saves; changed() is a no-op afterwards
```

Use it for everything a person edits, never `store.set` per keystroke. It reads the state with `getState` when the timer fires (`undefined` means nothing to save), writes one name at a time, retries after a lost connection, saves before lock or unload and warns before the page closes with unsaved changes. A save that lost a conflict (`theirs`) or was merged is `saved` plus `onChange` with `remote: true` for the name: that is the one place that tells the app its open entry is another text now. A second live handle for the same name is a `UsageError`; `store.remove(name)` stops that name's handles.

## 5. Where data lives

- User data lives only in the store: not in localStorage, sessionStorage, IndexedDB, cookies, the URL or `console.log` (on file://, Chrome gives every local HTML file the same storage). The one exception is the take-over of old data, which the library does (`migrateLocal`).
- **Preferences.** A choice from a fixed list (theme, language, sort order, last tab) stays in localStorage under the app's own key. Typed view state (search text) stays in memory. Anything a person typed, or would miss on another device, and any value that everyone sharing the vault sees, is data and goes into the vault.
- The library keeps a few non-secret items under `wds:<scope>:…` in localStorage (the last access ID, safety records): leave them alone, never call `localStorage.clear()`. Keys and passphrases never reach app code.
- The service is online only. When saving fails the library offers a backup download of the unsaved values. Do not build an offline mode.

## 6. Modelling

- **One record per entity** (a note, a project, an exam): `notes/3f9a1c2e`, never one record for the whole app state (it conflicts constantly and grows the history). The server keeps the last versions of every record (`showHistory`); a value is limited in size, and a `QuotaError` names the limit.
- **A list is a collection**: `notes/<id>` records plus an index with a little **meta** per item (a title, a date, a file name: at most 512 bytes of JSON, better under 200) so that a list renders without loading the items. Devices add and remove items at the same time without losing each other's.

```js
const notes = store.collection("notes/", {
  meta: (note) => ({ title: String(note.title || "").slice(0, 80) }),   // what a list needs; called on every write through the collection
});

render(await notes.load());                          // [{ id, name, meta }] in the order they were added; one request, then from memory
store.onChange(() => render(notes.items()));         // own writes and other devices

const { id } = await notes.add({ title: "Shopping", text: "" });   // random id; resolves when the item is stored (the list entry follows in the background)
const note = await notes.get(id);                    // the value (a Blob for bytes), or undefined; edit this object ...
const saver = notes.autosave(id, () => note, { onStatus });   // ... and call saver.changed(); like store.autosave, and it keeps the list entry (title) current
await notes.set("2026-ws", { title: "Exam" });       // upsert with an id of your own (1 to 200 characters, no "/")
const all = await notes.getAll();                    // [{ id, name, meta, value }]
await notes.remove("2026-ws");                       // item and list entry
```

  `col.set` follows the rule of `store.set`: on an existing item this page has not read it is a conflict; read it, show it, then save. Sort by a meta field (the list comes back in the order of adding). A collection of a few thousand items is the limit, because every list change uploads the whole index. A failed list write stays queued in the library and is retried on the next write and on focus. A read member can load and read. `getAll()` downloads every item: not for files.
- **Files.** A file is a record of bytes. Write the file first, then the item that names it (meta `{ file: name }`); delete in reverse order (the item first), so that a failure in the middle leaves at worst a file nothing names, never an item that points to nothing:

```js
const photos = store.collection("photos/");

async function addPhoto(file) {
  const id = crypto.randomUUID().slice(0, 8) + "-" + file.name;           // the ending stays in the name
  await store.set("files/" + id, file);                                      // 1. the file
  return (await photos.add({ caption: "" }, { meta: { file: id, name: file.name } })).id;   // 2. the item
}
async function deletePhoto(item) {                                          // item: { id, meta }
  await photos.remove(item.id);                                             // 1. the item
  await store.remove("files/" + item.meta.file);                            // 2. the file
}
```

  Open or download a stored file with a link that carries `download` (the click saves it; the file is not encrypted any more, say so next to the button):

```js
async function downloadFile(name, shownName) {
  const blob = await store.get("files/" + name);                // a Blob with the stored type
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: shownName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
```

  To show a file in a new tab instead, call `window.open("", "_blank")` inside the click, before the first `await`, and set `w.location.href` to the blob URL when the bytes arrive (after an `await` the popup blocker refuses it). Show a missing file as "attachment no longer available". Never write a clean-up of files that no item names: a partly loaded list makes live files look unused.
- **IDs** come from the collection or from `crypto.randomUUID().slice(0, 8)`; never derive them from text that can change.
- **Settings** for everyone who shares the vault are one small record `settings`; personal preferences stay in localStorage (section 5).
- The library has no user identity. An app that needs "booked by" asks for a name and stores it in the item.
- There is no unique index: check the loaded list before adding; a race between two devices remains.

## 7. Conflicts

The library remembers the version it read and writes only on top of it. When someone else saved a newer one, a dialog says so and offers **keep theirs** or **keep mine** (saved on top; the other version stays in the history). It never overwrites silently. For most apps that dialog is right, and the dialog names a record by the `title` of its collection meta when it is a string, else "this entry".

Decide in code only where a merge helps. One handler for everything; route with an `if` on `c.name`; a second `onConflict(fn)` is a `UsageError`, `onConflict(null)` removes the handler:

```js
store.onConflict((c) => {                                     // c.name, c.mine, c.theirs: { value, deleted }, or null when the record never existed
  if (c.name !== "settings" || c.mine.deleted || !c.theirs || c.theirs.deleted) return;   // undefined: the library's dialog asks the person
  return { merged: { ...c.theirs.value, ...c.mine.value } };  // two devices changed different settings: keep both. Or return "mine" or "theirs".
});
```

A handler may be async; one that throws also hands over to the dialog. `set` and `remove` resolve with `resolution`: `theirs` means the other value is the truth now, so show `res.value`. An autosave editor learns it from `onChange` (`remote: true`).

## 8. Members and the vault dialog

Every user has their own vault. `store.openVault()` opens the vault dialog, **for every role**: the owner sees the members and creates invites (role `write` or `read`, with a label) or revokes access (the vault is re-encrypted under new keys, with a progress bar that resumes after an interruption); everyone sees their own access, can change the passphrase, show the access sheet again, "Export everything (ZIP, unencrypted)" and "Lock now". Offer one "Vault" button in every app; it is also the way out if the app is retired (anybody can export with {{base}}/export/ using the access ID and passphrase; the ZIP is not an import format). A new member's access takes effect for the app after its next load.
Members see the other members' changes through `onChange`. There is one owner per vault; if the founder forgets the passphrase, the faculty can add a new owner with the founder's emergency code (users.en.md, "Recovery"); without that code the data is lost.

## 9. Errors

Thrown errors have `name`, `message`, often `code` and `status`; the classes are in `WDS.errors` (`WDSError` is the base). The library already shows a notice or dialog for most; app code decides only what happens on its own screen. The browser console shows a `404` while a vault is created and a `412` for a lost write: both are normal.

| Error | When | What to do |
|---|---|---|
| `OfflineError` | no connection, server down, or no answer in 30 s (`code: "timeout"`). A write whose answer was lost is checked and counted as saved if it arrived. | Keep the screen; the library offers the backup download. Autosave retries. |
| `ConflictError` | a write kept losing and the conflict could not be settled | Section 7. |
| `QuotaError` | value too large, vault or scope full, server read-only (`code: "read_only"`); the message names the limit | Tell the person; reads and deletes still work. |
| `AuthError` | wrong passphrase, expired or revoked access, a write by a read member (`forbidden`) | The library handles expiry and revocation. A button save that rejects: keep what the person typed and let them press again (autosave and the list entries are retried by the library). |
| `IntegrityError` | data fails a check (tampered or damaged) | Stop using that record; tell the person. |
| `VersionError` | data written by a newer library | Ask the person to update the app. |
| `UsageError` | misuse: `undefined` value, reserved name, a second autosave handle for one name | A bug in the app. |

## 10. wds-verify

A smoke test, not a proof. It runs the finished app from file:// in Chromium against the public sandbox (section 13), drives the library's dialogs, types canary strings into the fields, presses the save buttons, reloads and checks that the values come back, and searches every request and every storage for plaintext. Its static checks cover the script tag, the policy and the forbidden patterns. Every check: `tools/README.md` in the repository.

```sh
git clone {{repo_url}} && cd wiai-datastore       # once, with Node 22 or newer
(cd tools && npm install && npx playwright install chromium)
node tools/wds-verify.mjs <app.html>    # the Markdown report goes to stdout: put it into the README
```

Exit code 0 passed, 1 a check failed (fix, run again), 2 the tool could not run, 3 the sandbox is unavailable (not an app finding: wait, at most an hour). Without Node, say in the README that wds-verify did not run.

A plain form app passes without more. Write a `wds-verify.json` next to the app only when inputs are hidden until the user acts (a "New" button, tabs) or the page has a file input; pass it with `--config` if it lies elsewhere. `steps` run after the tool pressed what it recognised; `afterReload` takes the same steps after the reload (open each tab or item that shows the data: the list shows a title that the library writes a few seconds after the text). Steps: `click` (selector), `fill` ([selector, text]: unique, and it must come back as the same text), `select`, `press` ([selector, key]), `upload` (a file input), `download` (a button the person would press), `wait` (ms). Selectors are Playwright selectors.

```json
{
  "steps": [
    { "click": "#new" },
    { "fill": ["#text", "verify canary text for the notes example"] },
    { "wait": 3000 }
  ],
  "afterReload": [{ "click": "#list li:first-child button:first-child" }]
}
```

The report ends with "Not tested": a second device, a conflict, a read-only member, buttons it does not press. Try those by hand in a second browser window.

## 11. What to tell users

Put this into the app's README or start page, adapted. English first, German below (German uses "Sie"). **The first sentence of each language is the official wording of the faculty**: keep it word for word, in the language of the text (any other language uses the English one), and never claim more ("only you can read your data") or less. The rest may be shortened. The breach check of the passphrase dialogs is explained on the service's privacy pages and in users.en.md; the app's text does not have to repeat it.

```text
Data is end-to-end encrypted; the faculty holds a recovery key for emergencies.
Your data is stored on a faculty server. You need:
1. The join code from the person who runs this app (only for creating a vault).
2. A passphrase of your own, at least 12 characters. It cannot be reset: the server does not know it.
3. Your access sheet (access ID and emergency code). Print it or save it somewhere apart from this device.
With your emergency code the faculty can restore access after a documented procedure. Details: {{base}}/docs/users.en

Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel.
Ihre Daten liegen auf einem Server der Fakultät. Sie brauchen:
1. Den Beitrittscode von der Person, die diese App betreibt (nur zum Anlegen Ihres Tresors).
2. Eine eigene Passphrase mit mindestens 12 Zeichen. Sie lässt sich nicht zurücksetzen: Der Server kennt sie nicht.
3. Ihr Zugangsblatt (Zugangskennung und Notfallcode). Drucken oder speichern Sie es getrennt von diesem Gerät.
Mit Ihrem Notfallcode kann die Fakultät nach einem dokumentierten Verfahren den Zugang wiederherstellen. Details: {{base}}/docs/users.de
```

Next to a download button (a CSV, an attachment) say that the file is **not encrypted**. A text such as "saved locally" or "stays on this device" is wrong now: replace it.

## 12. Complete minimal example

A notes app: list, create, edit with autosave, delete, vault, in the linear shape every app has: unlock, load, render, `onChange`. Replace the scope ID. It runs from file:// with exactly this policy and tag, and passes wds-verify with the `wds-verify.json` of section 10 (examples/docs-recipes.spec.mjs tests it against the real server).

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
  [data-wds-role="read"] .edit { display: none; }
</style>
</head>
<body>
<h1>Notes</h1>
<p>
  <button id="new" class="edit">New note</button>
  <button id="vault">Vault</button>
  <span id="status" role="status"></span>
</p>
<ul id="list"></ul>
<textarea id="text" rows="10" disabled aria-label="Note text"></textarea>

{{script_tag}}
<script>
"use strict";
const store = WDS.connect({ scope: "myapp-k7m2a9" });   // the scope ID from the dashboard
const notes = store.collection("notes/", { meta: (note) => ({ title: note.text.split("\n")[0].slice(0, 80) }) });
const $ = (id) => document.getElementById(id);
let current = null, saveState = "idle";   // the open note: { id, note, saver }, and the status of its saver

function render(items) {
  $("list").replaceChildren(...items.map(({ id, meta }) => {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.textContent = meta.title || "(empty)";
    open.onclick = () => openNote(id);
    const del = document.createElement("button");
    del.className = "edit";
    del.textContent = "Delete";
    del.onclick = () => deleteNote(id);
    li.append(open, " ", del);
    return li;
  }));
}

async function closeNote() {
  if (!current) return;
  await current.saver.flush();
  current.saver.stop();
  current = null;
  $("text").value = "";
  $("text").disabled = true;
}

async function openNote(id) {
  await closeNote();
  const note = await notes.get(id);
  if (!note) return;
  const saver = notes.autosave(id, () => note, {
    onStatus: (status) => { saveState = status; $("status").textContent = status; },
  });
  current = { id, note, saver };
  $("text").value = note.text;
  $("text").readOnly = store.status().role === "read";
  $("text").disabled = false;
  $("text").focus();
}

async function deleteNote(id) {
  if (current && current.id === id) await closeNote();
  await notes.remove(id);
}

$("text").oninput = () => { current.note.text = $("text").value; current.saver.changed(); };
$("new").onclick = async () => openNote((await notes.add({ text: "" })).id);
$("vault").onclick = () => store.openVault();

async function start() {
  await store.unlock();                            // the library's dialog: create a vault or unlock
  render(await notes.load());
  store.onChange(async ({ names, remote }) => {      // our own writes (also the title while typing) and other devices
    render(notes.items());
    const open = remote && current && names.includes("notes/" + current.id) && saveState !== "dirty" && saveState !== "saving";
    const fresh = open ? await notes.get(current.id) : null;   // the open note changed elsewhere (or the other version won a conflict) and nothing was typed since
    if (fresh && current) { current.note.text = fresh.text; $("text").value = fresh.text; }
  });
}
start();
</script>
</body>
</html>
```

## 13. Sandbox and porting

The sandbox is a public scope for tests: **{{sandbox_scope}}**, open to everyone without a join code, limits {{sandbox_limits}}, everything deleted every night between {{sandbox_wipe}} and one hour later; creating vaults is limited ({{sandbox_creation}}). The library marks its dialogs and the page with "Sandbox", and a migration never deletes there. `wds-verify` uses it for you (it replaces the scope ID in a copy of your page). **Never write the sandbox scope ID into an app, and never enter real data.**
An app that exists already: read [porting.md]({{base}}/docs/porting.md) first.
