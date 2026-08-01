/**
 * Bridge from `node:http` to the Fetch-API handlers.
 *
 * Separate entry point (`chil-server/node`) so that importing the package on
 * Workers or Deno never pulls `node:` specifiers into the graph.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ChilHandler } from './handler.js';

/**
 * Request body as a web stream.
 *
 * Hand-rolled rather than `Readable.toWeb`, because of what happens when an
 * upload is refused halfway through — which is a normal event here, not an edge
 * case: too many bytes, or a magic number that is not on the allowlist.
 *
 * Refusing cancels this stream while the client is still sending. `toWeb` keeps
 * enqueuing into a closed controller at that point and throws
 * `ERR_INVALID_STATE`, and destroying the socket in `cancel` is no better —
 * the handler still has a `413` to write, and a destroyed socket turns a clear
 * refusal into a connection reset. So cancelling here only stops reading; the
 * connection is closed by `send`, after the refusal is out.
 */
function toWeb(req: IncomingMessage): { stream: ReadableStream<Uint8Array>; discard: () => void } {
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      req.on('data', (chunk: Buffer) => {
        if (closed) return;
        // Copied, not viewed. Node pools the buffers behind `IncomingMessage`
        // and reuses them, so a sink that holds a chunk — any sink that
        // buffers before writing — would watch its own data change underneath
        // it.
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 1) <= 0) req.pause();
      });
      req.on('end', () => {
        if (closed) return;
        closed = true;
        controller.close();
      });
      req.on('error', (err) => {
        if (closed) return;
        closed = true;
        controller.error(err);
      });
    },
    pull() {
      req.resume();
    },
    cancel() {
      closed = true;
      req.pause();
    },
  });

  return {
    stream,
    /**
     * Read the rest of the body and throw it away.
     *
     * Necessary because the response is written while the client is still
     * uploading. Leaving the remainder unread stalls the connection until the
     * server's request timeout, and the client sees a 408 instead of the 413
     * that was ready to send; destroying the socket instead resets the
     * connection, and the client sees no status at all.
     *
     * Node normally dumps an unconsumed body itself, but only when nothing ever
     * read from it — attaching the `data` listener above marks the request as
     * consumed, so that fallback does not apply here.
     */
    discard: () => {
      closed = true;
      req.resume();
    },
  };
}

interface Adapted {
  request: Request;
  discard: () => void;
}

function toRequest(req: IncomingMessage): Adapted {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    else headers.set(name, value);
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? toWeb(req) : null;

  const request = new Request(url, {
    method,
    headers,
    body: body?.stream,
    // Required by undici whenever the body is a stream: it says the request
    // body is not fully buffered before the response begins.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  return { request, discard: body?.discard ?? (() => {}) };
}

async function send(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
  discard: () => void,
): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });

  // Before the response goes out, not after: while the remainder is unread the
  // client can be blocked writing it, and a client blocked on a write is not
  // reliably reading the refusal we are about to send.
  if (!req.readableEnded) discard();

  res.writeHead(response.status, headers);

  if (response.body) {
    await pipeline(Readable.fromWeb(response.body as never), res);
  } else {
    await new Promise<void>((resolve) => res.end(resolve));
  }
}

/**
 * Adapts a handler to `node:http`.
 *
 * Resolves `false` when the handler declined the request, so it slots in front
 * of an existing router rather than replacing it:
 *
 *     const chil = toNodeHandler(createHandler({ broker, sink }));
 *     createServer(async (req, res) => {
 *       if (await chil(req, res)) return;
 *       ...your routes
 *     });
 */
export function toNodeHandler(
  handler: ChilHandler,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async function nodeHandler(req, res) {
    const { request, discard } = toRequest(req);
    const response = await handler(request);
    // Declined. The body is deliberately left untouched — the host's own router
    // is about to read it.
    if (response === null) return false;
    await send(req, res, response, discard);
    return true;
  };
}
