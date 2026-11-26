# Porting an existing app to WIAI Datastore

You port an app that exists already: it keeps its screens and its logic, and what changes is where its data lives. This page is the guide for that, with code that was run in Chromium, Firefox and WebKit
against the real server (examples/docs-recipes.spec.mjs). The script tag, the Content-Security-Policy and the API are in [integration.md]({{base}}/docs/integration.md); read its sections 2 to 7 first.
Work through the sections here in order:

1. Inventory: what the old app stores, and where it goes.
2. Replace the storage calls.
3. Own export and import (for people who move their data by file).
4. Data that is still in the browsers of existing users: `store.migrateLocal`, one call instead of a recipe.
5. What stays as it is.
6. Test the port, including the migration, with wds-verify and with your own tests.
7. Checklist for apps with forms and modal dialogs.

Units: 1 MB = 1,048,576 bytes everywhere in these pages (KB = 1024 bytes, GB = 2^30 bytes). The scope document gives exact bytes, for example `max_value_bytes` 10485760 for 10 MB.

## 1. Inventory

Find every place where the app keeps or reads data that outlives the page: `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, the Cache API, file handles, `fetch` to a server of its own, and its own export and import (a JSON or CSV file).
For each, write down what kind of entity it holds, how many there are, how large they get, and who changes them. Then map each kind:

| What the app has | In the datastore |
|---|---|
| A list of things: notes, entries, projects, students | A **collection**: `store.collection("notes/", { meta })`, one record per thing (integration.md, section 6) |
| A single small thing: settings, the running timer, a draft | One record: `store.set("settings", …)` and `store.get("settings")`; a draft or editor through `autosave` |
| Files: images, PDFs, attachments | A second collection of bytes, ending in the id (`"files/"`, ids like `a1b2c3-report.pdf`); the owning item or the meta says which item the file belongs to |
| References between things | The other thing's id inside the value (or the meta) |
| Computed data (totals, search results, week tables) | Not stored: compute it from the records |

Sources that `store.migrateLocal` does **not** take over: `sessionStorage`, cookies, the Cache API, the Origin Private File System, file handles and every IndexedDB database or localStorage key that you do not name in its options.
What the old app kept there is lost for the person when it is no longer written, or stays unencrypted in the browser for ever. If it matters, the old version needs an export button (section 3) that the person uses before the update.

## 2. Replace the storage calls

| Before | After |
|---|---|
| Read everything at start | `await store.unlock()` (or `onUnlock`), then `await col.load()` for the list, `col.getAll()` when every value is needed, `col.get(id)` when one is opened |
| Save after an edit | `col.autosave(id, () => item)` and `saver.changed()` for editors, `col.set(id, item)` for button saves, `col.add(item)` for new items |
| Delete | `await col.remove(id)`; check the result (integration.md, section 4) |
| "Save as backup" / JSON export of everything | `store.exportAll()` |
| Import of the old file format | keep it (section 3) |
| A save on `beforeunload` or `visibilitychange` | remove it: the library warns before closing and saves on lock |
| A "saved" label | the autosave `onStatus` (never show "saved" before the write returned) |

The app now needs the vault to be open before it shows data: register `store.onLock` and `store.onUnlock` once and build the screen in `start` (integration.md, section 4, "Lock and unlock again").
An app with one language (only German, say) calls `store.setLocale("de")` once right after `WDS.connect`, so that its texts and the library's dialogs speak the same language whatever the browser says. An app with a language switch calls it at start and on every change.

### Details that ports ask about

- **Results.** `col.set(id, value, opts)` resolves like `store.set`: `{ name, version, size, resolution, value?, deleted? }`; `col.add(value, opts)` resolves `{ id, name, version, resolution }`; `col.remove(id)` resolves like `store.remove`: `{ name, deleted, resolution, value? }`. `resolution` is `saved`, `mine`, `theirs` or `merged` (for `remove`: `deleted`, `absent`, `mine`, `theirs`).
- **`onChange`.** The payload is `{ items, added, removed, changed }`: `items` is the whole list (`{ id, name, meta, created }`), and `added`, `removed` and `changed` are **arrays of id strings** (`changed`: the ids whose meta changed). It fires for other devices, `refresh()` and repairs, never for your own calls.
- **`load()`.** Only `items()` and `has()` need `await col.load()` first; `get`, `getAll`, `set`, `add` and `remove` load the list themselves.
- **A settings record.** Read it once at start (`await store.get("settings")`), then save it with `store.autosave("settings", () => state)`: the library writes on top of the version it has read. Without the read, the first save of a record the page does not know is a conflict if the record exists (`store.set` does the same).
- **`label`.** `label(name)` of `WDS.connect` gets the record name, `"recipes/<id>"` for a collection item: look the title up in `col.items()` (the meta) or keep a Map from name to title.
- **A save that creates or replaces a file together with an entry.** Write the new file first, then the entry that names it, then remove the old file, and take the new file away again when the entry write loses with `theirs` or fails: the recipe is in integration.md, section 6, "Files" ("Save a note that gets a new or replaced attachment").
- **After `resolution === "theirs"`.** The vault holds the other side's value, and the library now knows that version: show `res.value`, keep the typed text in the form and say that the other version was saved first. If the person presses Save again the text is written on top of it (no dialog; the other version stays in the history):

  ```js
  const res = await recipes.set(id, typed);
  if (res.resolution === "theirs") showOther(res.value, "Someone saved this entry meanwhile. Save again to replace it with your text.");   // the form stays open, the typed text stays
  ```
- **Small decisions that are yours, and cheap to write down.** Migrated items keep the order of their old `created` date (`h.created`): sort by what a person sees (a date field of your own), not by id. A filter or search text that the app saves in `settings` comes back after every reload: reset it at start unless that is wanted, or do not take it over: a field that `map` leaves out of `settings` is not copied (Example 1 leaves out `search`; a person made nothing in it). An app that does restore its filter needs an `afterReload` reset in its test (section 6). When the scope has the breach check on (the dashboard prompt and wds-verify say so), the privacy text carries the second sentence of section 5; an app whose scope is not registered yet carries it too, and `wds-verify` says whether it was needed once the scope exists.

## 3. Own export and import

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

That variant gives every note a new random id, so references between items are lost and a second import of the same file makes copies. An app whose items refer to each other (a PDF belongs to a note by its number, the old ids are counters) keeps the old ids and rewrites every reference through the same function:
a second import then overwrites instead of doubling, `created` keeps the old order of the list (it counts for an id that the list does not have yet), and the ids are the ones that section 4 builds with `tagged: false` (`h.id(12)` gives `j12`, `h.id("a b")` gives `sa%20b`), so data that arrives once by this import and once by the migration of another browser is one copy, not two.
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

## 4. Data that is still in the browsers of existing users

Existing users have data in IndexedDB or localStorage. Dropping it would lose it, and leaving it there would keep unencrypted data on the device for ever. The rule "no user data in IndexedDB or localStorage" means the app never **stores** data there.
**Reading the old data once, writing it into the vault and deleting it afterwards is the intended way, and the library does it:** one call, `store.migrateLocal`, with an options object of 10 to 30 lines. The app does not touch `indexedDB` or `localStorage` itself.
(Do not copy code from older versions of these pages: there is no recipe to adapt any more, and wds-verify warns about an app that reads or deletes old storage by hand.)

What the library does, in this order, and what the person sees:

1. It looks at the old storage (read only). Nothing there: it returns `nothing` without any dialog or request. Another tab is already doing the job: `busy`. The vault of a member (not the owner): `skipped` with a notice.
   The library reads the old data only after the unlock and the check of the role, so a start that has nothing to do reads no files.
2. It asks once, in a dialog of its own (German or English, like the other dialogs): how many entries were found, into which vault (the last four characters of its access ID) they are copied, and that the old data is deleted afterwards. There is a button to download a backup (a ZIP with the entries and their files, not encrypted), a button "Not now" and, small and last, "Do not take over; delete the old data" (it asks once more; status `discarded`). When `map` leaves rows out with `h.skip`, the question says how many are deleted with the rest, and "Take over" waits until the person ticks a box or has downloaded the backup. When there is nothing to copy but settings, it asks nothing.
3. It copies with create-only writes (it never overwrites anything in the vault), writes the list of every collection, reads everything back and compares it byte for byte.
4. It writes a marker record into the vault and only then deletes the old rows: it reads them again first, and one changed row (a file of the same size with other bytes, say) means nothing is deleted. In a sandbox the old data is kept.
5. A toast tells the person what happened. `store.migrateLocal` resolves with a result object (below).

### Before you call it

- **The new app must be opened from the same place as the old one.** A page reads only the storage of its own origin. An app served over `http(s)` needs the same scheme, host and port (the path does not matter). A file opened from disk depends on the browser: Chromium shares localStorage and IndexedDB between all `file://` pages,
  Firefox and Safari give every file its own storage. So replace the old file in place (**same folder, same file name**, the same URL) and tell the users to open the new version the way they opened the old one. A new file with another name or path finds `nothing` in Firefox and Safari, and the old data stays there.
  wds-verify runs Chromium and opens the old page and the new app in one browser, so it cannot show this problem; its "Not tested" list names it when a `seed` is present.
