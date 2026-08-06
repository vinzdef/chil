import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Observable } from '@chiljs/client';

interface Lifecycle<T> extends Observable<T> {
  start(): void;
  destroy(): void;
}

/**
 * The session's own state type, read back off the session rather than passed
 * in, so callers write `useSession(() => createUploadSession(...), deps)` with
 * no type arguments and still get `UploadState` out.
 */
type StateOf<S> = S extends { getState(): infer T } ? T : never;

/**
 * Binds one of the framework-free sessions to React.
 *
 * `useSyncExternalStore` rather than a `useState` mirror: the session already
 * owns the state, and copying it into React would introduce a second source of
 * truth that can tear. This is also why the sessions cache their snapshot —
 * `getState` returning a fresh object each call makes this hook loop forever.
 *
 * The session is built by the effect that starts it. `destroy()` is terminal
 * and an effect can be torn down and re-run without the component's state
 * resetting — StrictMode in development, a hidden tree in production — so each
 * run needs a session of its own rather than the one the last run killed.
 *
 * Building it here rather than in a render-phase memo is what keeps the cleanup
 * free of state writes. A cleanup that writes a value the effect depends on
 * schedules the next cleanup, and that has no fixed point.
 */
export function useSession<S extends Lifecycle<unknown>>(
  create: () => S,
  deps: unknown[],
): [S, StateOf<S>] {
  // Held in a ref so a caller passing an inline arrow does not rebuild the
  // session on every render.
  const createRef = useRef(create);
  createRef.current = create;

  // Seeded during render so the first pass reads a real state rather than a
  // placeholder. This one is never started; the effect replaces it with the
  // session it owns, which begins in the same state.
  const [session, setSession] = useState<S>(() => createRef.current());

  useEffect(() => {
    const active = createRef.current();
    setSession(active);
    active.start();
    return () => active.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the caller's
  }, deps);

  // The cast bridges the constraint and the conditional: `S extends
  // Lifecycle<unknown>` is what lets any session satisfy this, and it is also
  // what stops TypeScript seeing that `getState` returns `StateOf<S>`.
  const state = useSyncExternalStore(
    session.subscribe,
    session.getState,
    session.getState,
  ) as StateOf<S>;
  return [session, state];
}
