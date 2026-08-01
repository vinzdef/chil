import { useEffect, useState } from 'react';
import type { RecipientLike } from '@chiljs/client';

/**
 * Anything `@chiljs/crypto`'s `createRecipient` returns. Declared structurally
 * so this package does not depend on the cipher.
 */
export interface RecipientHandle extends RecipientLike {
  readonly keyId: string;
  decrypt(data: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array>;
  decryptText(text: string): Promise<string>;
}

export interface UseRecipient {
  recipient: RecipientHandle | null;
  /** True until the key has been loaded or generated. */
  loading: boolean;
  /** IndexedDB unavailable, or blocked. Encryption cannot be used. */
  error: Error | null;
}

/**
 * Loads this device's recipient key, generating one on first use.
 *
 * ```tsx
 * const { recipient } = useRecipient(() => createRecipient({ scope: room }));
 * const handoff = useHandoffSession({ mint, transport, recipient: recipient ?? undefined });
 * ```
 *
 * Deliberately asynchronous with a `loading` state rather than something that
 * blocks: opening IndexedDB and generating a P-256 keypair is fast but not
 * instant, and a panel that shows a QR *before* the key is ready would be
 * showing a code whose uploads nothing can decrypt.
 *
 * Guard on it: render the QR only once `recipient` is non-null.
 */
export function useRecipient(create: () => Promise<RecipientHandle>): UseRecipient {
  const [state, setState] = useState<UseRecipient>({
    recipient: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    create().then(
      (recipient) => {
        if (!cancelled) setState({ recipient, loading: false, error: null });
      },
      (err: unknown) => {
        if (!cancelled) setState({ recipient: null, loading: false, error: err as Error });
      },
    );
    return () => {
      cancelled = true;
    };
    // `create` is intentionally not a dependency: callers write it inline, and
    // re-running would generate or re-open the key on every render. Remount to
    // change scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
