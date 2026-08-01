import {
  CLAIMANT_PARAM,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LABEL_LENGTH,
  LABEL_PARAM,
  TOKEN_PARAM,
  isValidClaimantId,
  isValidRoom,
  parseToken,
  statusFor,
  type Broker,
  type CheckResult,
  type ClaimResult,
  type ErrorReason,
  type MintResult,
  type UploadResult,
} from '@chiljs/core';
import { BodyRejected, guardBody } from './body.js';
import type { Sink } from './sink.js';

/**
 * Handlers answer with `null` when the path is not theirs, so they compose:
 * try chil, fall through to your own router.
 */
export type ChilHandler = (request: Request) => Promise<Response | null>;

export type ServerEvent =
  | { type: 'claimed'; room: string; flow: string; first: boolean }
  | { type: 'claim-refused'; room: string; reason: ErrorReason }
  | { type: 'upload-received'; room: string; flow: string; id: string; size: number }
  | { type: 'upload-refused'; room: string; reason: ErrorReason };

export interface HandlerOptions {
  broker: Broker;
  sink: Sink;
  /** Everything is mounted under this prefix. No trailing slash. */
  basePath?: string;
  maxBytes?: number;
  maxLabelLength?: number;
  /** See `GuardOptions.inspect` — the format allowlist. */
  inspect?: (head: Uint8Array) => ErrorReason | null;
  headBytes?: number;
  /**
   * Observation only. Never awaited and never allowed to fail a request: an
   * analytics collector being down must not cost someone their upload.
   */
  onEvent?: (event: ServerEvent) => void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Every answer here is about a single-use secret. None of it may be
      // cached, by the browser or by anything between.
      'Cache-Control': 'no-store',
    },
  });
}

function fail(reason: ErrorReason): Response {
  return json(statusFor(reason), { reason });
}

const methodNotAllowed = (allow: string): Response =>
  new Response('Method not allowed', { status: 405, headers: { Allow: allow } });

/**
 * The three public routes of the exchange.
 *
 * All three are unauthenticated by design — the token is the credential, and
 * the person holding it is on a device that has never met this server. Minting
 * is *not* here: see `createMintHandler`.
 */
export function createHandler(options: HandlerOptions): ChilHandler {
  const {
    broker,
    sink,
    basePath = '/chil',
    maxBytes = DEFAULT_MAX_BYTES,
    maxLabelLength = DEFAULT_MAX_LABEL_LENGTH,
    inspect,
    headBytes,
    onEvent,
  } = options;

  const emit = (event: ServerEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      /* observation must never fail a request */
    }
  };

  /**
   * Receives one file.
   *
   * Order is deliberate throughout:
   *
   * - the token is judged *before* the body is read, so a refusal does not
   *   spend the uploader's data allowance on bytes that were never going to be
   *   accepted, and does not hand an unauthenticated caller a free write;
   * - the claim is enforced here as well as at `/claim`, and this is the half
   *   that does the work — without it, someone holding a copied code
   *   would skip the page and POST straight here, and claiming would be
   *   decorative;
   * - the token is consumed only once the sink reports success, so an
   *   interrupted upload is retryable with the same code by the same client,
   *   whose claim is still standing.
   */
  async function upload(request: Request, url: URL): Promise<Response> {
    const parsed = parseToken(url.searchParams.get(TOKEN_PARAM) ?? '');
    if (!parsed) return fail('invalid-token');

    const claimant = url.searchParams.get(CLAIMANT_PARAM) ?? '';
    if (!isValidClaimantId(claimant)) return fail('bad-request');

    // An early out on the declared length, not the limit. What actually bounds
    // the write is the counter in `guardBody`, which sees bytes rather than a
    // header the caller wrote.
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      emit({ type: 'upload-refused', room: parsed.room, reason: 'too-large' });
      return fail('too-large');
    }

    const verdict = await broker.claim(parsed.room, parsed.secret, claimant);
    if (!verdict.ok) {
      emit({ type: 'upload-refused', room: parsed.room, reason: verdict.reason });
      return fail(verdict.reason);
    }

    if (!request.body) return fail('bad-request');

    const label = (url.searchParams.get(LABEL_PARAM) ?? '').trim().slice(0, maxLabelLength);
    const guarded = guardBody(request.body, { maxBytes, inspect, headBytes });

    let result;
    try {
      result = await sink.store(
        {
          room: verdict.room,
          label,
          flow: verdict.flow,
          declaredType: request.headers.get('content-type'),
          limitBytes: maxBytes,
        },
        guarded.stream,
      );
    } catch (err) {
      if (err instanceof BodyRejected) {
        emit({ type: 'upload-refused', room: verdict.room, reason: err.reason });
        return fail(err.reason);
      }
      throw err;
    }

    if (!result.ok) {
      emit({ type: 'upload-refused', room: verdict.room, reason: result.reason });
      return fail(result.reason);
    }

    await broker.consume(parsed.secret);
    emit({
      type: 'upload-received',
      room: verdict.room,
      flow: verdict.flow,
      id: result.id,
      size: result.size,
    });

    const body: UploadResult = { id: result.id, size: result.size, mime: result.mime };
    return json(201, body);
  }

  return async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${basePath}/`)) return null;
    const route = url.pathname.slice(basePath.length);

    if (route === '/check') {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const parsed = parseToken(url.searchParams.get(TOKEN_PARAM) ?? '');
      if (!parsed) return fail('invalid-token');

      const verdict = await broker.check(parsed.room, parsed.secret);
      if (!verdict.ok) return fail(verdict.reason);
      const body: CheckResult = { ok: true, claimed: verdict.claimed };
      return json(200, body);
    }

    if (route === '/claim') {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = parseToken(url.searchParams.get(TOKEN_PARAM) ?? '');
      if (!parsed) return fail('invalid-token');
      const claimant = url.searchParams.get(CLAIMANT_PARAM) ?? '';
      if (!isValidClaimantId(claimant)) return fail('bad-request');

      const verdict = await broker.claim(parsed.room, parsed.secret, claimant);
      if (!verdict.ok) {
        emit({ type: 'claim-refused', room: parsed.room, reason: verdict.reason });
        return fail(verdict.reason);
      }
      emit({
        type: 'claimed',
        room: verdict.room,
        flow: verdict.flow,
        first: verdict.first,
      });
      const body: ClaimResult = { ok: true, flow: verdict.flow, first: verdict.first };
      return json(200, body);
    }

    if (route === '/upload') {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      return upload(request, url);
    }

    return null;
  };
}

export interface MintHandlerOptions {
  broker: Broker;
  /**
   * Which room this request may mint for, or null to refuse.
   *
   * A function rather than a value because the answer comes from your
   * authentication — a session, a Basic realm, an API key. Returning a room for
   * a caller you have not authenticated is the one way to get this wrong.
   */
  room: (request: Request) => string | null | Promise<string | null>;
}

/**
 * A route that issues codes.
 *
 * Kept out of `createHandler`, and given a separate constructor with a
 * mandatory `room` resolver, because it is the one endpoint here that must
 * **never** be public. Everything else is protected by the token; this is what
 * produces tokens. Mount it behind whatever guards the requester's side —
 * session cookie, Basic auth, mTLS — and confirm with a `curl` that an
 * unauthenticated request gets a 401.
 */
export function createMintHandler(options: MintHandlerOptions): ChilHandler {
  return async function mintHandler(request: Request): Promise<Response | null> {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const room = await options.room(request);
    if (room === null || !isValidRoom(room)) {
      return new Response('Forbidden', { status: 403 });
    }
    const minted: MintResult = await options.broker.mint(room);
    return json(200, minted);
  };
}
