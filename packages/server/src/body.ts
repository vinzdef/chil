import type { ErrorReason } from '@chiljs/core';

/**
 * Thrown into the body stream when the upload is refused mid-flight.
 *
 * It travels through the sink's own write pipeline rather than being checked
 * before the sink runs, because both refusals — too many bytes, wrong magic
 * number — are only knowable once bytes are arriving. A sink should let it
 * propagate and clean up whatever it had started writing.
 */
export class BodyRejected extends Error {
  constructor(readonly reason: ErrorReason) {
    super(reason);
    this.name = 'BodyRejected';
  }
}

export interface GuardOptions {
  /**
   * Ceiling on bytes actually read.
   *
   * Enforced here rather than in the sink so that no sink implementor can
   * forget it. The declared `Content-Length` is attacker-supplied and is only
   * ever used as an early rejection, never as the limit.
   */
  maxBytes: number;
  /**
   * Verdict on the leading bytes, called once, before the sink sees them.
   *
   * This is the format allowlist. Neither `Content-Type` nor a filename is
   * consulted anywhere in this package — both come from an untrusted device,
   * and the resulting type decides how someone's browser will later treat those
   * bytes.
   */
  inspect?: (head: Uint8Array) => ErrorReason | null;
  /** How many leading bytes `inspect` gets. Enough for a magic number. */
  headBytes?: number;
}

export interface GuardedBody {
  stream: ReadableStream<Uint8Array>;
  /** Bytes seen so far. Meaningful once the stream has been fully consumed. */
  read: () => number;
}

/**
 * Wraps an upload body in the two checks the protocol owes every sink.
 *
 * The head is buffered until `headBytes` have arrived (or the stream ends) so
 * `inspect` sees a contiguous prefix rather than whatever the first chunk
 * happened to contain, then it is passed through unchanged.
 */
export function guardBody(
  source: ReadableStream<Uint8Array>,
  { maxBytes, inspect, headBytes = 16 }: GuardOptions,
): GuardedBody {
  let read = 0;
  let head: Uint8Array[] = [];
  let headLength = 0;
  let inspected = inspect === undefined;

  const flushHead = (controller: TransformStreamDefaultController<Uint8Array>): boolean => {
    const joined = new Uint8Array(headLength);
    let at = 0;
    for (const chunk of head) {
      joined.set(chunk, at);
      at += chunk.byteLength;
    }
    const reason = inspect?.(joined);
    if (reason) {
      controller.error(new BodyRejected(reason));
      return false;
    }
    inspected = true;
    if (joined.byteLength > 0) controller.enqueue(joined);
    head = [];
    headLength = 0;
    return true;
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      read += chunk.byteLength;
      if (read > maxBytes) {
        controller.error(new BodyRejected('too-large'));
        return;
      }
      if (inspected) {
        controller.enqueue(chunk);
        return;
      }
      head.push(chunk);
      headLength += chunk.byteLength;
      if (headLength >= headBytes) flushHead(controller);
    },
    flush(controller) {
      // A body shorter than `headBytes` — including an empty one, which is how
      // `inspect` gets the chance to refuse a zero-length upload.
      if (!inspected) flushHead(controller);
    },
  });

  return { stream: source.pipeThrough(transform), read: () => read };
}
