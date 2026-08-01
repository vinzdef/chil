import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test, { after } from 'node:test';
import { createBroker, parseToken, type ErrorReason } from '@chiljs/core';
import { createHandler, memorySink, type Sink } from '@chiljs/server';
import { toNodeHandler } from '@chiljs/server/node';
import {
  claimantId,
  createHandoffSession,
  createTransport,
  createUploadSession,
  ChilError,
} from '@chiljs/client';
import { createRecipient, createSealer, keyFromFragment, memoryKeyStore } from '@chiljs/crypto';

const CLAIMANT_A = 'claimant-aaaaaaaaaaaa';
const CLAIMANT_B = 'claimant-bbbbbbbbbbbb';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 2, 3, 4, 5]);
const NOT_JPEG = new Uint8Array(16).fill(0x42);

/** The format allowlist a file application would pass in. */
function jpegOnly(head: Uint8Array): ErrorReason | null {
  if (head.length === 0) return 'bad-type';
  const looksJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  return looksJpeg ? null : 'bad-type';
}

interface Harness {
  baseUrl: string;
  broker: ReturnType<typeof createBroker>;
  sink: ReturnType<typeof memorySink>;
  close: () => Promise<void>;
}

interface BootOptions {
  sink?: Sink;
  maxBytes?: number;
  maxLabelLength?: number;
  /**
   * Null turns the format allowlist off, which is what an encrypted deployment
   * has to do: ciphertext has no *image* magic bytes, so a JPEG allowlist and
   * end-to-end encryption cannot both be on. `sealedOnly()` is what goes in its
   * place — see the crypto tests.
   */
  inspect?: ((head: Uint8Array) => ErrorReason | null) | null;
}

async function boot(options: BootOptions = {}): Promise<Harness> {
  const broker = createBroker();
  const sink = memorySink();
  const handler = toNodeHandler(
    createHandler({
      broker,
      sink: options.sink ?? sink,
      maxBytes: options.maxBytes ?? 1024,
      maxLabelLength: options.maxLabelLength,
      inspect: options.inspect === null ? undefined : (options.inspect ?? jpegOnly),
    }),
  );

  const server: Server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end('not mine');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    broker,
    sink,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const harnesses: Harness[] = [];
async function harness(options?: BootOptions): Promise<Harness> {
  const made = await boot(options);
  harnesses.push(made);
  return made;
}

after(async () => {
  for (const one of harnesses) await one.close();
});

test('a scanned code can be claimed and spent exactly once', async () => {
  const { baseUrl, broker, sink } = await harness();
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');

  const claimed = await transport.claim(token, CLAIMANT_A);
  assert.equal(claimed.first, true);

  const result = await transport.upload({
    token,
    claimant: CLAIMANT_A,
    label: '  Giulia  ',
    body: JPEG,
    contentType: 'image/jpeg',
  });
  assert.equal(result.size, JPEG.byteLength);

  const stored = sink.list('shop');
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.label, 'Giulia', 'the label should arrive trimmed');
  assert.equal(stored[0]!.flow, claimed.flow, 'the sink must be able to join back to the handoff');

  // The code is now spent, and says so in a way the page can act on.
  await assert.rejects(
    () => transport.check(token),
    (err: ChilError) => err.reason === 'already-sent',
  );
});

test('the sink never sees the token', async () => {
  const { baseUrl, broker, sink } = await harness();
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');

  await transport.upload({ token, claimant: CLAIMANT_A, body: JPEG, contentType: 'image/jpeg' });

  const stored = sink.list('shop')[0]!;
  const serialised = JSON.stringify({ ...stored, bytes: undefined });
  const { secret } = parseToken(token)!;
  assert.ok(!serialised.includes(secret), 'the authoriser must not reach the storage layer');
});

test('a copied code is useless to whoever copied it, even skipping the page', async () => {
  const { baseUrl, broker } = await harness();
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');

  await transport.claim(token, CLAIMANT_A);

  // Straight to the upload route with no claim of their own — the case the
  // claim check on /upload exists for.
  await assert.rejects(
    () => transport.upload({ token, claimant: CLAIMANT_B, body: JPEG, contentType: 'image/jpeg' }),
    (err: ChilError) => err.reason === 'already-claimed' && err.status === 403,
  );
});

