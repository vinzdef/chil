# @chiljs/server

Fetch-API request handlers for [chil](https://github.com/vinzdef/chil).
`(Request) => Response | null`, so it runs on Node, Workers, Deno and Bun, and
returns `null` for paths it does not own so it mounts in front of your router.

```ts
import { createBroker } from '@chiljs/core';
import { createHandler, createMintHandler } from '@chiljs/server';
import { toNodeHandler } from '@chiljs/server/node';

const exchange = toNodeHandler(createHandler({ broker, sink }));

createServer(async (req, res) => {
  if (await exchange(req, res)) return;
  ...your routes
});
```

Three public routes under `basePath` (default `/chil`): `GET /check`,
`POST /claim`, `POST /upload`. All three are unauthenticated by design — the
token is the credential.

**`createMintHandler` is separate and must not be public.** It issues
credentials; it takes a `room` resolver so authentication is impossible to
forget.

## The sink

The one piece you write. `store(ctx, body)` receives a `ReadableStream` already
capped at `maxBytes` and already past your `inspect` allowlist. Let
`BodyRejected` propagate, and clean up partial writes in a `finally`.

`ctx` never contains the token: the authoriser has no business in the layer that
writes to disk.

Full documentation: the [repository README](https://github.com/vinzdef/chil#readme).

MIT.
