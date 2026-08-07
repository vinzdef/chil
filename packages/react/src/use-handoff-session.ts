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
  const { mint, transport, pollMs } = options;

  const onEvent = useRef(options.onEvent);
  onEvent.current = options.onEvent;

  const mintRef = useRef(mint);
  mintRef.current = mint;

  const buildUrlRef = useRef(options.buildUrl);
  buildUrlRef.current = options.buildUrl;

  // *Whether* a builder was supplied is a dependency; *which* builder it is, is
  // not. Passing a wrapper unconditionally would override the session's own
  // default, and the shape of the default URL belongs there.
  const custom = options.buildUrl !== undefined;

  const [session, state] = useSession(() => {
    // The builder in force when this session was made. A wrapper outliving the
    // prop that justified it still has something to call.
    const atCreation = buildUrlRef.current;
    return createHandoffSession({
      // Every callback reaches the session through a ref. A caller writing one
      // of these inline — `mint={() => fetch(...)}`, `buildUrl={(t) =>
      // handoffUrl({ token: t })}` — hands over a new identity on every render,
      // and a dependency that changes every render rebuilds the session on
      // every render.
      mint: (signal) => mintRef.current(signal),
      transport,
      // Held this way, a genuinely changed builder also leaves the code on
      // screen alone and applies at the next mint, which is how `mint` itself
      // already behaves: swapping a callback is not a reason to discard a live
      // code and make someone read a new one off the screen.
      buildUrl:
        atCreation === undefined
          ? undefined
          : (token: string) => (buildUrlRef.current ?? atCreation)(token),
      pollMs,
      onEvent: (event) => onEvent.current?.(event),
    });
  }, [transport, custom, pollMs]);

  const regenerate = useCallback(() => session.regenerate(), [session]);

  return useMemo(() => ({ ...state, regenerate }), [state, regenerate]);
}
