import { useCallback, useMemo, useRef } from 'react';
import {
  createUploadSession,
  type Transport,
  type UploadEvent,
  type UploadState,
} from 'chil-client';
import { useSession } from './use-session.js';

export interface UseUploadSessionOptions {
  /**
   * From the scanned URL. Read it however your router prefers — this package
   * has no opinion and no routing dependency.
   */
  token: string | null;
  transport: Transport;
  onEvent?: (event: UploadEvent) => void;
}

export interface UseUploadSession extends UploadState {
  send: (body: Blob | ArrayBuffer | Uint8Array, options?: { label?: string }) => void;
}

/**
 * The uploader's page.
 *
 * Claims on mount, exposes the phase, and sends when asked. Nothing here
 * renders: the copy, the layout and the language are yours, and this hook
 * deliberately hands back `reason` codes rather than sentences.
 *
 * Note what is *not* returned: a "can send" boolean that accounts for your form
 * being filled in. Disabling the button for a missing field is the fastest way
 * to build a form where nothing happens and nothing says why — validate with
 * the platform and let the button stay pressable.
 */
export function useUploadSession(options: UseUploadSessionOptions): UseUploadSession {
  const { token, transport } = options;

  // Through a ref, so a caller passing an inline handler does not re-claim the
  // code on every render.
  const onEvent = useRef(options.onEvent);
  onEvent.current = options.onEvent;

  const [session, state] = useSession(
    () =>
      createUploadSession({
        token,
        transport,
        onEvent: (event) => onEvent.current?.(event),
      }),
    [token, transport],
  );

  const send = useCallback(
    (body: Blob | ArrayBuffer | Uint8Array, sendOptions?: { label?: string }) =>
      session.send(body, sendOptions),
    [session],
  );

  return useMemo(() => ({ ...state, send }), [state, send]);
}
