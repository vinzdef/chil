# @chiljs/client

Browser half of [CHIL](https://github.com/vinzdef/chil): the transport,
the per-token claimant id, and two framework-free state machines.

```ts
import { createTransport, createUploadSession } from '@chiljs/client';

const session = createUploadSession({ token, transport: createTransport() });
session.subscribe(() => render(session.getState()));
session.start();                       // claims the code
session.send(blob, { label: name });   // phases: checking → ready → sending → sent
```

`getState` / `subscribe` is all `useSyncExternalStore` — or Vue, Svelte, or a
plain callback — needs. `@chiljs/react` is a thin binding over exactly this.

`createHandoffSession` is the requester's side: mints, polls, and reports whether the
code on screen is `live`, `claimed`, `received`, `expired` or `invalid`. It
gives you a `url` string; render it with your own QR library.

Uploads use `XMLHttpRequest` when progress is asked for, because `fetch` still
cannot report it — request streaming needs `duplex: 'half'` over HTTP/2 and is
absent from Safari. Do not "modernise" it.

## Two ids, one rule

`flow` is safe to send to an analytics collector. The claimant id is not — it is
the claim, and it is device storage whose consent exemption depends on having no
second purpose.

Full documentation: the [repository README](https://github.com/vinzdef/chil#readme).

MIT.
