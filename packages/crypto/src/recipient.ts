import { fromBase64url, toBase64url } from './base64.js';
import { asBytes, toBytes, type Bytes } from './bytes.js';
import { exportPublic, generateRecipient, importPublic, sharedKey } from './derive.js';
import { CryptoFailure } from './errors.js';
import { HEADER_BYTES, keyIdFor, readHeader, sameKeyId } from './format.js';
import { indexedDbKeyStore, memoryKeyStore, type KeyStore } from './keystore.js';

export interface Recipient {
  /** base64url. This is what goes in the URL fragment. */
  readonly publicKey: string;
  /** base64url of the four-byte id, for matching a stored item to this device. */
  readonly keyId: string;
  /**
   * Unseals bytes.
   *
   * Bytes that were never sealed are returned unchanged, so this is safe to
   * point at an entire queue during a rollout, or after turning encryption off.
   */
  decrypt(data: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array>;
  decryptText(text: string): Promise<string>;
  /**
   * Whether this device can unseal these bytes, without attempting it.
   *
   * For a list view: it distinguishes "sealed to a key this device no longer
   * has" from "corrupt", which are different things to tell an requester.
   */
  canDecrypt(data: Uint8Array): { ok: true } | { ok: false; reason: 'wrong-key' | 'corrupt' };
}

export interface RecipientOptions {
  /**
   * Which key this is. One per tenant or room — a device that serves two
   * of them under separate credentials should not share one key between them.
   */
  scope?: string;
  /** Defaults to IndexedDB in a browser, and throws where there is none. */
  store?: KeyStore;
}

/**
 * The requester's side: loads this device's keypair, or makes one.
 *
 * The private half is generated non-extractable and stored as a `CryptoKey`
 * handle — it never exists as bytes in JavaScript. See `derive.ts` for why that
 * matters and `keystore.ts` for exactly how long it survives, which is the part
 * worth reading before enabling any of this.
 *
 * There is deliberately no export, backup or escrow. Any of them would require
 * an extractable key, which is the property this is built on.
 */
export async function createRecipient(options: RecipientOptions = {}): Promise<Recipient> {
  const scope = options.scope ?? 'default';
  const store = options.store ?? defaultStore();

  let stored = await store.get(scope);
  if (!stored) {
    const pair = await generateRecipient();
    stored = {
      scope,
      privateKey: pair.privateKey,
      publicKeyRaw: await exportPublic(pair.publicKey),
    };
    await store.put(stored);
  }

  const { privateKey, publicKeyRaw } = stored;
  const keyId = await keyIdFor(publicKeyRaw);

  async function open(bytes: Bytes): Promise<Uint8Array> {
    // Throws `unsupported-version`; returns null for anything never sealed.
    const header = readHeader(bytes);
    if (!header) return bytes;

    if (!sameKeyId(header.keyId, keyId)) throw new CryptoFailure('wrong-key');

    let epk: CryptoKey;
    try {
      epk = await importPublic(header.epk);
    } catch {
      throw new CryptoFailure('corrupt');
    }

    const key = await sharedKey(privateKey, epk, publicKeyRaw, header.epk, ['decrypt']);

    try {
      const plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: header.iv,
          additionalData: asBytes(bytes.subarray(0, HEADER_BYTES)),
        },
        key,
        bytes.subarray(HEADER_BYTES),
      );
      return new Uint8Array(plain);
    } catch {
      // AES-GCM refuses without saying why, and it is right not to: a truncated
      // upload and a deliberately altered one are the same event here.
      throw new CryptoFailure('corrupt');
    }
  }

  return {
    publicKey: toBase64url(publicKeyRaw),
    keyId: toBase64url(keyId),

    async decrypt(data) {
      return open(await toBytes(data));
    },

    async decryptText(text) {
      const bytes = fromBase64url(text);
      if (!bytes) throw new CryptoFailure('corrupt');
      return new TextDecoder().decode(await open(asBytes(bytes)));
    },

    canDecrypt(bytes) {
      let header;
      try {
        header = readHeader(asBytes(bytes));
      } catch {
        return { ok: false, reason: 'corrupt' };
      }
      // Never sealed: readable as-is.
      if (!header) return { ok: true };
      if (!sameKeyId(header.keyId, keyId)) return { ok: false, reason: 'wrong-key' };
      return { ok: true };
    },
  };
}

function defaultStore(): KeyStore {
  if (typeof indexedDB !== 'undefined') return indexedDbKeyStore();
  // Node, a worker without IndexedDB, or a browser with storage disabled.
  // Deliberately not a silent fall back to memory: a key that quietly stops
  // persisting means files that quietly stop being readable.
  throw new Error(
    'no IndexedDB available — pass a store explicitly, e.g. createRecipient({ store: memoryKeyStore() })',
  );
}

export { memoryKeyStore };
