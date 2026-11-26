# WIAI Datastore

End-to-end encrypted key-value storage for single-file web apps built at the Faculty of Information Systems and Applied Computer Sciences
(WIAI), University of Bamberg. Faculty staff without a background in software development build small web apps with Claude (a grade
calculator, a time log, a reading list). Those apps run from file://, from a local web server or in Electron and keep their data on a
faculty server that only ever receives ciphertext. The app includes one script tag; the library handles keys, dialogs, conflicts, sharing
and export, so the app code never touches cryptography.

Service: https://wiai.uni-bamberg.de/datastore/ (the path is permanent: apps hard-code the library and API URL). Repository: https://github.com/UBA-PSI/wiai-datastore.

## Security model in brief

- **Encryption in the browser.** Each person has a vault. The passphrase is stretched with Argon2id in the browser; record names and
  values are encrypted with keys that never leave the browser. The server stores ciphertext, opaque record IDs and sizes, and checks
  only the format of what it receives ([PLAN.md](PLAN.md) section 2 lists exactly what it learns).
- **One exception by design: faculty recovery.** Every vault also wraps its key for the faculty's escrow key, so that a person who has
  forgotten the passphrase can get access back (proved with the recovery code from the access sheet, or through a recovery contact). The recovery has a waiting period, the vault owner is notified and can
  cancel it, and it is logged. Whoever holds the escrow private key could therefore decrypt every vault; every text about the privacy of
  an app has to say so. The public sandbox refuses every recovery.
- **The library is pinned.** Apps load the library with a Subresource Integrity hash, so a compromised server cannot hand them a
  different library without the browser refusing it. The hashes are published in this repository (see "Verify the served library").
- **Sharing and revocation.** Invites carry their own key material; revoking a member re-encrypts the vault. A signed roster lets every
  member check who has access.
- **Not covered:** a malicious app (it runs in the same page as the dialogs and could read the passphrase), weak passphrases beyond the
  library's checks, and traffic analysis. [SECURITY.md](SECURITY.md) says how to report a vulnerability.

## For developers and their Claude

