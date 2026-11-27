#!/usr/bin/env node
// wds-recover: operator recovery of a vault (PLAN 5.9, PROTOCOL 9). Run it on the operator's laptop, never on the server.
//
//   node tools/wds-recover.mjs start    <vault-id>                      start it with the user's emergency code, asked for on the terminal (or read from stdin)
//   node tools/wds-recover.mjs start    <vault-id> -                    the same, read from stdin (echo CODE | wds-recover start <vault-id> -)
//   node tools/wds-recover.mjs status   <vault-id>                      show the vault and its pending recovery
//   node tools/wds-recover.mjs cancel   <vault-id>                      cancel the pending recovery
//   node tools/wds-recover.mjs complete <vault-id> --escrow-key <file>  after the waiting period: add one owner invite and print its code
//
// Options:
//   --base <url>          service URL (default https://wiai.uni-bamberg.de/datastore); must be https, except for localhost, 127.0.0.1 and [::1]
//   --token-file <file>   operator token (default ~/.config/wiai-datastore/operator-token)
//   --escrow-key <file>   escrow private key file made by wds-keygen (format wds-escrow-private-1); read, used in memory, never stored
//   --expires-in-hours n  validity of the invite code (default 72, at most 359: the server refuses more than 15 days counted on its own clock)
//   --dry-run             complete: do everything except uploading the roster version
//   --yes                 complete: do not ask for confirmation
//   --json                machine-readable output on stdout
//
// The emergency code is a credential, and the only way to start a recovery (72 hours of waiting, then "complete"). A code given as a command-line argument is visible to other processes (ps) and ends up in the shell history, so
// the tool asks for it instead; a code in the argument list still works but triggers a warning.
// What "complete" does: fetch the escrow material with the operator token, check the roster chain, open the escrow slot's keyring
// entry with the escrow private key, build a roster version that adds exactly one owner invite and changes nothing else, sign it
// with the escrow signing key, check that the client library would accept it, upload it (recovery/complete), and print the invite
// code for the user. All cryptography comes from client/src/wds-core.js. Exit codes: 0 done, 1 failed, 2 usage or not ready yet.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';

const require = createRequire(import.meta.url);
const core = require('../client/src/wds-core.js');
const I = core.internals;
if (!I) throw new Error('wds-recover needs the development build of client/src/wds-core.js (with internals), not the production bundle');

export const DEFAULT_BASE = 'https://wiai.uni-bamberg.de/datastore';
const DEFAULT_TOKEN_FILE = join(homedir(), '.config', 'wiai-datastore', 'operator-token');
export const MAX_EXPIRES_HOURS = 359;
const RECOVERY_NOTE = 'The founder sees "a recovery of this vault was requested" on the next unlock and can cancel it.';

export class ToolError extends Error {
  constructor(message, { exitCode = 1, code } = {}) { super(message); this.exitCode = exitCode; this.code = code; }
}

// ---- argument parsing ----
const WITH_VALUE = new Set(['base', 'token-file', 'escrow-key', 'expires-in-hours']);
export function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out.positional.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (eq >= 0) out.flags[key] = a.slice(eq + 1);
    else if (WITH_VALUE.has(key)) {
      if (i + 1 >= argv.length) throw new ToolError('--' + key + ' needs a value', { exitCode: 2 });
      out.flags[key] = argv[++i];
    } else out.flags[key] = true;
  }
  return out;
}

// ---- inputs ----
function warnIfOpen(file, what) {
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) console.error('warning: ' + what + ' ' + file + ' is readable by other users (mode ' + mode.toString(8) + '); use chmod 600');
}
export function readToken(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw new ToolError('cannot read the operator token file ' + file + ': ' + e.code, { exitCode: 2 }); }
  warnIfOpen(file, 'the operator token file');
  const token = text.trim();
  if (!/^wdsop\.[A-Za-z0-9_-]{20,}$/.test(token)) throw new ToolError('the operator token file ' + file + ' does not contain a token of the form wdsop.<base64url>', { exitCode: 2 });
  return token;
}
export function normalizeVaultId(s) {
  let id;
  try { id = core.normalizeCode(String(s || '')); } catch (e) { id = ''; }
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new ToolError('"' + s + '" is not a vault ID (26 characters, digits and letters without I, L, O, U)', { exitCode: 2 });
  return id;
}

