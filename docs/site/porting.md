# Porting an existing app to WIAI Datastore

You port an app that exists already: it keeps its screens and logic, and what changes is where its data lives. The script tag, the policy and the API are in [integration.md]({{base}}/docs/integration.md); read it first.

## 1. Inventory

Find every place where the app keeps data that outlives the page: localStorage, sessionStorage, indexedDB, cookies, the Cache API, file handles, `fetch` to a server of its own, its own export and import. For each, write down what kind of thing it holds, how many there are and who changes them, then map it:

| What the app has | In the datastore |
|---|---|
| A list of things (notes, entries, students) | A collection: `store.collection("notes/", { meta })` |
| A single small thing (a timer, a draft) | One record: `store.set("timer", …)`; an editor through `autosave` |
| Settings | Shared by everyone in the vault, or typed by the person: one record. A personal preference chosen from a fixed list (theme, language, last tab): keep the app's own localStorage key (integration.md, section 5) |
| Files (images, PDFs) | `store.set("files/<id>", file)` plus an item that names it (integration.md, section 6) |
| References between things | The other thing's id inside the value |
| A unique index, computed data | No counterpart: check the loaded list before adding; compute totals from the records |

What `migrateLocal` does not take over (sessionStorage, cookies, the Cache API, file handles, every database or key you do not name) is lost for the person or stays unencrypted in the browser: if it matters, the old version needs an export button before the update.

## 2. Replacing the storage calls

| Before | After |
|---|---|
| Read everything at start | `await store.unlock()`, then `await col.load()`; `col.get(id)` when one is opened |
| Save after an edit | `col.autosave(id, () => item)` and `saver.changed()` for editors; `col.set(id, item)` for a button save; `col.add(item)` for a new item |
| Delete | `await col.remove(id)` |
| "Save as backup" of everything | The vault dialog: `store.openVault()` (integration.md, section 8) |
| A save on `beforeunload` or a "saved" label | Remove it: the library warns before closing, and `onStatus` tells the truth |
| Re-render after a change | `store.onChange` |

Forms: let them save through `autosave` (what a Save button has not saved is lost when the page locks). An open form changes only when `onChange` names its record with `remote: true` and the person has not typed since; do not `get` an open record from `onChange` for anything else (render totals and lists from `items()`). After `resolution === "theirs"` of a button save, show `res.value`.

## 3. Importing an old export file

Keep the app's import for its old export format: people who exported from the old version move their data over by file. Reading a file the person chose is not storing data. Derive the new ids from the old keys, so that a second import finds what the first one wrote, and add only what is missing (a second import must not overwrite what people changed since):

```js
const notes = store.collection("notes/", { meta: (n) => ({ title: n.title }) });
const newId = (oldId) => "old-" + encodeURIComponent(String(oldId));         // the same function for ids and references

async function importOldExport(file) {   // old format: { "notes": [{ "id": 1, "title": "…", "text": "…" }] }
  const data = JSON.parse(await file.text());
  if (!data || !Array.isArray(data.notes)) throw new Error("This is not an export of the old version.");
  for (const old of data.notes) {
    if ((await notes.get(newId(old.id))) !== undefined) continue;              // written by an earlier import, maybe changed since: leave it
    await notes.set(newId(old.id), { title: String(old.title || ""), text: String(old.text || "") });
  }
  return data.notes.length;
}
```

## 4. Data that is still in the browsers of existing users

Existing users have data in IndexedDB or localStorage. Dropping it loses it; leaving it keeps unencrypted data on the device for ever. **One call takes it over: `store.migrateLocal`.** The app never opens `indexedDB` or removes the old keys itself (wds-verify warns about that). Call it once per start, after `await store.unlock()` and before you load anything:

