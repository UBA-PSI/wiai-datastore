# Porting an existing app to WIAI Datastore

You port an app that exists already: it keeps its screens and its logic, and what changes is where its data lives. The code on this page was run in Chromium, Firefox and WebKit against the real server (examples/docs-recipes.spec.mjs). The script tag, the Content-Security-Policy and the API are in [integration.md]({{base}}/docs/integration.md); read its sections 2 to 7 first.
Work through the sections in order: 1 Inventory, 2 Replace the storage calls, 3 Own export and import, 4 The data in the browsers of existing users (`store.migrateLocal`, one call), 5 What stays as it is, 6 Test the port, 7 Checklist for apps with forms and modal dialogs.
Sizes in MB are defined in integration.md, section 4 (`usage`).

## 1. Inventory

Find every place where the app keeps or reads data that outlives the page: `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, the Cache API, file handles, `fetch` to a server of its own, and its own export and import (a JSON or CSV file).
For each, write down what kind of entity it holds, how many there are, how large they get, and who changes them. Then map each kind:

| What the app has | In the datastore |
|---|---|
| A list of things: notes, entries, projects, students | A **collection**: `store.collection("notes/", { meta })`, one record per thing (integration.md, section 6) |
| A single small thing: the running timer, a draft | One record: `store.set("timer", …)` and `store.get("timer")`; a draft or editor through `autosave` |
| Settings | A value for everyone who shares the vault (units of a shared collection), or anything the person typed (a name for a report header, own label lists): one record. A personal preference chosen from a fixed list (theme, language, sort order, last tab): keep the app's own localStorage key and do not name it in `migrateLocal` (integration.md, section 5). A preference that lives in IndexedDB or inside a data key cannot stay: it is claimed (`h.skip`), deleted with the rest and reset for the person, unless the app copies it to its own localStorage key before `migrateLocal` |
| Files: images, PDFs, attachments | A second collection of bytes, ending in the id (`"files/"`, ids like `a1b2c3-report.pdf`); the owning item or the meta says which item the file belongs to |
| References between things | The other thing's id inside the value (or the meta) |
| A unique index | No counterpart: the vault keeps only ids unique. Check in the app before `set`; two devices can still create duplicates |
| Computed data (totals, search results, week tables) | Not stored: compute it from the records |

Sources that `store.migrateLocal` does **not** take over: `sessionStorage`, cookies, the Cache API, the Origin Private File System, file handles and every IndexedDB database or localStorage key that you do not name in its options.
What the old app kept there is lost for the person when it is no longer written, or stays unencrypted in the browser for ever. If it matters, the old version needs an export button (section 3) that the person uses before the update.

## 2. Replace the storage calls

| Before | After |
|---|---|
| Read everything at start | `await store.unlock()` (or `onUnlock`), then `await col.load()` for the list, `col.getAll()` when every value is needed, `col.get(id)` when one is opened |
| Save after an edit | `col.autosave(id, () => item)` and `saver.changed()` for editors, `col.set(id, item)` for button saves and new items with an id of your own, `col.add(item)` for new items |
| Delete | `await col.remove(id)`; check the result (integration.md, section 4) |
| "Save as backup" / JSON export of everything | `store.exportAll()` (section 3) |
| Import of the old file format | keep it (section 3) |
| A save on `beforeunload` or `visibilitychange` | remove it: the library warns before closing and saves on lock |
| A "saved" label | the autosave `onStatus` (never show "saved" before the write returned) |

The app shows data only when the vault is open: register `store.onLock` and `store.onUnlock` once and build the screen in `start` (integration.md, section 4, "Lock and unlock again"). An app in one language (only German, say) calls `store.setLocale("de")` once right after `WDS.connect` (a language switch: at start and on every change).

### Details that ports ask about

- **A shared record that `autosave` keeps current** (a draft, a value for everyone): read it once at start (`await store.get("units")`), then `store.autosave("units", () => state)` writes on top of the version it has read. Without the read, the first save of a record the page does not know is a conflict if the record exists (`store.set` does the same).
- **After `resolution === "theirs"`:** section 7, point 2.
- **Small decisions that are yours.** Migrated items keep the order of their old `created` date (`h.created`): sort by what a person sees (a date field of your own), not by id. The privacy text of the app is in integration.md, section 13.

## 3. Own export and import

Replace the app's own "export everything" with `store.exportAll()`: it is the backup and the way out, but not an import format (integration.md, section 9). **Keep an import** for the old export format, so that people who exported from the old version can move their data over by file. Reading a file the person chose is not storing data, so it is allowed.
The import keeps the old ids and rewrites every reference through the same function: a second import of the same file overwrites instead of doubling, `created` keeps the old order of the list, and references between items stay valid. Read first, then `set`: an item that exists is overwritten, not a conflict. An import that replaces everything writes the new items first and removes the others afterwards.

```js
const notes = store.collection("notes/", { meta: (n) => ({ title: n.title }) });
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

