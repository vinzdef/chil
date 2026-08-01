# @chiljs/core

Protocol, token broker and store contract for [CHIL](https://github.com/vinzdef/chil).
Isomorphic, zero dependencies — it runs in a browser, in a Worker and on Node.

```ts
import { createBroker, memoryStore, parseToken } from "@chiljs/core";

const broker = createBroker({ store: memoryStore(), ttlMs: 5 * 60 * 1000 });

const { token, flow } = await broker.mint("shop-1"); // behind YOUR auth
const { room, secret } = parseToken(token)!;

await broker.check(room, secret); // never consumes, safe to poll
await broker.claim(room, secret, claimantId); // first browser wins
await broker.consume(secret); // only after the file is stored
```

Most applications reach for `@chiljs/server` instead, which wraps this in
request handlers. Use this package directly when you want the four operations
and none of the routing.

## Writing a store

`memoryStore()` is the default and is correct for a single process. Anything
else must make `claim` and `consume` atomic — see the note on `TokenStore`, and
run the suite:

```ts
import { checkStore } from "@chiljs/core/conformance";
const failures = (await checkStore(() => myStore())).filter((o) => !o.ok);
```

Full documentation: the [repository README](https://github.com/vinzdef/chil#readme).

MIT.
