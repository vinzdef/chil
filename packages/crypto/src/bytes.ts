/**
 * A `Uint8Array` that WebCrypto will accept.
 *
 * Since TypeScript 5.7 `Uint8Array` is generic over its backing buffer, and the
 * default `Uint8Array<ArrayBufferLike>` includes `SharedArrayBuffer`, which
 * `BufferSource` excludes. Everything this package allocates is already
 * `ArrayBuffer`-backed; the friction is only at the boundary, where a caller's
 * array arrives under the wider type.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * Narrows without copying in the ordinary case.
 *
 * A view over a `SharedArrayBuffer` is copied out, because WebCrypto rejects
 * those outright — better a copy than a `TypeError` from inside `subtle`.
 */
export function asBytes(view: Uint8Array): Bytes {
  return view.buffer instanceof ArrayBuffer ? (view as Bytes) : new Uint8Array(view);
}

/** Bytes from whatever the caller had to hand. */
export async function toBytes(data: Uint8Array | ArrayBuffer | Blob): Promise<Bytes> {
  if (data instanceof Uint8Array) return asBytes(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return new Uint8Array(data);
}