test('an unclaimed token is claimed by the upload itself', async () => {
  const { baseUrl, broker } = await harness();
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');

  // No prior claim: a caller that never loaded the page must still behave like
  // one that did.
  const result = await transport.upload({
    token,
    claimant: CLAIMANT_A,
    body: JPEG,
    contentType: 'image/jpeg',
  });
  assert.ok(result.id);
});

test('a chunked body with no declared length is still capped', async () => {
  const { baseUrl, broker } = await harness({ maxBytes: 32 });
  const { token } = await broker.mint('shop');

  // A streamed body carries `Transfer-Encoding: chunked` and no
  // `Content-Length`, so the early rejection never fires and the counter in
  // `guardBody` is the only thing standing between a scanned code and an
  // unbounded write. This is the case that check exists for — a lying
  // `Content-Length` is not, since Node frames the body by it and simply never
  // hands over the excess.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(JPEG);
      for (let i = 0; i < 8; i++) controller.enqueue(new Uint8Array(64));
      controller.close();
    },
  });

  const res = await fetch(
    `${baseUrl}/chil/upload?token=${encodeURIComponent(token)}&claimant=${CLAIMANT_A}&label=`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body,
      // @ts-expect-error -- undici needs this whenever a body is streamed
      duplex: 'half',
    },
  );
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { reason: 'too-large' });

  // And the refusal must not have cost the uploader their code.
  const { room, secret } = parseToken(token)!;
  assert.equal((await broker.check(room, secret)).ok, true);
});

test('a large body is refused with a status, not a reset', async () => {
  const { baseUrl, broker } = await harness({ maxBytes: 64 });
  const { token } = await broker.mint('shop');

  // Big enough that the sender is still writing when the refusal is decided —
  // several megabytes will not fit in the socket buffers. Refusing without
  // draining the remainder stalls until the server's request timeout and the
  // client sees a 408; destroying the socket instead resets the connection and
  // the sender sees no status at all. Both have happened here.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(JPEG);
      for (let i = 0; i < 512; i++) controller.enqueue(new Uint8Array(16 * 1024));
      controller.close();
    },
  });

  const res = await fetch(
    `${baseUrl}/chil/upload?token=${encodeURIComponent(token)}&claimant=${CLAIMANT_A}&label=`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body,
      // @ts-expect-error -- undici needs this whenever a body is streamed
      duplex: 'half',
    },
  );
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { reason: 'too-large' });
});

test('an oversized declared length is refused before the body is read', async () => {
  const { baseUrl, broker } = await harness({ maxBytes: 32 });
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');

  await assert.rejects(
    () =>
      transport.upload({
        token,
        claimant: CLAIMANT_A,
        body: new Uint8Array(4096),
        contentType: 'image/jpeg',
      }),
    (err: ChilError) => err.reason === 'too-large',
  );
});

test('the format allowlist reads the bytes, not the header', async () => {
  const { baseUrl, broker } = await harness();
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');

  await assert.rejects(
    () =>
      transport.upload({
        token,
        claimant: CLAIMANT_A,
        body: NOT_JPEG,
        // A truthful-looking header over bytes that are not a JPEG.
        contentType: 'image/jpeg',
      }),
    (err: ChilError) => err.reason === 'bad-type' && err.status === 415,
  );
});

test('an empty body is refused', async () => {
  const { baseUrl, broker } = await harness();
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');

  await assert.rejects(
    () =>
      transport.upload({
        token,
        claimant: CLAIMANT_A,
        body: new Uint8Array(0),
        contentType: 'image/jpeg',
      }),
    (err: ChilError) => err.reason === 'bad-type',
  );
});

test('a refused upload leaves the code usable — this is the whole point', async () => {
  const { baseUrl, broker } = await harness();
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');

  await assert.rejects(() =>
    transport.upload({ token, claimant: CLAIMANT_A, body: NOT_JPEG, contentType: 'image/jpeg' }),
  );

  // Same code, same sender, second attempt: accepted.
  const result = await transport.upload({
    token,
    claimant: CLAIMANT_A,
    body: JPEG,
    contentType: 'image/jpeg',
  });
  assert.ok(result.id);
});

