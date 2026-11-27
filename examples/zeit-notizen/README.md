# Zeit & Notizen

A single-file app for simple time tracking and note taking with attachments. It keeps its data end-to-end encrypted on the
WIAI Datastore and is written as an example of how an app for the service is built from `docs/site/llms.txt` and the pages it links.
The interface is German or English: before the vault is open it follows the browser (German for "de", else English), and the button "DE" / "EN" switches it (the choice is stored in the vault).

Open `index.html` from disk, from any web server or in Electron. There is nothing to build. The folder `old/` holds this app's older, **local-only** version (it keeps everything in the browser): `index.html` takes the data of that version over, once, when its owner opens the new app (see "Data of the older version"). The scope ID of the demo scope
(`zeitnotizen-demo-xn8kp9`) and the default service URL are in the file; the join code is not and has to come from the person who runs the demo scope.

## What it does

- **Zeit** (time): a timer with project and description (start, stop and save; a running timer survives a reload because it is a record of the vault),
  manual entries with date and duration (`1:30`, `1,5`, `45 min`), the recent entries by day with edit and delete.
- **Woche** (week): totals per project and day for a calendar week (Monday to Sunday, week number), previous and next week, CSV of the week or of all entries.
  A long project name wraps, the total of the week stays at the right edge, and below 760 px every project becomes a card (name and total on top, a chip per day with time).
- **Notizen** (notes): title, text, tags, optional project; autosave; search over title, text, tags, project name and attachment names (case and umlauts
  do not matter; all words must match; `/` jumps to the search field); filter by project and tag; attachments of any type up to the limit of the scope, with an image preview and a download button; the version history of a note.
- **Projekte** (projects): create, rename, archive, delete (the time entries of a deleted project are deleted with it; notes only lose the link).
- Header: **Tresor** (`store.openVault()`: the library's vault dialog with the members and invite codes, one's own access, the passphrase, the export ZIP and "Lock now"), **EN/DE**.
- **Language**: before unlock the app starts in the language of the browser (`navigator.language`: German if it starts with "de", else English), so the library's unlock and create dialogs follow the browser, too. The toggle (EN/DE) is a personal preference: it is stored in this browser's localStorage under the key `zeitnotizen.lang`, not in the vault, so every member of a shared vault (a read member too) chooses their own, and `migrateLocal` does not name the key. The app sets `<html lang>` at start and with every change, and the library's dialogs follow it.
- **Messages**: the app never shows the text of an exception. `errText` maps the error classes of `WDS.errors` to its own sentences; the end of a session (locked, revoked, expired) is handled by the library, which reloads the page, so the app stays silent there.
  The app's own notices appear at the bottom left (at the top below 960 px).
- **Data of the older version**: `old/index.html` is the local-only predecessor (projects and time entries as one JSON text in localStorage, notes, attachments and the timer in IndexedDB). The app takes that data over with one call, `store.migrateLocal` (`takeOverOldData` in `index.html`; `docs/site/porting.md` shows a cut-down version): the library asks the owner and copies into the vault; at the next start it asks whether the old data may be deleted (in a sandbox it keeps it). The language row of the old key-value store returns nothing from `map`: it stays where it is (a personal preference that the new app keeps in localStorage). The app never reads or deletes the old storage itself. Open the new file the way the old one was opened (Firefox and Safari keep the storage of every file apart, so the new file must replace the old one).
- Read members see everything and get no edit controls (the heading says "Zeiteinträge", there is no upload hint).
- Layout: system fonts, light and dark by the system setting, usable down to 380 px (one pane at a time for notes), everything works with the keyboard,
  visible focus, labelled fields, dialogs are native `<dialog>` elements.

## How the data is stored

One record per entity; the app never keeps its state in one record and never calls `list()` (that would download every attachment, see integration.md section 6). Lists of things are
**collections** (`store.collection`, integration.md section 6): a collection keeps an index record next to its records, with a little meta per item, merges the additions and removals of several devices
without losing any (the changes are replayed on the newest list; no clocks are involved). The library's dialogs name a record by the `title` of its meta.

