import { retryable, type ErrorReason, type MintResult } from '@chiljs/core';
import { KEY_FRAGMENT_PARAM, type RecipientLike } from './sealing.js';
import { createStore, type Observable } from './store.js';
import { ChilError, handoffUrl, type Transport } from './transport.js';

/**
 * What the server last said about the code on screen.
 *
 * `claimed` is deliberately not a way of dying: the code is still valid, the
 * person on the other device is still using it, and the reason to surface it is
 * the opposite one — so the requester stops offering this code to the next
 * person in the queue rather than assuming it failed.
 */
export type HandoffPhase = 'minting' | 'live' | 'claimed' | 'received' | 'expired' | 'invalid' | 'failed';

export interface HandoffState {
  phase: HandoffPhase;
  token: string | null;
  /**
   * The string to hand to the client — render it as a QR, send it as a link.
   * Null while minting or after a failure.
   */
  url: string | null;
  flow: string | null;
  /**
   * Local wall-clock deadline, computed from the returned duration rather than
   * sent as one: the requester's clock may differ from the server's, and a
   * skewed one would show a live code as already expired.
   */
  expiresAt: number | null;
  /** No longer usable, whatever the reason. The code should be covered. */
  dead: boolean;
}

export type HandoffEvent =
  | { type: 'minted'; token: string; flow: string }
  | { type: 'mint-failed' }
  | { type: 'claimed'; flow: string }
  | { type: 'received'; flow: string }
  | { type: 'expired'; flow: string };

export interface HandoffSessionOptions {
  /**
   * Asks *your* server for a code.
   *
   * A callback rather than a route in this package, because minting must sit
   * behind your authentication. See `createMintHandler` in `@chiljs/server`.
   */
  mint: (signal?: AbortSignal) => Promise<MintResult>;
  transport: Transport;
  /** Defaults to `handoffUrl({ token })` — this origin, `/upload`. */
  buildUrl?: (token: string) => string;
  /**
   * Puts this device's public key in the URL fragment, so the client can seal the
   * upload to it and the server stores something it cannot read.
   *
   * Ignored when `buildUrl` is supplied — build the fragment yourself with
   * `handoffUrl({ fragment: { k: recipient.publicKey } })`, or the key silently
   * stops travelling and the uploads arrive in the clear.
   */
  recipient?: RecipientLike;
  /** How often to ask whether the displayed code is still live. */
  pollMs?: number;
  now?: () => number;
  onEvent?: (event: HandoffEvent) => void;
}

export interface HandoffSession extends Observable<HandoffState> {
  /** Mints the first code and begins polling. Idempotent. */
  start(): void;
  /** Mints a fresh code. The previous one stays valid for its remaining life. */
  regenerate(): void;
  destroy(): void;
}

/**
 * Owns the requester's side: one code on screen, and the truth about it.
 *
 * Polling is not optional decoration. Tokens are single-use, so the code on
 * screen dies the moment someone's file lands — and nothing about this device's
 * own state says so. Without the poll the requester keeps holding up a dead code
 * for the next person in line.
 *
 * Watching the sink cannot answer this either: a code minted earlier stays
 * valid for its remaining life, so a file arriving is not proof that *this*
 * code was the one used. Asking about the token itself is.
 */
export function createHandoffSession(options: HandoffSessionOptions): HandoffSession {
  const { mint, transport, buildUrl, recipient, onEvent } = options;
  const pollMs = options.pollMs ?? 5000;
  const now = options.now ?? (() => Date.now());
  const toUrl =
    buildUrl ??
    ((token: string) =>
      handoffUrl({
        token,
        fragment: recipient ? { [KEY_FRAGMENT_PARAM]: recipient.publicKey } : undefined,
      }));

  const store = createStore<HandoffState>({
    phase: 'minting',
    token: null,
    url: null,
    flow: null,
    expiresAt: null,
    dead: false,
  });

  let controller = new AbortController();
  let poll: ReturnType<typeof setInterval> | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let destroyed = false;

  const emit = (event: HandoffEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      /* observation must never retire a live code */
    }
  };

  const stopTimers = (): void => {
    if (poll !== null) clearInterval(poll);
    if (expiry !== null) clearTimeout(expiry);
    poll = null;
    expiry = null;
  };

  const settle = (phase: HandoffPhase): void => {
    stopTimers();
    store.set({ phase, dead: true });
  };

  function watch(token: string): void {
    stopTimers();
    const deadline = store.getState().expiresAt;
    if (deadline !== null) {
      const remaining = deadline - now();
      const fire = (): void => {
        const { flow } = store.getState();
        settle('expired');
        if (flow) emit({ type: 'expired', flow });
      };
      if (remaining <= 0) {
        fire();
        return;
      }
      expiry = setTimeout(fire, remaining);
    }

    poll = setInterval(() => {
      void transport.check(token, controller.signal).then(
        (state) => {
          if (destroyed || store.getState().token !== token) return;
          // A claim says a client has taken it, which is worth showing but
          // changes nothing about the code itself. Polling continues.
          const claimed = state.claimed;
          const previous = store.getState().phase;
          store.set({ phase: claimed ? 'claimed' : 'live' });
          const { flow } = store.getState();
          if (claimed && previous !== 'claimed' && flow) emit({ type: 'claimed', flow });
        },
        (err: unknown) => {
          if (destroyed || store.getState().token !== token) return;
          const reason: ErrorReason = err instanceof ChilError ? err.reason : 'server-error';
          // Only a verdict on the token retires the code. A request that never
          // arrived says the link is flaky, not that the code was used —
          // blanking a live code over a dropped poll would send someone back to
          // the queue for nothing.
          if (retryable[reason]) return;

          const { flow } = store.getState();
          if (reason === 'already-sent') {
            // The server's tombstone for a token it actually spent, which is
            // what makes success truthful: a restart that lost the token
            // answers `invalid-token` and lands in `invalid`, not in a panel
            // claiming a file that never arrived.
            settle('received');
            if (flow) emit({ type: 'received', flow });
            return;
          }
          settle('invalid');
        },
      );
    }, pollMs);
  }

  function regenerate(): void {
    if (destroyed) return;
    controller.abort();
    controller = new AbortController();
    stopTimers();
    store.set({
      phase: 'minting',
      token: null,
      url: null,
      flow: null,
      expiresAt: null,
      dead: false,
    });

    mint(controller.signal).then(
      (result) => {
        if (destroyed) return;
        store.set({
          phase: 'live',
          token: result.token,
          url: toUrl(result.token),
          flow: result.flow,
          expiresAt: now() + result.expiresInMs,
          dead: false,
        });
        // Once per code that actually exists, carrying that code's own flow id.
        // A mint that failed reports nothing, because it produced no code.
        emit({ type: 'minted', token: result.token, flow: result.flow });
        watch(result.token);
      },
      () => {
        if (destroyed) return;
        store.set({ phase: 'failed', dead: true });
        emit({ type: 'mint-failed' });
      },
    );
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,

    start() {
      if (started || destroyed) return;
      started = true;
      regenerate();
    },

    regenerate,

    destroy() {
      destroyed = true;
      stopTimers();
      controller.abort();
    },
  };
}