## 4. Data that is still in the browsers of existing users

Existing users have data in IndexedDB or localStorage. Dropping it would lose it, and leaving it there would keep unencrypted data on the device for ever. The rule "no user data in IndexedDB or localStorage" means the app never **stores** data there.
**Reading the old data once, writing it into the vault and deleting it afterwards is the intended way, and the library does it:** one call, `store.migrateLocal`, with an options object of 10 to 30 lines. The app does not open `indexedDB` or remove the old keys itself (wds-verify warns about that).

What the library does, in this order, and what the person sees:

1. **It looks at the old storage** (read only, after the unlock and the check of the role). Nothing there: `nothing`, without any dialog or request. Another tab is doing the job: `busy`. The vault of a member (not the owner): `skipped` with a notice.
2. **It asks once** (view `migrate`, German or English like the other dialogs): "This browser holds 4 entries from an earlier version of this app. They are unencrypted and exist only on this device. Copy them into your vault (access ID ending in …) and then delete them from this browser? Deleting cannot be undone."
   Buttons: "Take over", "Download a backup (not encrypted)" (a ZIP `<id>-old-data-<date>.zip` with every old row and its files) and "Not now" (the dialog says that the unencrypted data stays and the question comes again at the next start). In a sandbox it says that the old data stays.
   Rows that `h.skip` left out are counted ("N entries are not taken over because the app does not use them. They are deleted with the rest of the old data"), and "Take over" stays disabled until the box "I do not need these N entries" is ticked or the backup was downloaded. Every non-empty migration asks.
3. **It copies** with create-only writes (view `progress`: "Taking over: 3 of 4", then "Checking the copy"), writes the list of every collection, reads everything back and compares it byte for byte.
4. **Entries that do not fit** (above `max_value_bytes`, or the vault is too full) are named in the view `migrate-large`: the person downloads them with one button, then chooses "Delete the old data anyway" (enabled once the ZIP was built and saved; if it cannot be built, the old data stays: use the backup button of the notice) or "Keep the old data" (or Escape: `partial`, nothing deleted). References from copied entries to a left-out entry become `null` before anything is written.
5. **It writes a marker record into the vault and only then deletes the old rows**: it reads them again first, and one changed row (a file of the same size with other bytes, say) means that nothing is deleted. In a sandbox the old data is kept.
6. **A toast tells the person what happened** (how many entries are in the vault, whether the old data was deleted, how many entries were written as copies, see "Ids"). `store.migrateLocal` resolves with a result object (below).

The library does these things; you cannot forget them, and wds-verify checks the result:

- **Owner only.** The old data is private to this browser; a member's vault is read by others. Another tab does not start a second run (`navigator.locks` answers `busy` at once).
- **Create-only and read back.** Nothing in the vault is overwritten; the copy is read back from the server and compared byte for byte.
- **Every old row is claimed** by an entry's `from` or by `h.skip`, else nothing is deleted.
- **Delete only if unchanged, and never in the sandbox** (the test global of section 6 is the one exception). No `deleteDatabase`, never `localStorage.clear()`, the keys of the library (`wds:`) are never touched.

### Before you call it

- **The new app must be opened from the same place as the old one.** A page reads only the storage of its own origin. An app served over `http(s)` needs the same scheme, host and port (the path does not matter). A file opened from disk depends on the browser: Chromium shares localStorage and IndexedDB between all `file://` pages,
  Firefox and Safari give every file its own storage. So replace the old file in place (**same folder, same file name**, the same URL) and tell the users to open the new version the way they opened the old one. A new file with another name or path finds `nothing` in Firefox and Safari, and the old data stays there.
  wds-verify runs Chromium and opens the old page and the new app in one browser, so it cannot show this problem; its "Not tested" list names it when a `seed` is present.
