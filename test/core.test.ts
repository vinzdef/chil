import assert from 'node:assert/strict';
import test from 'node:test';
import { createBroker, memoryStore, parseToken, retryable, statusFor } from 'chil-core';
import { checkStore } from 'chil-core/conformance';

const CLAIMANT_A = 'claimant-aaaaaaaaaaaa';
const CLAIMANT_B = 'claimant-bbbbbbbbbbbb';

test('memoryStore passes the store conformance suite', async () => {
  const outcomes = await checkStore(() => memoryStore());
  const failed = outcomes.filter((o) => !o.ok);
  assert.deepEqual(
    failed.map((f) => `${f.name}: ${f.error?.message}`),
    [],
  );
  assert.ok(outcomes.length >= 9, 'the suite should not be silently empty');
});

test('parseToken rejects what must never reach a store', () => {
  assert.equal(parseToken(''), null);
  assert.equal(parseToken('nodot'), null);
  assert.equal(parseToken('.leading'), null);
  assert.equal(parseToken('trailing.'), null);
  // The traversal guard: a room id is matched against an alphabet, not cleaned.
  assert.equal(parseToken('../../etc.secret0123456789ab'), null);
  assert.equal(parseToken('room/sub.secret0123456789ab'), null);
  // A secret too short to be unguessable is not a secret.
  assert.equal(parseToken('room.short'), null);

  assert.deepEqual(parseToken('room.secret0123456789ab'), {
    room: 'room',
    secret: 'secret0123456789ab',
  });
});

test('mint issues a parseable token and a flow that is not the secret', async () => {
  const broker = createBroker();
  const minted = await broker.mint('shop');

  const parsed = parseToken(minted.token);
  assert.ok(parsed);
  assert.equal(parsed.room, 'shop');
  assert.notEqual(
    minted.flow,
    parsed.secret,
    'flow must not be the secret — it is the value that is safe to send to analytics',
  );
  assert.ok(minted.expiresInMs > 0);
});

test('mint refuses a room id that would escape a path', async () => {
  const broker = createBroker();
  await assert.rejects(() => broker.mint('../etc'), TypeError);
  await assert.rejects(() => broker.mint('has.dot'), TypeError);
});

test('check does not consume and does not claim', async () => {
  const broker = createBroker();
  const { token } = await broker.mint('shop');
  const { room, secret } = parseToken(token)!;

  for (let i = 0; i < 3; i++) {
    const verdict = await broker.check(room, secret);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.claimed, false, 'checking must never claim');
  }
});

test('a second browser is refused, the first may return', async () => {
  const broker = createBroker();
  const { token } = await broker.mint('shop');
  const { room, secret } = parseToken(token)!;

  const first = await broker.claim(room, secret, CLAIMANT_A);
  assert.equal(first.ok && first.first, true);

  const again = await broker.claim(room, secret, CLAIMANT_A);
  assert.equal(again.ok && again.first, false, 'a reload must not count as a new claim');

  const other = await broker.claim(room, secret, CLAIMANT_B);
  assert.equal(other.ok, false);
  assert.equal(!other.ok && other.reason, 'already-claimed');
});

test('claiming does not consume — a failed upload keeps the code alive', async () => {
  const broker = createBroker();
  const { token } = await broker.mint('shop');
  const { room, secret } = parseToken(token)!;

  await broker.claim(room, secret, CLAIMANT_A);
  const verdict = await broker.check(room, secret);
  assert.equal(verdict.ok, true, 'a claimed code is still a valid code');
  assert.equal(verdict.ok && verdict.claimed, true);
});

test('a spent token reports already-sent, not invalid-token', async () => {
  const broker = createBroker();
  const { token } = await broker.mint('shop');
  const { room, secret } = parseToken(token)!;

  assert.equal(await broker.consume(secret), true);
  assert.equal(await broker.consume(secret), false, 'only one caller may spend a token');

  const verdict = await broker.check(room, secret);
  assert.equal(verdict.ok, false);
  assert.equal(
    !verdict.ok && verdict.reason,
    'already-sent',
    'the difference between "it arrived" and "your link is broken"',
  );
});

test('a token this broker never issued is invalid, not already-sent', async () => {
  const broker = createBroker();
  const verdict = await broker.check('shop', 'never-issued-0123456789');
  assert.equal(!verdict.ok && verdict.reason, 'invalid-token');
});

test("a spent token from another room does not leak that it existed", async () => {
  const broker = createBroker();
  const { token } = await broker.mint('shop');
  const { secret } = parseToken(token)!;
  await broker.consume(secret);

  const verdict = await broker.check('other-shop', secret);
  assert.equal(!verdict.ok && verdict.reason, 'invalid-token');
});

test('an expired token says so until the grace period ends', async () => {
  let clock = 1_000_000;
  const broker = createBroker({ ttlMs: 1000, graceMs: 5000, now: () => clock });
  const { token } = await broker.mint('shop');
  const { room, secret } = parseToken(token)!;

  clock += 2000;
  let verdict = await broker.check(room, secret);
  assert.equal(!verdict.ok && verdict.reason, 'expired-token');

  // Still expired, still the same answer, because the record survives grace.
  await broker.sweep();
  verdict = await broker.check(room, secret);
  assert.equal(!verdict.ok && verdict.reason, 'expired-token');

  clock += 10_000;
  await broker.sweep();
  verdict = await broker.check(room, secret);
  assert.equal(
    !verdict.ok && verdict.reason,
    'invalid-token',
    'past grace, a stale code is indistinguishable from a forged one — by design',
  );
});

test('claim on an expired token refuses without taking it', async () => {
  let clock = 1_000_000;
  const broker = createBroker({ ttlMs: 1000, now: () => clock });
  const { token } = await broker.mint('shop');
  const { room, secret } = parseToken(token)!;

  clock += 2000;
  const verdict = await broker.claim(room, secret, CLAIMANT_A);
  assert.equal(!verdict.ok && verdict.reason, 'expired-token');
});

test('exactly one of many simultaneous claims wins', async () => {
  const broker = createBroker();
  const { token } = await broker.mint('shop');
  const { room, secret } = parseToken(token)!;

  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      broker.claim(room, secret, `claimant-${String(i).padStart(12, '0')}`),
    ),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.ok && r.first).length, 1);
});

test('retryable separates a dropped connection from a verdict', () => {
  assert.equal(retryable['server-error'], true);
  assert.equal(retryable['storage-full'], true);
  assert.equal(retryable['already-sent'], false);
  assert.equal(retryable['already-claimed'], false);
  assert.equal(retryable['expired-token'], false);
});

test('statusFor covers every reason', () => {
  for (const reason of Object.keys(retryable) as (keyof typeof retryable)[]) {
    const status = statusFor(reason);
    assert.ok(status >= 400 && status < 600, `${reason} produced ${status}`);
  }
});
