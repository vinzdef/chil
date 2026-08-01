import { toBase64url, fromBase64url } from './base64.js';
import { asBytes, toBytes, type Bytes } from './bytes.js';
import { exportPublic, generateEphemeral, importPublic, sharedKey } from './derive.js';
import { CryptoFailure } from './errors.js';
import { IV_BYTES, keyIdFor, writeHeader } from './format.js';

export interface Sealer {
  /** Seals bytes. The result is self-contained — see `format.ts`. */
  encrypt(data: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array>;
  /** Seals a string to base64url, for the upload label. */
  encryptText(text: string): Promise<string>;
}

/**
 * The uploading side.
 *
 * Takes the recipient's public key, exactly as it arrived in the URL fragment,
 * and needs nothing else — no network, no server, no shared state. That is the
 * property that makes this end-to-end: this half of the exchange never talks to
 * anything.
 *
 * One ephemeral keypair per sealer, reused across the file and the label with
 * a fresh IV each time. Reusing an IV under one key would be catastrophic for
 * AES-GCM, which is why every call draws a new one from `getRandomValues` and
 * there is no way to supply your own.
 */
export async function createSealer(recipientPublicKey: string): Promise<Sealer> {
  const recipientRaw = fromBase64url(recipientPublicKey);
  if (!recipientRaw) throw new CryptoFailure('corrupt');

  let recipientKey: CryptoKey;
  try {
    recipientKey = await importPublic(recipientRaw);
  } catch {
    // Not a point on the curve. Usually a truncated scan or a mangled link.
    throw new CryptoFailure('corrupt');
  }

  const ephemeral = await generateEphemeral();
  const epkRaw = await exportPublic(ephemeral.publicKey);
  const keyId = await keyIdFor(recipientRaw);

  const key = await sharedKey(ephemeral.privateKey, recipientKey, recipientRaw, epkRaw, [
    'encrypt',
  ]);

  async function seal(plaintext: Bytes): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const header = writeHeader({ keyId: asBytes(keyId), epk: asBytes(epkRaw), iv });

    // The header is authenticated but not encrypted: tampering with the key id
    // or the ephemeral key breaks the tag rather than producing a plausible
    // decryption against some other key.
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: header },
      key,
      plaintext,
    );

    const out = new Uint8Array(header.length + sealed.byteLength);
    out.set(header, 0);
    out.set(new Uint8Array(sealed), header.length);
    return out;
  }

  return {
    async encrypt(data) {
      return seal(await toBytes(data));
    },

    async encryptText(text) {
      return toBase64url(await seal(new TextEncoder().encode(text)));
    },
  };
}

/**
 * Reads the recipient's public key out of a URL fragment.
 *
 * The fragment is where it has to be. A browser never sends `#…` to the server,
 * so the key reaches this page in the URL itself and the server that stores the
 * ciphertext never sees it. Put the same value in the query string and the
 * encryption is decorative.
 *
 * Returns null when there is none, which is the unencrypted case.
 */
export function keyFromFragment(hash = globalThis.location?.hash ?? ''): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const found = new URLSearchParams(raw).get('k');
  return found && found.length > 0 ? found : null;
}
