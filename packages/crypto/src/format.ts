import { asBytes, type Bytes } from './bytes.js';
import { CryptoFailure } from './errors.js';

/**
 * The sealed blob is self-describing:
 *
 *     [0..3)     magic "CHL"      3 bytes
 *     [3]        version          1 byte
 *     [4..8)     recipient key id 4 bytes
 *     [8..73)    ephemeral pubkey 65 bytes, raw uncompressed P-256
 *     [73..85)   IV               12 bytes
 *     [85..]     ciphertext + tag AES-GCM
 *
 * Self-contained on purpose. Nothing about a sealed file needs a sidecar
 * field, a database column or a flag on the sink, which means a queue can hold
 * sealed and unsealed items at once — during a rollout, or after turning the
 * feature off — and each is handled on its own terms.
 *
 * A literal magic rather than a bare version byte, because `decrypt` has to be
 * safe to point at anything: a plain JPEG opens with `0xFF`, which as a version
 * number is both wrong and larger than any this library will issue for a long
 * time. Three bytes that no image format begins with is the difference between
 * passing unsealed data through and refusing it.
 */
export const MAGIC = /* "CHL" */ Uint8Array.from([0x43, 0x48, 0x4c]);
export const VERSION = 1;

export const KEY_ID_BYTES = 4;
export const EPK_BYTES = 65;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

const KEY_ID_AT = MAGIC.length + 1;
const EPK_AT = KEY_ID_AT + KEY_ID_BYTES;
const IV_AT = EPK_AT + EPK_BYTES;
export const HEADER_BYTES = IV_AT + IV_BYTES;

export interface Header {
  version: number;
  keyId: Bytes;
  epk: Bytes;
  iv: Bytes;
}

export function writeHeader(header: Omit<Header, 'version'>): Bytes {
  const bytes = new Uint8Array(HEADER_BYTES);
  bytes.set(MAGIC, 0);
  bytes[MAGIC.length] = VERSION;
  bytes.set(header.keyId, KEY_ID_AT);
  bytes.set(header.epk, EPK_AT);
  bytes.set(header.iv, IV_AT);
  return bytes;
}

function hasMagic(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

/**
 * Null when these bytes were never sealed, which is not an error — it is how
 * an unencrypted item in a mixed queue is recognised and passed through.
 */
export function readHeader(bytes: Bytes): Header | null {
  if (!hasMagic(bytes)) return null;

  const version = bytes[MAGIC.length]!;
  // Past the magic, anything unreadable *is* an error: these bytes claim to be
  // ours.
  if (version > VERSION) throw new CryptoFailure('unsupported-version');
  if (version < VERSION) throw new CryptoFailure('corrupt');
  if (bytes.length < HEADER_BYTES + TAG_BYTES) throw new CryptoFailure('corrupt');

  return {
    version,
    keyId: bytes.subarray(KEY_ID_AT, KEY_ID_AT + KEY_ID_BYTES),
    epk: bytes.subarray(EPK_AT, EPK_AT + EPK_BYTES),
    iv: bytes.subarray(IV_AT, HEADER_BYTES),
  };
}

/**
 * An `inspect` guard that refuses any body which is not sealed.
 *
 * This is how "encrypted deployment" becomes a property of the server rather
 * than a promise the sender makes. If the recipient key is stripped out of the
 * URL fragment in transit, the uploader's page has nothing to seal with — and
 * without this, the plaintext is accepted and stored with nobody the wiser.
 * Here the body is refused before the sink is ever called.
 *
 * Pair it with `requireSeal` on the upload session, which refuses the same case
 * up front so the person is told before sending a file rather than after.
 *
 * ```ts
 * createHandler({ broker, sink, inspect: sealedOnly() });
 * ```
 *
 * Two limits, neither hideable. It cannot check the *payload* format — that is
 * the whole point of encryption, so `inspect` cannot do both jobs. And it stops
 * accidental plaintext, not a forgery: anyone can prepend these four bytes to
 * junk, exactly as they could seal to a key nobody holds. No server that cannot
 * decrypt can tell the difference.
 */
export function sealedOnly(): (head: Uint8Array) => 'bad-type' | null {
  return (head) => {
    if (head.length <= MAGIC.length) return 'bad-type';
    if (!hasMagic(head)) return 'bad-type';
    // Deliberately not upper-bounded against VERSION: the server only stores
    // these bytes, so a sender sealing with a newer version must not be refused
    // by an older server that could have held them perfectly well.
    return head[MAGIC.length]! >= 1 ? null : 'bad-type';
  };
}

export function sameKeyId(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * First four bytes of SHA-256 over the raw public key.
 *
 * Not a security control — it only lets a dashboard say "sealed to a key this
 * device no longer has" instead of "failed to decrypt". Four bytes collide
 * roughly once in four billion, and a collision costs one misleading label
 * before the AEAD refuses anyway.
 */
export async function keyIdFor(publicKeyRaw: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', asBytes(publicKeyRaw));
  return new Uint8Array(digest.slice(0, KEY_ID_BYTES));
}
