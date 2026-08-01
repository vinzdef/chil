import { randomId } from 'chil-core';
import type { Sink, SinkResult, StoreContext } from './sink.js';

export interface StoredItem extends StoreContext {
  id: string;
  bytes: Uint8Array;
  receivedAt: number;
}

export interface MemorySink extends Sink {
  list(room: string): StoredItem[];
  get(id: string): StoredItem | undefined;
  remove(id: string): void;
}

/**
 * Keeps uploads in a `Map`. For examples, tests and local development.
 *
 * Not for production: it holds every upload in the heap for the life of the
 * process, which is a memory leak with extra steps.
 */
export function memorySink(): MemorySink {
  const items = new Map<string, StoredItem>();

  return {
    async store(ctx: StoreContext, body: ReadableStream<Uint8Array>): Promise<SinkResult> {
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.byteLength;
        }
      } finally {
        // Releasing matters even on the error path: the guard errors this
        // stream to refuse an upload, and a held reader would keep the
        // underlying request alive.
        reader.releaseLock();
      }

      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }

      const id = randomId();
      items.set(id, { ...ctx, id, bytes, receivedAt: Date.now() });
      return { ok: true, id, size, mime: ctx.declaredType ?? undefined };
    },

    list(room) {
      return [...items.values()]
        .filter((item) => item.room === room)
        .sort((a, b) => a.receivedAt - b.receivedAt);
    },

    get: (id) => items.get(id),
    remove: (id) => void items.delete(id),
  };
}
