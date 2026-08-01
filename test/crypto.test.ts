import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRecipient,
  createSealer,
  keyFromFragment,
  memoryKeyStore,
  CryptoFailure,
  HEADER_BYTES,
  sealedOnly,
} from 'chil-crypto';
import { handoffUrl } from 'chil-client';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 2, 3, 4, 5]);

const fresh = () => createRecipient({ store: memoryKeyStore() });

async function reasonOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof CryptoFailure) return err.reason;
    throw err;
  }
  throw new Error('expected a CryptoFailure, got success');
}

test('a file sealed to a public key comes back through the private one', async () => {
  const recipient = await fresh();
  const sealer = await createSealer(recipient.publicKey);

  const sealed = await sealer.encrypt(JPEG);
  assert.notDeepEqual(sealed.subarray(0, 4), JPEG.subarray(0, 4), 'the magic bytes must be gone');
  assert.equal(sealed.length, HEADER_BYTES + JPEG.length + 16);

  assert.deepEqual(await recipient.decrypt(sealed), JPEG);
});

test('the label round-trips as base64url', async () => {
  const recipient = await fresh();
  const sealer = await createSealer(recipient.publicKey);

  const sealed = await sealer.encryptText('Giulia Rossi');
  assert.match(sealed, /^[A-Za-z0-9_-]+$/, 'must be safe in a query string unescaped');
  assert.equal(await recipient.decryptText(sealed), 'Giulia Rossi');
});

test('two seals of the same bytes differ — the IV is never reused', async () => {
  const recipient = await fresh();
  const sealer = await createSealer(recipient.publicKey);

  const a = await sealer.encrypt(JPEG);
  const b = await sealer.encrypt(JPEG);
  assert.notDeepEqual(a, b, 'identical ciphertexts would mean a reused IV');
  assert.deepEqual(await recipient.decrypt(a), await recipient.decrypt(b));
});

test('another device cannot read it, and says so specifically', async () => {
  const recipient = await fresh();
  const other = await fresh();
  const sealed = await createSealer(recipient.publicKey).then((s) => s.encrypt(JPEG));

  assert.equal(await reasonOf(() => other.decrypt(sealed)), 'wrong-key');
  assert.deepEqual(other.canDecrypt(sealed), { ok: false, reason: 'wrong-key' });
  // The device that *can* read it says so without decrypting.
  assert.deepEqual(recipient.canDecrypt(sealed), { ok: true });
});

test('unsealed bytes pass straight through', async () => {
  const recipient = await fresh();
  // The case that matters during a rollout, and the reason the format carries a
  // literal magic rather than a bare version byte: a JPEG opens with 0xFF,
  // which as a version number is larger than any this library will ever issue.
  assert.deepEqual(await recipient.decrypt(JPEG), JPEG);
  assert.deepEqual(recipient.canDecrypt(JPEG), { ok: true });
});

test('tampering with the ciphertext is refused', async () => {
  const recipient = await fresh();
  const sealed = await createSealer(recipient.publicKey).then((s) => s.encrypt(JPEG));

  const flipped = Uint8Array.from(sealed);
  flipped[flipped.length - 1] ^= 0x01;
  assert.equal(await reasonOf(() => recipient.decrypt(flipped)), 'corrupt');
});

test('tampering with the authenticated header is refused', async () => {
  const recipient = await fresh();
  const sealed = await createSealer(recipient.publicKey).then((s) => s.encrypt(JPEG));

  // A byte of the ephemeral public key. The header is additionalData, so this
  // breaks the tag rather than quietly deriving some other key.
  const flipped = Uint8Array.from(sealed);
  flipped[20] ^= 0x01;
  const reason = await reasonOf(() => recipient.decrypt(flipped));
  assert.ok(reason === 'corrupt', `expected corrupt, got ${reason}`);
});

test('a truncated blob is refused rather than half-read', async () => {
  const recipient = await fresh();
  const sealed = await createSealer(recipient.publicKey).then((s) => s.encrypt(JPEG));
  assert.equal(await reasonOf(() => recipient.decrypt(sealed.subarray(0, 40))), 'corrupt');
});

test('a future version is named as such, not called corrupt', async () => {
  const recipient = await fresh();
  const sealed = await createSealer(recipient.publicKey).then((s) => s.encrypt(JPEG));

  const future = Uint8Array.from(sealed);
  future[3] = 99;
  assert.equal(await reasonOf(() => recipient.decrypt(future)), 'unsupported-version');
});

