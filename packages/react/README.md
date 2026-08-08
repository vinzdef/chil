# @chiljs/react

Headless React hooks for [CHIL](https://github.com/vinzdef/chil). No
markup, no styles, no QR renderer.

```tsx
const transport = createTransport();

function Upload({ token }: { token: string | null }) {
  const { phase, progress, reason, canRetry, send } = useUploadSession({ token, transport });
  ...
}

function Panel() {
  const { url, phase, regenerate } = useHandoffSession({ transport, mint });
  return url ? <QrCode value={url} /> : null;
}
```

`useUploadSession` claims on mount and exposes `checking | ready | sending |
sent | error`. `useHandoffSession` mints, polls, and distinguishes `received` from
`expired` from `invalid` — they call for different words and different next
moves.

Both return `reason` codes rather than sentences. The copy and the language are
yours.

## The URL

`<origin><path>?token=…#k=…` — the token in the query because the page reads it
back, the key in the fragment because a browser never sends one to the server.
Neither placement is an application's choice, so neither is overridable.

```tsx
useHandoffSession({
  mint,
  transport,
  origin: 'https://send.example.com', // defaults to location.origin
  path: '/hand-off',                  // defaults to /
  params: { debug: '1' },             // the server sees these
  fragment: { locale },               // it never sees these
  recipient,
});
```

For a shape those cannot express — a hash router, a shortener, a signed
redirector — transform `state.url` where you render it:

```tsx
const { url } = useHandoffSession({ mint, transport, recipient });
return url ? <QrCode value={hashRouted(url)} /> : null;
```

There is deliberately no `buildUrl`. It replaced the one line that places the
key, so a consumer who reached for it to add a query parameter shipped plaintext
from a deployment that had asked for encryption.

## Encryption

Off unless you pass the keys. Two more hooks cover the encrypted path — what it
protects against, and what it costs, is in
[`@chiljs/crypto`](https://github.com/vinzdef/chil/tree/main/packages/crypto#readme).

```tsx
// Requester — the public key rides in the URL fragment, which the server never sees.
const { recipient } = useRecipient(() => createRecipient({ scope: room }));
const { url } = useHandoffSession({ mint, transport, recipient: recipient ?? undefined });

// Sender — build the sealer from the fragment.
const [seal, setSeal] = useState<SealerLike>();
useEffect(() => {
  const key = keyFromFragment();
  if (key) void createSealer(key).then(setSeal);
}, []);
const { send } = useUploadSession({ token, transport, seal, requireSeal: true });

// Dashboard — fetch, decrypt, object URL, revoked on unmount.
const { src, reason } = useDecrypted(fileUrl, recipient);
```

`seal` is asynchronous to build, so it arrives undefined on the first render and
defined on a later one. That is expected and costs a re-claim, not a code.

`requireSeal` refuses in `error` with `seal-required` rather than downgrading to
plaintext when the fragment was stripped in transit — by a link rewriter, a chat
preview generator, a shortener. It refuses at send, not at claim, so the sender
still reaches a working page.

`useRecipient` reads its callback once. Remount to change scope.

## Types

`SealerLike` and `RecipientLike` are re-exported here, so the encrypted path
needs no second import. Both are types — `import type`, or a bundler fails at
runtime looking for a value that was never there. From `@chiljs/crypto`, `Sealer`
satisfies `SealerLike`, and `Recipient` satisfies both `RecipientLike` and the
`RecipientHandle` that `useDecrypted` takes. No casts either way.

React 18+ (`useSyncExternalStore`). React 19 works.

Full documentation: the [repository README](https://github.com/vinzdef/chil#readme).

MIT.