// Escrow private key file of wds-keygen: {format: "wds-escrow-private-1", key_id, e_pub, s_pub, e_d_hex, s_d_hex}. Checked, then
// turned into CryptoKeys; the raw scalars are not kept.
export async function loadEscrowKey(file) {
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new ToolError('cannot read the escrow key file ' + file + ': ' + (e.code || e.message), { exitCode: 2 }); }
  warnIfOpen(file, 'the escrow key file');
  if (!doc || doc.format !== 'wds-escrow-private-1') throw new ToolError(file + ' is not an escrow private key file (format wds-escrow-private-1, made by tools/wds-keygen.mjs)', { exitCode: 2 });
  const hex = (s, n, what) => { if (typeof s !== 'string' || !new RegExp('^[0-9a-f]{' + 2 * n + '}$').test(s)) throw new ToolError('the escrow key file has an invalid ' + what, { exitCode: 2 }); return I.unhex(s); };
  const ePub = I.b64uDecode(String(doc.e_pub), 65), sPub = I.b64uDecode(String(doc.s_pub), 65);
  const eD = hex(doc.e_d_hex, 32, 'e_d_hex'), sD = hex(doc.s_d_hex, 32, 's_d_hex');
  const keyId = await I.escrowKeyId(ePub, sPub);
  if (doc.key_id !== keyId) throw new ToolError('the escrow key file is inconsistent: key_id does not match the public keys', { exitCode: 2 });
  const ePriv = await I.importPrivate('E', eD, ePub), sPriv = await I.importPrivate('S', sD, sPub);
  // the private scalars must belong to the public keys: a signature made now must verify
  const probe = I.utf8('wds-recover self-test');
  if (!(await I.ecdsaVerify(sPub, await I.ecdsaSign(sPriv, probe), probe))) throw new ToolError('the escrow signing key does not match its public key', { exitCode: 2 });
  return { keyId, label: doc.label || '', ePub, sPub, ePriv, sPriv, ePubB64: I.b64u(ePub), sPubB64: I.b64u(sPub) };
}

// ---- operator API ----
export function checkBase(base) {
  let u;
  try { u = new URL(String(base)); } catch (e) { throw new ToolError('--base "' + base + '" is not a URL', { exitCode: 2 }); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new ToolError('refusing to send the operator token to ' + u.protocol + '//' + u.host + ': use an https:// address (plain http is accepted only for localhost, 127.0.0.1 and [::1])', { exitCode: 2 });
  }
  return u;
}