- **Only the owner of a vault takes data over.** A member's vault is not the place for someone else's old data: the old data is private to this browser and would be copied into a vault that others read. A member gets `status: "skipped"`, a notice with a backup button (once per page; once the person dismissed it, not again in this browser) and the old data stays where it is.
  The way for a member: export in the old version, and the owner imports that file (section 3), or the member creates a vault of their own.
- **Call it once per page, in `start`, before you load or write anything of your own** (see "What your app does with the result"). Settings of the old app are filled in only where the vault has no value yet, so a start that first writes defaults of its own leaves less to fill.
- **Try it with test data, in a fresh browser profile.** A person who tries the port by hand in the browser that holds their real old data moves that data into a vault that they may call a test and delete later in the dashboard, and the library deletes the old data from that browser (that is its job). Use wds-verify with a `seed` (section 6), or a new browser profile into which you put test data.

### The call

```js
const result = await store.migrateLocal({
  id: "cookbook",                                           // names this migration: 1 to 40 characters of a-z, 0-9 and "-"
  indexedDB: { name: "cookbook", stores: ["recipes", "images"] },   // optional: one object or an array; only these stores are read and emptied
  localStorage: { keys: ["cookbook.prefs"], prefixes: [] },   // optional; a prefix matches with startsWith
  tagged: true,                                             // optional, default true: see "Ids"
  map(old, h) { /* section "map" below */ },                // required; may be async
  texts: { de: { "migrate.title": "Alte Daten übernehmen" } },   // optional: your own words for single dialog texts
});
```

| Option | Meaning |
|---|---|
| `id` | Names the migration. It is part of the lock name, of the tag key in localStorage and of the marker record in the vault. Use the app's name. |
| `indexedDB` | The old database and the stores to take over. Databases are opened without creating them (a missing one is simply empty) and only the listed stores are read and emptied; the database itself is never deleted. Two databases may have a store of the same name: then `old.rows` needs `"db/store"`. |
| `localStorage` | `keys` and `prefixes` of the old keys. Keys of the library (starting with `wds:`) are never read or removed; an empty prefix or one starting with `wds:` is a `UsageError`. |
| `tagged` | `true` (default): ids start with the tag of this browser. `false`: natural ids such as `j12`. Decide by the old ids (section "Ids"). |
| `map(old, h)` | Turns the old rows into entries of your collections and records (below). Pure: same input, same output. |
| `texts` | Overrides single texts of the migration dialogs, per language (`{ de: {…}, en: {…} }`) or flat (`{ "migrate.yes": "…" }`). Keys: `migrate.title`, `.question` (with `{count}` and `{vault}`), `.question.sandbox`, `.question.large`, `.question.skipped`, `.skip.ack` (with `{n}`), `.question.none`, `.question.later`, `.backup`, `.backup.short`, `.backup.hint`, `.backup.nofiles`, `.backup.failed`, `.backup.none`, `.yes`, `.no`, `.discard`, `.discard.title`, `.discard.text`, `.discard.text.sandbox`, `.discard.back`, `.discard.confirm`, `.progress`, `.progress.check`, `.differs.title`, `.differs.text`, `.differs.keepVault`, `.differs.keepBoth`, `.differs.later`, `.differs.hint`, `.large.title`, `.large.text`, `.large.download`, `.large.ack`, `.large.delete`, `.large.keep`, `.done.deleted`, `.done.kept`, `.done.changed`, `.done.again`, `.done.discarded`, `.done.discarded.kept`, `.done.settings`, `.done.settings.kept`, `.partial`, `.partial.differs`, `.failed`, `.skipped`. Never promise in a text that the data is safe: the library's own texts say what happens. |

