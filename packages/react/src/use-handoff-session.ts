import { useCallback, useMemo, useRef } from 'react';
import {
  createHandoffSession,
  type MintResult,
  type HandoffEvent,
  type HandoffState,
  type RecipientLike,
  type Transport,
} from '@chiljs/client';
import { useSession } from './use-session.js';

export interface UseHandoffSessionOptions {
  /** Calls your authenticated mint endpoint. See `createMintHandler`. */
  mint: (signal?: AbortSignal) => Promise<MintResult>;
  transport: Transport;
  /** Defaults to `location.origin`. */
  origin?: string;
  /** The page that reads the token and does the upload. Defaults to `/`. */
  path?: string;
  /** Extra query values — a debug flag, a locale. The server sees these. */
  params?: Record<string, string>;
  /** Extra fragment values. The server never sees these. `k` is reserved. */
  fragment?: Record<string, string>;
  /**
   * Puts this device's public key in the URL fragment, so the sender can seal
   * the upload to it. See `useRecipient`, and `@chiljs/crypto`.
   */
  recipient?: RecipientLike;
  pollMs?: number;
  onEvent?: (event: HandoffEvent) => void;
}

export interface UseHandoffSession extends HandoffState {
  /** Mints a fresh code. The current one is not revoked; it simply ages out. */
  regenerate: () => void;
}

/**
 * A record's *contents* as a dependency, since its identity is not one.
 *
 * These are written inline at the call site, so a new object arrives on every
 * render, and a dependency that changes every render mints a code every render.
 * Sorted, or key order alone puts a fresh code on the screen.
 */
function stable(record: Record<string, string> | undefined): string {
  return record ? JSON.stringify(Object.entries(record).sort()) : '';
}

/**
 * The requester's panel.
 *
 * Mints on mount, polls while a code is on screen, and reports what the server
 * says about it. `url` is the string to hand to the sender — render it as a QR,
 * send it as a link — with whatever you already have, since this package ships
 * no renderer.
 *
 * `phase` distinguishes `received` from `expired` from `invalid` on purpose:
 * they call for different words and different next moves. A code that did its
 * job needs no "generate another" button, because the requester's next move is
 * to close the panel.
 */
export function useHandoffSession(options: UseHandoffSessionOptions): UseHandoffSession {
  const { mint, transport, origin, path, params, fragment, recipient, pollMs } = options;

  const onEvent = useRef(options.onEvent);
  onEvent.current = options.onEvent;

  const mintRef = useRef(mint);
  mintRef.current = mint;

  const [session, state] = useSession(
    () =>
      createHandoffSession({
        // `mint` reaches the session through a ref. A caller writing it inline —
        // `mint={() => fetch(...)}` — hands over a new identity on every render,
        // and a dependency that changes every render rebuilds the session on
        // every render.
        mint: (signal) => mintRef.current(signal),
        transport,
        origin,
        path,
        params,
        fragment,
        recipient,
        pollMs,
        onEvent: (event) => onEvent.current?.(event),
      }),
    // The URL's *values* are the dependencies, not the handles carrying them. A
    // ref would be the wrong instrument: what a ref buys is immunity to identity
    // churn, and these are strings. They must reach the screen, because a code
    // displayed with a stale fragment is a code whose uploads seal to a key this
    // device may no longer hold.
    [transport, origin, path, stable(params), stable(fragment), recipient?.publicKey, pollMs],
  );

  const regenerate = useCallback(() => session.regenerate(), [session]);

  return useMemo(() => ({ ...state, regenerate }), [state, regenerate]);
}
