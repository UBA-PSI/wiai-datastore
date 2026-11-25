# Vendored code

| File | Source | Version | License |
|---|---|---|---|
| `hash-wasm-argon2.umd.min.js` | npm package `hash-wasm`, file `dist/argon2.umd.min.js` (Argon2 only build, WebAssembly embedded) | 4.13.0 | MIT, see `LICENSE` |

`SHA256SUMS` holds the checksums of the vendored files; verify with `shasum -a 256 -c SHA256SUMS` in this directory.
The client tests check them as well (the test "vendored files match their checksums" in `client/test/primitives.test.mjs`).

npm tarball `hash-wasm-4.13.0.tgz`, registry integrity (also in `client/package-lock.json`):
`sha512-GrWl7wsV46fKIXQZB5ebskLZLAmKL6d9RS0fspCxDeQyjoNu1AfTJTMLPOJyfzaQm0ldFiwFN21/w+sE/kgEFQ==`. `hash-wasm-argon2.umd.min.js`
and `LICENSE` are byte-identical to `dist/argon2.umd.min.js` and `LICENSE` in that tarball.

The file is used unmodified. On its own it defines the global `hashwasm` (classic script), `module.exports` (CommonJS) or
registers through `define()` (AMD). The bundle (`client/build.mjs`) therefore runs it inside a private function scope with
a CommonJS-like `exports` and no `define`: no global is set, the page's own hash-wasm or AMD loader is neither used nor
disturbed, and `wds-core.js` receives `argon2id` once, at load time, through a private variable. Only `argon2id` is used.

To update: install the new version of `hash-wasm` in an empty directory, copy `dist/argon2.umd.min.js`, replace the
license text if it changed, regenerate `SHA256SUMS`, and re-run the test vectors (`client/test/make-vectors.mjs` must
still produce the same Argon2id values).