A mistake in the options (a missing `id`, an unknown option, a source that is not named) is a `UsageError` before anything is read. The collections that `map` writes into must be created with `store.collection` before the call.

### map(old, h)

`old` is a picture of the old storage, built before `map` runs. `map` gets **copies** of the rows (objects, arrays, Maps, Sets and Dates are copied; a Blob, File or binary buffer is shared, so never change its bytes): you may change what you are given, also in a classic script, and the old rows are never touched.

| `old` | |
|---|---|
| `old.rows("recipes")` | `[{ key, value }]` of that IndexedDB store, in key order; the store name, or `"db/store"` when two databases have a store of that name; `[]` when the database or store does not exist. A key-value store (`put(value, key)`) has the same shape. |
| `old.local` | `{ key: text }` of every configured key and prefix match that exists, the strings as localStorage holds them. |
| `old.keys(prefix)` | The keys of `old.local` (starting with `prefix`). |
| `old.json(key)` | `JSON.parse` of one key; `undefined` when the key does not exist; an error that names the key when the text is not JSON. |

`h` are the helpers. They are pure and give the same answer every time:

| `h` | |
|---|---|
| `h.id(oldKey, ending)` | The id of an entry for an old key (section "Ids"). `ending` is optional and looks like `".pdf"` (a dot and 1 to 8 letters or digits). |
| `h.ref(storeName, oldKey, ending)` | The id of the entry that the row with `oldKey` in `storeName` becomes: use it for **references**. `null` when that row does not exist (a dead reference becomes `null`), and `null` for a missing key. |
| `h.blob(value, field)` | A `Blob` from the row value: the value itself when it is a Blob or File, else `value.blob`, `value.data` (an ArrayBuffer or typed array) or a `data:` URL string. With `field`: `value[field]`. Anything else stops the run (a field called `pdf` is not guessed: pass its name). |
| `h.created(x)` | Milliseconds from a Date, a number or a date string; `undefined` otherwise. For `created` below. |
| `h.skip(rowOrKey, why)` | Leaves a row out **on purpose**. **A skipped row is deleted with the rest of the old data and never reaches the vault** (only the backup has it). Use it for rows that are no user data (a cache, a version marker), never for something a person made: copy an attachment whose note is gone with `note: null`, a timer of a deleted project without the project. The question tells the person how many rows are deleted, and "Take over" waits for a confirmation (a box, or the backup download). |
| `h.fail(rowOrKey, why)` | Stops the run for a row that cannot be mapped: nothing is written, nothing is deleted, the result is `failed` and `why` names the row. |

`map` returns an object; every field is optional and every unknown field is an error:

| Field | Written as | Entry |
|---|---|---|
| `items` | `col.set(id, value, { meta, created, mime })` | `{ col, id, value, meta?, created?, mime?, from }`: `value` is a Blob, a File or binary data (stored as bytes) or JSON. `id` is 1 to 200 characters without `/` (use `h.id`). **`mime`** is the type that `store.getBlob` gives back, and it counts only for bytes (a JSON value ignores it). Without `mime`, the `type` of the Blob or File is stored, so `value: h.blob(row.value)` of a File of type `image/jpeg` needs none; `h.blob` of a row `{ data, type }` gives a Blob of that `type`, and one of a `data:` URL the type of the URL. A Blob without a type, or a typed array or ArrayBuffer you pass as the value, is stored without a type and `getBlob` returns `application/octet-stream`: give `mime` then, or to override a type that is wrong. The type is no part of the check against the vault (the bytes are), but a `map` that changes only the `mime` field counts as a corrected `map` (below; the type of a Blob that has no `mime` field is not compared). |
| `records` | `store.set(name, value, { mime })` | `{ name, value, mime?, from }` for single records such as a timer. The name must not be inside the prefix of a collection, nor start with `.wds/`. |
| `settings` | filled into one record | `{ record, value, from }`: `value` is a JSON object of old settings. The library adds the keys that the vault's record lacks (see `WDS.fillGaps` below) and never overwrites one; it retries, and asks nothing. What the vault already has, and every field of the old JSON that `map` does not return, is **not kept**: it is deleted with the old key and exists only in the backup. |

- **`from` is required on every entry**: the row object that `old.rows()` gave you, a localStorage key (a string), or an array of them (an entry that is made from several rows). Every row of every configured store and every localStorage key that matches must be claimed by some entry's `from` or by `h.skip`.
  If one is neither, the run stops (`failed`, "N old row(s) were neither copied nor skipped: …") and **nothing is deleted**. This is what protects the person's data from a `filter` that drops rows, a store you forgot to map, or the rows of another app in the same origin. A key that is configured but does not exist in this browser may be named in `from`; it claims nothing.
