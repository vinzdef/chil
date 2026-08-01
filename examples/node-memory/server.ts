/**
 * A complete exchange in one file, on plain `node:http`.
 *
 *     npm run example
 *
 * Then open the printed requester URL, and load the code URL it gives you on
 * another device on the same network. Everything is in memory: restart and
 * it is all gone.
 *
 * What this is showing, in the order it matters:
 *
 *  1. `/chil/*` is mounted in front of an existing router and declines
 *     anything that is not its own, so adopting it is three lines.
 *  2. Minting sits behind the example's Basic auth, using a separate handler.
 *     That separation is the whole reason `createMintHandler` exists.
 *  3. The sink is where the bytes go, and it is the only piece a real
 *     application must write.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { createBroker, type ErrorReason } from '@chiljs/core';
import { createHandler, createMintHandler, memorySink } from '@chiljs/server';
import { toNodeHandler } from '@chiljs/server/node';

const PORT = Number(process.env.PORT ?? 8099);
const ROOM = 'demo';
const REQUESTER_PASSWORD = 'demo';

const broker = createBroker({ ttlMs: 5 * 60 * 1000 });
const sink = memorySink();

/** JPEG only, from the magic bytes. Neither the header nor a filename is consulted. */
function jpegOnly(head: Uint8Array): ErrorReason | null {
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  return jpeg ? null : 'bad-type';
}

/** Stand-in for whatever really guards your requester side. */
function requesterAuthorised(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const [, password] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  return password === REQUESTER_PASSWORD;
}

const exchange = toNodeHandler(
  createHandler({
    broker,
    sink,
    maxBytes: 4 * 1024 * 1024,
    inspect: jpegOnly,
    onEvent: (event) => console.log('[chil]', JSON.stringify(event)),
  }),
);

const mint = toNodeHandler(
  createMintHandler({
    broker,
    // The resolver is where authentication happens. Returning a room for a
    // caller you have not authenticated is the one way to get this wrong.
    room: (request) => (request.headers.get('x-requester') === 'yes' ? ROOM : null),
  }),
);

const server = createServer((req, res) => {
  void (async () => {
    // The public exchange first: three routes, no authentication, the token is
    // the credential.
    if (await exchange(req, res)) return;

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.pathname === '/requester/mint') {
      if (!requesterAuthorised(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="requester"' }).end();
        return;
      }
      // The flag the mint handler's resolver looks for. In a real application
      // this would be a session lookup, not a header you set yourself.
      req.headers['x-requester'] = 'yes';
      await mint(req, res);
      return;
    }

    if (url.pathname === '/requester/queue') {
      if (!requesterAuthorised(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="requester"' }).end();
        return;
      }
      const items = sink.list(ROOM).map(({ id, label, flow, receivedAt, bytes }) => ({
        id,
        label,
        flow,
        receivedAt,
        size: bytes.byteLength,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(items, null, 2));
      return;
    }

    res.writeHead(404).end('Not found');
  })().catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end('server error');
  });
});

// Unconditional and on a timer: the only thing between this design and
// unbounded growth, so it must not depend on traffic arriving.
setInterval(() => void broker.sweep(), 60_000).unref();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
  CHIL example on http://127.0.0.1:${PORT}

  Mint a code (requester side, password "${REQUESTER_PASSWORD}"):
    curl -s -u requester:${REQUESTER_PASSWORD} -XPOST http://127.0.0.1:${PORT}/requester/mint

  Upload against the token it returns:
    curl -i -XPOST --data-binary @file.jpg -H 'Content-Type: image/jpeg' \\
      'http://127.0.0.1:${PORT}/chil/upload?token=<token>&claimant=claimant-aaaaaaaaaaaa&label=Ada'

  Try the same token twice, and try a second claimant id — both are refused, and
  the reasons differ. See what arrived:
    curl -s -u requester:${REQUESTER_PASSWORD} http://127.0.0.1:${PORT}/requester/queue
`);
});
