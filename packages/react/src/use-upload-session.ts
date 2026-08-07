import { useCallback, useMemo, useRef } from 'react';
import {
  createUploadSession,
  type SealerLike,
  type Transport,
  type UploadEvent,
  type UploadState,
} from '@chiljs/client';
import { useSession } from './use-session.js';

export interface UseUploadSessionOptions {
  /**
   * From the scanned URL. Read it however your router prefers — this package
   * has no opinion and no routing dependency.
   */
  token: string | null;
  transport: Transport;
  /**
   * Encrypts the file and the label before they leave the device. Built from
   * the recipient's key in the URL fragment. See `@chiljs/crypto`.
   *
   * Building one is asynchronous, so this arrives undefined on the first render
   * and defined on a later one. That is expected and costs a re-claim, not a
   * code: the claimant id is derived from the token, and the same claimant
   * claiming again succeeds.
   */
  seal?: SealerLike;
  /**
   * Refuse to send at all unless `seal` is present, rather than silently
   * downgrading to plaintext when the fragment was stripped in transit. Set it
   * wherever the deployment is encrypted.
   */
  requireSeal?: boolean;
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
  const { token, transport, requireSeal } = options;

  // Through a ref, so a caller passing an inline handler does not re-claim the
  // code on every render.
  const onEvent = useRef(options.onEvent);
  onEvent.current = options.onEvent;

  const sealRef = useRef(options.seal);
  sealRef.current = options.seal;

  // *Whether* a sealer was supplied is a dependency; *which* sealer it is, is
  // not. Passing an object unconditionally would make the session believe it is
  // always sealing, and a plaintext deployment would label its uploads as
  // ciphertext.
  const sealed = options.seal !== undefined;

  const [session, state] = useSession(() => {
    // The sealer in force when this session was made, so a wrapper outliving
    // the prop that justified it still has something to call.
    const atCreation = sealRef.current;
    return createUploadSession({
      token,
      transport,
      // Held through a ref because a sealer is a pair of callbacks, and a
      // dependency whose identity changes every render would re-claim the code
      // on every render.
      seal:
        atCreation === undefined
          ? undefined
          : {
              encrypt: (data) => (sealRef.current ?? atCreation).encrypt(data),
              encryptText: (text) => (sealRef.current ?? atCreation).encryptText(text),
            },
      requireSeal,
      onEvent: (event) => onEvent.current?.(event),
    });
  }, [token, transport, sealed, requireSeal]);

  const send = useCallback(
    (body: Blob | ArrayBuffer | Uint8Array, sendOptions?: { label?: string }) =>
      session.send(body, sendOptions),
    [session],
  );

  return useMemo(() => ({ ...state, send }), [state, send]);
}
