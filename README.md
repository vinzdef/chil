# CHIL

**C**laimed **H**andoff **I**nbound **L**ink.

An unauthenticated sender hands a file to an authenticated (or otherwise trusted) session, brokered by a
short-lived single-use token that travels in a URL. Getting that URL to the
sender is your choice and not this library's: a QR code on screen is good way to do so, a link, an
SMS.

Optionally the data can be E2E encrypted.

Framework-agnostic core, React bindings, no dependencies.

---

| Package          | What it is                                  | Runs on                  |
| ---------------- | ------------------------------------------- | ------------------------ |
| `@chiljs/core`   | protocol, token broker, store contract      | isomorphic, zero deps    |
| `@chiljs/server` | fetch-API handlers                          | Node, Workers, Deno, Bun |
| `@chiljs/client` | claim, upload with progress, state machines | any browser              |
| `@chiljs/react`  | headless hooks                              | React 18+                |
| `@chiljs/crypto` | optional end-to-end encryption              | WebCrypto                |

## Support

If you found this useful, consider supporting me
on [Buy Me a Coffee](https://buymeacoffee.com/vinzdef) or [GitHub](https://github.com/sponsors/vinzdef).

Are you building (or want to build) something that uses this library? I might be able to help.

Get in touch: [https://vincent.codes](https://vincent.codes).

## The exchange

```
requester                      server                        sender
   │                             │                             │
   │──────── mint(room) ────────▶│                             │
   │◀─────── token, flow ────────│                             │
   │                             │                             │
   │╌╌╌╌╌╌╌╌╌ share url ╌╌╌╌╌╌╌╌╌│╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌▶│
   │                             │                             │
   │                             │◀─ claim(token, claimant) ───│
   │                             │ first wins, rest refused    │
   │──────── poll check ────────▶│                             │
   │                             │                             │
   │                             │◀─ upload(token, claimant) ──│
   │                             │ sink writes ─▶ consumed     │
   │◀────── already-sent ────────│                             │
```

Four properties, which are the reason this exists as a library:

- **The token is consumed on success only.** <br/> A dropped upload is retryable with
  the same code.
- **Claim, check and consume are three operations.**
- **Spent tokens leave a tombstone.** <br/> So a sender can know the upload went fine after reloading that same URL (for a configurable amount of time).
- **The correlation id and the credential are different values.** <br/> `flow` is safe
  to send to an analytics collector. The claimant id is not, and never leaves your
  origin. See [Privacy](#privacy).

## Use cases

A session **that is already authenticated or trusted** needs a file from
a device that is not.

- **Capture from a phone into a desktop session.** <br/> Someone at a workstation
  needs a file taken right now. The phone opens a URL, sends one file, done.
- **Counter and kiosk intake.** <br/> ID documents, proof of address, a signed form.
  The customer uses their own phone; the teller's session receives it; the
  customer never needs an account.
- **Field work against an existing ticket.** <br/> Files onto a work order or a claim
  from whichever phone is on site, into a terminal someone else is logged into.
- **Guest drop.** <bt/> A one-time upload link to an outside party: contractor,
  client, applicant.
- **Your own second device.** <br/> You are on a laptop and the file is on your phone.
  No app, no emailing it to yourself.

This is not: multi-device sync, a general file-transfer service, or resumable
multi-gigabyte uploads. One file, one token, one direction.

## Install

```sh
npm i @chiljs/server @chiljs/core   # server
npm i @chiljs/client                # any client — no framework
npm i @chiljs/react                 # React, instead of the above (pulls in @chiljs/client)
npm i @chiljs/crypto                # optional, either side, end-to-end encryption
```

Node 20+. ESM only.

## Server

```ts
import { createBroker } from '@chiljs/core';
import { createHandler, createMintHandler } from '@chiljs/server';
import { toNodeHandler } from '@chiljs/server/node';

const broker = createBroker();            // memoryStore() by default

const exchange = toNodeHandler(
  createHandler({
    broker,
    sink: mySink,                         // the one piece you write
    maxBytes: 4 * 1024 * 1024,
    inspect: (head) => (isJpeg(head) ? null : 'bad-type'),
  }),
);

const mint = toNodeHandler(
  createMintHandler({
    broker,
    room: (request) => sessionRoom(request),   // ← your authentication
  }),
);

createServer(async (req, res) => {
  if (await exchange(req, res)) return;   // /chil/check, /claim, /upload
  ...your routes
});
```

`createHandler` returns `null` for paths it does not own, so it mounts in front
of an existing router rather than replacing it. On Workers, Deno or Bun, skip
`toNodeHandler` and use the `(Request) => Response` handler directly.

**Minting is not one of the public routes.** It is the endpoint that produces
credentials, so it has its own constructor with a mandatory `room` resolver.
Mount it behind whatever guards your requester side, and prove it with a `curl`
that gets a 401.

### The sink

The only thing this library does not implement. A filesystem queue, S3, a
database blob and a print spooler are all reasonable, and none of them belongs
in a protocol package.

```ts
const sink: Sink = {
  async store(ctx, body) {
    // ctx: { room, label, flow, declaredType, limitBytes }  — no token, ever
    await write(body);
    return { ok: true, id, size };
  },
};
```

Two obligations: let `BodyRejected` propagate (it is how a too-large or
wrong-format upload is refused mid-flight — clean up your partial write in a
`finally` and rethrow), and expect to be called again after a sender's
connection drops.

## React

```tsx
const transport = createTransport(); // same-origin, /chil

function Upload({ token }) {
  const { phase, progress, reason, canRetry, send } = useUploadSession({
    token,
    transport,
  });

  if (phase === "sent") return <Done />;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send(file, { label: name });
      }}
    >
      ...
    </form>
  );
}

function Panel() {
  const { url, phase, regenerate } = useHandoffSession({
    transport,
    mint: myMint,
  });
  return url ? <QrCode value={url} /> : null;
}
```

The hooks return `reason` codes, never sentences: the copy and the language are
yours. `url` is a plain string — get it to the sender however suits, whether
that is a QR library you already use or a link you send. Shipping a renderer
would make this an opinionated UI package instead of a protocol one.

That string is `<origin><path>?token=…`, and `path` defaults to `/`, so pass the
page that does the upload: `path: '/send'`. `origin`, `params` and `fragment` are
there too, for a different host, a debug flag, a locale. For a shape they cannot
express — a hash router, a shortener — transform `url` where you render it.

> **Not React?** Good. `createUploadSession` and `createHandoffSession` in `@chiljs/client` are
> plain objects with `getState` / `subscribe`, which is all `useSyncExternalStore`
> and every other framework's equivalent need.

## Other token stores

`memoryStore()` is the default and is right for a single process. These are
secrets with a five-minute life; persisting them to survive a restart is
machinery bought for a cost nobody pays.

If you do need Redis, KV or a table, implement `TokenStore` — and read this
first:

> **`claim` and `consume` must be atomic.** They are on the store interface,
> rather than composed in the broker from `get` + `put`, for exactly that
> reason. In one process, check-then-write is atomic for free on the event loop.
> Behind a network it is not: two claimants both read `claimedBy === undefined`,
> both write, and both hold the code — at which point claiming is decorative and
> a copied url works twice.

Then prove it:

```ts
import { checkStore } from "@chiljs/core/conformance";
const failures = (await checkStore(() => myStore())).filter((o) => !o.ok);
```

## End-to-end encryption (optional)

Browsers never send a URL fragment to the server, so the requester's public key
can reach the sender out of band and the server stores bytes it cannot read.

```ts
const recipient = await createRecipient({ scope: room }); // IndexedDB, non-extractable
useHandoffSession({ mint, transport, recipient }); // key rides in #k=
useUploadSession({ token, transport, seal, requireSeal: true }); // seals inside send()
createHandler({ broker, sink, inspect: sealedOnly() }); // server refuses plaintext
```

Where the key sits is the session's decision, not an option: the token goes in
the query because the sender's page reads it back, the key goes in the fragment
because a browser never sends one to the server. A URL you rewrite by hand is the
one way to lose it, which is why the check below exists.

**In an encrypted deployment, plaintext must never be accepted — so the server
enforces it.**

The key travels in the URL fragment, and link rewriters, chat
preview generators and URL shorteners all strip fragments. When that happens the
uploading page has nothing to seal with, and the failure would otherwise be silent:
the file would arrive in the clear and neither end would say so. `sealedOnly()` refuses
any body without a seal header, before the sink is called. `requireSeal` is the
matching courtesy on the sender: it fails up front rather than after the person
has uploaded a file.

That guard stops accidental plaintext, which is the real failure. **It cannot stop
a forgery**: anyone can prepend the header bytes to junk, just as they could seal
to a key nobody holds. No server that cannot decrypt can tell those apart.

Off by default, and worth turning on only when **storage is a different trust
domain from the application** — an object store, a managed host, backups. It
does not protect against a compromised app server, because that server ships the
JavaScript doing the encryption.

Three costs, none hideable: `inspect` can no longer check the payload's format,
since that is encrypted — use `sealedOnly()` in its place; `maxLabelLength` must
rise to 512; and loading that file adds a decryption step.

**Key loss is permanent for anything already queued.**

Full detail, including exactly how long an IndexedDB key survives and what
evicts it: [`@chiljs/crypto`](packages/crypto/README.md).

## Privacy

| Id          | Scope       | On device        | Safe to send to analytics    |
| ----------- | ----------- | ---------------- | ---------------------------- |
| `flow`      | per handoff | no               | **yes** — authorises nothing |
| claimant id | per handoff | `sessionStorage` | **no** — it is the claim     |

The claimant id is device storage. If you have EU or UK users, that is EU ePrivacy
Art. 5(3) — PECR in the UK — which exempts it from consent only while it is
_strictly necessary_, which it is: without it the claim and the upload disagree
and someone is refused their own file. **That exemption is conditional on the
value having no second purpose.** Send it to a collector and the exemption stops
holding. `flow` exists precisely so there is something safe to send.

ePrivacy governs the storage; GDPR governs what you then do with the value. The
exemption from consent is not an exemption from needing a lawful basis under
Art. 6 — which is yours to establish, and is easier to argue while the id stays
scoped to one token, one tab, and your own origin.

> None of this is legal advice. Deploying this library, like any other, is a
> processing decision in your context and not ours — review it with your DPO or
> counsel.

The claimant id is stored under a key containing the token, so the token is a key
name in `sessionStorage`. That store is origin- and tab-scoped, so anything able
to read it is already running in your origin — and while the upload page is
open, that also means reading the token straight off the URL. What the storage
adds is a later read in the same tab, after the URL is gone but before the
five-minute token expires and while it is still unspent. Third-party tags count
here: they execute in your origin. If you embed any on the upload page, that is
the case to weigh.

`hashKey` stores under a digest of the token instead, closing that case:

```ts
useUploadSession({
  token,
  transport,
  claimant: claimantId(token, { hashKey: true }),
});
```

Off by default, because it is not free. The digest is a 64-bit non-cryptographic
hash — `crypto.subtle` is async and this runs in a synchronous factory — so two
tokens can in principle collide, share one id, and make two exchanges that
should look unrelated linkable. It takes far more codes in a single tab than
anyone opens, but it is a privacy regression rather than a broken upload, which
is the wrong direction for a page that already accepts the URL exposure.

Two more, neither optional:

- The handoff URL carries a bearer secret in its query string. Anything the
  receiving page links to needs `rel="noreferrer"` — same-origin links included,
  since the default referrer policy sends the full URL, token and all, straight
  into your own access log.
- Keep query strings out of those logs.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run example      # a full exchange on localhost, in memory
```

**Node 24+ to run the suite.** The tests are TypeScript executed directly by
`node --test`, so they need native type stripping. The published packages need
only Node 20; CI checks that floor separately by importing the built output
there.

## Licence

MIT.