export function makeApi(base, token) {
  checkBase(base || DEFAULT_BASE);
  const root = String(base || DEFAULT_BASE).replace(/\/+$/, '') + '/api/v1/admin';
  return async function call(method, path, json) {
    let res;
    try {
      res = await fetch(root + path, { method, headers: { Authorization: 'Bearer ' + token, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
    } catch (e) { throw new ToolError('cannot reach ' + root + ': ' + (e.cause && e.cause.code || e.message)); }
    let body = null;
    try { body = await res.json(); } catch (e) { /* no JSON */ }
    if (!res.ok) {
      const code = body && body.error ? body.error : 'http_' + res.status;
      throw new ToolError('the server answered ' + res.status + ' ' + code + (body && body.message ? ': ' + body.message : ''), { code, exitCode: code === 'recovery_not_ready' ? 2 : 1 });
    }
    return body;
  };
}

function when(unix) { return new Date(unix * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC'); }
function span(seconds) {
  if (seconds <= 0) return 'now';
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
  return (d ? d + ' d ' : '') + (h || d ? h + ' h ' : '') + m + ' min';
}

// ---- commands ----
export async function cmdStatus(call, vaultId, now = () => Math.floor(Date.now() / 1000)) {
  const v = await call('GET', '/vaults/' + vaultId);
  const r = v.recovery;
  const left = r ? r.ready_at - now() : null;
  return { vault: v, ready: r ? left <= 0 : false, secondsLeft: r ? Math.max(0, left) : null };
}

export async function cmdStart(call, vaultId, { code }) {
  let parsed;
  try { parsed = await core.parseRecoveryCode(code); } catch (e) { throw new ToolError('that is not an emergency code (28 symbols, e.g. XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX): ' + e.message, { exitCode: 2 }); }
  return call('POST', '/vaults/' + vaultId + '/recovery', { recovery_code: parsed.canonical });
}

export async function cmdCancel(call, vaultId) { return call('DELETE', '/vaults/' + vaultId + '/recovery'); }

// Build, check and (unless dryRun) upload the escrow-signed roster version. Returns {code, slotId, version, expires, uploaded, scope}.
export async function cmdComplete(call, vaultId, key, { expiresInHours = 72, dryRun = false, now = () => Math.floor(Date.now() / 1000), log = () => {} } = {}) {
  if (!Number.isFinite(expiresInHours) || expiresInHours < 1 || expiresInHours > MAX_EXPIRES_HOURS) throw new ToolError('--expires-in-hours must be between 1 and ' + MAX_EXPIRES_HOURS + ' (the server allows invites for 15 days at most, counted on its own clock; one hour is left as margin for clock differences)', { exitCode: 2 });
  const status = await cmdStatus(call, vaultId, now);
  if (!status.vault.recovery) throw new ToolError('no recovery is pending for this vault; start one first', { exitCode: 2 });
  if (!status.ready) throw new ToolError('the waiting period is not over: ' + span(status.secondsLeft) + ' left (ready at ' + when(status.vault.recovery.ready_at) + ')', { exitCode: 2 });
  if (status.vault.deleted) throw new ToolError('the vault has been deleted', { exitCode: 1 });

  const esc = await call('GET', '/vaults/' + vaultId + '/escrow');
  const scope = esc.scope, docs = esc.roster.versions;
  if (!docs.length) throw new ToolError('the server sent no roster');
  const head = docs[docs.length - 1], headHash = esc.roster.head_hash;
  // 1. the chain is internally consistent (signatures, links, invariants); the escrow sets named in the chain are taken as pins here,
  //    what must match the key file is the escrow slot of the head
  const named = new Set();
  for (const d of docs) for (const s of d.body.slots) if (s.kind === 'escrow') named.add(await I.escrowKeyId(I.b64uDecode(s.e_pub, 65), I.b64uDecode(s.s_pub, 65)));
  let chain;
  try { chain = await I.verifyRosterChain({ scope, vault: vaultId, escrowPins: [...named], retiredEscrow: [], docs, prior: null }); }
  catch (e) { throw new ToolError('the roster chain from the server does not verify: ' + e.message); }
  if (chain[chain.length - 1].hash !== headHash || head.body.version !== esc.roster.head) throw new ToolError('the server\'s head hash does not match the roster it sent');
  // 2. the escrow slot of the head is the one this key file belongs to
  const slot = head.body.slots.find((s) => s.id === esc.escrow_slot);
  if (!slot || slot.kind !== 'escrow') throw new ToolError('the roster has no escrow slot with ID ' + esc.escrow_slot);
  if (slot.e_pub !== key.ePubB64 || slot.s_pub !== key.sPubB64) {
    const theirs = await I.escrowKeyId(I.b64uDecode(slot.e_pub, 65), I.b64uDecode(slot.s_pub, 65));
    throw new ToolError('this vault\'s escrow slot belongs to key set ' + theirs + ' but the key file is ' + key.keyId + (key.label ? ' (' + key.label + ')' : '') + '; use the other key file');
  }
  // 3. open the escrow keyring entry and check it against the signed commitments, as a client does
  let kr;
  try {
    const plain = await I.eciesOpen({ recipientPriv: key.ePriv, recipientPub: key.ePub, envelope: I.b64uDecode(esc.keyring_entry),
      aadTail: I.aadKeyring(scope, vaultId, esc.escrow_slot, head.body.version, key.ePub) });
    kr = I.parseKeyringPlaintext(plain);
  } catch (e) { throw new ToolError('the escrow keyring entry cannot be opened with this key: ' + e.message); }
  const want = head.body.commit.epochs;
  if (kr.epochs.length !== want.length) throw new ToolError('the keyring entry does not list the committed epochs');
  const vmk = new Map();
  for (let i = 0; i < want.length; i++) {
    const cv = I.b64u((await I.deriveVaultKeys(kr.epochs[i].k, null)).cVmk);
    if (kr.epochs[i].e !== want[i].e || cv !== want[i].c) throw new ToolError('the keyring entry does not match the roster commitments (wrong or tampered entry)');
    vmk.set(kr.epochs[i].e, kr.epochs[i].k);
  }
  if (I.b64u((await I.deriveVaultKeys(null, kr.nk)).cNk) !== head.body.commit.nk) throw new ToolError('the name key in the keyring entry does not match the roster commitment');
  log('escrow material verified for vault ' + vaultId + ' (scope ' + scope + ', roster version ' + head.body.version + ', epoch ' + head.body.epoch + ')');

  // 4. the new owner invite: fresh slot keys, an invite secret, and exactly one added slot
  const newE = await I.generateKeyPair('E'), newS = await I.generateKeyPair('S');
  const slotId = I.randomSlotId(), secret = I.randomBytes(17), idBytes = I.randomBytes(12), accessId = await I.b32cEncode(idBytes);
  const sk = await I.deriveSlotKeys(secret);
  const t = now();
  const expires = t + Math.round(expiresInHours * 3600);
  const body = JSON.parse(JSON.stringify(head.body));
  body.version += 1; body.prev = headHash; body.signer = esc.escrow_slot; body.time = Math.max(head.body.time, t);
  body.slots.push({ e_pub: I.b64u(newE.pub), expires, id: slotId, kind: 'invite', role: 'owner', s_pub: I.b64u(newS.pub) });
  body.slots.sort((a, b) => (a.id < b.id ? -1 : 1));
  const keyring = await I.makeKeyring(scope, body, vmk, kr.nk);
  const signed = await I.signRoster(body, key.sPriv);
  // 5. what the clients would say: the whole chain with the new version must verify (this is the rule "add one owner invite, change nothing")
  try { await I.verifyRosterChain({ scope, vault: vaultId, escrowPins: [...named], retiredEscrow: [], docs: [...docs, signed], prior: null }); }
  catch (e) { throw new ToolError('the new roster version would be refused by the client library, nothing was uploaded: ' + e.message); }
  const wrapped = await I.wrapSlot({ kWrapRaw: sk.kWrap, scope, vault: vaultId, accessId, kdf: { alg: 'invite' }, slotId, keySets: [{ e: newE, s: newS }] });
  const result = { code: (await I.makeInviteCode(idBytes, secret)).display, slotId, version: body.version, expires, scope, vault: vaultId, uploaded: false };
  if (dryRun) return result;
  await call('POST', '/vaults/' + vaultId + '/recovery/complete', {
    roster: signed, keyring,
    new_slots: [{ slot: slotId, access_id: accessId, kdf: { alg: 'invite' }, token_hash: I.b64u(sk.tokenHash), wrapped: I.b64u(wrapped) }],
  });
  result.uploaded = true;
  return result;
}

// ---- command line ----
const HELP = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n');

// The emergency code from the terminal (hidden is not possible with readline, so it is read as one line on stderr's prompt) or from stdin.
async function readCode(io, stdin = process.stdin) {
  if (stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: process.stderr });
    try { return (await rl.question('Emergency code of the user: ')).trim(); } finally { rl.close(); }
  }
  let text = '';
  for await (const chunk of stdin) { text += chunk; if (text.length > 4096) break; }
  return text.trim();
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await rl.question(question + ' [y/N] ')).trim()); } finally { rl.close(); }
}