- **Only the owner of a vault takes data over.** A member's vault is not the place for someone else's old data: the old data is private to this browser and would be copied into a vault that others read. A member gets `status: "skipped"`, a notice with a backup button (once per page, at every start, until the old data is taken over into a vault of the person's own or the backup was downloaded and the old data removed) and the old data stays where it is.
  A member downloads the backup from the notice, or the owner imports the old export only if the old import adds and does not replace.
- **Call it once per page, in `start`, before you load or write anything of your own** (see "What your app does with the result").
- **Try it with test data, in a fresh browser profile.** A person who tries the port by hand in the browser that holds their real old data moves that data into a vault that they may call a test and delete later in the dashboard, and the library deletes the old data from that browser (that is its job). Use wds-verify with a `seed` (section 6), or a new browser profile into which you put test data.

### The call

```js
const result = await store.migrateLocal({
  id: "cookbook",                                           // names this migration: 1 to 40 characters of a-z, 0-9 and "-"
  indexedDB: { name: "cookbook", stores: ["recipes", "images"] },   // optional: one object or an array; only these stores are read and emptied
  localStorage: { keys: ["cookbook.favorites"], prefixes: [] },   // optional; a prefix matches with startsWith
  map(old, h) { /* section "map" below */ },                // required; may be async
});
```

- `id` names the migration (the lock, the tag key in localStorage and the marker record in the vault); use the app's name. The collections that `map` writes into must be created with `store.collection` before the call.
- `indexedDB`: databases are opened without creating them (a missing one is simply empty), only the listed stores are read and emptied, the database itself is never deleted. Two databases may have a store of the same name: then `old.rows` needs `"db/store"`.
- `localStorage`: `keys` and `prefixes` of the old keys. A preference that stays in localStorage (section 1) is not named here, and no prefix may cover a key that the new app keeps writing (it would be deleted again at every start): list such data keys by name. Keys starting with `wds:` are never read or removed; an empty prefix or one starting with `wds:` is a `UsageError`.
- `map(old, h)` turns the old rows into entries (below). Pure: same input, same output.

A wrong option (a missing `id`, an unknown option, a source that is not named) rejects with a `UsageError` before anything is read. The wording of the dialogs is the library's, in German and English.

### map(old, h)

`old` is a picture of the old storage, built before `map` runs. `map` gets **copies** of the rows (objects, arrays, Maps, Sets and Dates are copied; a Blob, File or binary buffer is shared, so never change its bytes): you may change what you are given, and the old rows are never touched.

| `old` | |
|---|---|
| `old.rows("recipes")` | `[{ key, value }]` of that IndexedDB store, in key order; the store name, or `"db/store"` when two databases have a store of that name; `[]` when the database or store does not exist. A key-value store (`put(value, key)`) has the same shape. |
| `old.local` | `{ key: text }` of every configured key and prefix match that exists, the strings as localStorage holds them (`Object.keys(old.local)` lists the keys). |
| `old.json(key)` | `JSON.parse` of one key; `undefined` when the key does not exist; an error that names the key when the text is not JSON. |

`h` are the helpers. They are pure and give the same answer every time:

| `h` | |
|---|---|
| `h.id(oldKey, ending)` | The id of an entry for an old key (section "Ids"). `ending` is optional and looks like `".pdf"` (a dot and 1 to 8 letters or digits). |
| `h.ref(storeName, oldKey, ending)` | The id of the entry that the row with `oldKey` in `storeName` becomes: use it for **references**. `null` when that row does not exist (a dead reference becomes `null`), and `null` for a missing key. |
| `h.blob(value, field)` | A `Blob` from the row value: the value itself when it is a Blob or File, else `value.blob`, `value.data` (an ArrayBuffer or typed array) or a `data:` URL string. With `field`: `value[field]`. Anything else stops the run (a field called `pdf` is not guessed: pass its name). |
| `h.created(x)` | Milliseconds from a Date, a number or a date string; `undefined` otherwise. For `created` below. |
| `h.skip(rowOrKey, why)` | Leaves a row out **on purpose**. **A skipped row is deleted with the rest of the old data and never reaches the vault** (only the backup has it). Use it for rows that are no user data (a cache, a version marker, a preference that stays in localStorage), never for something a person made: copy an attachment whose note is gone with `note: null`, a timer of a deleted project without the project. |

`map` returns an object with `items` and `records`; both are optional and every unknown field is an error (a `settings` field too: personal preferences stay in localStorage and are not named in `migrateLocal`; shared values are a record).

| Field | Written as | Entry |
|---|---|---|
| `items` | `col.set(id, value, { meta, created, mime })` | `{ col, id, value, meta?, created?, mime?, from }`: `value` is a Blob, a File or binary data (stored as bytes) or JSON. `id` is 1 to 200 characters without `/` (use `h.id`). **`mime`** is the type that `store.getBlob` gives back and counts only for bytes. Without `mime`, the `type` of the Blob or File is stored (`h.blob` of a row `{ data, type }` gives a Blob of that `type`, one of a `data:` URL the type of the URL). A Blob without a type, a typed array or an ArrayBuffer is stored without one and `getBlob` returns `application/octet-stream`: give `mime` then, or to override a type that is wrong. A `map` that changes only the `mime` field counts as a corrected `map` (below). |
| `records` | `store.set(name, value, { mime })` | `{ name, value, mime?, from }` for single records such as a timer, or a value that everyone who shares the vault uses. The name must not be inside the prefix of a collection, nor start with `.wds/`. Create-only like every entry. |

- **`from` is required on every entry**: the row object that `old.rows()` gave you, a localStorage key (a string), or an array of them (an entry that is made from several rows). Every row of every configured store and every localStorage key that matches must be claimed by some entry's `from` or by `h.skip`.
  If one is neither, the run stops (`failed`, "N old row(s) were neither copied nor skipped: …") and **nothing is deleted**. This protects the person's data from a `filter` that drops rows, a store you forgot to map, or the rows of another app in the same origin. A key that is configured but does not exist in this browser may be named in `from`; it claims nothing.
- **`map` runs twice and both results must be identical** (same ids, same JSON). Ids come from `h.id`, never from `crypto.randomUUID()`, `Math.random()` or the clock (`Date.now()`, `new Date()` without an argument); otherwise the run fails. An interrupted run could not continue with random ids: it would copy everything again.
- A JSON value must not contain a Blob, a typed array, a Map or a Set: JSON would write them as `{}`. Make the file its own item (`h.blob`) and refer to it by id. BigInt and cyclic values stop the run. Dates become ISO strings. A JSON value larger than `max_value_bytes` is "too large" (step 4).
- Every id and every name is checked before the first write (length, `/`, duplicates inside one run, a collection that is not of this store, a record inside a collection's prefix). Every `h.ref` result must be the id of an item of the same run, else the run stops.
- **A mistake in `map`, or in one person's data, is a `failed` result, never a rejection**: a missing `from`, an id with `/`, an unknown store in `old.rows`, a `created` that is not a number, a throw in `map` (`why` is "map threw: …"), an `old.json` of a damaged key. The page must still start for that person, so the library writes the message with `console.error`, shows the notice with the backup button, deletes nothing and returns `{ status: "failed", why }`.
  To let the person go on past a damaged text, read `old.local[key]` yourself and copy it unchanged into a record (`records: [{ name: "damaged", value: { text: old.local[key] }, from: key }]`).
- **A corrected `map`.** The marker remembers, per entry, what `map` made of it. An entry that `map` now makes differently is new again (it goes through the check against the vault); one that it makes the same way is done, so a start with the marker asks nothing and what the person edited or deleted in the new app since stays. When you test a corrected `map` in the sandbox (which keeps the old data), the first run's entries are already in the vault: use a new `id`, a fresh browser profile or wait for the nightly wipe.
- `meta` is at most 512 bytes of JSON. `created` is a number of milliseconds that only decides the order of the list (integration.md, section 6, "`set` and `created`").

### Ids

An old key becomes the id of an entry: `h.id(oldKey)` is `<tag>-<token>`. The tag is 8 random hex characters per browser and migration, kept in the old localStorage under `wds:migrate:<id>:tag` (the one write the library makes there; it stays after the old data is deleted, because it names this browser's marker in the vault), so two browsers with the same old ids never overwrite each other (every item then exists twice; the person deletes the copies).
The token is `s` plus the URL-encoded string for a string key (`"a/b"` gives `sa%2Fb`), `b` plus hex for a binary key and `j` plus the URL-encoded JSON text for everything else (the number 12 gives `j12`). Different keys never give the same id (1 and "1", "a/b" and "a_b"), an id never contains `/`, and one longer than 200 characters is cut (the first 180 characters, `~` and a hash). The ending is appended: `h.id(7, ".pdf")` is `<tag>-j7.pdf`.
**An id that two sides compute must be computed with the same call.** A reference gets its target's id from `h.ref("images", p.image, ".jpg")`; the target gets it from `h.id(row.key, ".jpg")`. If the reference side does not know the file name (the usual case: the entry holds only the key of its image), use a fixed ending on both sides (`".jpg"`: the old app saved every photo as JPEG); `h.ref` returns `null` when the target row is gone, so a dead reference never reaches the vault.
**An entry that is in the vault already with other content** (a lost or partial run, a corrected `map`, a record that the app or a second browser wrote first) is never overwritten: the old version is written create-only as `<id>~<tag>-<hash>` (a record: `<name>~<tag>-<hash>`; the hash is the start of the entry's own hash, so a second change makes a second copy), read back like every copy and counted as copied. `result.copies` lists these names and the done toast says how many. The same content counts as copied without a write. **A copy of an item shows up in its collection; a copy of a record is invisible to the app** unless it reads `result.copies` (merge it, or show it). So keep lists of things the person made in a collection, not in a record.

**The new ids contain `-` and `%`** (`<tag>-j12`, `<tag>-sa%2Fb`; a file keeps its ending, `<tag>-j7.pdf`). Code that splits an id at `-`, takes the part before it as the "real" id, reads a number out of it or builds a file name from it must be checked and changed before the first migrated item is shown: take the whole id, and look the rest up in the meta.
The same holds wherever an id goes into something with a syntax of its own: `querySelector("#item-" + id)` and other CSS selectors (use `CSS.escape(id)`, or keep the id in `data-id` and read `dataset.id`), `id="…"` attributes, `location.hash` routes (use `encodeURIComponent`), and arithmetic on ids (`Number(id)` sorts, a counter `nextId = max + 1` gives `NaN` once a migrated id is in the list).
**Two stores with the same keys** (notes 1, 2, 3 and todos 1, 2, 3) that go into **one** collection give the same id twice: the run stops (`failed`, "two entries would get the same name"). Use one collection per store, or put the store into the key on both sides: `h.id(["notes", row.key])` for the item and for every reference to it (`h.ref` builds `h.id(oldKey)` only, so write such a reference yourself with the same `h.id` call).

### Example 1: a reference from one entry to another (photos in a recipe)

The old "Cookbook": the IndexedDB database `cookbook` with the store `recipes` (keys are the names the person gave: `"apple-pie"`, `"Tarte Tatin"`; values `{ title, photos: [{ image, caption }], saved }`, where `image` is the key of a row in `images`) and the store `images` (keys `"img-1"`; each value is a `File`; the old app re-encoded every upload as JPEG).
The recipe lists its photos by the id of the image. Both sides compute that id with the same call and the same fixed ending `".jpg"` (the recipe side does not know the file name); a photo whose image row is gone keeps its caption and gets `image: null`. Example 2 shows the other shape, where only the file points to its owner.

```js
const recipes = store.collection("recipes/", { meta: (r) => ({ title: String(r.title || "").slice(0, 80) }) });
const images = store.collection("images/");

const result = await store.migrateLocal({
  id: "cookbook",
  indexedDB: { name: "cookbook", stores: ["recipes", "images"] },
  map(old, h) {
    const items = old.rows("recipes").map((row) => ({ col: recipes, id: h.id(row.key), from: row, created: h.created(row.value.saved),
      value: { title: String(row.value.title || ""), photos: (row.value.photos || []).map((p) => ({ image: h.ref("images", p.image, ".jpg"), caption: String(p.caption || "") })) } }));   // h.ref: the id that the image side computes; null when the image row is gone
    for (const row of old.rows("images")) items.push({ col: images, id: h.id(row.key, ".jpg"), from: row, value: h.blob(row.value), meta: { name: String(row.value.name || "photo.jpg").slice(0, 100) } });   // the value is a File: h.blob gives it back as it is, with its type
    return { items };
  },
});
```

### Example 2: a localStorage JSON, notes, files and a key-value store

The example app `examples/zeit-notizen` has a local-only predecessor in `examples/zeit-notizen/old/index.html`: projects and time entries as one JSON text in the localStorage key `zeitnotizen.daten` (two counters, so `p1` and `e1` keep their ids apart), notes with auto-increment ids in the IndexedDB database `zeitnotizen`,
attachments with a File and the id of their note, and a key-value store `meta` with the rows `timer` and `lang`. This is the code of the example app (the file `index.html` holds exactly this block, between two marker comments).
It shows `records` (the running timer), a **reverse reference** from the file to its note (`h.ref`; the note does not list its files, so nothing computes a file's id from the other side), `h.skip` for rows that are no user data (an unknown key of the key-value store, an empty JSON) and for the language row (a preference in IndexedDB cannot stay there: it is reset, and the person's question counts it as one entry that is not taken over), and an id with an ending that only the file side builds. Nothing a person made is skipped: an attachment whose note is gone is copied with `note: null`, a timer of a deleted project without a project.

```js
const result = await store.migrateLocal({
  id: "zeitnotizen",
  indexedDB: { name: "zeitnotizen", stores: ["notes", "files", "meta"] },
  localStorage: { keys: ["zeitnotizen.daten"] },
  map(old, h) {
    const DATA = "zeitnotizen.daten";                   // projects and time entries: one JSON text in localStorage
    const data = old.json(DATA) || {};
    const projects = Array.isArray(data.projects) ? data.projects : [], entries = Array.isArray(data.entries) ? data.entries : [];
    const pid = (n) => h.id("p" + n), eid = (n) => h.id("e" + n);    // two counters in one JSON text: "p" and "e" keep their ids apart
    const known = new Set(projects.map((p) => p.id));
    const meta = {};                                    // the key-value store: the timer is data, every other row is skipped
    for (const row of old.rows("meta")) {
      if (row.key === "timer") meta.timer = row;
      else h.skip(row, row.key === "lang" ? "language: reset, the new app keeps it in localStorage" : "not a setting of the new app");
    }
    const ending = (name) => (/\.[A-Za-z0-9]{1,8}$/.exec(String(name)) || [""])[0];   // nothing refers to the id of a file, so its id may use the name

    const items = [];
    if (!projects.length && !entries.length && old.local[DATA] !== undefined) h.skip(DATA, "no projects and no entries");
    projects.forEach((p, i) => items.push({ col: projectsCol, id: pid(p.id), from: DATA,
      value: { id: pid(p.id), name: String(p.name || ""), color: i, archived: false, created: 0 } }));
    entries.forEach((e) => items.push({ col: timeCol, id: eid(e.id), from: DATA,
      value: { id: eid(e.id), project: known.has(e.project) ? pid(e.project) : null, date: String(e.date), minutes: Number(e.minutes) || 0, desc: String(e.desc || ""), start: null, created: h.created(e.date) || 0 } }));
    for (const row of old.rows("notes")) {
      const n = row.value, made = h.created(n.created) || 0;
      items.push({ col: notesCol, id: h.id(row.key), from: row, created: h.created(n.created),
        value: { id: h.id(row.key), title: String(n.title || ""), text: String(n.text || ""), tags: Array.isArray(n.tags) ? n.tags.map(String) : [], project: null, created: made, updated: made } });
    }
    for (const row of old.rows("files")) {
      const f = row.value, note = h.ref("notes", f.noteId);              // the id that the note side computes; null when the note is gone: the file is kept, it just belongs to no note
      const blob = h.blob(f);
      items.push({ col: filesCol, id: h.id(row.key, ending(f.name)), from: row, value: blob, mime: blob.type || "application/octet-stream",
        meta: { note, name: String(f.name).slice(0, 100), mime: (blob.type || "application/octet-stream").slice(0, 80), size: blob.size } });
    }

    const records = [], t = meta.timer && meta.timer.value;
    if (t) records.push({ name: "timer", from: meta.timer, value: { project: known.has(t.project) ? pid(t.project) : null, desc: String(t.desc || ""), start: Number(t.start) } });   // a timer of a deleted project keeps running, without a project
    return { items, records };
  },
});
```

### What your app does with the result

`store.migrateLocal` resolves with `{ status, deleted?, copies?, why? }` and shows the person a notice of its own (a toast with the key `migration`; it cannot be switched off). It rejects only for wrong options (`UsageError`, before anything is read) and when the person cancels the unlock dialog (`err.code === "cancelled"`).
Everything else, including a mistake in `map` or in one person's data, a lost connection, a full vault and a lock in the middle, is a `failed` result with the old data kept. In every case the app **loads normally afterwards**:

| `status` | Meaning | What the app does |
|---|---|---|
| `nothing` | No old data in this browser (or none left). No dialog, no request. | Load. |
| `busy` | Another tab of the app is taking the data over right now. | Load. What the other tab copies arrives with the next refresh. |
| `skipped` | The vault is a member's (`why: "not-owner"`). The old data is untouched; the library showed a notice with a backup button. | Load. |
| `declined` | The person chose "Not now", pressed Escape or closed the dialog. Nothing was written. | Load. The question comes again at the next start. |
| `partial` | Old data stays: entries that did not fit and the person kept the old data. | Load. The question comes again at the next start. |
| `failed` | Nothing was deleted. `why` is an English sentence for you (the rows that were neither copied nor skipped, a reference to nothing, offline, quota, "the old data changed while it was read"). | Load; log `why` for yourself. A locked vault gives `why` starting with "locked". |
| `migrated` | The entries are in the vault and were read back. `deleted` is `"deleted"` (the old data is gone), `"kept"` (sandbox: it stays) or `"changed"` (the old app was used meanwhile: nothing was deleted, the rest is taken over at the next start). | Load. |

After `declined`, `partial` and `failed` the old data is still there and the app loads. A record that the app writes meanwhile (default units, a started timer) does not block the next take-over, but the old value then lands in a copy (see "Ids"): write a record only when the person changed it, and read `result.copies` if you have to merge.

```js
let migrationChecked = false;                          // once per page, not at every unlock

async function start() {                               // runs after every unlock (integration.md, section 4)
  if (!migrationChecked) {
    migrationChecked = true;
    const result = await takeOverOldData();            // the call above, in a function; nothing else of the app has read or written the vault yet
    if (result.status === "failed") console.warn("old data not taken over:", result.why);
  }
  renderList(await recipes.load());                    // the collections already contain what was taken over
}
```

## 5. What stays as it is

- Forms whose submit handler calls `preventDefault()` (integration.md, section 3). Downloads the person asks for (a CSV, an attachment, a PDF), with a note that the file is not encrypted (integration.md, section 11). Printing. Reading a file the person chose.
- The app's own screens, texts, validation and calculations. Search and filters over values the page holds in memory. Personal preferences in localStorage (integration.md, section 5).
- Remove: `localStorage` and `indexedDB` code for user data, background saves, own export of "everything" (use `exportAll`), own passphrase or login screens, "saved locally" texts, and the old code that read or deleted the old storage once the app calls `store.migrateLocal`.
- **The privacy text.** Wherever the app says what happens to the data (README, start page), it uses the sentences of integration.md, section 13, word for word. An old "your data stays on this device" is wrong now.

## 6. Test the port

Run `node tools/wds-verify.mjs <app.html> --target sandbox` (integration.md, section 17), then walk through the "Not tested" list of its report by hand: a second window, a conflict, a read-only member, lock and unlock, a modal dialog of your own that is open when the library asks something (section 7), and **the migration with old data**.

### The migration test in wds-verify (the seed block)

Put the old, local-only version of the app next to the new one (a file in a folder such as `old/`, kept in the repository) and add a `seed` block to `wds-verify.json`: the old page and the steps that type old data into it (the file of `examples/zeit-notizen` is printed with its seed in integration.md, section 12, "Writing wds-verify.json").
The run goes in this order, and every library dialog is answered when it appears, so the app needs **no step** for the migration question:

1. **The old app.** The tool opens the old page (`seed.page`), runs the seed `steps` there (a `{canary}` in a fill text becomes a unique generated value; `upload` puts a generated PNG into a file input), waits for a debounced save and takes stock of the old storage: every localStorage key and every IndexedDB store with rows.
2. **The new app** opens in the same browser context (`file://` pages share storage in Chromium, so the app finds the old data like a returning user's browser).
3. **The library's dialogs.** Unlock, "create a vault" (a generated passphrase), the access sheet (confirmed), then the migration question: the tool presses `migrate-backup` (and waits for the download) and `migrate-yes`, waits while the progress view runs, and for entries that do not fit (view `migrate-large`) downloads the files and presses `migrate-delete`. (A prompt that the app draws itself is answered by a step, for example `{"click": "#migrate-yes"}`.)
4. **The steps** of `wds-verify.json`, each after the open library dialogs have been answered. With a seed they come first; the tool then types its own canaries only into fields that are still empty.
5. **Automatic filling and button presses** (the fields, then the save buttons), a second round for fields the app emptied, then a pause for debounced saves.
6. **The reload**, the unlock dialog, the `afterReload` steps, then all checks.

What the report says: the seeded values are in the old storage ("Seed: the old app"), they are visible **after the reload and the unlock**, so they came out of the vault ("Migration: old data visible"), they appear nowhere unencrypted ("old data only encrypted": no request, console line, cookie, new storage place or download other than the library's backup and file downloads), and the old storage is empty
(mock target: "old data deleted", everything the old app stored, every key and every store with rows) or still full (sandbox target: "kept in the sandbox"). A preference key that stays in localStorage on purpose goes into `seed.keep` (`"keep": ["myapp.lang"]`), else the mock run reports it as old data that was left. Details and every finding id: `tools/README.md` in the repository, section "Testing a migration".

### Writing seed steps that prove something

- **Typed values must come back as the same text.** The tool searches for exactly what it typed, in the requests and on the screen after the reload. A field that turns the text into something else (a tag field that splits `"a, b"` into two tags, a number or date field) hides the value: the report says "old data visible 4 of 5" or "1 typed value neither shown nor written". Type one token per tag field (`{"fill": ["#tag", "tag{canary}"]}`), and put the value that must round-trip into a text field; a number field cannot carry a value of 6 characters (the minimum for a search), so a year or a count is never proven by the seed alone.
- **`upload` paths are relative to `wds-verify.json`**, not to the folder of `seed.page`: `{"upload": ["#note-file", "old/sample-old.pdf"]}` when the file lies in `old/`. Without a path the tool generates a PNG.
- **Prove that references and files arrived**, not only the texts. The tool only reads text, so make them visible: an `afterReload` step that opens the edit dialog of an entry shows the attached file name (`{"click": ":nth-match(#list .ref:has(button[data-act=\"open\"]) button[data-act=\"edit\"], 2)"}`, then `{"click": "#btn-cancel"}`). Steps take any Playwright selector: CSS, `:has()`, `:nth-match()`, `text=`, `role=`.
- **Lock, unlock, conflicts and members are not covered by the steps.** Test them by hand in the sandbox (a second window), or in your own Playwright test: `tools/lib/drive-library.mjs` answers the library's dialogs (`createVault`, `unlock`, `answerMigration`, and `redeemInvite(page, { code })` for a member who has an invite code from `store.share()`; integration.md, section 12, "Driving the library's dialogs"), against a mock (`const mock = await startMock({ bundle: true })` from `tools/lib/wds-mock.mjs`, which needs the Python of the server; `mock.createScope("myapp")`, `mock.service` is the base URL for `WDS.connect({ baseUrl })`, `await mock.stop()` at the end) or the sandbox.

### The deletion path in the sandbox: the test global

The sandbox never deletes old data, so the deletion path needs the test global. `--migration-delete` (needs a `seed`) makes wds-verify set `window.__WDS_MIGRATION_TEST__ = true` in its own browser before any script of the page runs, and the tool then expects the old storage to be empty. On the mock target it changes nothing.
**Your own automated tests may set it too**, in the browser that your test script controls (never in the app file, never in a page that a person opens):

```js
await context.addInitScript(() => { window.__WDS_MIGRATION_TEST__ = true; });   // your own Playwright context
```

The library honours the global only when `navigator.webdriver === true` (an automated browser) and only in a sandbox, and it logs one warning to the console when it does. The question of the dialog stays the sandbox's ("the old data stays in this browser"); the result says what happened (`deleted: "deleted"`). **Never write the global into the app**, not even to see the deletion by hand: wds-verify fails a file that assigns it and a page that sets it at run time.
In a real browser the old data would be deleted while its only copy is in a sandbox vault that is wiped tonight.

### The join code for tests (a real scope)

A test against the app's real scope is **optional**: `wds-verify --target sandbox --migration-delete` covers vault, migration and deletion without any code; it is worth doing for attachments larger than the sandbox allows ({{sandbox_limits}}), or when the person asks. With the enrollment "join code" a vault needs the code, a credential of the person who runs the app: never in an environment variable, a command line, the chat, a script, `wds-verify.json`, CLAUDE.md, AGENTS.md or any file in a repository. The test helper reads it from **one file that the person creates in their own terminal**, so that the code never enters the transcript:

```sh
mkdir -p ~/.wds && chmod 700 ~/.wds
(umask 077; cat > ~/.wds/join-code)        # paste the join code, press Enter, then Ctrl-D
```

The file is called `join-code` (no extension), holds plain text, is not readable by others and is not inside the repository; `WDS_JOIN_CODE_FILE` names another file (on Windows `%USERPROFILE%\.wds\join-code`), and a missing or unusable file is a `DriveError` that prints these commands. Afterwards the person deletes it (`rm ~/.wds/join-code`). **You, the agent, never read, print, copy or list that file, and never ask for the code in the chat**: say what the test is for (one test vault, to see the deletion path the sandbox never runs), give the person the commands and wait until they say the file is there. With the enrollment "open" no code is needed; with "closed" no test vault can be made: say that the deletion path was not tested against the real scope.
**Every test in a real scope ends with** `deleteVault(page, { accessId, passphrase })`. Tell the person the vault ID (`store.status().vaultId`) and the time of the test; if the vault is still listed in the dashboard (expert settings, vaults), the person deletes exactly that ID. After the run the old stores are empty, the old keys are gone (only `wds:migrate:<id>:tag` stays), the result was `migrated` with `deleted: "deleted"`, every old item is in the vault, and a second start gives `nothing`.

## 7. Checklist for apps with forms and modal dialogs

The library's dialogs (unlock after a session expired, conflict, share, the migration question) are modal `<dialog>` elements in the browser's top layer: they open **above** the modal dialogs of your own app, and the page below them is inert while they are open. Check these points; wds-verify cannot, because it creates no conflicts.

1. **Close your own modal dialogs in `store.onLock` and open none while a store call is pending** (integration.md, section 4; select them with `dialog:not(.wds-dialog)`).
2. **Keep the typed values when a save fails** (`OfflineError`, `QuotaError`): the form stays open with what the person typed. **Disable the save button while a write is in flight** and enable it again in `finally`. After `resolution === "theirs"` the vault holds the other side's value and the library knows that version: show `res.value`, keep the typed text in the form and say that the other version was saved first; if the person saves again, the text is written on top of it (no dialog; the other version stays in the history).

```js
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = readForm(form);                       // the typed values stay in the form until the save worked
  saveButton.disabled = true;                          // no second save while one is in flight
  try {
    const res = await recipes.set(id, values);
    if (res.resolution === "theirs") showSaved(res.value, "Someone saved this entry meanwhile. Save again to replace it with your text.");   // the form stays open, the typed text stays
    else { closeForm(); showSaved(values); }
  } catch (err) {
    showError(err);                                    // OfflineError, QuotaError, ...: the form stays open with what the person typed
  } finally {
    saveButton.disabled = false;
  }
});
```

3. **Open a file from the vault in a new tab inside the click** (integration.md, section 6, "Files").
4. **The app's own notices live inside its dialogs.** A fixed-position element of the page (a `#toast` with `z-index: 20`) lies **under** a modal dialog: a "please enter a title" message would be invisible while the dialog is open. Put validation and error messages inside the dialog (`#form-error`), or make the notice a `popover="manual"` element, and keep the page's own toast for messages that are shown while no dialog is open.
5. **Never reload an item that is open in a form**: a `get` or a reload on `onChange`/`onStale` adopts the newest version and the save will not see the conflict; reload after the form is closed.
