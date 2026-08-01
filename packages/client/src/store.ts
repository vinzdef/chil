/**
 * The smallest observable that `useSyncExternalStore` will accept, and the
 * reason the sessions in this package are framework-free.
 *
 * The one rule, and it is the trap: **`getState` must return the same object
 * reference until something actually changes.** React calls it on every render
 * and compares by identity; hand back a fresh object each time and it re-renders
 * forever. `set` below is what enforces that — it replaces the snapshot only
 * when a field differs.
 */
export interface Observable<T> {
  getState(): T;
  subscribe(listener: () => void): () => void;
}

export interface Store<T extends object> extends Observable<T> {
  set(patch: Partial<T>): void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    set(patch) {
      let changed = false;
      for (const key of Object.keys(patch) as (keyof T)[]) {
        if (!Object.is(state[key], patch[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;

      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
  };
}