- **`map` runs twice and both results must be identical** (same ids, same JSON). Ids come from `h.id`, never from `crypto.randomUUID()`, `Math.random()` or the clock (`Date.now()`, `new Date()` without an argument); otherwise the run fails (`failed`, `why` says so). An interrupted run could not continue with random ids: it would copy everything again.
- A JSON value must not contain a Blob, a typed array, a Map or a Set: JSON would write them as `{}`. Make the file its own item (`h.blob`) and refer to it by id. BigInt and cyclic values stop the run. Dates become ISO strings. A JSON value larger than `max_value_bytes` is "too large" (below).
- Every id and every name is checked before the first write (length, `/`, duplicates inside one run, a collection that is not of this store, a record inside a collection's prefix). Every `h.ref` result must be the id of an item of the same run, else the run stops.
- `map` may build new objects (`{ ...v, photos }`) or change the copies it was given (`v.cover = h.ref(...)`); the old rows are not affected either way.
- **A mistake in `map`, or in one person's data, is a `failed` result, never a rejection**: a missing `from`, an id with `/`, an unknown store in `old.rows`, a `created` that is not a number, an `old.json` of a damaged key. The page must still start for that person, so the library writes the message with `console.error`, shows the notice with the backup button, deletes nothing and returns `{ status: "failed", why }`. Only wrong options reject (before anything is read).
- **A damaged value** (a localStorage text that is no JSON): `old.json(key)` fails the run, the old data stays and the person can download the backup. To let the person go on anyway, read `old.local[key]` yourself and copy the text unchanged into a record (`records: [{ name: "damaged-settings", value: { text: old.local[key] }, from: key }]`): the data goes into the vault instead of being dropped.
- **A corrected `map`.** The marker remembers, per entry, what `map` made of it. An entry that `map` now makes differently is new again (it goes through the check against the vault; the entries that differ are offered as "Entries that differ"); one that it makes the same way is done. When you test a corrected `map` in the sandbox (which keeps the old data), the first run's entries are already in the vault: use a new `id`, a fresh browser profile or wait for the nightly wipe. The library prints a console warning when it finds a marker.
- `meta` is at most 512 bytes of JSON (the rule of the collections). `created` is a number of milliseconds that only decides the order of the list (integration.md, section 6, "set and created").
- `WDS.fillGaps(current, old)` is the rule for `settings` as a static helper: a copy of `current` plus each key of `old` that is **absent** (`undefined`) in `current`. `null`, `""`, `0` and `false` are values: a setting the person cleared does not come back.

### Ids

An old key becomes the id of an entry: `h.id(oldKey)` is `<tag>-<token>` with `tagged: true` and `<token>` alone with `tagged: false`. The token is `s` plus the URL-encoded string for a string key (`"a/b"` gives `sa%2Fb`), `b` plus hex for a binary key and `j` plus the URL-encoded JSON text for everything else (the number 12 gives `j12`).
Different keys never give the same id (1 and "1", "a/b" and "a_b"), an id never contains `/`, and one longer than 200 characters is cut (the first 180 characters, `~` and a hash). The ending is appended: `h.id(7, ".pdf")` is `<tag>-j7.pdf`.
**An id that two sides compute must be computed with the same call.** A reference gets its target's id from `h.ref("images", p.image, ".jpg")`; the target gets it from `h.id(row.key, ".jpg")`. If the reference side does not know the file name (the usual case: the entry holds only the key of its image),
use a fixed ending on both sides (`".jpg"`: the old app saved every photo as JPEG); `h.ref` returns `null` when the target row is gone, so a dead reference never reaches the vault.

**Do you need the tag in the item ids? Decide by the old ids.**

| The old ids are | Choose | Why |
|---|---|---|
| counters, short or typed by people (`1`, `"settings"`, a title) | `tagged: true` (the default) | the same id in two browsers means two different things; without the tag they would overwrite each other |
| random and long enough that two different items never share one (a UUID; eight random hex characters are fine for some hundred items, not for thousands) | `tagged: false` is possible | the item ids stay short and the code that reads them needs no change except for the `%` of an encoded key; the marker and the tag stay per browser |

The tag is 8 random hex characters per browser and migration, kept in the old localStorage under `wds:migrate:<id>:tag` (the one write the library makes there; it stays after the old data is deleted, because it names this browser's marker in the vault).
The two choices fail differently when the same data reached two browsers (the person exported and imported it, or copied the profile) and both are migrated. **With the tag you get duplicates**: every item exists twice, once per tag. Nothing is lost and nothing is overwritten, the person deletes the copies.
**Without the tag you can get items that differ**: the second browser finds the ids in the vault. Identical items count as copied (one item remains). Items that differ are never overwritten: the person is asked (below, "Entries that differ"). When in doubt, keep the tag: duplicates cost a click, a conflict stops a migration.

**The new ids contain `-` and `%`** (`<tag>-j12`, `<tag>-sa%2Fb`; a file keeps its ending, `<tag>-j7.pdf`; without the tag `j12` and `sa%2Fb`). Code that splits an id at `-`, takes the part before it as the "real" id, reads a number out of it or builds a file name from it must be checked and changed before the first migrated item is shown: take the whole id, and look the rest up in the meta.
The same holds wherever an id goes into something with a syntax of its own: `querySelector("#item-" + id)` and other CSS selectors (use `CSS.escape(id)`, or keep the id in `data-id` and read `dataset.id`), `id="…"` attributes, `location.hash` routes (the browser may rewrite `%3A`: use `encodeURIComponent`),
and arithmetic on ids (`Number(id)` sorts, a counter `nextId = max + 1` gives `NaN` once a migrated id is in the list; the old app of a port read ids with `+dataset.id` and sorted with `b.id - a.id`: both broke).

**Two stores with the same keys** (notes 1, 2, 3 and todos 1, 2, 3) that go into **one** collection give the same id twice: the run stops (`failed`, "two entries would get the same name"). Use one collection per store, or put the store into the key on both sides: `h.id(["notes", row.key])` for the item and for every reference to it (`h.ref` builds `h.id(oldKey)` only, so write such a reference yourself with the same `h.id` call).

### Example 1: string keys, a list of photos inside a recipe, references in both directions, settings in localStorage

The old "Cookbook": the IndexedDB database `cookbook` with the store `recipes` (keys are the names that the person gave: `"apple-pie"`, `"Tarte Tatin"`; values `{ title, portions, steps: [text], photos: [{ image, caption }], saved }`, where `image` is the key of a row in `images` and `saved` an ISO date)
and the store `images` (keys `"img-1"`, `"img-2"`; each value is a `File`; the old app re-encoded every upload as JPEG), and one localStorage key `cookbook.prefs` with `{ units, view, search }`.
In the new app a recipe lists its photos (`photos: [{ image: <id of the image>, caption }]`) and the image's meta points back (`recipe`). Both sides compute the image's id with the same call and the same fixed ending `".jpg"` (the recipe side does not know the file name);
a photo whose image row is gone keeps its caption and gets `image: null`. Example 2 shows the other shape, where only the file points to its owner. Run against the real server with a seeded old database, this block is part of the repository's tests.

```js
const recipes = store.collection("recipes/", { meta: (r) => ({ title: String(r.title || "").slice(0, 80) }) });
const images = store.collection("images/");

const result = await store.migrateLocal({
  id: "cookbook",
  indexedDB: { name: "cookbook", stores: ["recipes", "images"] },
  localStorage: { keys: ["cookbook.prefs"] },
  map(old, h) {
    const photosOf = (v) => (v && Array.isArray(v.photos) ? v.photos : []);
    const owner = new Map();                            // old image key -> id of the recipe that shows it: the other direction, for the image's meta
    for (const row of old.rows("recipes")) for (const p of photosOf(row.value)) if (!owner.has(p.image)) owner.set(p.image, h.id(row.key));
    const items = old.rows("recipes").map((row) => {
      const v = row.value;
      if (!v || typeof v.title !== "string") h.fail(row, "not a recipe with a title");
      const photos = photosOf(v).map((p) => ({ image: h.ref("images", p.image, ".jpg"), caption: String(p.caption || "") }));   // the id that the image side computes below; null when the image row is gone
      return { col: recipes, id: h.id(row.key), from: row, created: h.created(v.saved),
        value: { title: v.title, portions: Number(v.portions) || 1, steps: Array.isArray(v.steps) ? v.steps.map(String) : [], photos } };
    });
    for (const row of old.rows("images")) {
      items.push({ col: images, id: h.id(row.key, ".jpg"), from: row, value: h.blob(row.value),   // the value is a File: h.blob gives it back as it is, with its type; no mime here, so the type is kept (image/jpeg)
        meta: { name: String(row.value.name || "photo.jpg").slice(0, 100), ...(owner.has(row.key) ? { recipe: owner.get(row.key) } : {}) } });
    }
    const prefs = old.json("cookbook.prefs") || {};
    return { items, settings: { record: "settings", from: "cookbook.prefs",
      value: { units: prefs.units, view: prefs.view } } };   // prefs.search is left out on purpose: the new app starts with an empty search (section 2); a field that map does not return is deleted with the old key and exists only in the backup
  },
});
```


### Example 2: a localStorage JSON, notes, files and a key-value store

The example app `examples/zeit-notizen` has a local-only predecessor in `examples/zeit-notizen/old/index.html`: projects and time entries as one JSON text in the localStorage key `zeitnotizen.daten` (two counters, so `p1` and `e1` keep their ids apart), notes with auto-increment ids in the IndexedDB database `zeitnotizen`,
attachments with a File and the id of their note, and a key-value store `meta` with the rows `timer` and `lang`. This is the code of the example app (the field names of its records; the file `index.html` holds exactly this block, between two marker comments).
It shows `records` (the running timer), `settings` (the language, filled in only where the vault has none), a **reverse reference**, from the file to its note (`h.ref`; the note does not list its files, so nothing computes a file's id from the other side), `h.skip` for rows that are no user data (an unknown key of the key-value store, an empty JSON), and an id with an ending that only the file side builds. Nothing a person made is skipped: an attachment whose note is gone is copied with `note: null`, a timer of a deleted project without a project.

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
    const meta = {};                                    // the key-value store: "timer" and "lang"
    for (const row of old.rows("meta")) { if (row.key === "timer" || row.key === "lang") meta[row.key] = row; else h.skip(row, "not a setting of the new app"); }
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
    const settings = meta.lang ? { record: "settings", from: meta.lang, value: { lang: meta.lang.value === "en" ? "en" : "de" } } : undefined;
    return { items, records, settings };
  },
});
```

### What your app does with the result

`store.migrateLocal` resolves with `{ status, sandbox, deleted?, copied?, total?, tooLarge?, differs?, why?, again? }` and shows the person a notice of its own (a toast with the key `migration`; connect with `notify: false` and show your own sentence instead). Every notice that leaves the old data in place has a button "Download a backup"; the result has a (not enumerable) method `downloadBackup()` that does the same, for an app with `notify: false`. It rejects only for wrong options (`UsageError`, before anything is read) and when the person cancels the unlock dialog (`err.code === "cancelled"`).
Everything else, including a mistake in `map` or in one person's data, a lost connection, a full vault and a lock in the middle, is a `failed` result with the old data kept. In every case the app **loads normally afterwards**:

| `status` | Meaning | What the app does |
|---|---|---|
| `nothing` | No old data in this browser (or none left). No dialog, no request. | Load. |
| `busy` | Another tab of the app is taking the data over right now. | Load. What the other tab copies arrives with the next refresh. |
| `skipped` | The vault is a member's (`why: "not-owner"`). The old data is untouched; the library showed a notice with a backup button. | Load. |
| `discarded` | The person chose "Do not take over; delete the old data" and confirmed. Nothing was written to the vault; `deleted` says whether the old data is gone (`"kept"` in a sandbox). | Load. |
| `declined` | The person chose "Not now", pressed Escape or closed the dialog. Nothing was written. | Load. The question comes again at the next start. |
| `partial` | Old data stays: entries that did not fit were left out (`tooLarge: [{ name, size, why }]`) and the person chose to keep the old data, or entries differ from the vault and are not decided (`why: "differs"`, `differs: [names]`). `copied` and `total` say how many entries were written. | Load. The question comes again at the next start. |
| `failed` | Nothing was deleted. `why` is an English sentence for you (the rows that were neither copied nor skipped, a reference to nothing, offline, quota, "the old data changed while it was read"). | Load; log `why` for yourself. A locked vault gives `why` starting with "locked". |
| `migrated` | The entries are in the vault and were read back. `deleted` is `"deleted"` (the old data is gone), `"kept"` (sandbox: it stays), or `"changed"` (the old app was used meanwhile: nothing was deleted, the rest is taken over at the next start). `again: true` means that no copy was needed and only the delete was repeated. | Load. |

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

### What the person sees

- **The question** (view `migrate`): "This browser holds 4 entries from an earlier version of this app. They are unencrypted and exist only on this device. Copy them into your vault (access ID ending in …) and then delete them from this browser? Deleting cannot be undone."
  With the buttons "Take over", "Download a backup (not encrypted)" and "Not now", and the small "Do not take over; delete the old data" (a second view `migrate-discard` asks for confirmation). In a sandbox it says that the old data stays. Rows that `h.skip` left out are counted ("N entries are not taken over because the app does not use them. They are deleted with the rest of the old data") and "Take over" stays disabled until the box "I do not need these N entries" is ticked or the backup was downloaded. Entries that do not fit are named ("N of them cannot be copied into the vault; you get them as downloads").
  A person who chooses "Not now" keeps unencrypted data in the browser and is asked again at the next start; the dialog says so.
- **Progress** (view `progress`, no buttons): "Taking over: 3 of 4", then "Checking the copy".
- **Entries that differ** (view `migrate-differs`): the vault already holds an entry with the same id and other content (the second browser of the same person with `tagged: false`, an item changed in the new app before the question was answered). The library never overwrites it. The person chooses: keep the versions in the vault, keep both (the old version is added as `<id>~<tag>`), or decide later (nothing is deleted).
- **Too large** (view `migrate-large`): entries above the limit for one value (`max_value_bytes`, from `store.usage()`) and, when the vault is too full, the largest entries do not go into the vault. They are listed with one download button each, and the old data can be deleted only after every download was used or a box "I have saved the files or do not need them" is ticked.
  "Keep the old data" (or Escape) ends with `partial` and the old data stays. References from copied entries to a left-out entry become `null` before anything is written. Never an unanswerable "does not fit": the person always gets the files.
- **The backup** is a ZIP file `<id>-old-data-<yyyy-mm-dd>.zip` with `data.json` (every old row; Blobs listed with size, type and name) and the files under `files/`. It is not encrypted and works without the vault. When the files do not fit into one ZIP file the data file and every file are saved as separate downloads, and the dialog says so. A download that the person asks for is allowed by the rules of integration.md, section 11.
- **The notice** afterwards says how many entries are in the vault and whether the old data was deleted.

All dialogs are modal `<dialog>` elements in the top layer: they appear above a modal dialog of your own (section 7).

### Safety, in short

The library does these things; you cannot forget them, and wds-verify checks the result. They are the reason for `from`, for the two `map` runs and for the checks above.

- **Owner only, never silently.** Only the owner of a vault takes over, and only after the person said yes (or the same old rows were verified before). Another tab does not start a second run: a lock (`navigator.locks`, ifAvailable) answers `busy` at once.
- **Nothing is overwritten and nothing is deleted before it was verified.** Writes are create-only, the copy is read back from the server and compared byte for byte, the list entries of every collection are on the server (a repair runs when one is missing), and a marker in the vault remembers, per entry, a short hash of what `map` made of it.
- **A start with the marker asks nothing and compares nothing.** The old data may still be there (sandbox, kept, a crash before the delete): the marker says which entries were copied. What the person edited or deleted in the new app since stays as it is; only an entry that `map` now makes differently (a new or changed old row, a corrected `map`) starts a new run. One localStorage key that holds many entries (projects and time entries as one JSON) is compared per entry, so one more entry in it is one new entry.
- **The delete only removes what was copied, and only if nothing changed.** It reads the old rows again, compares every file byte for byte with the snapshot (a file of the same size with other bytes counts as changed; no file is read at the other starts, where size, type, name and date are enough) and compares inside one IndexedDB transaction. One changed row: nothing is deleted (`deleted: "changed"`). Keys of localStorage are removed only when their value is still the copied one.
  One window stays open: a file that another tab replaces by one with the same size, type, name and date in the few milliseconds between that second reading and the transaction is not noticed (a transaction cannot wait for a read of bytes).
  There is no `deleteDatabase`, never `localStorage.clear()`, and the keys of the library are never touched. The old app must not be used while the question is open; if it is, nothing is lost.
- **The sandbox keeps the old data.** When `store.status().sandbox` is true the copy is made and the old data stays: the sandbox is wiped tonight and the old data would be gone for good. The sandbox takes small data only ({{sandbox_limits}}): test with a few small items there, and with real-size data in a test vault of the app's own scope (section 6).
  The one exception is the test global for automated tests (section 6).
- **A second browser of the same person** (the same old ids in two browsers) gets its own tag, so nothing overwrites anything: duplicates with `tagged: true`, a question with `tagged: false`.
- **What the library does not know:** which rows of the old storage belong to the app. That is what `from`, `h.skip` and the list of stores and keys in the options say, and why a store or key that you leave out is never deleted.

## 5. What stays as it is

- Forms whose submit handler calls `preventDefault()` (integration.md, section 3). Downloads the person asks for (a CSV, an attachment, a PDF), with a note that the file is not encrypted (integration.md, section 11). Printing. Reading a file the person chose.
- The app's own screens, texts, validation and calculations. Search and filters over values the page holds in memory.
- Remove: `localStorage` and `indexedDB` code for new data, background saves, own export of "everything" (use `exportAll`), own passphrase or login screens, "saved locally" texts (replace them with the text of integration.md, section 13), and the old code that read or deleted the old storage once the app calls `store.migrateLocal`.
- **The privacy text.** Wherever the app says what happens to the data (README, start page), it uses the official sentence, word for word and in the language of the text (a third language uses the English one), and, when the scope has the breach check of passphrases on (the default), the breach-check sentence right after it. An old "your data stays on this device" is wrong now.
  - English: **Data is end-to-end encrypted; the faculty holds a recovery key for emergencies.** **When you choose a passphrase, your browser checks it against known data breaches with the Pwned Passwords service (USA); the service receives your IP address and the first five characters of a checksum of the passphrase, never the passphrase itself.**
  - German: **Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel.** **Wenn Sie eine Passphrase wählen, prüft Ihr Browser sie beim Dienst Pwned Passwords (USA) auf bekannte Datenlecks; der Dienst erhält Ihre IP-Adresse und die ersten fünf Zeichen einer Prüfsumme der Passphrase, nie die Passphrase selbst.**

## 6. Test the port

Run `node tools/wds-verify.mjs <app.html> --target sandbox` (integration.md, section 17), then walk through the "Not tested" list of its report by hand: a second window, a conflict, a read-only member, lock and unlock, a modal dialog of your own that is open when the library asks something (section 7), and **the migration with old data**.

### The migration test in wds-verify (the `seed` block)

Put the old, local-only version of the app next to the new one (a file in a folder such as `old/`, kept in the repository) and add a `seed` block to `wds-verify.json` (integration.md, section 12, "Writing wds-verify.json"). The one of `examples/zeit-notizen` looks like this, next to its `steps` and `afterReload`:

```json
{
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

The run goes in this order, and every library dialog is answered when it appears, so the app needs **no step** for the migration question:

1. **The old app.** The tool opens the old page (`seed.page`), runs the seed `steps` there (a `{canary}` in a fill text becomes a unique generated value; `upload` puts a generated PNG into a file input), waits for a debounced save and takes stock of the old storage: every localStorage key and every IndexedDB store with rows.
2. **The new app** opens in the same browser context (`file://` pages share storage in Chromium, so the app finds the old data like a returning user's browser).
3. **The library's dialogs.** Unlock, "create a vault" (a generated passphrase), the access sheet (confirmed), then the migration question: the tool presses `migrate-backup` (and waits for the download) and `migrate-yes`; it waits while the progress view runs; for entries that do not fit (view `migrate-large`) it downloads each file (`migrate-large-download`) and presses `migrate-delete`.
   For entries that differ (view `migrate-differs`) it presses `migrate-differs-later` and says so in the notes: it decides nothing about a person's data. (A prompt that the app draws itself is answered by a step, for example `{"click": "#migrate-yes"}`.)
4. **The steps** of `wds-verify.json`, each after the open library dialogs have been answered. With a seed they come first; the tool then types its own canaries only into fields that are still empty.
5. **Automatic filling and button presses** (the fields, then the save buttons), a second round for fields the app emptied, then a pause for debounced saves.
6. **The reload**, the unlock dialog, the `afterReload` steps (and, when a search field of the app hides the data, its reset), then all checks.

What the report says: the seeded values are in the old storage ("Seed: the old app"), they are visible **after the reload and the unlock**, so they came out of the vault ("Migration: old data visible"), they appear nowhere unencrypted ("old data only encrypted": no request, console line, cookie, new storage place or download other than the library's backup and file downloads), and the old storage is empty
(mock target: "old data deleted", everything the old app stored, every key and every store with rows) or still full (sandbox target: "kept in the sandbox"). Details and every finding id: `tools/README.md` in the repository, section "Testing a migration".
**An app that restores a search or a filter after the reload** (a `settings` record with the last filter, say) needs an `afterReload` step that resets it, for example `{"fill": ["#search", ""]}`: the tool types a canary into the search field, and a restored filter would hide the data it looks for. It clears search fields itself as a last resort and says so in the report.

### Writing seed steps that prove something

- **Typed values must come back as the same text.** The tool searches for exactly what it typed, in the requests and on the screen after the reload. A field that turns the text into something else (a tag field that splits `"a, b"` into two tags, a number or date field) hides the value: the report says "old data visible 4 of 5" or "1 typed value neither shown nor written". Type one token per tag field (`{"fill": ["#tag", "tag{canary}"]}`, a separator is no part of it), and put the value that must round-trip into a text field; a number field cannot carry a value of 6 characters (the minimum for a search), so a year or a count is never proven by the seed alone.
- **`upload` paths are relative to `wds-verify.json`**, not to the folder of `seed.page`: `{"upload": ["#note-file", "old/sample-old.pdf"]}` when the file lies in `old/`. Without a path the tool generates a PNG. Different file names in the seed and in `steps` keep the report clearer, but the same name is no leak any more: a download that the tool started with a button of the library's migration dialog holds the old data by design, with every name in it.
- **Prove that references, files and settings arrived**, not only the texts. The tool only reads text, so make them visible: an `afterReload` step that opens the edit dialog of an entry shows the attached file name (`{"click": ":nth-match(#list .ref:has(button[data-act=\"open\"]) button[data-act=\"edit\"], 2)"}`, then `{"click": "#btn-cancel"}`), a label that follows a setting (the theme name on a button) shows that settings arrived. Steps take any Playwright selector: CSS, `:has()`, `:nth-match()`, `text=`, `role=`.
- **Notices above your dialogs.** A toast of the library (after the migration: "N entries are now in your vault") sits at the bottom right in the top layer, **above a modal dialog of your own, and can cover its Save button**; the short ones go after about 9 seconds, the ones for `failed`, `partial` and `changed` stay until they are dismissed. A person has to press its "Dismiss" first, and so does a step: put `{"click": "[data-wds=\"toast-dismiss\"]"}` before a `click` in your dialog (or let a click fail first: the tool dismisses a toast that covers the element, clicks again and notes it in "Test run notes"). Pressing Enter in a field is not covered by the toast.
- **Lock, unlock and conflicts are not covered by the steps.** The tool answers the library's dialogs once (create, unlock, the migration question) but has no step that locks, unlocks or writes a second version. Test them by hand in the sandbox (a second window), or in your own Playwright test against a mock: `const mock = await startMock({ bundle: true })` from `tools/lib/wds-mock.mjs` (needs the Python of the server; `mock.createScope("myapp")` resolves the scope document with its `scope` ID, `mock.bundle.file` is the library of that mock, which pins the mock's escrow keys, `mock.service` is the base URL for `WDS.connect({ baseUrl })`), and `await mock.stop()` at the end.

### The deletion path in the sandbox: the test global

The sandbox never deletes old data, so the deletion path needs the test global. `--migration-delete` (needs a `seed`) makes wds-verify set `window.__WDS_MIGRATION_TEST__ = true` in its own browser before any script of the page runs, and the tool then expects the old storage to be empty. On the mock target it changes nothing.
**Your own automated tests may set it too**, in the browser that your test script controls (never in the app file, never in a page that a person opens):

```js
await context.addInitScript(() => { window.__WDS_MIGRATION_TEST__ = true; });   // your own Playwright context; or enableMigrationDelete(context) of tools/lib/drive-library.mjs
```

The library honours the global only when `navigator.webdriver === true` (an automated browser) and only in a sandbox, and it logs one warning to the console when it does. The question of the dialog stays the sandbox's ("the old data stays in this browser"); the result says what happened (`deleted: "deleted"`). **Never write the global into the app**, not even to see the deletion by hand: wds-verify fails a file that assigns it and a page that sets it at run time.
In a real browser the old data would be deleted while its only copy is in a sandbox vault that is wiped tonight.

### Your own tests: vaults, members, the library's dialogs

`tools/lib/drive-library.mjs` in the clone answers the library's dialogs for your own Playwright scripts (integration.md, section 12, "Driving the library's dialogs"): `createVault(page)`, `unlock(page, { accessId, passphrase })`, `answerMigration(page)` (backup, take over; for too-large entries each download and delete),
and `redeemInvite(page, { code, passphrase? })` for a member test: the unlock dialog is open, a member has an invite code from `store.share()`; it fills the code and a passphrase of the member's own and confirms the access sheet. It resolves `{ accessId, passphrase }`. When a wait times out, the `DriveError` names what the dialog looked like (view, `aria-busy`, classes, text); a dialog in the view `error` has a `retry` button (`[data-wds="retry"]`) that starts the step again, and a request that stalls for 30 s ends there as well.
Use the sandbox (a copy from `--sandbox-copy`) for such tests, or a test vault in your own scope.

### The join code for tests (a real scope)

A test against the app's real scope is **optional**: `wds-verify --target sandbox --migration-delete` covers vault, migration and deletion without any code. It is worth doing when the app holds attachments larger than the sandbox allows ({{sandbox_limits}}), or when the person asks for it.
Creating a vault in a scope with the enrollment "join code" needs the code, a credential of the person who runs the app. It never goes into an environment variable, a command line, the chat, a test script, a `wds-verify.json`, CLAUDE.md or AGENTS.md, or any file inside a repository.
The test helper reads it from **one file that the person creates themselves in their own terminal** (not through you, so the code never enters the transcript):

```sh
mkdir -p ~/.wds && chmod 700 ~/.wds
(umask 077; cat > ~/.wds/join-code)        # paste the join code, press Enter, then Ctrl-D
```

The file is called `join-code`, without an extension (a `join-code.txt` is not found), holds plain text (a text from TextEdit in rich-text mode does not work) and must not be readable by others (`chmod 600 ~/.wds/join-code` fixes a file made with Finder). A person who is not at ease in a terminal skips this test: it is optional. Afterwards the person deletes the file: `rm ~/.wds/join-code`. On Windows the file is `%USERPROFILE%\.wds\join-code` (create it with Notepad; file modes are not checked there). The environment variable `WDS_JOIN_CODE_FILE` names another file; the code itself is never taken from the environment.
Before the helper reads the file it checks that it exists, is a regular file, is not readable by other users (`chmod 600`) and is not inside the repository you work in; the content is trimmed, never printed, and no error message contains it. A missing or unusable file is a `DriveError` that prints the commands above.

**You, the agent, never read, print, copy or list that file, and never ask for the code in the chat.** When you reach this step, say what the test is for (one test vault, to see the deletion path that the sandbox never runs), give the person the commands and wait until they say the file is there.
With the enrollment "open" no code is needed. With "closed" no test vault can be made: say that the deletion path was not tested against the real scope.

### The test vault, afterwards

The library has no call that deletes a vault, but the test helper does: **every test in a real scope ends with** `deleteVault(page, { accessId, passphrase })`, which removes the vault that `createVault` made (it opens a second client of the page's library, as the owner). Tell the person **the ID of that vault**: `store.status().vaultId`, and the time of the test.
The person never picks a vault by its time among the vaults of their users. If the vault is still listed in the dashboard (expert settings, vaults; the ID is the first column), the person deletes exactly that ID: the vault is blocked at once and removed for good after 30 days, and a deleted vault no longer counts against the scope's vault limit.

### What to check in a test vault

After the run the old IndexedDB stores are empty, the old localStorage keys are gone (only the tag `wds:migrate:<id>:tag` stays), `store.migrateLocal` resolved `migrated` with `deleted: "deleted"`, and every old item is in the vault (count, a file byte for byte, a reference between two items, the creation order).
A second start resolves `nothing`. Then seed again and let a second tab write to the old store while the question is open: the result must be `deleted: "changed"` and the old data still there.

## 7. Checklist for apps with forms and modal dialogs

The library's dialogs (unlock after a session expired, conflict, share, the migration question) are modal `<dialog>` elements in the browser's top layer: they open **above** the modal dialogs of your own app, and the page below them is inert while they are open. Check these nine points; wds-verify cannot, because it creates no conflicts.

1. **Close your own modal dialogs in `store.onLock` and open none while a store call is pending.** If a modal dialog of yours opens with `showModal()` after a library dialog came up, the library puts its own dialog on top of yours again, but the person has to answer its question first. To find only your own dialogs use `dialog:not(.wds-dialog)`; do not close the library's.
2. **Keep the typed values when a save fails** (`OfflineError`, `QuotaError`): the form stays open with what the person typed. After "theirs" (`res.resolution === "theirs"`) show `res.value` and keep the typed text available.
3. **Disable the save button while a write is in flight** and enable it again in `finally`.
4. **Submit handlers call `preventDefault()`** (the policy has `form-action 'none'`; a form without such a handler would navigate and be blocked).
5. **A restored search or filter needs an `afterReload` reset in `wds-verify.json`** (section 6), or is not restored at all (section 2, "Small decisions").
6. **Ids go into selectors only through `CSS.escape(id)`** (or `data-id` and `dataset.id`): migrated ids contain `%` and `-` (section 4, "Ids").

```js
store.onLock(() => {
  document.querySelectorAll("dialog:not(.wds-dialog)[open]").forEach((d) => d.close());   // (1) your own dialogs only; never the library's
  clearScreen();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();                              // (4) the policy blocks a real form submission
  const values = readForm(form);                       // (2) the typed values stay in the form until the save worked
  saveButton.disabled = true;                          // (3) no second save while one is in flight
  try {
    const res = await recipes.set(id, values);
    if (res.resolution === "theirs") showSaved(res.value);   // the other side won: show what is stored now, the typed text is still in the form
    else { closeForm(); showSaved(values); }
  } catch (err) {
    showError(err);                                    // OfflineError, QuotaError, ...: the form stays open with what the person typed
  } finally {
    saveButton.disabled = false;
  }
});

const row = document.querySelector("#item-" + CSS.escape(id));   // (6) an id goes into a selector only through CSS.escape (or read it from dataset.id)
```

7. **Open a file from the vault in a new tab inside the click.** `window.open(blobUrl)` after `await store.getBlob(…)` is no longer part of the click: over a slow connection the popup blocker refuses it. Open the (empty) window first, then fill it, and offer a download link when the window is refused (a test in Playwright's headless Chromium cannot see a PDF in that window: integration.md, section 12, "Driving the library's dialogs", says what to check instead):

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

8. **The app's own notices live inside its dialogs.** A fixed-position element of the page (a `#toast` with `z-index: 20`) lies **under** a modal dialog: a "please enter a title" message would be invisible while the dialog is open. Put validation and error messages inside the dialog (`#form-error`), or make the notice a `popover="manual"` element, and keep the page's own toast for messages that are shown while no dialog is open.
9. **Library notices can cover your dialog's buttons** (section 6, "Notices above your dialogs"): a notice is a box of 26rem width (416 px at the default font size; in a window narrower than 36rem the window width minus 1rem), 1rem from the right and the bottom edge of the **window** (.5rem from all edges in a narrow window), 5 to 8rem high (integration.md, section 4 has the exact numbers). It covers the bottom right of a dialog that reaches into that corner, and a margin inside the dialog does not help. Put the footer buttons of your dialogs (Save, Cancel) on the **left** or in the middle, and let a test press `toast-dismiss` first.