test('a garbled public key is refused at the sealer, not at upload time', async () => {
  assert.equal(await reasonOf(() => createSealer('not-a-key')), 'corrupt');
  // Right alphabet, wrong length — a QR scanned through a smear.
  assert.equal(await reasonOf(() => createSealer('AAAABBBBCCCC')), 'corrupt');
});

test('the same device gets the same key back from the store', async () => {
  const store = memoryKeyStore();
  const first = await createRecipient({ store, scope: 'shop' });
  const again = await createRecipient({ store, scope: 'shop' });
  assert.equal(first.publicKey, again.publicKey, 'a reload must not mint a new key');

  const sealed = await createSealer(first.publicKey).then((s) => s.encrypt(JPEG));
  assert.deepEqual(await again.decrypt(sealed), JPEG);
});

test('scopes do not share a key', async () => {
  const store = memoryKeyStore();
  const one = await createRecipient({ store, scope: 'shop-1' });
  const two = await createRecipient({ store, scope: 'shop-2' });
  assert.notEqual(one.publicKey, two.publicKey);

  const sealed = await createSealer(one.publicKey).then((s) => s.encrypt(JPEG));
  assert.equal(await reasonOf(() => two.decrypt(sealed)), 'wrong-key');
});

test('the private key is not extractable', async () => {
  const store = memoryKeyStore();
  await createRecipient({ store, scope: 'shop' });
  const stored = await store.get('shop');

  assert.ok(stored);
  assert.equal(stored.privateKey.extractable, false, 'the whole design rests on this');
  await assert.rejects(
    () => crypto.subtle.exportKey('pkcs8', stored.privateKey),
    'an extractable key could be stolen by any script on the page',
  );
});

test('a lost key store means new uploads work and old ones do not', async () => {
  const store = memoryKeyStore();
  const before = await createRecipient({ store, scope: 'shop' });
  const queued = await createSealer(before.publicKey).then((s) => s.encrypt(JPEG));

  // Cleared site data, a replaced device, or Safari's seven-day eviction.
  await store.remove('shop');

  const after = await createRecipient({ store, scope: 'shop' });
  assert.notEqual(after.publicKey, before.publicKey, 'a fresh keypair is generated on demand');

  const arriving = await createSealer(after.publicKey).then((s) => s.encrypt(JPEG));
  assert.deepEqual(await after.decrypt(arriving), JPEG, 'new uploads keep working');
  assert.equal(
    await reasonOf(() => after.decrypt(queued)),
    'wrong-key',
    'anything already queued is gone for good — this is the cost of the design',
  );
});

test('the key travels in the fragment, which never reaches a server', async () => {
  const recipient = await fresh();
  const url = handoffUrl({
    origin: 'https://shop.example',
    token: 'shop.abcdefghijklmnop',
    fragment: { k: recipient.publicKey },
  });

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('k'), null, 'the key must never be in the query string');
  assert.ok(parsed.hash.includes(recipient.publicKey));
  assert.equal(keyFromFragment(parsed.hash), recipient.publicKey);
});

test('no fragment means no encryption, and that is not an error', () => {
  assert.equal(keyFromFragment(''), null);
  assert.equal(keyFromFragment('#'), null);
  assert.equal(keyFromFragment('#debug=1'), null);
});

test('sealedOnly refuses a body that was never sealed', () => {
  const guard = sealedOnly();

  assert.equal(guard(JPEG), 'bad-type', 'plaintext must not reach the sink');
  assert.equal(guard(new Uint8Array(0)), 'bad-type', 'an empty body is not sealed');
  assert.equal(guard(Uint8Array.from([0x43, 0x48, 0x4c])), 'bad-type', 'magic without a version');
  assert.equal(guard(Uint8Array.from([0x43, 0x48, 0x4b, 1])), 'bad-type', 'one byte off the magic');
});

test('sealedOnly accepts a real sealed body, and any future version', async () => {
  const guard = sealedOnly();
  const recipient = await createRecipient({ scope: 'shop', store: memoryKeyStore() });
  const sealer = await createSealer(recipient.publicKey);
  const sealed = await sealer.encrypt(JPEG);

  assert.equal(guard(sealed.subarray(0, 16)), null, 'the guard only ever sees the head');

  // A server that only stores bytes must not refuse a client sealing with a
  // version it has not heard of, or an upgrade strands every older server.
  const future = Uint8Array.from([0x43, 0x48, 0x4c, 99]);
  assert.equal(guard(future), null);
});
