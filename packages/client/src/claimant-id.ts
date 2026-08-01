import { uuid } from '@chiljs/core';

/**
 * The id this browser claims a code with.
 *
 * The server gives a code to the first client that claims it and refuses any
 * other, so this value is what separates "the same person reloaded the page"
 * from "someone else copied the code off the screen". It proves nothing
 * about who the browser is; it only has to be the same value across every
 * request this page makes about this token — the claim on load and the upload
 * that follows. Two different values would refuse someone their own code.
 *
 * Keyed per token, because one client may legitimately be handed two codes in a
 * session, and a single shared id would let the second claim inherit the
 * first's state.
 *
 * ## Privacy
 *
 * This value is device storage. For EU or UK users that is EU ePrivacy
 * Art. 5(3) — PECR in the UK — which exempts it from consent only for as long
 * as it is *strictly necessary*, which it is: without it the claim and the
 * upload disagree and the uploader is refused their own file. That exemption is
 * conditional on the value having no second purpose. **Do not send it to an
 * analytics collector.** Use `flow` for that; it exists precisely so there is
 * something safe to send.
 *
 * ePrivacy governs the storage; GDPR governs what you then do with the value.
 * Being exempt from consent is not being exempt from needing a lawful basis
 * under Art. 6, which is the deployer's to establish.
 *
 * None of this is legal advice — review your deployment with your DPO or
 * counsel.
 */
const KEY_PREFIX = 'chil:claimant:';

/**
 * Ids minted during this page's life.
 *
 * Consulted before storage so a browser that refuses to persist anything still
 * sends one id for the whole exchange. `sessionStorage` carries it across a
 * reload; this carries it across a claim and an upload.
 */
const minted = new Map<string, string>();

export interface ClaimantIdOptions {
  /**
   * Defaults to `sessionStorage` — never `localStorage`. The id is meaningful
   * for one visit to one code; a value that outlived the tab would still be
   * there the next time the same client opened a different code.
   */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /**
   * Store under a digest of the token rather than the token itself.
   *
   * Off by default. The key is otherwise `chil:claimant:<token>`, which puts a
   * live bearer secret into an enumerable store. That store is origin- and
   * tab-scoped, so anything that can read it is already running in your origin
   * and — while the upload page is open — can read the token off the URL
   * anyway. What this closes is the later read in the same tab, once the URL is
   * gone but the token has neither expired nor been spent. Third-party tags
   * execute in your origin and are the realistic case.
   *
   * The trade is a collision: two tokens whose digests match share one id, and
   * two exchanges that should look unrelated become linkable. At 64 bits that
   * needs far more codes in one tab than anyone opens.
   */
  hashKey?: boolean;
}

export function claimantId(token: string, options: ClaimantIdOptions = {}): string {
  const cached = minted.get(token);
  if (cached) return cached;

  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const key = KEY_PREFIX + (options.hashKey ? digest(token) : token);
  const stored = read(storage, key);
  const id = stored ?? uuid();

  minted.set(token, id);
  if (!stored) write(storage, key, id);
  return id;
}

/**
 * 64-bit FNV-1a of the token, hex, as two interleaved 32-bit lanes.
 *
 * Not a cryptographic hash and not trying to be. `crypto.subtle` is async and
 * this runs inside a synchronous factory, so using it would make
 * `createUploadSession` async for a reason that does not need one. Secrecy is
 * not the property wanted either: a lossy digest cannot be turned back into a
 * token whichever algorithm produced it. Collision resistance is the only one
 * that matters here, and 64 bits is far more than one tab's codes need.
 */
function digest(token: string): string {
  let a = 0x811c9dc5;
  let b = 0x811c9dc5 ^ 0x5bf03635;
  for (let i = 0; i < token.length; i += 1) {
    const c = token.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // Access alone throws in some privacy modes, before any read.
    return null;
  }
}

function read(storage: ClaimantIdOptions['storage'], key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: ClaimantIdOptions['storage'], key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    /*
     * Storage unavailable. The upload still works — the id lives in memory for
     * as long as the page does. What is lost is the reload: a refreshed page
     * mints a new id and the server, holding the old one, refuses it. Losing a
     * retry is the acceptable failure here; losing the upload is not.
     */
  }
}
