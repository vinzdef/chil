import { parseToken, retryable, type ErrorReason } from '@chiljs/core';
import { claimantId } from './claimant-id.js';
import type { SealerLike } from './sealing.js';
import { createStore, type Observable } from './store.js';
import { ChilError, type Transport } from './transport.js';

export type UploadPhase = 'checking' | 'ready' | 'sending' | 'sent' | 'error';

export interface UploadState {
  phase: UploadPhase;
  /** 0 to 1. Only meaningful while `sending`. */
  progress: number;
  reason: ErrorReason | null;
  /** Whether the current failure is worth offering a retry for. */
  canRetry: boolean;
  /** Learned by claiming. Safe to send to analytics; the claimant id is not. */
  flow: string | null;
  room: string | null;
  /** The sink's id for the stored file, once it has arrived. */
  id: string | null;
}

export type UploadEvent =
  | { type: 'claimed'; flow: string; first: boolean }
  | { type: 'claim-failed'; reason: ErrorReason }
  | { type: 'upload-started'; flow: string | null }
  | { type: 'upload-succeeded'; flow: string | null; id: string | null }
  | { type: 'upload-failed'; flow: string | null; reason: ErrorReason };

export interface UploadSessionOptions {
  /** Read from the scanned URL. Null or malformed lands in `error`. */
  token: string | null;
  transport: Transport;
  /** Override only for tests; the default is derived from the token. */
  claimant?: string;
  /**
   * Encrypts the file and the label before they leave the device.
   *
   * Built from the recipient's public key in the URL fragment, which the server
   * never sees — so with this set, the server stores bytes it cannot read. See
   * `@chiljs/crypto`.
   *
   * Three things change when this is on, and none is the library's to hide:
   *
   * - the server can no longer `inspect` the format of what it stores, because
   *   ciphertext has no *image* magic bytes — use `sealedOnly()` instead, which
   *   checks that a body is sealed at all;
   * - a recipient that loses its key can no longer read what is already queued;
   * - **the label gets much longer.** An 85-byte header, a 16-byte tag and
   *   base64url on top mean a 12-character name arrives as ~150 characters, and
   *   a 60-character one as ~215. Raise `maxLabelLength` on the server to 512
   *   or the label is silently truncated and surfaces as `corrupt` at
   *   decryption time, a long way from the cause.
   */
  seal?: SealerLike;
  /**
   * Refuse to send anything at all unless `seal` is present.
   *
   * Set this wherever the deployment is encrypted. The recipient's key travels
   * in the URL fragment, and link rewriters, chat preview generators and URL
   * shorteners all strip fragments — so `seal` can be undefined for reasons
   * that have nothing to do with the page and everything to do with how the
   * link reached it. Supplying your own `buildUrl` to the handoff session drops
   * the key the same way.
   *
   * Without this, either of those silently downgrades the upload to plaintext.
   * With it, the session refuses in `error` with `seal-required` and never
   * issues a request.
   *
   * This is the courtesy half of the guarantee, not the guarantee: it saves the
   * person from uploading a file only to have it rejected. The enforcement is
   * `sealedOnly()` from `@chiljs/crypto`, on the server, where a client cannot
   * decline to participate.
   */
  requireSeal?: boolean;
  /**
   * Observation only — analytics, logging. Never awaited, and a throw here
   * cannot fail an upload.
   */
  onEvent?: (event: UploadEvent) => void;
}

export interface UploadSession extends Observable<UploadState> {
  /** Claims the code. Idempotent; safe to call from an effect that re-runs. */
  start(): void;
  /** Sends one file. Allowed from `ready` and from a retryable `error`. */
  send(body: Blob | ArrayBuffer | Uint8Array, options?: { label?: string }): void;
  /** Abandons any in-flight request. The session is unusable afterwards. */
  destroy(): void;
}

/**
 * Owns one uploader's side of the exchange.
 *
 * The code is claimed once on load, before a form is worth offering: tokens are
 * single-use, so without this a page reloaded after a successful send would
 * present a working form and only refuse at the end — after the file had been
 * picked, named and uploaded.
 *
 * A failed send stays recoverable. The server consumes the token only on
 * success, so the same code still works and retrying is pressing send again.
 */
