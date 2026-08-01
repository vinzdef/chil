import { randomId } from './ids.js';
import {
  DEFAULT_GRACE_MS,
  DEFAULT_SPENT_TTL_MS,
  DEFAULT_TOKEN_TTL_MS,
  formatToken,
  isValidRoom,
  type ErrorReason,
  type MintResult,
} from './protocol.js';
import { memoryStore } from './memory-store.js';
import type { TokenStore } from './store.js';

export type Verdict =
  | { ok: true; room: string; flow: string; claimed: boolean }
  | { ok: false; reason: ErrorReason };

/**
 * Answer to a claim.
 *
 * Separate from `Verdict` because `claimed` would mean something different
 * here: after a claim it is true by construction, and the useful fact is
 * whether this call is what made it true. Two booleans a rename apart is
 * exactly the kind of thing that reads correct and counts wrong.
 */
export type ClaimVerdict =
  | { ok: true; room: string; flow: string; first: boolean }
  | { ok: false; reason: ErrorReason };

export interface BrokerOptions {
  /** Defaults to `memoryStore()`. */
  store?: TokenStore;
  ttlMs?: number;
  graceMs?: number;
  spentTtlMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  newId?: () => string;
}

export interface Broker {
  /**
   * Issues a code for `room`.
   *
   * **Must be called behind your own authorisation.** Whoever can mint can
   * cause an upload into that room. `chil-server` deliberately does not
   * expose this as a public route.
   *
   * Minting does not revoke an earlier code: a previously issued token stays
   * valid for its remaining life.
   */
  mint(room: string): Promise<MintResult>;

  /**
   * Verdict on a token, without consuming or claiming it.
   *
   * Free to call and safe to poll. Separate from `claim` on purpose: an
   * requester's panel polls this to notice its code has been used, and a check
   * that claimed would have the panel take the claim before the person holding
   * the client had finished with it.
   */
  check(room: string, secret: string): Promise<Verdict>;

  /**
   * Verdict on a token, recording which browser is using it.
   *
   * The first client to arrive takes the code; the same client may come back as
   * often as it likes, so a reload costs nothing; anyone else is refused with
   * `already-claimed`. That is what stops a code copied off a screen from
   * being usable by whoever copied it.
   *
   * Claiming never consumes. A claimed token still dies only on a stored file.
   */
  claim(room: string, secret: string, claimant: string): Promise<ClaimVerdict>;

  /**
   * Spends a token. Call only after the file is safely stored.
   *
   * This ordering is the single most important reliability property of the
   * design: an interrupted upload leaves the token valid, so the person retries
   * instead of queueing for a fresh code.
   *
   * Returns whether this call is what spent it.
   */
  consume(secret: string): Promise<boolean>;

  /**
   * Drops what has aged out.
   *
   * Call it on a timer, unconditionally. It must not depend on traffic
   * arriving — it is the only thing between this design and unbounded growth.
   */
  sweep(now?: number): Promise<void>;

  readonly store: TokenStore;
  readonly ttlMs: number;
}

export function createBroker(options: BrokerOptions = {}): Broker {
  const store = options.store ?? memoryStore();
  const ttlMs = options.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const spentTtlMs = options.spentTtlMs ?? DEFAULT_SPENT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? randomId;

  /**
   * Shared by `check` and `claim`: turns the absence of a live record into the
   * most specific refusal available.
   */
  async function missing(room: string, secret: string): Promise<ErrorReason> {
    const done = await store.spent(secret);
    // A token this broker actually spent, rather than one it never issued.
    if (done && done.room === room) return 'already-sent';
    return 'invalid-token';
  }

  async function mint(room: string): Promise<MintResult> {
    if (!isValidRoom(room)) {
      throw new TypeError(`invalid room id: ${JSON.stringify(room)}`);
    }
    const secret = newId();
    const flow = newId();
    const issuedAt = now();
    await store.put({ room, secret, flow, issuedAt, expiresAt: issuedAt + ttlMs });
    return { token: formatToken(room, secret), expiresInMs: ttlMs, flow };
  }

  async function check(room: string, secret: string): Promise<Verdict> {
    const record = await store.get(secret);
    // A secret that belongs to another room is treated as unknown rather than
    // as a mismatch: saying "wrong room" would confirm the secret exists.
    if (!record || record.room !== room) {
      return { ok: false, reason: await missing(room, secret) };
    }
    if (record.expiresAt < now()) return { ok: false, reason: 'expired-token' };
    return {
      ok: true,
      room: record.room,
      flow: record.flow,
      claimed: record.claimedBy !== undefined,
    };
  }

  async function claim(room: string, secret: string, claimant: string): Promise<ClaimVerdict> {
    // Expiry and tombstones are judged before anything is written, so a dead
    // code is refused with the reason it deserves. The only race this leaves is
    // a token expiring between here and the compare-and-set below, which costs
    // nothing: the record is unreachable either way.
    const verdict = await check(room, secret);
    if (!verdict.ok) return verdict;

    const outcome = await store.claim(secret, claimant);
    if (outcome.status === 'missing') {
      return { ok: false, reason: await missing(room, secret) };
    }
    if (outcome.status === 'conflict') return { ok: false, reason: 'already-claimed' };
    // Re-checked rather than trusted from the verdict above: on a networked
    // store the compare-and-set is the authoritative read.
    if (outcome.record.room !== room) return { ok: false, reason: 'invalid-token' };

    return {
      ok: true,
      room: outcome.record.room,
      flow: outcome.record.flow,
      first: outcome.first,
    };
  }

  // Free functions rather than methods on the returned literal, so that
  // `const { claim } = broker` keeps working. A `this.check` call inside an
  // object literal breaks the moment anyone destructures.
  return {
    store,
    ttlMs,
    mint,
    check,
    claim,
    consume: (secret: string) => Promise.resolve(store.consume(secret, now())),
    sweep: async (at = now()) => {
      await store.sweep?.(at, graceMs, spentTtlMs);
    },
  };
}
