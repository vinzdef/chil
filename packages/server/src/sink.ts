import type { ErrorReason } from '@chiljs/core';

export interface StoreContext {
  room: string;
  /** Free text the uploader typed, already trimmed and length-capped. */
  label: string;
  /**
   * Correlation id for the code this upload came through.
   *
   * Worth persisting next to the file: it is the only place the two ends of the
   * exchange meet, so an event emitted later — a print, a download, a
   * confirmation — can still be tied back to the handoff.
   */
  flow: string;
  /** The `Content-Type` the device claimed. Untrusted; recorded, not believed. */
  declaredType: string | null;
  /** The cap already being enforced on `body`, for sizing a buffer. */
  limitBytes: number;
}

export type SinkResult =
  | { ok: true; id: string; size: number; mime?: string }
  | { ok: false; reason: ErrorReason };

/**
 * Where the bytes go.
 *
 * Deliberately the only thing this package does not implement: a filesystem
 * queue, S3, a database blob and a print spooler are all reasonable, and none
 * of them belongs in a protocol library.
 *
 * Two things the contract asks of an implementation:
 *
 * 1. **Let `BodyRejected` propagate.** The stream errors when the upload
 *    exceeds the byte cap or fails the format check. Clean up the partial write
 *    in a `finally` and rethrow; swallowing it stores a truncated file and
 *    reports success.
 * 2. **Be prepared to be called and then not consumed.** The token is spent
 *    only after this resolves, so a caller whose connection drops afterwards
 *    will retry, and the retry arrives here again.
 *
 * The token never appears in `StoreContext`. The authoriser has no business in
 * the layer that writes to disk, and keeping it out means a sink cannot log it
 * by accident.
 */
export interface Sink {
  store(ctx: StoreContext, body: ReadableStream<Uint8Array>): Promise<SinkResult>;
}
