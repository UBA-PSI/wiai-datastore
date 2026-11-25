#!/usr/bin/env node
// wds-keygen: create one escrow key set (E = ECDH P-256, S = ECDSA P-256) for the WIAI Datastore (PROTOCOL.md 3.4).
//
//   node tools/wds-keygen.mjs --label current --out <dir>
//
// Writes <dir>/wds-escrow-<label>-private.json (mode 0600; private scalars, for KeePassXC, never into the repo or onto
// the server) and <dir>/wds-escrow-<label>-public.json (public keys and key ID, for the server config, Ansible and
// client/escrow-pins.json). Run once for "current" and once for "spare"; keep the two private files apart.
import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]] : null).filter(Boolean));
const label = args.label;
const out = args.out;
if (!label || !/^(current|spare)$/.test(label) || !out) {
  console.error('usage: node tools/wds-keygen.mjs --label current|spare --out <dir>');
  process.exit(2);
}
const subtle = globalThis.crypto.subtle;
const b64u = (buf) => Buffer.from(buf).toString('base64url');

async function pair(alg) {
  const usages = alg.name === 'ECDH' ? ['deriveBits'] : ['sign', 'verify'];
  const kp = await subtle.generateKey(alg, true, usages);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  const d = Buffer.from(jwk.d, 'base64url');
  if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) throw new Error('unexpected key encoding');
  return { pub, d };
}

const E = await pair({ name: 'ECDH', namedCurve: 'P-256' });
const S = await pair({ name: 'ECDSA', namedCurve: 'P-256' });
const id = b64u(await subtle.digest('SHA-256', Buffer.concat([E.pub, S.pub])));
const pub = { format: 'wds-escrow-public-1', label, key_id: id, e_pub: b64u(E.pub), s_pub: b64u(S.pub) };
const priv = { ...pub, format: 'wds-escrow-private-1', e_d_hex: E.d.toString('hex'), s_d_hex: S.d.toString('hex') };

mkdirSync(out, { recursive: true, mode: 0o700 });
const privPath = join(out, 'wds-escrow-' + label + '-private.json');
const pubPath = join(out, 'wds-escrow-' + label + '-public.json');
if (existsSync(privPath) || existsSync(pubPath)) { console.error('refusing to overwrite existing files in ' + out); process.exit(1); }
writeFileSync(privPath, JSON.stringify(priv, null, 2) + '\n', { mode: 0o600 });
chmodSync(privPath, 0o600);
writeFileSync(pubPath, JSON.stringify(pub, null, 2) + '\n', { mode: 0o644 });
console.log(JSON.stringify(pub));