```js
const result = await store.migrateLocal({
  id: "zeitnotizen",                                          // names this migration: 1 to 40 characters of a-z, 0-9 and "-"
  indexedDB: { zeitnotizen: ["notes", "files"] },             // { database: [stores] }; only these stores are read
  localStorage: ["zeitnotizen.daten"],                        // keys, or "prefix*"
  map(old, ref) {                                             // called once per old row; returns zero or more writes
    if (old.source === "localStorage") {                      // one JSON text: projects and entries; take everything from it
      const data = JSON.parse(old.value);
      return [
        ...data.projects.map((p) => ({ collection: "projects/", id: old.id + "-p" + p.id, value: { name: p.name }, meta: { name: p.name } })),
        ...data.entries.map((e) => ({ collection: "entries/", id: old.id + "-e" + e.id, value: e, meta: { date: e.date } })),
      ];
    }
    if (old.source === "zeitnotizen/notes")                   // old.key is the row's key, old.value the row
      return { collection: "notes/", id: old.id, value: { title: old.value.title, text: old.value.text }, meta: { title: old.value.title } };
    if (old.source === "zeitnotizen/files")                   // the file points to its note: ref(key, source) is the id that row gets
      return { collection: "files/", id: old.id, value: dataUrlToBlob(old.value.dataUrl), meta: { note: ref(old.value.noteId, "zeitnotizen/notes"), name: old.value.name } };
  },                                                          // a row that returns nothing stays in the browser, untouched
});
if (result.status === "failed") console.warn("old data not taken over:", result.why);

function dataUrlToBlob(url) {                                 // the app converts: "data:image/png;base64,AAAA" -> Blob
  const [head, body] = url.split(",");
  return new Blob([Uint8Array.from(atob(body), (c) => c.charCodeAt(0))], { type: head.slice(5, head.indexOf(";")) });
}
```

- **The map.** `old` is `{ source, key, value, id }`: `source` is `"localStorage"` or `"<database>/<store>"`, `value` the text of a localStorage key or the stored row, and `old.id` a stable id for the row (a tag of this browser plus the key): use it as the new id and take the whole id, never split or parse it. `ref(key, source)` gives the id of another row, for references (`source` is `"localStorage"` or `"<database>/<store>"`, by default the one of this row; it does not check that the row exists, so show a reference to nothing as missing). A write is `{ collection: prefix, id, value, meta }` (an item) or `{ name, value }` (a record); `value` is JSON or a Blob. Several writes from one row need ids of your own (`old.id + "-p1"`). A wrong option rejects with a `UsageError`; a mistake in `map` is a `failed` result.
- **The result** is `{ status, why? }`; `status` is `nothing` (no old data, nothing to ask), `declined` (the question comes again at the next start), `migrated` (copied; the old rows are still in the browser) or `failed` (`why` is a sentence for you; what was copied stays, the old rows stay). Load normally in every case.
- **The safety facts**, which the library guarantees and you cannot forget. The first start only copies: it asks the owner once (a member gets one console line, no dialog), offers "Download a copy of the old data first", writes create-only (an existing different record goes through the normal conflict path, `onConflict` or the dialog, and "keep the vault's version" counts as handled) and deletes nothing. At the next start, when the owner has seen the copy in the app, the library asks once whether to delete the old rows ("Not now" keeps them and asks again; never in the sandbox). Only rows that `map` turned into writes and that are unchanged since the copy are deleted, and **such a row is deleted whole**: take everything you need from every row.
- **What the person sees:** one question at the first start ("This browser holds N entries from an earlier version of this app. Copy them into your vault?"), one outcome line; at the next start one question ("Is everything in the app? Then delete the old entries from this browser"); a failure shows a dialog.
- **The new app must be opened from the same place as the old one**: the same address, or the same file name in the same folder (Firefox and Safari give every file its own storage). Replace the old file in place.

## 5. Testing

Run `node tools/wds-verify.mjs <app.html>` (integration.md, section 10). Put the old version of the app into a folder such as `old/` and add a seed to `wds-verify.json`: the tool types old data into the old page, opens the new app in the same browser, accepts the question, and checks that the old values appear after the reload and that the old data is still there (the sandbox never asks about deleting). `{canary}` becomes a unique value; `upload` works as in the steps.

```json
{
  "seed": {
    "page": "old/index.html",
    "steps": [
      { "fill": ["#note-title", "Old note {canary}"] },
      { "click": "#note-add" }
    ]
  }
}
```

Then try by hand what the tool does not: a second window, a conflict, a read-only member.
Wherever the app says what happens to the data, it uses the privacy sentence of integration.md, section 11; an old "your data stays on this device" is wrong now.
