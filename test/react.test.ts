import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';
import type { Transport } from '@chiljs/client';

// A DOM before react-dom is loaded, hence the dynamic import below: the client
// renderer reads globals while it initialises.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.test/',
});
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
// `navigator` is a getter on the Node global, so it cannot be assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
});
globals.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement, StrictMode, useEffect, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useHandoffSession, useUploadSession } = await import('@chiljs/react');

const TOKEN = 'room1.abcdefghijklmnop';

/**
 * Answers every route without a network. The identity has to survive re-renders
 * — it is one of the hook's dependencies, and a fresh one each render would
 * rebuild the session for reasons of the test's own making.
 */
const transport: Transport = {
  check: async () => ({ ok: true, claimed: false }),
  claim: async () => ({ ok: true, flow: 'flow-1', first: true }),
  upload: async () => ({ id: 'file-1', size: 16 }),
};

/** Records what reached the wire, so a test can assert what was sent, not only what was said. */
interface Wire {
  claims: number;
  uploads: { body: unknown; label?: string; contentType?: string }[];
}

function recordingTransport(): [Transport, Wire] {
  const wire: Wire = { claims: 0, uploads: [] };
  return [
    {
      check: async () => ({ ok: true, claimed: false }),
      claim: async () => {
        wire.claims += 1;
        return { ok: true, flow: 'flow-1', first: wire.claims === 1 };
      },
      upload: async (args) => {
        wire.uploads.push({
          body: args.body,
          label: args.label,
          contentType: args.contentType,
        });
        return { id: 'file-1', size: 16 };
      },
    },
    wire,
  ];
}

/** Stands in for `createSealer`, without the cipher: prefixing is enough to prove it ran. */
const sealer = {
  encrypt: async (data: Uint8Array | ArrayBuffer | Blob) => {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    return Uint8Array.from([0xff, ...bytes]);
  },
  encryptText: async (text: string) => `sealed:${text}`,
};

const mint = async () => ({ token: TOKEN, expiresInMs: 60_000, flow: 'flow-1' });

interface Probe {
  /** Bumped by the component itself, so a render loop shows up as a number. */
  renders: number;
  phase: string | null;
  url: string | null;
}

/**
 * Mounts a hook consumer under StrictMode and lets the effects run.
 *
 * The timeout on each test is load-bearing: a hook that never settles hangs the
 * renderer rather than failing an assertion, so without one a regression would
 * stall the run instead of reporting.
 */
async function mount(render: (probe: Probe) => ReactElement): Promise<Probe> {
  const probe: Probe = { renders: 0, phase: null, url: null };
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(createElement(StrictMode, null, render(probe)));
  });
  // Long enough for the mint and the claim to resolve and for anything they
  // schedule to have run.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  await act(async () => {
    root.unmount();
  });
  return probe;
}

after(() => dom.window.close());

test('a handoff consumer settles under StrictMode', { timeout: 10_000 }, async () => {
  function Consumer({ probe }: { probe: Probe }): null {
    probe.renders += 1;
    const session = useHandoffSession({ mint, transport, pollMs: 60_000 });
    probe.phase = session.phase;
    return null;
  }

  const probe = await mount((p) => createElement(Consumer, { probe: p }));

  assert.ok(probe.renders < 50, `rendered ${probe.renders} times`);
  // The session that ends up on screen must be a live one. Settling by never
  // starting anything would pass the count above and ship a dead hook.
  assert.equal(probe.phase, 'live');
});

test('an inline buildUrl does not rebuild the session', { timeout: 10_000 }, async () => {
  function Consumer({ probe }: { probe: Probe }): null {
    probe.renders += 1;
    const session = useHandoffSession({
      mint,
      transport,
      pollMs: 60_000,
      // Written at the call site, so its identity is new on every render. Every
      // other callback this hook takes is held in a ref for exactly this
      // reason; one that is a dependency instead rebuilds the session each
      // render, and each rebuild renders again.
      buildUrl: (token) => `https://sender.test/u?t=${token}`,
    });
    probe.phase = session.phase;
    probe.url = session.url;
    return null;
  }

  const probe = await mount((p) => createElement(Consumer, { probe: p }));

  assert.ok(probe.renders < 50, `rendered ${probe.renders} times`);
  assert.equal(probe.phase, 'live');
  // The builder is used, not merely tolerated: a ref that nothing calls would
  // pass every assertion above.
  assert.equal(probe.url, `https://sender.test/u?t=${TOKEN}`);
});

