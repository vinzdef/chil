import {
  CLAIMANT_PARAM,
  LABEL_PARAM,
  TOKEN_PARAM,
  type CheckResult,
  type ClaimResult,
  type ErrorBody,
  type ErrorReason,
  type UploadResult,
} from '@chiljs/core';

export class ChilError extends Error {
  constructor(
    readonly reason: ErrorReason,
    readonly status: number,
  ) {
    super(reason);
    this.name = 'ChilError';
  }
}

export interface UploadArgs {
  token: string;
  claimant: string;
  label?: string;
  body: Blob | ArrayBuffer | Uint8Array;
  contentType?: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface Transport {
  check(token: string, signal?: AbortSignal): Promise<CheckResult>;
  claim(token: string, claimant: string, signal?: AbortSignal): Promise<ClaimResult>;
  upload(args: UploadArgs): Promise<UploadResult>;
}

export interface TransportOptions {
  /** Must match the server's `basePath`. */
  basePath?: string;
  /**
   * Absolute origin to prefix. Leave unset for same-origin, which is the
   * common case and the one that lets the browser attach cookies and cached
   * credentials without any configuration.
   */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export function createTransport(options: TransportOptions = {}): Transport {
  const basePath = options.basePath ?? '/chil';
  const baseUrl = options.baseUrl ?? '';
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const at = (route: string, params: Record<string, string>): string =>
    `${baseUrl}${basePath}${route}?${new URLSearchParams(params).toString()}`;

  async function reasonOf(res: Response): Promise<ErrorReason> {
    try {
      const body = (await res.json()) as ErrorBody;
      return body.reason ?? 'server-error';
    } catch {
      return 'server-error';
    }
  }

  return {
    async check(token, signal) {
      const res = await doFetch(at('/check', { [TOKEN_PARAM]: token }), {
        signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new ChilError(await reasonOf(res), res.status);
      return (await res.json()) as CheckResult;
    },

    async claim(token, claimant, signal) {
      const res = await doFetch(at('/claim', { [TOKEN_PARAM]: token, [CLAIMANT_PARAM]: claimant }), {
        method: 'POST',
        signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new ChilError(await reasonOf(res), res.status);
      return (await res.json()) as ClaimResult;
    },

    async upload(args) {
      const url = at('/upload', {
        [TOKEN_PARAM]: args.token,
        [CLAIMANT_PARAM]: args.claimant,
        [LABEL_PARAM]: args.label ?? '',
      });
      const type =
        args.contentType ??
        (typeof Blob !== 'undefined' && args.body instanceof Blob ? args.body.type : '');

      // `XMLHttpRequest` purely for upload progress, which `fetch` still cannot
      // report: request streaming needs `duplex: 'half'` over HTTP/2 and is not
      // available in Safari. Anyone "modernising" this to `fetch` silently
      // deletes the progress bar on the devices that matter most.
      if (args.onProgress && typeof XMLHttpRequest !== 'undefined') {
        return uploadWithProgress(url, args, type);
      }

      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': type || 'application/octet-stream' },
        body: args.body as BodyInit,
        signal: args.signal,
      });
      if (!res.ok) throw new ChilError(await reasonOf(res), res.status);
      args.onProgress?.(1);
      return (await res.json()) as UploadResult;
    },
  };
}

function uploadWithProgress(url: string, args: UploadArgs, type: string): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', type || 'application/octet-stream');

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) args.onProgress?.(event.loaded / event.total);
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        args.onProgress?.(1);
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch {
          reject(new ChilError('server-error', xhr.status));
        }
        return;
      }
      let reason: ErrorReason = 'server-error';
      try {
        reason = (JSON.parse(xhr.responseText) as ErrorBody).reason ?? 'server-error';
      } catch {
        /* keep the default */
      }
      reject(new ChilError(reason, xhr.status));
    });

    // A dropped connection mid-upload. Status 0 and `server-error`, which is
    // retryable — and correctly so: the token was not consumed, so the same
    // code still works.
    xhr.addEventListener('error', () => reject(new ChilError('server-error', 0)));
    xhr.addEventListener('abort', () => reject(new ChilError('server-error', 0)));

    if (args.signal) {
      if (args.signal.aborted) {
        xhr.abort();
        return;
      }
      args.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(args.body as XMLHttpRequestBodyInit);
  });
}

export interface HandoffUrlOptions {
  /** Defaults to `location.origin`. */
  origin?: string;
  /**
   * The page that reads the token and does the upload. Defaults to `/`.
   *
   * A default of `/` rather than a guess at your routing: where that page lives
   * is an application's decision, and a library that picks for it is wrong more
   * often than it is right.
   */
  path?: string;
  token: string;
  /** Anything else the page should carry through — a debug flag, a locale. */
  params?: Record<string, string>;
  /**
   * Values for the URL fragment, as `#k=…&…`.
   *
   * The fragment exists here for one purpose: a browser never sends it to the
   * server. Anything put here reaches the sender in the URL itself, and the
   * server that will store the upload never learns it. That is what makes
   * end-to-end encryption possible — see `@chiljs/crypto`, which puts the
   * recipient's public key here.
   *
   * Never put anything the *server* needs in here; it will not arrive.
   */
  fragment?: Record<string, string>;
}

/**
 * Builds the handoff URL — the string the sender receives.
 *
 * Rendering is deliberately not this package's job: the choice of canvas, SVG,
 * error-correction level and styling belongs to the application, and dragging a
 * renderer in as a dependency is what turns a protocol library into an
 * opinionated one. Pass the returned string to `qrcode`, `react-qr-code`, or
 * whatever you already use.
 *
 * Note what this URL is: a bearer secret in a query string. Set
 * `referrerpolicy` on any link the receiving page renders, and keep query
 * strings out of your access logs.
 */
export function handoffUrl({
  origin,
  path = '/',
  token,
  params,
  fragment,
}: HandoffUrlOptions): string {
  const base = origin ?? globalThis.location?.origin ?? '';
  const query = new URLSearchParams({ [TOKEN_PARAM]: token, ...params });
  const hash = fragment ? new URLSearchParams(fragment).toString() : '';
  return `${base}${path}?${query.toString()}${hash ? `#${hash}` : ''}`;
}