| Record | Content |
|---|---|
| `projects/<id>`, `projects.index` | name, colour, archived; the collection of projects (meta: title) |
| `time/<id>`, `time.index` | project, date, minutes, description (and the start time for timer entries); the collection of time entries (meta: title, date, minutes, project) |
| `notes/<id>`, `notes.index` | title, text, tags, project, times; the collection of notes (meta: title) |
| `files/<id>`, `files.index` | the bytes of one attachment (`filesCol.set(id, file, ...)`; shown with `store.get`, which returns a Blob, loaded only when a note is opened); the id is `<fileId>-<name>.<ending>`, the meta says which note owns it, the name, the MIME type and the size |
| `timer` | the running timer (project, description, start); deleted when it stops |

- **Start and lock.** `start` runs once per page: `await store.unlock()`, the take-over of old data, then it loads the four lists and reads the records with `getAll()`. A lock, a revoked access or an expired session reloads the page (the library saves what is pending first), so the app has no lock handler and no lock screen.
- The note editor uses `notesCol.autosave`, which also keeps the title of the list entry current; switching notes flushes first. A new note is created with `set(id, note)` (the record at once, the list entry queued in the background). Attachment changes flush at once.
- Nothing is shown as saved before the write returned: records are written first and the screen follows. If the list entry of an item cannot be written yet, the library keeps it queued and retries it.
- **Deleting** uses the result of `remove()`: if the person keeps a newer version of an entry in a conflict, the entry stays on screen and the app says so. Deleting a note removes its attachments first, deleting a project removes its time entries first.
- **Conflicts** are decided in one handler, `store.onConflict`: for `notes/`, `time/` and `projects/` it shows one dialog that presents both versions as readable text (never JSON) and lets the person keep theirs or mine (the other version stays in the history); `timer` keeps the own value; attachments and everything else get the library's dialog (the handler returns nothing).
  There is no conflict dialog for the lists: the library merges them. A newer version of the open note (another device saved it, or its version won a conflict) arrives through `store.onChange` with `remote: true` and is shown in the editor unless the person has typed since.
- **Other members.** Records that others add, remove or change arrive when the window gets focus: `store.onChange` fires with `remote: true` and the names, and the app loads what changed (and every event also reads the items that a merged list shows and the app does not hold yet).
- A timer that runs over midnight is booked on the day it started. The duration is rounded to whole minutes, at least one.
- **CSV and downloads.** The CSV export of the time entries and the download of an attachment are downloads that the person asks for with a button; the page says that the CSV file is not encrypted (integration.md section 11). wds-verify treats the downloads that a `download` step asks for as information; its steps press the CSV button once and report "user-requested download, contains canaries: yes".

## Tests

```sh
scripts/test-examples.sh                          # Chromium; WDS_BROWSERS=chromium,firefox,webkit for all three
```

`app.spec.mjs` starts the real server with a temporary database (the integration environment of the client tests) and opens the unchanged app from file://.
The library URL and the service URL of the app are the production ones; the browser context maps them to the local server. Only the integrity hash and the scope ID
in a temporary copy are replaced by those of the local stack. It covers projects, timer (also after a reload), manual entries, the week table, notes with autosave, search and tags,
attachments (image preview, PDF download), the history dialog, export (ZIP, with the lists as records of their own, from the vault dialog) and CSV, the language toggle, lock (the page reloads), sharing with a write and a read member,
the conflict dialog (which version is not saved yet, which lines differ), the pickup of new items on focus, two people adding entries at the same time (nothing is lost), a revoked member,
the weekly overview at 1280, 1024, 800 and 380 px (totals in view, cards on a narrow screen), and the layout at 380 px in light and dark. `ZN_SHOTS=<directory>` also saves screenshots.

`app.spec.mjs` also has a case for the older version (Chromium only, because the old page and the new app are two files): it fills `old/index.html`, opens the new app, creates a vault, answers the library's question (with the backup ZIP), and checks that everything arrived (projects, entries, the note with its attachment, the running timer), that the old storage is empty and that the question does not come back.

`docs-recipes.spec.mjs` (in `examples/`) runs the code blocks of `docs/site/integration.md` and `docs/site/porting.md` (collections, conflicts in code, files, the import of an old export, `store.migrateLocal` with a seeded old database against the real server and a sandbox) in the three browser engines, and runs wds-verify on the example app of the guide and on this app with its `seed` (mock and sandbox target).

## Verification