export async function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  try {
    const { positional, flags } = parseArgs(argv);
    const [command, vaultArg, ...rest] = positional;
    if (flags.help || !command) { io.out(HELP); return command || flags.help ? 0 : 2; }
    if (!['start', 'status', 'cancel', 'complete'].includes(command)) throw new ToolError('unknown command "' + command + '"; use start, status, cancel or complete', { exitCode: 2 });
    if (!vaultArg) throw new ToolError(command + ' needs the vault ID', { exitCode: 2 });
    const vaultId = normalizeVaultId(vaultArg);
    const token = readToken(flags['token-file'] || DEFAULT_TOKEN_FILE);
    const call = makeApi(flags.base || DEFAULT_BASE, token);
    const json = !!flags.json;

    if (command === 'status') {
      const s = await cmdStatus(call, vaultId);
      if (json) io.out(JSON.stringify({ ...s.vault, ready: s.ready, seconds_left: s.secondsLeft })); else {
        const v = s.vault, r = v.recovery;
        io.out('vault ' + v.vault + ' in scope ' + v.scope + (v.deleted ? '  (deleted)' : ''));
        io.out('  epoch ' + v.epoch + ', roster version ' + v.roster_version + ', ' + v.bytes + ' bytes');
        io.out(r ? '  recovery: pending, requested ' + when(r.requested) + ', ' + (s.ready ? 'READY since ' + when(r.ready_at) : 'ready at ' + when(r.ready_at) + ' (' + span(s.secondsLeft) + ' left)') : '  recovery: none pending');
      }
      return 0;
    }
    if (command === 'start') {
      let code = rest.join(' ');
      if (!rest.length || code === '-') code = await (io.readCode ? io.readCode() : readCode(io));
      else io.err('warning: an emergency code on the command line is visible to other processes and stays in the shell history; omit it and the tool asks for it');
      if (!code) throw new ToolError('start needs the emergency code', { exitCode: 2 });
      const r = await cmdStart(call, vaultId, { code });
      if (json) io.out(JSON.stringify(r)); else {
        io.out('recovery started; waiting period ends ' + when(r.ready_at) + ' (' + span(r.ready_at - Math.floor(Date.now() / 1000)) + ')');
        io.out(RECOVERY_NOTE);
        io.out('Then: wds-recover complete ' + vaultId + ' --escrow-key <file>');
      }
      return 0;
    }
    if (command === 'cancel') {
      await cmdCancel(call, vaultId);
      if (json) io.out(JSON.stringify({ cancelled: true })); else io.out('recovery cancelled for vault ' + vaultId);
      return 0;
    }
    // complete
    if (!flags['escrow-key'] || flags['escrow-key'] === true) throw new ToolError('complete needs --escrow-key <file> (the private key file made by wds-keygen)', { exitCode: 2 });
    const hours = flags['expires-in-hours'] !== undefined ? Number(flags['expires-in-hours']) : 72;
    const key = await loadEscrowKey(flags['escrow-key']);
    if (!flags.yes && !flags['dry-run']) {
      if (!process.stdin.isTTY) throw new ToolError('complete adds an owner to the vault; run it with --yes (or interactively) to confirm', { exitCode: 2 });
      if (!(await confirm('Add a new owner invite to vault ' + vaultId + ' (signing with escrow key ' + key.keyId.slice(0, 8) + '...)?'))) throw new ToolError('cancelled', { exitCode: 2 });
    }
    const r = await cmdComplete(call, vaultId, key, { expiresInHours: hours, dryRun: !!flags['dry-run'], log: json ? () => {} : (m) => io.err(m) });
    if (json) io.out(JSON.stringify({ invite_code: r.code, vault: r.vault, scope: r.scope, slot: r.slotId, roster_version: r.version, expires: r.expires, uploaded: r.uploaded }));
    else {
      io.out(r.uploaded ? 'recovery completed: roster version ' + r.version + ' signed with the escrow key and stored.' : 'dry run: the roster version ' + r.version + ' is valid; nothing was uploaded.');
      io.out('');
      io.out('Invite code for the user (owner access, valid until ' + when(r.expires) + '):');
      io.out('  ' + r.code);
      io.out('');
      io.out('Give it to the user over a different channel than the access sheet. In the app they choose "redeem invite", enter the code and set a new passphrase.');
      io.out('The old owner access is not revoked; the founder sees a notice that the faculty added an owner.');
    }
    return 0;
  } catch (e) {
    if (e instanceof ToolError) { io.err('wds-recover: ' + e.message); return e.exitCode; }
    io.err('wds-recover: unexpected error: ' + (e && e.stack || e));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
