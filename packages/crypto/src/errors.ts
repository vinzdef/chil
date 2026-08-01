/**
 * Why a decryption did not happen.
 *
 * Codes rather than sentences, for the same reason `ErrorReason` is: the
 * wording, and the language, belong to the application. These are the four
 * cases an requester's dashboard has to be able to tell apart.
 */
export type CryptoReason =
  /**
   * This device has no private key at all.
   *
   * A fresh browser profile, cleared site data, or a replacement device. New
   * uploads will work — a keypair is generated on demand — but anything already
   * queued was sealed to a key that no longer exists.
   */
  | 'no-key'
  /**
   * Sealed to a different key than this device holds.
   *
   * Detected from the key id in the header, before any attempt to decrypt, so
   * it is distinguishable from corruption rather than surfacing as a generic
   * failure.
   */
  | 'wrong-key'
  /** Truncated, tampered with, or not a sealed blob at all. */
  | 'corrupt'
  /** Sealed by a newer version of this library than is running here. */
  | 'unsupported-version';

export class CryptoFailure extends Error {
  constructor(readonly reason: CryptoReason) {
    super(reason);
    this.name = 'CryptoFailure';
  }
}
