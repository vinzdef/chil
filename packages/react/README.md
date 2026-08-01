# @chiljs/react

Headless React hooks for [chil](https://github.com/vinzdef/chil). No
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

React 18+ (`useSyncExternalStore`). React 19 works.

Full documentation: the [repository README](https://github.com/vinzdef/chil#readme).

MIT.