`wds-verify.json` (an object with `locale`, `steps`, `afterReload` and `seed`) first plays the older version (`seed`: a project, a time entry, a note with an uploaded file and a running timer in `old/index.html`) and lets the new app take the data over (the tool answers the library's question itself), then creates two projects, a time entry and a note with tags, uploads a file, opens the weekly view and presses the CSV button (a user-requested download). Run from a checkout of the public repository
(https://github.com/UBA-PSI/wiai-datastore), Node 22 or newer:

```sh
cd tools && npm install && npx playwright install chromium && cd ..
WDS_VERIFY_OFFLINE=1 node tools/wds-verify.mjs examples/zeit-notizen/index.html --target mock --heading-level 3
```

`--heading-level 3` writes the report's title as `###` and its sections as `####`, so that it fits under this `## Verification` heading (the title line and the "Target" line are left out below).

`WDS_VERIFY_OFFLINE=1` switches off the two online lookups (the published hashes and the scope check): the demo scope `zeitnotizen-demo-xn8kp9` is not registered at the production service, and the tool fails an unknown scope. For an app with a registered scope, leave the variable out.
`--target mock` needs Python 3.13 with the server packages (`.venv`) and runs the app against a local copy of the server; without the flag the tool uses the public sandbox with a copy of the page, the way a developer runs it.

The line "Library version released" is information, not a finding about the app: the library version is not marked as frozen yet, so its hash may still change (then the tag in this file has to be replaced).
The tool plays the older version first (the `seed` block) and the library's migration question is answered by the tool itself (a backup download, then "Take over"; on the mock also the second start's question about deleting the old data); the app needs no step for it. The tool then types into the fields it finds before a project exists; the app rightly rejects those entries, so they never appear on screen. The tool does not expect values back that the app neither showed nor wrote to the store, and looks at every tab after the reload (one `afterReload` click per tab), so "Data after reload" passes. The app reads its data back at start; `app.spec.mjs` checks every view after a reload.

**Result: passed** (32 checks passed, 0 failed, 0 warnings)

This is a smoke test, not a proof. It catches the usual mistakes (plaintext in storage or requests, wrong script tag, wide CSP); it cannot see what it did not trigger.

#### All checks

| Check | Result | Details |
|---|---|---|
| Library hashes | info | Published hashes from the file client/dist/hashes.json (--hashes). |
| Library version | pass | 1.0.0 is a published version. |
| Library version released | info | Version 1.0.0 is not marked as released (frozen) in hashes.json; its hash may still change. This is about the library, not about your app. |
| Subresource integrity | pass | The integrity attribute matches the published hash of 1.0.0. |
| crossorigin attribute | pass | crossorigin="anonymous" is set. |
| onerror fallback | pass | The library tag has the onerror handler of integration.md, section 2. |
| Content Security Policy | pass | A meta policy is present and not broader than the recommended one. |
| No other scripts | pass | The library is the only external script. |
| No direct access to the datastore | pass | The datastore host is named in the code, but no fetch, XMLHttpRequest, WebSocket, sendBeacon or EventSource is used. |
| No sandbox scope ID in the app | pass |  |
| Old data: store.migrateLocal | info | The app calls store.migrateLocal: the library copies the old browser data into the vault and, at the next start, asks whether to delete it (never in the sandbox). With a "seed" in wds-verify.json the run tests it (porting.md, section 5). |
| Modal dialogs of the app | info | The app opens modal dialogs with showModal(). Library dialogs open above your own modal dialogs; select your own dialogs with dialog:not(.wds-dialog). |
| Current scope settings | info | Scope settings not checked: the mock creates the scope it needs; the production service knows nothing of this run. |
| Seed: the old app | pass | old/index.html stored 7 of 7 typed value(s) in the browser storage (11 step(s)). |
| Library loads | pass | The library of the page loaded in Chromium from a file:// URL (the mock serves it). |
| store.lock() reloads the page | pass | store.lock() reloaded the page. It showed no typed value before the unlock. |
| No canary in request URL | pass |  |
| No canary in request header | pass |  |
| No canary in request body | pass |  |
| No canary in page URL | pass |  |
| No canary in WebSocket frame | pass |  |
| No canary in localStorage | pass |  |
| No canary in sessionStorage | pass |  |
| No canary in IndexedDB | pass |  |
| No canary in Cache Storage | pass |  |
| No canary in cookie | pass |  |
| No canary in window.name | pass |  |
| No canary in console output | pass |  |
| No canary in download | pass |  |
| No canary in server database (mock) | pass |  |
| Downloads | info | zeitnotizen-old-data-2026-11-27.zip (offered by the library's migration dialog), zeiteintraege-2026-11-27.csv (user-requested download, contains canaries: yes) (the copy of the old data that the library's migration dialog offers; not a leak) |
| Vault created | pass | The library dialog created a vault in the mock (open enrollment, passphrase checked by the library). |
| Data was saved | pass | 28 encrypted record write(s) reached the mock; the canaries were searched for in all of them. |
| Input fields | info | 7 field(s) filled with canaries (0 found by the tool, 7 by wds-verify.json steps); buttons pressed by the tool: none. |
| Migration: old data visible | pass | All 5 value(s) typed into the old app are visible after the migration, the lock and the unlock (the start view after the unlock and every view an afterReload step opens were looked at). |
| Migration: old data only encrypted | pass | None of the seeded values appears in a request, a URL, the console or a cookie or the server's database; the 28 record write(s) carry them encrypted. |
| Migration: old data deleted | pass | The old data is gone from the old app's storage after the migration (4 key(s) and store(s) that the old app had filled). |
| wds-verify.json steps | info | 22 step(s) run (7 fill, 10 click, 1 upload, 5 wait, 1 press, 1 download). |
| Browser language | info | The browser ran with the locale de-DE (the library dialogs follow <html lang>, else this). |
| Data after reload | pass | 5 of 5 typed value(s) are visible again after reloading and unlocking (the start view and every afterReload step looked at, together) (at least one of every round). 2 other typed values were neither shown as text nor written to the store before the reload and are not counted: #entry-duration ("1,5 S |
| Write frequency | pass | No record was written three or more times within a second. |

Dynamic run: 30.2 s, 0 canary field(s), 28 record write(s).

#### Not tested

This run cannot see the following. Test each by hand before you hand the app over:

- A second device and conflicts: open the app in two browsers with the same vault, change the same record in both, and look at what a person sees (the conflict dialog or your onConflict handler; no entry may get lost).
- A read-only member: invite a member with the role "read" (store.openVault()), and check that every control that writes is hidden or disabled for them and that no error shows.
- Buttons the tool does not press: delete, export, download, import, lock, and everything that the save word list, data-wds-verify="save" or a click step does not match. Press each by hand. This run saw: "Tresor", "EN", "Vorige Woche", "Nächste Woche", "Diese Woche", "CSV: diese Woche", "CSV: alle Einträge".
- Fields in views no step opens (tabs, panels, dialogs of the app): 13 hidden field(s) were seen but not filled. Fill them by hand, or add steps (click the tab, fill the field, click save) and afterReload steps.
- The old data is found only when the new app is opened from the same origin as the old one (Chromium: any file:// page shares storage with any other; Firefox and Safari: only the same file, so the new file needs the same name in the same folder). The tool opens both in one Chromium and cannot show this. The sandbox never deletes old data: the deletion is covered by the library's own tests.

## What to tell users

```text
Data is end-to-end encrypted; the faculty holds a recovery key for emergencies.
When you choose a passphrase, your browser checks it against known data breaches with the Pwned Passwords service (USA); the service receives your IP address and the first five characters of a checksum of the passphrase, never the passphrase itself.
Your data is stored on a faculty server. You need:
1. The join code from the person who runs this app (only for creating a vault).
2. A passphrase of your own, at least 12 characters. It cannot be reset: the server does not know it.
3. Your access sheet (access ID and recovery code). Print it or save it somewhere apart from this device.
With your recovery code the faculty can restore access after a documented procedure. Details: https://wiai.uni-bamberg.de/datastore/docs/users.en

Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel.
Wenn Sie eine Passphrase wählen, prüft Ihr Browser sie beim Dienst Pwned Passwords (USA) auf bekannte Datenlecks; der Dienst erhält Ihre IP-Adresse und die ersten fünf Zeichen einer Prüfsumme der Passphrase, nie die Passphrase selbst.
Ihre Daten liegen auf einem Server der Fakultät. Sie brauchen:
1. Den Beitrittscode von der Person, die diese App betreibt (nur zum Anlegen Ihres Tresors).
2. Eine eigene Passphrase mit mindestens 12 Zeichen. Sie lässt sich nicht zurücksetzen: Der Server kennt sie nicht.
3. Ihr Zugangsblatt (Zugangskennung und Wiederherstellungscode). Drucken oder speichern Sie es getrennt von diesem Gerät.
Mit Ihrem Wiederherstellungscode kann die Fakultät nach einem dokumentierten Verfahren den Zugang wiederherstellen. Details: https://wiai.uni-bamberg.de/datastore/docs/users.de
```