Building an app for the service, or porting an existing one? Start with [docs/site/llms.txt](docs/site/llms.txt) (served at https://wiai.uni-bamberg.de/datastore/llms.txt) and the guide it links,
[docs/site/integration.md](docs/site/integration.md): the exact script tag with its integrity hash, the Content-Security-Policy, the API, collections for lists of items, conflicts, and the example app [examples/zeit-notizen](examples/zeit-notizen).
Porting an existing app is its own page, [docs/site/porting.md](docs/site/porting.md): the data that older, local-only versions left in the browsers of their users is taken over with one library call, `store.migrateLocal`. For a real end-to-end test there is a **public sandbox scope** on the service: open enrollment, small quotas, everything deleted every night
(llms.txt names its scope ID; never write that ID into an app).

```sh
git clone https://github.com/UBA-PSI/wiai-datastore && cd wiai-datastore
(cd tools && npm install && npx playwright install chromium)          # Node >= 22
node tools/wds-verify.mjs path/to/app.html --target sandbox            # the real library against the sandbox: no Python, no build
node tools/wds-verify.mjs path/to/app.html --static-only               # only Node: script tag, CSP, forbidden patterns
```

The tool is described in [tools/README.md](tools/README.md) and in integration.md, section "wds-verify". The dashboard (staff of the University of Bamberg) hands out the scope ID, the join code and a prompt for Claude that carries the scope's settings,
plus a section for the app's own CLAUDE.md and AGENTS.md.

## Documents

| File | For |
|---|---|
| [PLAN.md](PLAN.md) | Design, threat model, decisions, review log |
| [PROTOCOL.md](PROTOCOL.md) | Normative wire format: encodings, keys, envelopes, roster, HTTP API, error codes. It wins over PLAN.md for byte-level and HTTP details |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability |
| [docs/site/](docs/site/) | What the service serves: `llms.txt`, `integration.md` (developers and their Claude), `users.de.md`, `users.en.md`, `operator.md` (including the public sandbox), `export.html` |
| [server/README.md](server/README.md), [client/README.md](client/README.md) | Details of the two code bases |

## Layout

```
client/        browser library: src/wds-core.js (protocol, crypto), src/wds-ui.js (dialogs, WDS.connect), vendor/ (Argon2id),
               build.mjs -> dist/wds-<version>.js + .sri + hashes.json, escrow-pins.json, test/ (node tests, Playwright)
server/        wds_server/ (Starlette app, SQLite), tests/ (unittest), config.example.ini
tools/         wds-keygen (escrow key sets), wds-recover (operator recovery), wds-verify (smoke test for apps)
docs/site/     served documentation and the export tool (Markdown, llms.txt, export.html), no build step
examples/      example apps for the service (zeit-notizen: time tracking and notes with attachments) with wds-verify.json and a Playwright test, and the test of the code blocks of integration.md and porting.md (docs-recipes.spec.mjs)
scripts/       test-server.sh, test-client.sh, test-integration.sh, test-tools.sh, test-examples.sh
```

## Set up

```sh
uv venv --python 3.13 .venv
uv pip install --python .venv starlette==0.46.1 uvicorn==0.32.0 pynacl==1.5.0   # exactly the Debian 13 package versions
(cd client && npm install)                                                       # Playwright 1.65.1 and hash-wasm 4.13.0, Node >= 22
node client/build.mjs                                                            # client/dist
```

Run a local server (the documentation is then at http://127.0.0.1:8000/datastore/docs/):

```sh
cd server
../.venv/bin/python -m wds_server.cli create-scope --db /tmp/wds.db --config config.ini --slug demo --name Demo --enrollment open
../.venv/bin/python -m wds_server --db /tmp/wds.db --config config.ini
```

Copy `server/config.example.ini` to `config.ini` first and put escrow public keys and an operator token hash into it (`tools/wds-keygen.mjs`,
`python -m wds_server.cli operator-token`).

## Tests

| Command | Runs |
|---|---|
| `scripts/test-server.sh` | server unit tests (in-process ASGI client, injectable clock and disk probe) |
| `scripts/test-client.sh` | client node tests (protocol, vectors, UI helpers, build), then Playwright UI tests in Chromium against an in-memory fake server. `SKIP_BROWSER=1` runs only the node tests |
| `scripts/test-integration.sh` | the real server against the real bundle in Chromium, Firefox and WebKit, from file:// pages: protocol behaviour (`integration.spec.mjs`) and the documentation, the example app under the documented Content-Security-Policy, and the export page (`docs.spec.mjs`) |
| `scripts/test-examples.sh` | the example apps in examples/ and the code blocks of integration.md and porting.md (collections, conflicts in code, lock and unlock, `store.migrateLocal` with a seeded old database) from file:// in Chromium against the real server (library and service URL mapped to it); `WDS_BROWSERS=chromium,firefox,webkit` for all three |

Run one browser with `WDS_BROWSERS=chromium scripts/test-integration.sh`, one test with `-g "export page"`. Details in client/README.md.

## Documentation served by the app

`server/wds_server/docs.py` serves `docs/site` (config `[server] docs_dir`, default: next to the server package) at
`/datastore/llms.txt`, `/datastore/docs/<name>` (small built-in Markdown renderer), `/datastore/docs/<name>.md` (raw) and `/datastore/export/` (the export tool;
`/datastore/export/wds-export.html` as a download). Placeholders such as `{{script_tag}}`, `{{sri}}`, `{{version}}`, `{{csp}}` and `{{base}}` are replaced at request
time from `client/dist/hashes.json` and the configuration, so the pages always name the library that is deployed. The list is in the header of `docs.py`.

The Content-Security-Policy in the documents is built in `docs.csp_policy` and was verified in all three engines with the real bundle; if you change the library
(new origins, new browser features), run `scripts/test-integration.sh` and update that function and `tools/lib/static-checks.mjs` (`CSP_TEMPLATE`) together.

## Verify the served library

The library file that apps load must be the one built from this repository. Compare the served file with the published hash:

```sh
curl -s https://wiai.uni-bamberg.de/datastore/client/wds-1.0.0.js | shasum -a 256                     # SHA-256 of the served file
curl -s https://wiai.uni-bamberg.de/datastore/client/wds-1.0.0.js | openssl dgst -sha384 -binary | openssl base64 -A   # its SRI value (without "sha384-")
cat client/dist/hashes.json                                                                       # "sha256" and "sri" per version
```

The values must equal the `sha256` and `sri` entries of `client/dist/hashes.json` in this repository, and the `integrity` attribute of
every app's script tag must equal that `sri`. To check that the file was built from these sources, run `node client/build.mjs` with
the escrow pins of `client/escrow-pins.json` and compare `client/dist/wds-1.0.0.js` byte for byte. `wds-verify` does the tag check for
an app and also compares the served `/datastore/client/hashes.json` with the clone.

## Release and deploy

1. `node client/build.mjs --freeze` for a tested library version (a frozen version never changes; a new version needs a new number in `client/package.json`).
2. The operator's deployment uploads `server/wds_server`, `client/dist` and `docs/site` to the service host after the server tests pass, and restarts the service.
3. Check `https://wiai.uni-bamberg.de/datastore/healthz`, the documentation and the export page.

Operation (escrow keys, recovery, quotas, read-only mode, backups, incidents): [docs/site/operator.md](docs/site/operator.md).

## Rules of this repository

Code, identifiers and developer documents in English. Dashboard, privacy page and end-user texts in German and English (German with "Sie", plain and short).
No dates or time estimates in documents. No emojis. Private escrow keys never enter the repository.

## License

MIT, see [LICENSE](LICENSE). The bundled Argon2 implementation (hash-wasm, `client/vendor/`) is MIT-licensed as well; its licence is in `client/vendor/LICENSE`.
