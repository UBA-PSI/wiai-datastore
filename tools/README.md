# Tools

Operator and developer tools of the WIAI Datastore (public repository: <https://github.com/UBA-PSI/wiai-datastore>). Node >= 22 (developed on Node 26), no runtime
dependencies; the only library code is `../client/src/wds-core.js`. Playwright is a devDependency (`npm install` in this directory, or the copy in
`../client/node_modules`), used only by the dynamic part of `wds-verify`.

| Tool | For | Needs |
|---|---|---|
| `wds-keygen.mjs` | Operator: create an escrow key set (`--label current\|spare --out <dir>`). | nothing |
| `wds-recover.mjs` | Operator: recover a vault for a user (PLAN 5.9, PROTOCOL 9). | operator token, escrow private key file |
| `wds-verify.mjs` | Developer (and the developer's Claude): smoke test of an app before it is shared. | static: Node. dynamic: Chromium, and Python 3.13 venv (mock) or the public sandbox |

## wds-recover

```sh
node tools/wds-recover.mjs start    <vault-id>                      # asks for the emergency code (the tool calls it the recovery code); starts the 72 hour waiting period
node tools/wds-recover.mjs start    <vault-id> -                    # the code from stdin: echo CODE | node tools/wds-recover.mjs start <vault-id> -
node tools/wds-recover.mjs status   <vault-id>
node tools/wds-recover.mjs cancel   <vault-id>
node tools/wds-recover.mjs complete <vault-id> --escrow-key ~/wiai-datastore-escrow/wds-escrow-current-private.json
```

The emergency code is a credential that starts a recovery, so it is not taken from the argument list (shell history, `ps`): the tool asks for it, or reads stdin.
A code given as an argument still works and triggers a warning. The tool refuses to send the operator token to a `--base` that is not https (localhost, 127.0.0.1 and [::1] excepted).

Common options: `--base <url>` (default `https://wiai.uni-bamberg.de/datastore`), `--token-file <file>` (default
`~/.config/wiai-datastore/operator-token`), `--json`. `complete` also takes `--expires-in-hours` (default 72, at most 359: the server refuses invites that expire more than 15 days after its own clock, so one hour is left as margin),
`--dry-run` (everything except the upload) and `--yes` (no question; required when there is no terminal).

`complete` fetches the escrow material, checks the roster chain, opens the escrow keyring entry with the escrow private key and
checks it against the signed commitments, builds a roster version that adds exactly one owner invite and nothing else, signs it
with the escrow signing key, verifies the whole chain with the client library's own verifier, uploads it and prints the invite
code. The user redeems it in their app; the old owner slot stays until the user revokes it. The escrow private key file is read
into memory only. The tool writes no file, and it never prints the token or the key. Exit codes: 0 done, 1 failed, 2 usage error or
the waiting period is not over.

Which escrow key file? The roster of the vault names the key set of its escrow slot; `complete` says so when the file does not
match. Vault IDs are in the dashboard; operator.md section 3 shows how to find one from an access ID.

## wds-verify

```sh
git clone https://github.com/UBA-PSI/wiai-datastore && cd wiai-datastore       # the tool lives in the public repository
(cd tools && npm install && npx playwright install chromium)                  # Node >= 22, once
node tools/wds-verify.mjs path/to/app.html [--config wds-verify.json]
```

The report (Markdown) goes to stdout: paste it into the app's README. Exit codes: 0 passed, 1 a check failed, 2 the tool could not run (no Playwright, bad arguments), 3 the sandbox is unavailable (rate limited, full, switched off: not an app finding; wait, at most an hour).
The app opens in Chromium from a `file://` page against the public sandbox scope of the real service (open enrollment, small quotas, everything deleted every night). The tool replaces the scope ID in a copy of the page, so the app file keeps its own. Three families of checks:

1. **Static checks** (only Node): one script tag `https://wiai.uni-bamberg.de/datastore/client/wds-<version>.js` with `crossorigin="anonymous"`, the `integrity` hash of that published version and the `onerror` fallback of integration.md, section 2 (a message in the app's language is an info); a CSP meta tag that is not broader than the recommended one, placed before the first script (additions of `font-src data:`, `media-src blob: data:` and `img-src https://host` are accepted; `'self'` in `script-src` or a missing `base-uri` / `form-action` fail); no other scripts; no `fetch`, `XMLHttpRequest`, `WebSocket` or `sendBeacon` to the datastore host; the sandbox scope ID anywhere in the app fails; CSS that sets `display`, `visibility` or `opacity` on `.wds-` classes or `[data-wds…]` elements fails; `indexedDB` or localStorage access that `store.migrateLocal` would do (a hand-made migration) and `localStorage.clear()` warn; no `<html lang>` warns; an info says when neither the page nor the README next to it holds the official privacy sentence. The scope check fetches the public document of the app's scope ID: an unknown scope fails; the report prints the limits.
2. **The canary leak search.** The tool creates a vault through the library's dialogs, types unique canary strings into the fields (text fields get text; date, time, number, select and file inputs get valid generated values; a plain form is submitted with `button[type=submit]` or Enter when no save word matches), presses the buttons whose text is a save word (save, speichern, add, hinzufügen, anlegen, create, buchen, book, reservieren, senden, submit, ok, and a `data-wds-verify="save"` mark) but never a delete word, runs the steps of `wds-verify.json`, and searches the canaries and the vault passphrase in every request (URL, header, body), page URL, WebSocket frame, localStorage, sessionStorage, IndexedDB, Cache Storage, cookie, console line and download (raw, URL-encoded, base64, hex, UTF-16). It warns about a record written three or more times within a second without a button press (use autosave) and about one record that holds the data of several items. It fails when nothing was stored, because then it proved nothing. Downloads that a `download` step asks for are information.
3. **Data after reload.** `store.lock()` must reload the page and the page must show no vault data until the person unlocks; then the tool reloads, unlocks with the passphrase and checks that the typed values are visible again (the page text and the field values right after the unlock and after every `afterReload` step, taken together). Pass: at least one typed value of every round is back. Fail: records were written, nothing is visible and there are no `afterReload` steps. Values that the app neither showed nor wrote to the store (input it rejected) are not expected back; the detail names them.

The library's dialogs are driven by their stable attributes (`data-wds-view` on the dialog, `data-wds` on every control), so any language works; only the app's own buttons are found by their text. A dialog is *ready* when it has a `data-wds-view` and no `aria-busy="true"`; the tool answers every open library dialog before it touches the app. The report ends with **Not tested**: a second device, a conflict, a read-only member, buttons it does not press, file inputs without an upload step, fields in views no step opens. Test those by hand.

### wds-verify.json

Optional, next to the app (or named with `--config`). An object; every key is optional; a bare array is an error. A plain form app needs none. Write one when inputs are hidden until the user acts (a "New" button, tabs) or the page has a file input.

```json
{
  "steps": [
    { "click": "#tab-notes" },
    { "fill": ["#title", "a unique text for the canary search"] },
    { "press": ["#title", "Enter"] },
    { "upload": ["#cover"] },
    { "wait": 500 }
  ],
  "afterReload": [{ "click": "#tab-notes" }]
}
```

`steps` run after the tool pressed what it recognised; `afterReload` runs after the reload and the unlock (open each tab that shows data). Steps (selectors are Playwright selectors: CSS, `:has()`, `text=`, `role=`): `click` selector; `fill` [selector, text] (the text is searched for like a canary and must come back as the same text; `{canary}` becomes a unique token); `select` [selector, value]; `press` [selector, key]; `upload` [selector] (a generated PNG) or [selector, path relative to the file]; `download` selector (a button the person would press: expected download, reported as information); `wait` ms (at most 60000). `locale` (BCP 47, default `en-US`) sets the browser language.
**`seed`** takes the story of a ported app one step further: `{ "page": "old/index.html", "steps": [ ... ], "keep": [ ... ] }`. The tool opens the old, local-only page in the same browser, runs the steps there (`{canary}` gives unique values), opens the new app, creates the vault, accepts the library's question, and checks (ids `seed`, `migration-visible`, `migration-encrypted`, `migration-old-data`): the seeded values are in the old storage; they are visible **after the reload and the unlock**, so they came out of the vault; they appear nowhere unencrypted (the library's own copy download is no leak); and the old data is **still there** in the sandbox, which never deletes (the deletion is covered by the library's own tests). `keep` names old keys and `database/store` names that may stay on purpose.

### Your own end-to-end tests

Playwright against the sandbox: take a copy of the app from `--sandbox-copy app-sandbox.html`, open it, and select the library's dialogs by their attributes, never by text: the dialog has `data-wds-view="<view>"` (`unlock`, `create`, `redeem`, `sheet`, `conflict`, `history`, …) and every button, input, select and `summary` in it has `data-wds="<name>"` (for example `access-id-input`, `passphrase`, `passphrase-repeat`, `unlock-submit`, `to-create`, `create-submit`, `sheet-confirm`, `sheet-continue`, `conflict-theirs`, `conflict-mine`). The Argon2id key derivation takes seconds: wait for the next view (up to 60 s) and for `aria-busy="true"` to go. Use the Playwright of the clone (`tools/node_modules/playwright`). A test of "open the file in a new tab" uses a `text/plain` blob: headless Chromium has no PDF viewer, so a PDF stays at `about:blank` and arrives as a download.

### Internal options

For the repository's own tests and CI; the documented use is the command above.

| Option | |
|---|---|
| `--target mock` / `auto` | `sandbox` is the default. `mock`: the real server runs locally with a temporary database (`../.venv`, or `WDS_PYTHON`; Python 3.13 with `server/requirements.txt`), the datastore host is mapped to it and the library is built from `client/src`; the server's database is inspected too, and the production scope check is skipped; the tool also confirms the question about deleting old data that the library asks at the second start (never in the sandbox). `auto` takes `mock` when Python is found, else the sandbox, else only the static checks run (with a warning). |
| `--hashes <file>` | Published library hashes (default: `<service>/client/hashes.json`, then `client/dist/hashes.json` of the clone). For an unreleased build: `node tools/wds-verify.mjs --script-tag --hashes client/dist/hashes.json`. |
| `--scope-check off` | No request for the scope document (a scope that is not registered yet). |
| `--locale <tag>`, `--wait-ms <n>` | Browser language; time for debounced saves at the end (default 2800). |
| `--strict`, `--json`, `--headed`, `--out <file>`, `--heading-level <1-5>` | Warnings fail; JSON findings; show the browser; also write the report to a file; the report's title gets that many `#`. |
| `--static-only`, `--sandbox-copy <f>`, `--script-tag [version]` | Static checks only; write a copy of the app that stores into the sandbox (the file name must contain "sandbox") and exit; print the complete script tag and the CSP meta tag and exit. |

Environment (tests and another service): `WDS_PYTHON`, `WDS_VERIFY_SERVICE` (base URL of the service), `WDS_VERIFY_HASHES_URL` (or `off`), `WDS_VERIFY_OFFLINE=1` (no optional online lookups), `WDS_VERIFY_LIBRARY` (a library file that the sandbox target serves instead of the production one). The mock builds its own library and replaces the tag's hash in its copy of the page. The report says "your clone has a library build that the service does not publish yet" when the clone is newer than the service.

## Test apps and tests

`test-apps/good` is a small correct app (profile record, autosaved note, one record per list item); `test-apps/bad` leaks the note to localStorage, posts items to another host and calls the datastore API directly. The files carry the library hash of the build they were written for; the tests substitute the current hash. Run everything with `scripts/test-tools.sh` (`SKIP_BROWSER=1` skips the browser tests).
