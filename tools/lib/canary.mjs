// Canary strings and the encodings in which wds-verify looks for them.
//
// A canary is a unique string that the verifier types into the app. A leak is any place where a canary shows up again: raw,
// URL-encoded, as base64 (all three byte alignments, so a canary inside a longer base64 text is found), base64url, hex, or as
// UTF-16LE (raw, hex and base64 of those bytes). Text is searched as bytes, so a binary body is searched the same way as a header.
import { randomBytes } from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64');

// All byte patterns that stand for the string `s`; each is {enc, bytes}.
export function needlesFor(s) {
  const out = [];
  const add = (enc, bytes) => { if (bytes.length >= 6 && !out.some((n) => n.enc === enc && Buffer.compare(n.bytes, bytes) === 0)) out.push({ enc, bytes: Buffer.from(bytes) }); };
  const utf8 = Buffer.from(s, 'utf8');
  add('raw', utf8);
  const pct = encodeURIComponent(s);
  if (pct !== s) add('url-encoded', Buffer.from(pct));
  const pctLower = pct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  if (pctLower !== pct) add('url-encoded', Buffer.from(pctLower));
  const form = pct.replace(/%20/g, '+');
  if (form !== pct) add('url-encoded (form)', Buffer.from(form));
  add('hex', Buffer.from(utf8.toString('hex')));
  add('hex', Buffer.from(utf8.toString('hex').toUpperCase()));
  for (const [label, bytes] of [['base64', utf8], ['base64 of UTF-16LE', Buffer.from(s, 'utf16le')]]) {
    // A base64 text of a longer message contains the canary at one of three alignments; the first and last symbols of each
    // are partly made of neighbouring bytes and are cut off.
    for (let shift = 0; shift < 3; shift++) {
      const enc = b64(Buffer.concat([Buffer.alloc(shift), bytes])).replace(/=+$/, '');
      const body = enc.slice([0, 2, 3][shift], enc.length - 3);
      if (body.length >= 8) {
        add(label, Buffer.from(body));
        add(label.replace('base64', 'base64url'), Buffer.from(body.replace(/\+/g, '-').replace(/\//g, '_')));
      }
    }
  }
  const u16 = Buffer.from(s, 'utf16le');
  add('UTF-16LE', u16);
  add('hex of UTF-16LE', Buffer.from(u16.toString('hex')));
  return out;
}

// A haystack is a Buffer or a string. Returns the first needle that occurs, or null.
export function findIn(haystack, needles) {
  const buf = Buffer.isBuffer(haystack) ? haystack : Buffer.from(String(haystack), 'utf8');
  for (const n of needles) if (buf.includes(n.bytes)) return n;
  return null;
}

// Canary set for one run: the nonce keeps canaries unique across runs and apps.
export class Canaries {
  constructor() {
    this.nonce = randomBytes(6).toString('hex');
    this.items = []; // {index, label, kind, value, needles}
    this.counter = 0;
  }
  // kind: text | email | url | tel | number
  make(label, kind = 'text') {
    const n = ++this.counter;
    const core = this.nonce + 'z' + String(n).padStart(2, '0');
    let value;
    if (kind === 'email') value = 'wds' + core + '@canary.example';
    else if (kind === 'url') value = 'https://canary.example/' + core;
    else if (kind === 'tel' || kind === 'number') value = '7' + String(parseInt(this.nonce.slice(0, 7), 16) % 1e7).padStart(7, '0') + String(n).padStart(3, '0');
    else value = 'WDSCANARY ' + core + ' äöü&=';
    return this.add(label, kind, value);
  }
  // A unique token for the {canary} placeholder of wds-verify.json fill steps (letters and digits only, so every field accepts it).
  token() { return 'WDSCANARY-' + this.nonce + 'z' + String(++this.counter).padStart(2, '0'); }
  // A text the developer chose (wds-verify.json fill steps), or a secret such as the passphrase. core: a part of the text that is
  // searched for on its own as well (the generated token inside a longer text).
  add(label, kind, value, core) {
    const needles = needlesFor(value);
    // the core token alone, so a leak that cuts the text is still found
    if (kind === 'text' && value.startsWith('WDSCANARY ')) needles.push(...needlesFor(value.split(' ')[1]));
    if (core && core !== value) needles.push(...needlesFor(core));
    const item = { index: this.items.length, label, kind, value, needles };
    this.items.push(item);
    return item;
  }
  // First canary found in the haystack: {item, needle} or null. only: optional predicate; the items it rejects are not searched for.
  scan(haystack, only) {
    const buf = Buffer.isBuffer(haystack) ? haystack : Buffer.from(String(haystack), 'utf8');
    for (const item of this.items) {
      if (only && !only(item)) continue;
      const n = findIn(buf, item.needles);
      if (n) return { item, needle: n };
    }
    return null;
  }
}
