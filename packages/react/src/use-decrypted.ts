import { useEffect, useState } from 'react';
import type { RecipientHandle } from './use-recipient.js';

export interface UseDecrypted {
  /** Object URL for an `<img src>`, or null while working or on failure. */
  src: string | null;
  loading: boolean;
  /**
   * The `CryptoReason` from `@chiljs/crypto` — `no-key`, `wrong-key`,
   * `corrupt`, `unsupported-version` — or `fetch-failed`.
   *
   * A code, not a sentence. `wrong-key` in particular deserves its own wording:
   * it means this device is not the one that issued the handoff, which a requester
   * can act on, unlike "corrupt".
   */
  reason: string | null;
}

/**
 * Fetches and unseals one item, as an object URL.
 *
 * This is the cost of encryption that no library can hide. Without it a
 * dashboard renders `<img src={fileUrl(...)}>` and the browser does the
 * fetching, the decoding and the HTTP caching. With it, every image becomes
 * fetch → decrypt → object URL, the bytes pass through JavaScript, and
 * `Cache-Control` no longer helps because the response body is useless on its
 * own.
 *
 * Pass `recipient: null` and this does nothing, so a component can be written
 * once and used with encryption on or off.
 */
export function useDecrypted(
  url: string | null,
  recipient: RecipientHandle | null,
): UseDecrypted {
  const [state, setState] = useState<UseDecrypted>({
    src: null,
    loading: url !== null,
    reason: null,
  });

  useEffect(() => {
    if (!url || !recipient) {
      setState({ src: null, loading: false, reason: null });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setState({ src: null, loading: true, reason: null });

    void (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error('fetch-failed');
        const plain = await recipient.decrypt(await res.arrayBuffer());
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([plain as BlobPart]));
        setState({ src: objectUrl, loading: false, reason: null });
      } catch (err) {
        if (cancelled) return;
        const reason =
          err instanceof Error && err.name === 'AbortError'
            ? null
            : ((err as { reason?: string }).reason ?? 'fetch-failed');
        if (reason !== null) setState({ src: null, loading: false, reason });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      // Revoked on the way out, or every scroll through a queue leaks a copy of
      // every file it rendered.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, recipient]);

  return state;
}
