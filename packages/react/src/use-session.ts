import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Observable } from 'chil-client';

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
 * The `version` counter exists for remounts. `destroy()` is terminal, so a
 * component that unmounts and mounts again — StrictMode in development, an
 * offscreen tree in production — would otherwise resurrect a dead session.
 * Bumping it in cleanup forces a fresh one on the way back in.
 */
export function useSession<S extends Lifecycle<unknown>>(
  create: () => S,
  deps: unknown[],
): [S, StateOf<S>] {
  const [version, setVersion] = useState(0);

  // Held in a ref so a caller passing an inline arrow does not rebuild the
  // session on every render.
  const createRef = useRef(create);
  createRef.current = create;

  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the caller's
  const session = useMemo(() => createRef.current(), [...deps, version]);

  useEffect(() => {
    session.start();
    return () => {
      session.destroy();
      setVersion((v) => v + 1);
    };
  }, [session]);

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
