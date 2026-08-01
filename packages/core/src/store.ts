export type MaybePromise<T> = T | Promise<T>;

export interface TokenRecord {
  room: string;
  secret: string;
  /** Public correlation id. Authorises nothing. */
  flow: string;
  issuedAt: number;
  expiresAt: number;
  /**
   * The browser that claimed this code, once one has.
   *
   * Undefined until someone opens the upload page or uploads. Not an
   * authorisation — the token is still what authorises — but it stops a second
   * client using a code someone else is already working through.
   */
  claimedBy?: string;
}

/**
 * A token that was actually spent, and when.
 *
 * Deleting on consume would make a token that worked indistinguishable from one
 * that never existed, and both ends have something true to say only if they can
 * tell those apart: the uploader who reloads after sending should be told the
 * file arrived, and the panel should only claim success when there was one.
 */
export interface SpentRecord {
  room: string;
  spentAt: number;
}

export type StoreClaim =
  | { status: 'missing' }
  /** Someone else holds it. `record` is returned so the caller can still read `room`. */
  | { status: 'conflict'; record: TokenRecord }
  | { status: 'ok'; record: TokenRecord; first: boolean };

/**
 * Where tokens live.
 *
 * The default `memoryStore()` is correct for a single process and is what most
 * deployments want — these are secrets with a five-minute life, and persisting
 * them to survive a restart is machinery bought for a cost nobody pays.
 *
 * ## The one rule for other backends
 *
 * **`claim` and `consume` must be atomic.** They are on this interface, rather
 * than being composed in the broker from `get` + `put`, for exactly that
 * reason. In a single process, check-then-write is atomic for free on the event
 * loop. Behind Redis or a KV store it is not: two clients can both read
 * `claimedBy === undefined`, both write, and both believe they hold the code —
 * at which point claiming is decorative and the property it exists to provide
 * (a copied code is useless to whoever copied it) is silently gone.
 *
 * Implement `claim` as a compare-and-set and `consume` as a delete that reports
 * whether it was the one to delete. Then run `checkStore` from
 * `@chiljs/core/conformance` against it, which tests precisely this.
 */
export interface TokenStore {
  put(record: TokenRecord): MaybePromise<void>;

  /** Null when unknown. Expiry is the broker's judgement, not the store's. */
  get(secret: string): MaybePromise<TokenRecord | null>;

  /**
   * Atomically take the code for `claimant`, or report that someone else has it.
   *
   * Returns `first: true` only when this call is what set `claimedBy`. The same
   * client claiming again succeeds with `first: false`, so a reload costs
   * nothing.
   */
  claim(secret: string, claimant: string): MaybePromise<StoreClaim>;

  /**
   * Atomically spend the token and write its tombstone.
   *
   * Returns whether this call is what spent it. Two concurrent uploads on one
   * token both reach here; only one gets `true`.
   */
  consume(secret: string, spentAt: number): MaybePromise<boolean>;

  spent(secret: string): MaybePromise<SpentRecord | null>;

  /**
   * Drop what has aged out. Optional: a store with native TTLs has nothing to
   * do here, and the broker treats its absence as "the backend handles it".
   */
  sweep?(now: number, graceMs: number, spentTtlMs: number): MaybePromise<void>;
}
