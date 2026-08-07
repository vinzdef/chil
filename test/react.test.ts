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

const { act, createElement, StrictMode } = await import('react');
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