export function createUploadSession(options: UploadSessionOptions): UploadSession {
  const { token, transport, onEvent } = options;
  const parsed = token ? parseToken(token) : null;

  const store = createStore<UploadState>({
    phase: token && parsed ? 'checking' : 'error',
    progress: 0,
    reason: token && parsed ? null : 'invalid-token',
    canRetry: false,
    flow: null,
    // The token is `<room>.<secret>`, so the page knows its room without asking
    // anyone. A token too malformed to split leaves it null; that upload is
    // refused anyway.
    room: parsed?.room ?? null,
    id: null,
  });

  const claimant = options.claimant ?? (token ? claimantId(token) : '');
  const controller = new AbortController();
  let started = false;
  let destroyed = false;

  const emit = (event: UploadEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      /* observation must never break the exchange */
    }
  };

  const reasonOf = (err: unknown): ErrorReason =>
    err instanceof ChilError ? err.reason : 'server-error';

  function start(): void {
    if (started || destroyed || !token || !parsed) return;
    started = true;

    transport.claim(token, claimant, controller.signal).then(
      (claimed) => {
        if (destroyed) return;
        store.set({ phase: 'ready', flow: claimed.flow, reason: null, canRetry: false });
        emit({ type: 'claimed', flow: claimed.flow, first: claimed.first });
      },
      (err: unknown) => {
        if (destroyed) return;
        const reason = reasonOf(err);
        emit({ type: 'claim-failed', reason });

        // A reload after a successful send. The file arrived, so say so —
        // reporting a broken link here would report a failure that never
        // happened.
        if (reason === 'already-sent') {
          store.set({ phase: 'sent', reason: null, progress: 1 });
          return;
        }
        // Only a verdict on the token itself blocks the form. A claim that
        // could not complete — offline client, server hiccup — must not lock out
        // someone holding a perfectly good code; the upload claims again
        // anyway, with the same claimant id, so nothing is lost but the flow id.
        if (retryable[reason]) {
          store.set({ phase: 'ready', reason: null, canRetry: false });
          return;
        }
        store.set({ phase: 'error', reason, canRetry: false });
      },
    );
  }

  function send(body: Blob | ArrayBuffer | Uint8Array, sendOptions: { label?: string } = {}): void {
    if (destroyed || !token) return;
    const { phase, flow } = store.getState();
    if (phase !== 'ready' && phase !== 'error') return;

    // Before anything leaves the device. A sealed deployment that lost its key
    // in transit must fail here, not send the file in the clear.
    if (options.requireSeal && !options.seal) {
      store.set({ phase: 'error', reason: 'seal-required', canRetry: false, progress: 0 });
      emit({ type: 'upload-failed', flow, reason: 'seal-required' });
      return;
    }

    store.set({ phase: 'sending', progress: 0, reason: null, canRetry: false });
    // A retry is a second attempt and counts as one: the ratio worth reading is
    // attempts to arrivals, not people to arrivals.
    emit({ type: 'upload-started', flow });

    // Sealing happens here rather than at the call site so that turning
    // encryption on does not change how anything calls `send`. It is deliberately
    // inside the `sending` phase: on a large file it is slow enough to see, and
    // showing a progress bar that has not started is better than a button that
    // appears to have done nothing.
    const prepared = options.seal
      ? Promise.all([
          options.seal.encrypt(body),
          sendOptions.label ? options.seal.encryptText(sendOptions.label) : undefined,
        ])
      : Promise.resolve([body, sendOptions.label] as const);

    prepared
      .then(([sealedBody, sealedLabel]) =>
        transport.upload({
          token: token,
          claimant,
          label: sealedLabel,
          body: sealedBody,
          // A sealed body is ciphertext. Saying `image/jpeg` would be a lie the
          // recipient might act on, and the server cannot check it either way.
          contentType: options.seal ? 'application/octet-stream' : undefined,
          onProgress: (fraction) => {
            if (!destroyed) store.set({ progress: fraction });
          },
          signal: controller.signal,
        }),
      )
      .then(
        (result) => {
          if (destroyed) return;
          store.set({ phase: 'sent', progress: 1, id: result.id });
          emit({ type: 'upload-succeeded', flow, id: result.id });
        },
        (err: unknown) => {
          if (destroyed) return;
          const reason = reasonOf(err);

          // The upload landed and the reply did not: the connection dropped
          // after the server had stored the file and spent the token, so the
          // retry is refused as a duplicate. It arrived, and telling them
          // otherwise sends them back for a fresh code for nothing.
          if (reason === 'already-sent') {
            store.set({ phase: 'sent', progress: 1 });
            // Counted as arrived, because it did. The attempt that actually
            // dropped already reported itself as failed.
            emit({ type: 'upload-succeeded', flow, id: null });
            return;
          }

          store.set({ phase: 'error', reason, canRetry: retryable[reason] });
          // The reason rides along: "eleven failures" and "eleven failures,
          // nine of them an expired code" call for different fixes.
          emit({ type: 'upload-failed', flow, reason });
        },
      );
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    start,
    send,
    destroy() {
      destroyed = true;
      controller.abort();
    },
  };
}
