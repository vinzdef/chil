/** base64url, no padding. Local rather than shared, to keep this package standalone. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const LOOKUP = /* @__PURE__ */ (() => {
  const table = new Uint8Array(128).fill(255);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function toBase64url(bytes: Uint8Array): string {
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

/** Returns null rather than throwing: the input is usually a URL fragment. */
export function fromBase64url(text: string): Uint8Array | null {
  const length = text.length;
  if (length % 4 === 1) return null;

  const bytes = new Uint8Array(Math.floor((length * 3) / 4));
  let at = 0;
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? LOOKUP[code]! : 255;
    if (value === 255) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, at);
}
