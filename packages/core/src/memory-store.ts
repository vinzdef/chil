import type { SpentRecord, StoreClaim, TokenRecord, TokenStore } from './store.js';

/**
 * Tokens in a `Map`, in one process.
 *
 * The right default. A restart invalidates displayed codes and the requester
 * generates a new one — blast radius is one token lifetime, and whatever the
 * sink wrote is untouched.
 *
 * `claim` and `consume` are atomic here for free: nothing awaits between the
 * read and the write, so the event loop cannot interleave another caller. That
 * is the entire reason this is safe, and it is exactly the property a networked
 * store has to re-establish deliberately.
 *
 * Not safe across processes. Two replicas each see their own map, so a code
 * minted by one is unknown to the other.
 */
export function memoryStore(): TokenStore {
  const live = new Map<string, TokenRecord>();
  const spent = new Map<string, SpentRecord>();

  return {
    put(record) {
      live.set(record.secret, { ...record });
    },

    get(secret) {
      const found = live.get(secret);
      return found ? { ...found } : null;
    },

    claim(secret, claimant): StoreClaim {
      const record = live.get(secret);
      if (!record) return { status: 'missing' };
      if (record.claimedBy !== undefined && record.claimedBy !== claimant) {
        return { status: 'conflict', record: { ...record } };
      }
      const first = record.claimedBy === undefined;
      record.claimedBy = claimant;
      return { status: 'ok', record: { ...record }, first };
    },

    consume(secret, spentAt) {
      const record = live.get(secret);
      if (!record) return false;
      live.delete(secret);
      spent.set(secret, { room: record.room, spentAt });
      return true;
    },

    spent(secret) {
      const found = spent.get(secret);
      return found ? { ...found } : null;
    },

    sweep(now, graceMs, spentTtlMs) {
      for (const [secret, record] of live) {
        if (record.expiresAt + graceMs < now) live.delete(secret);
      }
      // Tombstones outlive tokens because they answer a different question.
      for (const [secret, record] of spent) {
        if (record.spentAt + spentTtlMs < now) spent.delete(secret);
      }
    },
  };
}
