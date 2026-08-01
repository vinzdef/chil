import { useCallback, useMemo, useRef } from 'react';
import {
  createHandoffSession,
  type MintResult,
  type HandoffEvent,
  type HandoffState,
  type Transport,
} from '@chiljs/client';
import { useSession } from './use-session.js';

export interface UseHandoffSessionOptions {
  /** Calls your authenticated mint endpoint. See `createMintHandler`. */
  mint: (signal?: AbortSignal) => Promise<MintResult>;
  transport: Transport;
  buildUrl?: (token: string) => string;
  pollMs?: number;
  onEvent?: (event: HandoffEvent) => void;
}

export interface UseHandoffSession extends HandoffState {
  /** Mints a fresh code. The current one is not revoked; it simply ages out. */
  regenerate: () => void;
}

/**
 * The requester's panel.
 *
 * Mints on mount, polls while a code is on screen, and reports what the server
 * says about it. `url` is the string to hand to the client — render it as a QR,
 * send it as a link — with whatever you already have, since this package ships
 * no renderer.
 *
 * `phase` distinguishes `received` from `expired` from `invalid` on purpose:
 * they call for different words and different next moves. A code that did its
 * job needs no "generate another" button, because the requester's next move is
 * to close the panel.
 */
export function useHandoffSession(options: UseHandoffSessionOptions): UseHandoffSession {
  const { mint, transport, buildUrl, pollMs } = options;

  const onEvent = useRef(options.onEvent);
  onEvent.current = options.onEvent;

  const mintRef = useRef(mint);
  mintRef.current = mint;

  const [session, state] = useSession(
    () =>
      createHandoffSession({
        // Through a ref: a caller writing `mint={() => fetch(...)}` inline
        // would otherwise mint a new code on every render.
        mint: (signal) => mintRef.current(signal),
        transport,
        buildUrl,
        pollMs,
        onEvent: (event) => onEvent.current?.(event),
      }),
    [transport, buildUrl, pollMs],
  );

  const regenerate = useCallback(() => session.regenerate(), [session]);

  return useMemo(() => ({ ...state, regenerate }), [state, regenerate]);
}
