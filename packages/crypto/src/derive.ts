import { asBytes } from './bytes.js';

export const CURVE = 'P-256';

const ALGORITHM = { name: 'ECDH', namedCurve: CURVE } as const;

export function generateEphemeral(): Promise<CryptoKeyPair> {
  // Extractable, unlike the recipient's: the public half has to be exported
  // into the blob header. Only the public half is ever read back.
  return crypto.subtle.generateKey(ALGORITHM, true, ['deriveBits']) as Promise<CryptoKeyPair>;
}

export function generateRecipient(): Promise<CryptoKeyPair> {
  /*
   * `extractable: false`. This is the single most important line in the
   * package: the private key never exists as bytes anywhere in JavaScript —
   * not at generation, not at rest in IndexedDB, not in use. It is handed to
   * `deriveBits` as an opaque handle and the browser does the maths internally.
   *
   * The consequence worth understanding: script on the page can *use* the key
   * while the page is open, but cannot export it. An XSS becomes a session-long
   * problem rather than a permanent key compromise. Making this `true` to add a
   * backup or export feature gives that back.
   */
  return crypto.subtle.generateKey(ALGORITHM, false, ['deriveBits']) as Promise<CryptoKeyPair>;
}

export function importPublic(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asBytes(raw), ALGORITHM, true, []);
}

export async function exportPublic(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

/**
 * The shared AES-GCM key, from one side's private key and the other's public.
 *
 * HKDF rather than the raw ECDH output: WebCrypto's `deriveKey` for ECDH hands
 * back the x-coordinate of the shared point with no key derivation applied,
 * which is usable but is not what anyone wants to be defending later. `info`
 * binds both public keys into the derivation, so a shared secret can only ever
 * produce a key for the pair it actually belongs to.
 */
export async function sharedKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  recipientRaw: Uint8Array,
  epkRaw: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);

  // The label is domain separation and is part of the wire format: change it
  // and every key derived before the change stops being reachable. The trailing
  // digit is the version to bump if the derivation itself ever changes.
  const LABEL = [0x63, 0x68, 0x69, 0x6c, 0x31]; // "chil1"
  const info = new Uint8Array(LABEL.length + recipientRaw.length + epkRaw.length);
  info.set(LABEL, 0);
  info.set(recipientRaw, LABEL.length);
  info.set(epkRaw, LABEL.length + recipientRaw.length);

  const ikm = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}
