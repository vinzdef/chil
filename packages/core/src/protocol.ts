/**
 * The wire contract. Everything here is shared by the browser, the server and
 * any store adapter, so it holds no I/O and no environment assumptions.
 */

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * A token is `<room>.<secret>`.
 *
 * The prefix names the room the drop belongs to, so the upload route knows
 * where the file is going without a store lookup; the secret half is what
 * actually authorises the upload. Splitting on the first separator is why a
 * room id may not contain one — see `isValidRoom`.
 */
export const TOKEN_SEPARATOR = '.';

export interface ParsedToken {
  room: string;
  secret: string;
}

export function parseToken(token: string): ParsedToken | null {
  const at = token.indexOf(TOKEN_SEPARATOR);
  if (at <= 0 || at === token.length - 1) return null;
  const room = token.slice(0, at);
  const secret = token.slice(at + 1);
  if (!isValidRoom(room) || !isValidSecret(secret)) return null;
  return { room, secret };
}

export function formatToken(room: string, secret: string): string {
  return `${room}${TOKEN_SEPARATOR}${secret}`;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** How long a displayed code stays usable. */
export const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * How long an expired token is kept before being swept.
 *
 * Not a grace period on validity — the upload is still refused. It exists so
 * the refusal can say `expired-token` rather than `invalid-token`. Sweep on the
 * dot and a stale code becomes indistinguishable from a forged one.
 */
export const DEFAULT_GRACE_MS = 60 * 1000;

/**
 * How long the record of a *spent* token survives.
 *
 * Long, because it answers a different question from the token itself: "did my
 * file arrive?" stays worth answering for as long as the file is around.
 */
export const DEFAULT_SPENT_TTL_MS = 4 * 60 * 60 * 1000;

/** Ceiling on one upload, enforced against bytes actually read. */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** Ceiling on the free-text label the uploader types. */
export const DEFAULT_MAX_LABEL_LENGTH = 120;

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

/*
 * Declared once, here, because the two ends only agree if they spell them the
 * same way. A client that claims with `client` and uploads with `claimantId`
 * turns the claim check into a formality that always passes.
 */
export const TOKEN_PARAM = 'token';
export const CLAIMANT_PARAM = 'claimant';
export const LABEL_PARAM = 'label';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Room ids reach this code from the network, inside a token, and a host will
 * use one to pick a directory or a bucket prefix. No dot, because the token
 * format splits on one; no slash or dot-dot, because this is the traversal
 * guard. Matched against an alphabet rather than sanitised.
 */
const ROOM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidRoom(room: string): boolean {
  return ROOM_PATTERN.test(room);
}

/** Shape of anything `randomId` produces, plus room for longer custom ids. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidSecret(secret: string): boolean {
  return SECRET_PATTERN.test(secret);
}

/**
 * Shape of the id a browser claims a code with.
 *
 * Wide enough for a UUID, narrow enough that the value can only ever be an
 * opaque handle: it is compared and stored against a token, never used to build
 * a path or a query. The length floor matters — a one-character id would be
 * trivially guessable by a second client wanting to impersonate the first.
 */
const CLAIMANT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function isValidClaimantId(id: string): boolean {
  return CLAIMANT_ID_PATTERN.test(id);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface MintResult {
  /** `<room>.<secret>`. This is the value that goes into the handoff URL. */
  token: string;
  /**
   * A duration, not a deadline. The requester's clock may differ from the
   * server's, and a skewed one would show a live code as already expired.
   */
  expiresInMs: number;
  /**
   * Public correlation id for this code, minted alongside the secret.
   *
   * It exists so events on both ends can be tied together: the panel reports it
   * when the code is shown, the uploading page learns it by claiming, and the
   * sink is handed it so a later event can report it too. It authorises
   * nothing — that is the token's job — which is exactly why it is safe to send
   * to an analytics collector when the token is not.
   */
  flow: string;
}

/** Answer to a non-consuming check. */
export interface CheckResult {
  ok: true;
  /**
   * Whether some browser has taken this code.
   *
   * Informative only. A claimed code is still perfectly valid and is still the
   * one the uploader is working through; the reason to surface it is so the
   * requester stops offering the same code to the next person in the queue.
   */
  claimed: boolean;
}

/** Answer to a claim. */
export interface ClaimResult {
  ok: true;
  flow: string;
  /**
   * Whether this request is what took the code.
   *
   * False when the claimant is coming back — a reload, or a retry after a
   * dropped connection. Counting a claim on the first only is what stops the
   * number measuring page loads, which link previews and prefetches inflate.
   */
  first: boolean;
}

export interface UploadResult {
  id: string;
  size: number;
  mime?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ErrorReason =
  /** Malformed request: unparseable token, missing body, bad claimant id. */
  | 'bad-request'
  | 'invalid-token'
  /**
   * The token was spent by a real upload. A refusal, but a happy one: the file
   * arrived. Separated from `invalid-token` so someone reloading the page after
   * sending is told what happened rather than that their link broke.
   */
  | 'already-sent'
  /**
   * A different browser already claimed this code.
   *
   * Distinct from `already-sent`: nothing was uploaded and the code may still
   * be spent by whoever claimed it. The person seeing this is the second
   * client — typically someone who copied the code off a screen.
   */
  | 'already-claimed'
  | 'expired-token'
  | 'too-large'
  | 'bad-type'
  /**
   * Sealing was required and no usable recipient key arrived.
   *
   * Raised by the client, never by the server: the key travels in the URL
   * fragment, which link rewriters and preview generators strip, and the whole
   * point is that losing it must not silently downgrade to plaintext. Lives in
   * this union so a page translates one set of codes rather than two.
   */
  | 'seal-required'
  | 'storage-full'
  | 'server-error';

export interface ErrorBody {
  reason: ErrorReason;
}

/**
 * Whether trying the same thing again could plausibly work.
 *
 * A property of the protocol, not of any particular UI: it is the difference
 * between "the network dropped" and "the server has ruled on your token". Both
 * ends use it — the uploading page to decide whether to offer a retry, the
 * panel to decide whether a failed poll should retire a live code.
 */
export const retryable: Record<ErrorReason, boolean> = {
  'bad-request': false,
  'invalid-token': false,
  'already-sent': false,
  // Retrying cannot help: the code belongs to another browser now, and only a
  // fresh code changes that.
  'already-claimed': false,
  'expired-token': false,
  'too-large': false,
  'bad-type': false,
  // A fresh link is the only fix; retrying sends the same keyless URL again.
  'seal-required': false,
  'storage-full': true,
  'server-error': true,
};

/**
 * HTTP status for a refusal.
 *
 * Here rather than in the server package because the client reads it too: a
 * response with no parseable body still has a status, and it is the only thing
 * left to guess a reason from.
 */
export function statusFor(reason: ErrorReason): number {
  switch (reason) {
    // 400 is reserved for a request that is malformed — a claimant id the server
    // will not accept, a missing body. A well-formed request bearing a token
    // the server will not honour is a refusal, not a syntax error, so every
    // token verdict below is a 403.
    case 'bad-request':
      return 400;
    case 'invalid-token':
    case 'already-sent':
    case 'already-claimed':
    case 'expired-token':
      return 403;
    case 'too-large':
      return 413;
    case 'bad-type':
      return 415;
    // Client-side only. Mapped so the union stays exhaustive; a server that
    // somehow emitted it is refusing an unacceptable body.
    case 'seal-required':
      return 415;
    case 'storage-full':
      return 507;
    case 'server-error':
      return 500;
  }
}

/*
 * Display text is deliberately absent. The protocol carries the reason; how it
 * is worded, and in which language, is the application's concern.
 */
