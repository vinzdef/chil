/**
 * Id generation, on WebCrypto only.
 *
 * `node:crypto` would be the obvious choice on a server and would make this
 * package unusable in a browser or a Worker, which is where half of it runs.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding, from bytes, without `Buffer` or `btoa`. */
function encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += ALPHABET[c & 0x3f];
  }
  return out;
}

/**
 * 128 bits of randomness, base64url, no padding — 22 characters.
 *
 * Used for both secrets and flow ids. Base64url is deliberate: nothing it
 * produces needs escaping in a URL, and it contains no `.`, so a secret can
 * never be mistaken for a token separator.
 */
export function randomId(bytes = 16): string {
  return encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * RFC 4122 v4 UUID, for claimant ids.
 *
 * `crypto.randomUUID` is secure-context only, so it is used when present and
 * otherwise built from `getRandomValues`, which is not restricted — an app has
 * to keep working on a plain-HTTP LAN origin during development.
 */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Constant-time comparison of two strings of the same alphabet.
 *
 * Not currently on any hot path in this package — the store looks secrets up by
 * key rather than comparing them — but exported because a store adapter that
 * scans will need it, and hand-rolling this is how timing leaks appear.
 */
export function safeEqual(a: string, b: string): boolean {
  // Length is folded into the result rather than short-circuiting on it: an
  // early return would leak the length through timing.
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