test('a sink that fails does not spend the token', async () => {
  const failing: Sink = {
    async store(_ctx, body) {
      await body.cancel();
      return { ok: false, reason: 'storage-full' };
    },
  };
  const { baseUrl, broker } = await harness({ sink: failing });
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');

  await assert.rejects(
    () => transport.upload({ token, claimant: CLAIMANT_A, body: JPEG, contentType: 'image/jpeg' }),
    (err: ChilError) => err.reason === 'storage-full' && err.status === 507,
  );

  const { room, secret } = parseToken(token)!;
  const verdict = await broker.check(room, secret);
  assert.equal(verdict.ok, true, 'a storage failure must not cost someone their code');
});

test('a malformed claimant id is rejected before anything is claimed', async () => {
  const { baseUrl, broker } = await harness();
  const { token } = await broker.mint('shop');

  const res = await fetch(
    `${baseUrl}/chil/claim?token=${encodeURIComponent(token)}&claimant=x`,
    { method: 'POST' },
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { reason: 'bad-request' });

  const { room, secret } = parseToken(token)!;
  const verdict = await broker.check(room, secret);
  assert.equal(verdict.ok && verdict.claimed, false, 'a rejected request must not claim');
});

test('answers about a live secret are never cacheable', async () => {
  const { baseUrl, broker } = await harness();
  const { token } = await broker.mint('shop');
  const res = await fetch(`${baseUrl}/chil/check?token=${encodeURIComponent(token)}`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('wrong methods are refused, and unknown paths fall through to the host', async () => {
  const { baseUrl } = await harness();

  assert.equal((await fetch(`${baseUrl}/chil/claim`)).status, 405);
  assert.equal((await fetch(`${baseUrl}/chil/check`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${baseUrl}/chil/nope`)).status, 404);

  const mine = await fetch(`${baseUrl}/something-else`);
  assert.equal(mine.status, 404);
  assert.equal(await mine.text(), 'not mine', 'the handler must decline paths it does not own');
});

// ---------------------------------------------------------------------------
// The session state machine, driven against the real server
// ---------------------------------------------------------------------------

function settles(
  session: ReturnType<typeof createUploadSession>,
  done: (state: ReturnType<typeof session.getState>) => boolean,
): Promise<ReturnType<typeof session.getState>> {
  return new Promise((resolve) => {
    const check = (): void => {
      const state = session.getState();
      if (done(state)) resolve(state);
    };
    session.subscribe(check);
    check();
  });
}

test('the upload session claims, sends, and reports progress', async () => {
  const { baseUrl, broker } = await harness();
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');

  const events: string[] = [];
  const session = createUploadSession({
    token,
    transport,
    claimant: CLAIMANT_A,
    onEvent: (event) => events.push(event.type),
  });

  session.start();
  await settles(session, (s) => s.phase === 'ready');
  assert.equal(session.getState().room, 'shop', 'the room comes out of the token, not the server');
  assert.ok(session.getState().flow, 'the flow id is learned by claiming');

  session.send(JPEG, { label: 'Marco' });
  const sent = await settles(session, (s) => s.phase === 'sent' || s.phase === 'error');
  assert.equal(sent.phase, 'sent');
  assert.equal(sent.progress, 1);
  assert.ok(sent.id);
  assert.deepEqual(events, ['claimed', 'upload-started', 'upload-succeeded']);
  session.destroy();
});

test('a session on a spent code lands in sent, not in a broken link', async () => {
  const { baseUrl, broker } = await harness();
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');
  await transport.upload({ token, claimant: CLAIMANT_A, body: JPEG, contentType: 'image/jpeg' });

  // The reload after a successful send.
  const session = createUploadSession({ token, transport, claimant: CLAIMANT_A });
  session.start();
  const state = await settles(session, (s) => s.phase !== 'checking');
  assert.equal(state.phase, 'sent');
  assert.equal(state.reason, null);
  session.destroy();
});

test('a session on a code someone else holds lands in error', async () => {
  const { baseUrl, broker } = await harness();
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');
  await transport.claim(token, CLAIMANT_A);

  const session = createUploadSession({ token, transport, claimant: CLAIMANT_B });
  session.start();
  const state = await settles(session, (s) => s.phase !== 'checking');
  assert.equal(state.phase, 'error');
  assert.equal(state.reason, 'already-claimed');
  assert.equal(state.canRetry, false, 'only a fresh code helps here');
  session.destroy();
});

test('a session with no token fails immediately without a request', async () => {
  const { baseUrl } = await harness();
  const session = createUploadSession({ token: null, transport: createTransport({ baseUrl }) });
  session.start();
  assert.equal(session.getState().phase, 'error');
  assert.equal(session.getState().reason, 'invalid-token');
  session.destroy();
});

test('a failed send is retryable from the error state', async () => {
  const { baseUrl, broker } = await harness();
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');

  const session = createUploadSession({ token, transport, claimant: CLAIMANT_A });
  session.start();
  await settles(session, (s) => s.phase === 'ready');

  session.send(NOT_JPEG);
  const failed = await settles(session, (s) => s.phase === 'error');
  assert.equal(failed.reason, 'bad-type');

  // Same session, same code, corrected file.
  session.send(JPEG);
  const sent = await settles(session, (s) => s.phase === 'sent');
  assert.ok(sent.id);
  session.destroy();
});

// ---------------------------------------------------------------------------
// End-to-end encryption, through the real server
// ---------------------------------------------------------------------------

test('a sealed upload reaches the recipient and never the server', async () => {
  // No `inspect`: ciphertext has no *image* magic bytes, so a JPEG allowlist and
  // encryption are mutually exclusive by construction.
  // A sealed label is far longer than the name inside it: an 85-byte header, a
  // 16-byte tag and base64url on top. Leave `maxLabelLength` at its default and
  // the server silently truncates it, which surfaces much later as `corrupt`.
  const { baseUrl, broker, sink } = await harness({
    maxBytes: 4096,
    maxLabelLength: 512,
    inspect: null,
  });
  const transport = createTransport({ baseUrl });
  const { token } = await broker.mint('shop');

  const recipient = await createRecipient({ store: memoryKeyStore() });
  const seal = await createSealer(recipient.publicKey);

  const session = createUploadSession({ token, transport, claimant: CLAIMANT_A, seal });
  session.start();
  await settles(session, (s) => s.phase === 'ready');

  const secret = new TextEncoder().encode('a file nobody else may read');
  session.send(secret, { label: 'Giulia Rossi' });
  const sent = await settles(session, (s) => s.phase === 'sent' || s.phase === 'error');
  assert.equal(sent.phase, 'sent');

  const stored = sink.list('shop')[0]!;

  // What the server actually holds.
  assert.notDeepEqual(stored.bytes, secret);
  assert.ok(
    !new TextDecoder().decode(stored.bytes).includes('nobody else'),
    'the plaintext must not be recoverable from what was stored',
  );
  assert.notEqual(stored.label, 'Giulia Rossi', 'the name is personal data and is sealed too');
  assert.ok(!stored.label.includes('Giulia'));

  // And what the requester gets back.
  assert.deepEqual(await recipient.decrypt(stored.bytes), secret);
  assert.equal(await recipient.decryptText(stored.label), 'Giulia Rossi');

  session.destroy();
});

test('the handoff url carries the key in its fragment, so the mint never sees it', async () => {
  const { baseUrl, broker } = await harness();
  const transport = createTransport({ baseUrl });
  const recipient = await createRecipient({ store: memoryKeyStore() });

  const handoff = createHandoffSession({
    mint: () => broker.mint('shop'),
    transport,
    recipient,
    pollMs: 60_000,
  });
  handoff.start();
  const live = await new Promise<string>((resolve) => {
    const check = (): void => {
      const { url } = handoff.getState();
      if (url) resolve(url);
    };
    handoff.subscribe(check);
    check();
  });

  const parsed = new URL(live, 'http://placeholder');
  assert.equal(parsed.searchParams.get('k'), null);
  assert.ok(parsed.hash.includes(recipient.publicKey), 'the key must ride in the fragment');

  // The sender rebuilds the sealer from the fragment, with no server round trip.
  const scanned = keyFromFragment(parsed.hash);
  assert.equal(scanned, recipient.publicKey);
  const seal = await createSealer(scanned!);
  assert.deepEqual(await recipient.decrypt(await seal.encrypt(JPEG)), JPEG);

  handoff.destroy();
});

test('a queue holding sealed and unsealed items works either way', async () => {
  const { baseUrl, broker, sink } = await harness({ maxBytes: 4096, inspect: null });
  const transport = createTransport({ baseUrl });
  const recipient = await createRecipient({ store: memoryKeyStore() });
  const seal = await createSealer(recipient.publicKey);

  // Before the rollout.
  await transport.upload({
    token: (await broker.mint('shop')).token,
    claimant: CLAIMANT_A,
    body: JPEG,
    contentType: 'image/jpeg',
  });
  // After it.
  await transport.upload({
    token: (await broker.mint('shop')).token,
    claimant: CLAIMANT_B,
    body: await seal.encrypt(JPEG),
    contentType: 'application/octet-stream',
  });

  const items = sink.list('shop');
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.deepEqual(recipient.canDecrypt(item.bytes), { ok: true });
    assert.deepEqual(await recipient.decrypt(item.bytes), JPEG);
  }
});

test('getState returns a stable reference until something changes', async () => {
  const { baseUrl, broker } = await harness();
  const { token } = await broker.mint('shop');
  const session = createUploadSession({ token, transport: createTransport({ baseUrl }) });

  const before = session.getState();
  assert.equal(session.getState(), before, 'React compares snapshots by identity');
  session.destroy();
});

function fakeStorage(): Pick<Storage, 'getItem' | 'setItem'> & { keys: () => string[] } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    keys: () => [...map.keys()],
  };
}

test('hashKey keeps the token out of the storage key', () => {
  const token = 'shop.hashkey-absent-0000';
  const hashed = fakeStorage();
  const raw = fakeStorage();

  claimantId(token, { storage: hashed, hashKey: true });
  claimantId('shop.hashkey-absent-1111', { storage: raw });

  assert.equal(hashed.keys().length, 1);
  assert.equal(
    hashed.keys()[0]!.includes(token),
    false,
    'a live bearer secret must not be a key name in an enumerable store',
  );
  assert.equal(
    raw.keys()[0],
    'chil:claimant:shop.hashkey-absent-1111',
    'the default is unchanged — hashing is opt-in',
  );
});

test('a hashed key still returns the same id after a reload', () => {
  const storage = fakeStorage();

  // A reload is a fresh page: the in-memory cache is gone and only storage
  // carries the id. Two different tokens, so neither read is served by it.
  const first = claimantId('shop.hashkey-reload-aaaa', { storage, hashKey: true });
  const second = claimantId('shop.hashkey-reload-aaaa', { storage: storage, hashKey: true });

  assert.equal(second, first, 'a reload that mints a new id is refused its own file');
  assert.equal(storage.keys().length, 1, 'the same token must not occupy two keys');
});

test('hashed keys stay scoped per token', () => {
  const storage = fakeStorage();

  const a = claimantId('shop.hashkey-scope-aaaa', { storage, hashKey: true });
  const b = claimantId('shop.hashkey-scope-bbbb', { storage, hashKey: true });

  assert.notEqual(a, b, 'one id across two codes would link two exchanges');
  assert.equal(storage.keys().length, 2);
});

test('requireSeal refuses before anything leaves the device', async () => {
  const { baseUrl, broker, sink } = await harness({ inspect: null });
  const { token } = await broker.mint('shop');

  // The sealed deployment whose key was stripped from the fragment in transit:
  // requireSeal is on, and `seal` is undefined for reasons the page cannot see.
  const session = createUploadSession({
    token,
    transport: createTransport({ baseUrl }),
    claimant: CLAIMANT_A,
    requireSeal: true,
  });

  session.start();
  await settles(session, (s) => s.phase === 'ready');

  session.send(JPEG, { label: 'Ada' });
  const refused = await settles(session, (s) => s.phase === 'error' || s.phase === 'sent');

  assert.equal(refused.phase, 'error');
  assert.equal(refused.reason, 'seal-required');
  assert.equal(refused.canRetry, false, 'the same keyless URL would fail identically');
  assert.deepEqual(sink.list('shop'), [], 'no plaintext may reach the sink');

  // And the code is untouched, so a fresh link still works for this person.
  const { room, secret } = parseToken(token)!;
  assert.equal((await broker.check(room, secret)).ok, true);

  session.destroy();
});
