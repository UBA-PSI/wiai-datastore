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
- Header: **Teilen** (the library's share dialog: invite codes with the role write or read, revoke), **Export** (`store.exportAll`, a ZIP of everything, decrypted),
  **Neu laden** (reads the records of the others; see below), **Sperren** (lock the vault and clear the page), **EN/DE**.
- **Language**: before unlock the app starts in the language of the browser (`navigator.language`: German if it starts with "de", else English), so the library's unlock and create dialogs follow the browser, too. A choice stored in the vault replaces it after unlock; the toggle is stored in the vault. The app tells the library with `store.setLocale` (at start and with every change), so dialogs and notices of the library speak the language of the app.
- **Messages**: the app never shows the text of an exception. `errText` maps the error classes of `WDS.errors` to its own sentences; the end of a session (revoked, expired) is announced by the library and the lock screen, so the app stays silent there.
  Confirmations of the library (for example the export) are not repeated by the app; the app's own notices appear at the bottom left (at the top below 960 px) because the library's are at the bottom right.
- **Data of the older version**: `old/index.html` is the local-only predecessor (projects and time entries as one JSON text in localStorage, notes, attachments and the timer in IndexedDB). The app takes that data over with one call, `store.migrateLocal` (`takeOverOldData` in `index.html`; the same code is in `docs/site/porting.md`, example 2): the library asks the owner once, copies into the vault, checks the copy and deletes the old data (in a sandbox it keeps it). The app never reads or deletes the old storage itself. Open the new file the way the old one was opened (Firefox and Safari keep the storage of every file apart, so the new file must replace the old one).
- Read members see everything and get no edit controls (the heading says "Zeiteinträge", there is no upload hint).
- Layout: system fonts, light and dark by the system setting, usable down to 380 px (one pane at a time for notes), everything works with the keyboard,
  visible focus, labelled fields, dialogs are native `<dialog>` elements.

## How the data is stored

One record per entity; the app never keeps its state in one record and never calls `list()` (that would download every attachment, see integration.md section 6). Lists of things are
**collections** (`store.collection`, integration.md section 6): a collection keeps an index record next to its records, with a little meta per item, merges the additions and removals of several devices
without losing any (the changes are replayed on the newest list; no clocks are involved) and repairs itself with `rebuild()`.

| Record | Content |
|---|---|
| `projects/<id>`, `projects.index` | name, colour, archived; the collection of projects |
| `time/<id>`, `time.index` | project, date, minutes, description (and the start time for timer entries); the collection of time entries (meta: date, minutes, project) |
| `notes/<id>`, `notes.index` | title, text, tags, project, times; the collection of notes (meta: title) |
| `files/<id>`, `files.index` | the bytes of one attachment (`filesCol.add(file, ...)`; shown with `getBlob`, loaded only when a note is opened); the id is `<fileId>-<name>.<ending>`, the meta says which note owns it, the name, the MIME type and the size |
| `timer` | the running timer (project, description, start); deleted when it stops |
| `settings` | the language |

- **Start and lock.** `store.onUnlock(start)` and `store.onLock(...)` are registered once; `start` loads the four lists and reads the records with `getAll()` (at most 8 requests at a time). "Sperren" clears everything of the vault from the page, "Entsperren" runs `start` again.
- The note editor uses `notesCol.autosave`, which also keeps the title of the list entry current; switching notes flushes first. A new note is created with `add()` (record and list entry at once), so another device sees it without waiting. Attachment changes flush at once.
- Nothing is shown as saved before the write returned: records are written first and the screen follows. A collection call that stored the item but could not write the list entry yet (`err.stored`) counts as a success; the library writes the entry with the next list write.
- **Deleting** uses the result of `remove()`: if the person keeps a newer version of an entry in a conflict, the entry stays on screen and the app says so. Deleting a note removes its attachments first, deleting a project removes its time entries first.
- **Conflicts** are decided per kind of record: `store.onConflict("notes/", ...)`, `("time/", ...)` and `("projects/", ...)` show one dialog that presents both versions as readable text (never JSON) and lets the person keep theirs or mine (the other version stays in the history); `"settings"` merges in code (two devices changed different settings: keep both) and `"timer"` keeps the own value. Attachments and everything else get the library's dialog.
  There is no conflict dialog for the lists: the library merges them. `autosave`'s `onResolved` takes over a newer version into the open editor.
- **Other members.** Items that others add, remove or change arrive when the window gets focus (the collections fire `onChange` and the app loads what changed); "Neu laden" reads everything again at once. "Listen reparieren" (at the bottom) calls `rebuild()` on the four collections: it reads every record once and writes the lists new; it is for the case that something is missing from a list (a lost write, a damaged index).
- A timer that runs over midnight is booked on the day it started. The duration is rounded to whole minutes, at least one.
- **CSV and downloads.** The CSV export of the time entries and the download of an attachment are downloads that the person asks for with a button; the page says that the CSV file is not encrypted (integration.md section 11). wds-verify exempts `exportAll` and the downloads that a `download` step asks for; its steps press the CSV button once and report "user-requested download, contains canaries: yes".

## Tests

```sh
scripts/test-examples.sh                          # Chromium; WDS_BROWSERS=chromium,firefox,webkit for all three
```

`app.spec.mjs` starts the real server with a temporary database (the integration environment of the client tests) and opens the unchanged app from file://.
The library URL and the service URL of the app are the production ones; the browser context maps them to the local server. Only the integrity hash and the scope ID
in a temporary copy are replaced by those of the local stack. It covers projects, timer (also after a reload), manual entries, the week table, notes with autosave, search and tags,
attachments (image preview, PDF download, a file over the limit), the history dialog, export (ZIP, with the lists as records of their own) and CSV, the language toggle, lock and unlock, sharing with a write and a read member,
the conflict dialog (which version is not saved yet, which lines differ), the pickup of new items on focus and at "Neu laden", two people adding entries at the same time (nothing is lost), a revoked member after "Neu laden", "Listen reparieren" after a list was deleted behind the app's back,
the weekly overview at 1280, 1024, 800 and 380 px (totals in view, cards on a narrow screen), and the layout at 380 px in light and dark. `ZN_SHOTS=<directory>` also saves screenshots.

`app.spec.mjs` also has a case for the older version (Chromium only, because the old page and the new app are two files): it fills `old/index.html`, opens the new app, creates a vault, answers the library's question (with the backup ZIP), and checks that everything arrived (projects, entries, the note with its attachment, the running timer, the language), that the old storage is empty and that the question does not come back.

`docs-recipes.spec.mjs` (in `examples/`) runs the code blocks of `docs/site/integration.md` and `docs/site/porting.md` (collections, conflicts in code, lock and unlock again, the import of an old export, `store.migrateLocal` with a seeded old database against the real server and a sandbox, the checklist for forms, the popup block) in the three browser engines, and runs wds-verify on the example app of the guide and on this app with its `seed` (mock and sandbox target, with `--migration-delete`).

## Verification

`wds-verify.json` (an object with `locale`, `steps`, `afterReload` and `seed`) first plays the older version (`seed`: a project, a time entry, a note with an uploaded file and a running timer in `old/index.html`) and lets the new app take the data over (the tool answers the library's question itself), then creates two projects, a time entry and a note with tags, uploads a file, opens the weekly view and presses the CSV button (a user-requested download). Run from a checkout of the public repository
(https://github.com/UBA-PSI/wiai-datastore), Node 22 or newer:

```sh
cd tools && npm install && npx playwright install chromium && cd ..
WDS_VERIFY_OFFLINE=1 node tools/wds-verify.mjs examples/zeit-notizen/index.html
```

`WDS_VERIFY_OFFLINE=1` switches off the two online lookups (the published hashes and the scope check): the demo scope `zeitnotizen-demo-xn8kp9` is not registered at the production service, and the tool fails an unknown scope. For an app with a registered scope, leave the variable out.
Python 3.13 with the server packages (`.venv`) makes the target "mock"; without it use `--target sandbox` (the tool then runs against the public sandbox with a copy of the page).

The line "Library version released" is information, not a finding about the app: the library version is not marked as frozen yet, so its hash may still change (then the tag in this file has to be replaced).
The tool plays the older version first (the `seed` block) and the library's migration question is answered by the tool itself (a backup download, then "Take over"); the app needs no step for it. The tool then types into the fields it finds before a project exists; the app rightly rejects those entries, so they never appear on screen. The tool does not expect values back that the app neither showed nor wrote to the store, and looks at every tab after the reload (one `afterReload` click per tab), so "Data after reload" passes. The app reads its data back at start; `app.spec.mjs` checks every view after a reload.

**Result: passed** (30 checks passed, 0 failed, 0 warnings)

This is a smoke test, not a proof. It catches the usual mistakes (plaintext in storage or requests, wrong script tag, wide CSP); it cannot see what it did not trigger.

### All checks

| Check | Result | Details |
|---|---|---|
| Library hashes | info | Published hashes from the local clone (client/dist/hashes.json); https://wiai.uni-bamberg.de/datastore/client/hashes.json online lookup switched off (WDS_VERIFY_OFFLINE). |
| Library version | pass | 1.0.0 is a published version. |
| Library version released | info | Version 1.0.0 is not marked as released (frozen) in hashes.json; its hash may still change. This is about the library, not about your app. |
| Subresource integrity | pass | The integrity attribute matches the published hash of 1.0.0. |
| crossorigin attribute | pass | crossorigin="anonymous" is set. |
| Content Security Policy | pass | A meta policy is present and not broader than the recommended one. |
| No other scripts | pass | The library is the only external script. |
| No direct access to the datastore | pass | The datastore host is named in the code, but no fetch, XMLHttpRequest, WebSocket, sendBeacon or EventSource is used. |
| No sandbox scope ID in the app | pass |  |
| Modal dialogs of the app | info | The app opens modal dialogs with showModal(). Library dialogs open above your own modal dialogs. Close your own dialogs in store.onLock and open none while a store call is pending (the person has to answer the library dialog first; select your own dialogs with dialog:not(.wds-dialog)). |
| Current scope settings | info | Scope settings not checked (WDS_VERIFY_OFFLINE is set). |
| Seed: the old app | pass | old/index.html stored 7 of 7 typed value(s) in the browser storage (11 step(s)). |
| Library loads | pass | The library of the page loaded in Chromium from a file:// URL (the mock serves it). |
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
| Downloads | info | zeitnotizen-old-data-2026-11-26.zip (offered by the library's migration dialog), zeiteintraege-2026-11-26.csv (user-requested download, contains canaries: yes) (a download of the library's migration dialog that holds the seeded old data: the backup it offers before it deletes; not counted as a leak) |
| Vault created | pass | The library dialog created a vault in the mock (open enrollment, passphrase checked by the library). |
| Data was saved | pass | 23 encrypted record write(s) reached the mock; the canaries were searched for in all of them. |
| Input fields | info | 7 field(s) filled with canaries (0 found by the tool, 7 by wds-verify.json steps); buttons pressed by the tool: none. |
| Migration: old data visible | pass | All 5 value(s) typed into the old app are visible in the app after the migration, reloading and unlocking (the start view after reloading and unlocking and every view an afterReload step opens were looked at). |
| Migration: the library's dialog | info | The library asked whether to take over the old data; the tool downloaded the backup (zeitnotizen-old-data-2026-11-26.zip) and pressed "Take over". |
| Migration: old data only encrypted | pass | None of the seeded values appears in a request, a URL, the console or a cookie or the server's database; the 23 record write(s) carry them encrypted. |
| Migration: old data deleted | pass | The old data is gone from the old app's storage after the migration (all 4 key(s) and store(s) that the old app had filled). |
| wds-verify.json steps | info | 22 step(s) run (7 fill, 10 click, 1 upload, 5 wait, 1 press, 1 download). |
| Browser language | info | The browser ran with the locale de-DE (the library dialogs follow it unless the app sets one). |
| Data after reload | pass | 5 of 5 typed value(s) are visible again after reloading and unlocking (the start view and every afterReload step looked at, together) (at least one of every round). 2 other typed values were neither shown as text nor written to the store before the reload and are not counted: #entry-duration ("1,5 S |
| Write frequency | pass | No record was written three or more times within a second. |

Dynamic run: 29.7 s, 0 canary field(s), 23 record write(s).

### Not tested

This run cannot see the following. Test each by hand before you hand the app over:

- A second device and conflicts: open the app in two browsers with the same vault, change the same record in both, and look at what a person sees (the conflict dialog or your onConflict handler; no entry may get lost).
- A read-only member: invite a member with the role "read", and check that every control that writes is disabled or hidden for them and that no error shows.
- Lock and unlock again in one page: lock the vault (store.lock(), or wait for the timeout) and unlock without reloading; the screen must be empty on lock and filled again on unlock, and nothing may be registered twice (register onLock and onUnlock once, outside start). Close your own modal dialogs in onLock: the library locks with its dialogs above yours, and the unlock dialog that comes next must not find one of yours open.
- Buttons the tool does not press: delete, export, download, import, lock, and everything that the save word list, data-wds-verify="save" or a click step does not match. Press each by hand. This run saw: "Neu laden", "Teilen", "Export", "EN", "Sperren", "Vorige Woche", "Nächste Woche", "Diese Woche", "CSV: diese Woche", "CSV: alle Einträge", "Listen reparieren".
- Fields in views no step opens (tabs, panels, dialogs of the app): 9 hidden field(s) were seen but not filled. Fill them by hand, or add steps (click the tab, fill the field, click save) and afterReload steps.
- The migration with real-size old data (attachments, many items) and the "old app was used meanwhile" case (nothing is deleted, the result is "changed"): try both by hand against a test vault in the app's own scope, in a fresh browser profile (the migration moves the data of your everyday browser, and deletes it there).
- The old data is found only when the new app is opened from the same origin as the old one (Chromium: any file:// page shares storage with any other; Firefox and Safari: only the same file, so the new file needs the same name in the same folder; a web server: the same scheme, host and port). The tool opens both in one Chromium and cannot show this: replace the old file in place and tell the users to open the new one the same way.

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
