/**
 * Structural types for the optional encryption layer.
 *
 * Declared here, rather than imported, so that `@chiljs/client` never depends
 * on `@chiljs/crypto`. An application that does not encrypt should not ship a
 * cipher, and an application that wants a different construction than the one
 * `@chiljs/crypto` offers should be able to supply it by satisfying these two
 * shapes.
 */

export interface SealerLike {
  encrypt(data: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array>;
  encryptText(text: string): Promise<string>;
}

export interface RecipientLike {
  /** base64url, as it will appear in the URL fragment. */
  readonly publicKey: string;
}

/** The fragment parameter carrying the recipient's public key. */
export const KEY_FRAGMENT_PARAM = 'k';
