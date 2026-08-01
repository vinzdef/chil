/**
 * A conformance suite for `TokenStore` implementations.
 *
 * Framework-free on purpose: it is a list of named async checks that throw, so
 * it drops into `node:test`, vitest, or a bare script without this package
 * gaining a test-runner dependency.
 *
 *     import { checkStore } from '@chiljs/core/conformance';
 *     const failures = await checkStore(() => redisStore(url));
 *
 * The check that matters is `claim is atomic under concurrency`. Everything
 * else a plausible implementation gets right by accident; that one is what
 * separates a store that enforces single-claimant from a store that only appears
 * to. Read it before writing an adapter.
 */
import type { TokenRecord, TokenStore } from './store.js';

export interface StoreCheck {
  name: string;
  run(store: TokenStore): Promise<void>;
}

export interface CheckOutcome {
  name: string;
  ok: boolean;
  error?: Error;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(over: Partial<TokenRecord> = {}): TokenRecord {
  const issuedAt = Date.now();
  return {
    room: 'room',
    secret: 'secret-0123456789abcdef',
    flow: 'flow-0123456789abcdef',
    issuedAt,
    expiresAt: issuedAt + 60_000,
    ...over,
  };
}

export const storeChecks: StoreCheck[] = [
  {
    name: 'get returns what put wrote, and null for anything else',
    async run(store) {
      const written = record();
      await store.put(written);
      const read = await store.get(written.secret);
      assert(read !== null, 'get returned null for a secret that was just put');
      assert(read.room === written.room, 'room did not survive the round trip');
      assert(read.flow === written.flow, 'flow did not survive the round trip');
      assert(read.expiresAt === written.expiresAt, 'expiresAt did not survive the round trip');
      assert(read.claimedBy === undefined, 'a fresh record must not be claimed');
      assert((await store.get('secret-not-issued-here')) === null, 'get invented a record');
    },
  },

  {
    name: 'claim reports missing for an unknown secret',
    async run(store) {
      const outcome = await store.claim('secret-not-issued-here', 'claimant-0123456789ab');
      assert(outcome.status === 'missing', `expected missing, got ${outcome.status}`);
    },
  },

  {
    name: 'first claim wins, the same client may return, a second client is refused',
    async run(store) {
      const written = record();
      await store.put(written);

      const first = await store.claim(written.secret, 'claimant-aaaaaaaaaaaa');
      assert(first.status === 'ok', `first claim should succeed, got ${first.status}`);
      assert(first.first === true, 'the first claim must report first: true');

      const again = await store.claim(written.secret, 'claimant-aaaaaaaaaaaa');
      assert(again.status === 'ok', 'the same client must be allowed back');
      assert(again.first === false, 'a returning claimant must report first: false');

      const other = await store.claim(written.secret, 'claimant-bbbbbbbbbbbb');
      assert(other.status === 'conflict', `a second client must conflict, got ${other.status}`);
    },
  },

  {
    name: 'claim is atomic under concurrency — exactly one caller sees first: true',
    async run(store) {
      const written = record();
      await store.put(written);

      // Fired without awaiting in between, which is the whole point: an
      // implementation that reads, awaits, then writes will let all of these
      // observe an unclaimed record and all of them believe they won.
      const outcomes = await Promise.all(
        Array.from({ length: 32 }, (_, i) =>
          store.claim(written.secret, `claimant-${String(i).padStart(12, '0')}`),
        ),
      );

      const winners = outcomes.filter((o) => o.status === 'ok' && o.first);
      assert(
        winners.length === 1,
        `expected exactly one winner, got ${winners.length}. ` +
          'claim must be a compare-and-set, not read-then-write.',
      );
      const ok = outcomes.filter((o) => o.status === 'ok');
      assert(ok.length === 1, `only the winner may get status ok, got ${ok.length}`);
    },
  },

  {
    name: 'consume is atomic — exactly one caller spends the token',
    async run(store) {
      const written = record();
      await store.put(written);

      const results = await Promise.all(
        Array.from({ length: 16 }, () => store.consume(written.secret, Date.now())),
      );
      const spent = results.filter(Boolean);
      assert(spent.length === 1, `expected exactly one consumer, got ${spent.length}`);
      assert((await store.get(written.secret)) === null, 'a consumed token must be gone');
    },
  },

  {
    name: 'consume leaves a tombstone naming the room',
    async run(store) {
      const written = record({ room: 'shop-2' });
      await store.put(written);
      await store.consume(written.secret, Date.now());

      const tomb = await store.spent(written.secret);
      assert(tomb !== null, 'a spent token must leave a tombstone, or already-sent is impossible');
      assert(tomb.room === 'shop-2', 'the tombstone must name the room it belonged to');
    },
  },

  {
    name: 'an unspent token has no tombstone',
    async run(store) {
      const written = record();
      await store.put(written);
      assert((await store.spent(written.secret)) === null, 'an unspent token must not be spent');
    },
  },

  {
    name: 'sweep drops expired tokens only after the grace period',
    async run(store) {
      if (!store.sweep) return; // A backend with native TTLs has nothing to do.
      const now = Date.now();
      const written = record({ expiresAt: now - 1_000 });
      await store.put(written);

      await store.sweep(now, 60_000, 60_000);
      assert(
        (await store.get(written.secret)) !== null,
        'an expired token must survive its grace period, or it cannot be told from a forged one',
      );

      await store.sweep(now + 120_000, 60_000, 60_000);
      assert((await store.get(written.secret)) === null, 'sweep must drop tokens past grace');
    },
  },

  {
    name: 'sweep drops tombstones on their own, longer clock',
    async run(store) {
      if (!store.sweep) return;
      const now = Date.now();
      const written = record();
      await store.put(written);
      await store.consume(written.secret, now);

      await store.sweep(now + 120_000, 60_000, 3_600_000);
      assert(
        (await store.spent(written.secret)) !== null,
        'a tombstone must outlive the token — it answers a different question',
      );

      await store.sweep(now + 7_200_000, 60_000, 3_600_000);
      assert((await store.spent(written.secret)) === null, 'sweep must eventually drop tombstones');
    },
  },
];

/**
 * Runs every check against a fresh store and returns the outcomes.
 *
 * A factory rather than an instance, because the checks must not see each
 * other's records.
 */
export async function checkStore(
  factory: () => TokenStore | Promise<TokenStore>,
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const check of storeChecks) {
    try {
      await check.run(await factory());
      outcomes.push({ name: check.name, ok: true });
    } catch (err) {
      outcomes.push({ name: check.name, ok: false, error: err as Error });
    }
  }
  return outcomes;
}