test('a recipient rides in the URL fragment', { timeout: 10_000 }, async () => {
  function Consumer({ probe }: { probe: Probe }): null {
    probe.renders += 1;
    const session = useHandoffSession({
      mint,
      transport,
      pollMs: 60_000,
      // A fresh handle each render, as `useRecipient` would hand back after any
      // parent re-render. Only the key inside it is a dependency.
      recipient: { publicKey: 'PUBKEY' },
    });
    probe.phase = session.phase;
    probe.url = session.url;
    return null;
  }

  const probe = await mount((p) => createElement(Consumer, { probe: p }));

  assert.ok(probe.renders < 50, `rendered ${probe.renders} times`);
  assert.equal(probe.phase, 'live');
  // The fragment, not the query string: a browser never sends `#…` to the
  // server, which is the whole reason the key can travel this way.
  assert.ok(probe.url?.includes('#k=PUBKEY'), `url was ${probe.url}`);
  assert.ok(!probe.url?.includes('?k=') && !probe.url?.includes('&k='), `url was ${probe.url}`);
});

test('an upload consumer settles under StrictMode', { timeout: 10_000 }, async () => {
  function Consumer({ probe }: { probe: Probe }): null {
    probe.renders += 1;
    const session = useUploadSession({ token: TOKEN, transport });
    probe.phase = session.phase;
    return null;
  }

  const probe = await mount((p) => createElement(Consumer, { probe: p }));

  assert.ok(probe.renders < 50, `rendered ${probe.renders} times`);
  assert.equal(probe.phase, 'ready');
});

test('a sealer encrypts the body and the label', { timeout: 10_000 }, async () => {
  const [recording, wire] = recordingTransport();

  function Consumer({ probe }: { probe: Probe }): null {
    probe.renders += 1;
    const session = useUploadSession({ token: TOKEN, transport: recording, seal: sealer });
    probe.phase = session.phase;
    // Sent from an effect once the claim has landed, which is where a form's
    // submit handler would sit. `send` refuses from any phase but `ready` and
    // `error`, so StrictMode's second run is a no-op rather than a second file.
    useEffect(() => {
      if (session.phase === 'ready') session.send(Uint8Array.from([1, 2, 3]), { label: 'photo.jpg' });
    }, [session, session.phase]);
    return null;
  }

  const probe = await mount((p) => createElement(Consumer, { probe: p }));

  assert.ok(probe.renders < 50, `rendered ${probe.renders} times`);
  assert.equal(wire.uploads.length, 1);
  const [sent] = wire.uploads;
  assert.deepEqual(sent.body, Uint8Array.from([0xff, 1, 2, 3]));
  assert.equal(sent.label, 'sealed:photo.jpg');
  // Ciphertext is not a JPEG, and saying so would be a lie the recipient acts on.
  assert.equal(sent.contentType, 'application/octet-stream');
  assert.equal(probe.phase, 'sent');
});

test('a sealer arriving late does not lose the code', { timeout: 10_000 }, async () => {
  const [recording, wire] = recordingTransport();

  function Consumer({ probe }: { probe: Probe }): null {
    probe.renders += 1;
    // Built asynchronously, as `createSealer` is, and rebuilt at the call site
    // on every render afterwards — the identity churn a ref exists to absorb.
    const [ready, setReady] = useState(false);
    useEffect(() => {
      const timer = setTimeout(() => setReady(true), 10);
      return () => clearTimeout(timer);
    }, []);
    const session = useUploadSession({
      token: TOKEN,
      transport: recording,
      seal: ready ? { ...sealer } : undefined,
    });
    probe.phase = session.phase;
    useEffect(() => {
      if (session.phase === 'ready' && ready) session.send(Uint8Array.from([1, 2, 3]));
    }, [session, session.phase, ready]);
    return null;
  }

  const probe = await mount((p) => createElement(Consumer, { probe: p }));

  assert.ok(probe.renders < 50, `rendered ${probe.renders} times`);
  // The sealer took effect even though it did not exist when the session was
  // built; the file must not go out in the clear because the key was slow.
  assert.equal(wire.uploads.length, 1);
  assert.deepEqual(wire.uploads[0]?.body, Uint8Array.from([0xff, 1, 2, 3]));
  // Churn is absorbed: the arrival costs one rebuild under StrictMode's double
  // mount, not one per render.
  assert.ok(wire.claims <= 6, `claimed ${wire.claims} times`);
});

test('requireSeal refuses to send in the clear', { timeout: 10_000 }, async () => {
  const [recording, wire] = recordingTransport();
  let reason: string | null = null;

  function Consumer({ probe }: { probe: Probe }): null {
    probe.renders += 1;
    // The fragment was stripped in transit — by a link rewriter, a chat preview
    // generator, a shortener — so the page has nothing to seal with.
    const session = useUploadSession({
      token: TOKEN,
      transport: recording,
      requireSeal: true,
    });
    probe.phase = session.phase;
    reason = session.reason;
    useEffect(() => {
      if (session.phase === 'ready') session.send(Uint8Array.from([1, 2, 3]));
    }, [session, session.phase]);
    return null;
  }

  const probe = await mount((p) => createElement(Consumer, { probe: p }));

  assert.ok(probe.renders < 50, `rendered ${probe.renders} times`);
  assert.equal(probe.phase, 'error');
  assert.equal(reason, 'seal-required');
  // Refused before anything left the device, not after the file was uploaded.
  assert.equal(wire.uploads.length, 0);
});
