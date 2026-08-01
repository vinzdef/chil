# @chiljs/crypto

Optional end-to-end encryption for [chil](https://github.com/vinzdef/chil).
The client seals the upload to a key the server never sees; only the device that
issued the handoff can open it.

```ts
// Requester — key generated once, kept in IndexedDB.
const recipient = await createRecipient({ scope: room });
useHandoffSession({ mint, transport, recipient }); // public key goes in the URL fragment

// Client — reads the fragment, seals inside send().
const key = keyFromFragment();
useUploadSession({
  token,
  transport,
  seal: key ? await createSealer(key) : undefined,
});

// Dashboard.
const file = await recipient.decrypt(downloaded);
```

ECDH P-256 → HKDF-SHA256 → AES-256-GCM. The sealed blob is self-describing, so a
queue can hold sealed and unsealed items at once and `decrypt` passes plaintext
straight through — you can roll it out, and roll it back, without stranding
anything.

## Why the fragment

A browser never sends `#…` to the server. The key reaches the client in the URL
itself, so the server that stores the ciphertext never learns it. Put the same
value in the query string and the encryption is decorative.

## What this protects against, and what it does not

**Does:** storage compromise, backups, an untrusted object store or host, a
subpoena on data at rest.

**Does not:** a compromised application server. The server that stores the
ciphertext also ships the JavaScript that encrypts it. Swap the bundle,
exfiltrate the key. This is the standing limit of browser-delivered E2E and no
library fixes it.

So it pays when storage is a _different trust domain_ from the application. When
they are the same host, it mostly buys ceremony — and costs you the checks below.

## What it costs

**A format allowlist has to go — swap it for `sealedOnly()`.** Ciphertext has no
_image_ magic bytes, so checking for JPEG rejects every upload; content
validation and E2E are contradictory by definition. But a sealed blob does carry
this library's own magic, so `inspect: sealedOnly()` still buys you something
better than nothing: your server's guarantee changes from "this is a JPEG" to
"this is sealed and under N bytes", and a plaintext upload from a page that lost
its key is refused rather than stored.

Understand what that check is worth. It reads a magic signature the uploader
supplied, so it is trivially forgeable: anyone holding a valid token can prepend
those bytes to arbitrary data and pass. It catches the accident — a page whose
key was stripped in transit — not an attacker. The guarantee is asserted by the
uploader, not verified by the server, that is beyond the scope of this library.

**Raise `maxLabelLength` to 512.** A sealed label carries an 85-byte header and
a 16-byte tag before base64url, so a 12-character name arrives as ~150
characters. Leave the default of 120 and the server truncates it, which surfaces
much later as `corrupt`.

**`<img src>` stops working.** Every image becomes fetch → decrypt → object URL,
and `Cache-Control` no longer helps. `useDecrypted` in `@chiljs/react` makes it
a one-liner, but it is still a change to your components.

## How long the key survives — read before shipping

The private key is generated **non-extractable** and stored in IndexedDB as a
`CryptoKey` handle, so it never exists as bytes in JavaScript. Script on the
page can _use_ it while the page is open and cannot export it: an XSS becomes a
session-long problem rather than a permanent key compromise. That is also why
there is deliberately no backup, export or escrow — all three need an
extractable key.

The consequence is that key loss is real and silent. A device whose key is gone
keeps working — a fresh keypair is generated on demand and new uploads seal to
it — but **anything already queued under the old key is unreadable for good.**

Survives: reload, tab close, browser restart, device reboot, and any amount of
server-side redeployment. None of this lives on the server.

Lost to:

| Cause                                                       | Notes                                                                                                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clearing site data                                          | The realistic one, and the worst — it can happen mid-shift with items queued.                                                                                                                    |
| Replaced, reset or reimaged device; another browser profile | Nothing recovers this.                                                                                                                                                                           |
| Private / incognito browsing                                | The store dies with the window.                                                                                                                                                                  |
| Safari ITP eviction                                         | All script-writable storage is erased after **seven days without user interaction with the site**. A tracking countermeasure, not a storage policy; Chrome and Firefox do not do it.             |
| Storage pressure                                            | Browsers evict whole origins when the disk fills. `requestPersistence()` asks for exemption and is usually granted to a site with real interaction history. It does **not** exempt you from ITP. |

The ITP case sounds the most alarming and costs the least: the clock is reset by
someone opening the page, so a kiosk in daily use never approaches it, and a
device idle for seven days has an empty queue anyway if your retention is
shorter than that.

Loss cannot be prevented from here, so the design makes it legible instead:
`decrypt` reports `no-key`, `wrong-key`, `corrupt` and `unsupported-version` as
distinct reasons, and `canDecrypt` answers without attempting, so a list view
can say "sealed to a key this device no longer has" rather than showing a broken
image.

## Scope

One key per tenant or room — `createRecipient({ scope: room })`. Two devices
sharing one set of credentials will not be able to read each other's uploads;
the device becomes part of the identity.

Full documentation: the [repository README](https://github.com/vinzdef/chil#readme).

MIT.
