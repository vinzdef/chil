export interface StoredKey {
  scope: string;
  /** Non-extractable. Never leaves this object as bytes. */
  privateKey: CryptoKey;
  publicKeyRaw: Uint8Array;
}

export interface KeyStore {
  get(scope: string): Promise<StoredKey | null>;
  put(key: StoredKey): Promise<void>;
  remove(scope: string): Promise<void>;
}

const DB_NAME = 'chil';
const STORE_NAME = 'recipient-keys';

/**
 * The recipient's keypair, in IndexedDB.
 *
 * IndexedDB rather than `localStorage`, and the reason is not capacity or
 * ergonomics: IndexedDB can structured-clone a `CryptoKey` object directly, so
 * the non-extractable private key is stored *as a key handle*. `localStorage`
 * holds strings only, which would force `extractable: true` and put the raw
 * private key within reach of any script on the page.
 *
 * ## How long this actually survives — read before shipping
 *
 * Longer than a session, but it is **not** permanent storage, and the failure
 * is silent. A device whose key is gone still works — a fresh keypair is
 * generated on demand and new uploads seal to it — but anything already in the
 * queue under the old key is undecryptable for good.
 *
 * Survives: page reload, tab close, browser restart, device reboot, and any
 * amount of server-side redeployment. None of this is on the server.
 *
 * Lost to:
 *
 * - **Clearing site data.** The realistic one, and the worst: it can happen
 *   mid-shift with items still queued.
 * - **A replaced, reset or reimaged device**, and any other browser profile.
 * - **Private / incognito browsing**, where the store dies with the window.
 * - **Safari's ITP eviction.** All script-writable storage for an origin is
 *   erased after *seven days without user interaction with that site*. It is a
 *   tracking countermeasure, not a storage policy, and Chrome and Firefox do
 *   not do it. Note what resets the clock: someone opening the page, not the
 *   browser being used. A kiosk in daily use never approaches it, and a device
 *   idle long enough to trigger it has an empty queue anyway — so this is the
 *   least costly of the four, despite sounding like the most alarming.
 * - **Storage pressure**, where a browser evicts whole origins under disk
 *   pressure. `navigator.storage.persist()` asks for exemption from this one
 *   and is usually granted to a site with real interaction history — see
 *   `requestPersistence`. It does **not** exempt anything from ITP above.
 *
 * The mitigation is not to prevent loss, which is not possible from here, but
 * to make it legible: `decrypt` reports `wrong-key` and `no-key` as distinct
 * reasons so a dashboard can say which happened instead of showing a broken
 * image.
 */
export function indexedDbKeyStore(
  dbName = DB_NAME,
  storeName = STORE_NAME,
): KeyStore {
  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'scope' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function transact<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = run(tx.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  return {
    async get(scope) {
      const found = await transact<StoredKey | undefined>('readonly', (store) =>
        store.get(scope),
      );
      return found ?? null;
    },
    async put(key) {
      await transact('readwrite', (store) => store.put(key));
    },
    async remove(scope) {
      await transact('readwrite', (store) => store.delete(scope));
    },
  };
}

/**
 * A key store in a `Map`. For tests, and for Node, which has WebCrypto but no
 * IndexedDB. Everything in it dies with the process.
 */
export function memoryKeyStore(): KeyStore {
  const keys = new Map<string, StoredKey>();
  return {
    get: async (scope) => keys.get(scope) ?? null,
    put: async (key) => void keys.set(key.scope, key),
    remove: async (scope) => void keys.delete(scope),
  };
}

/**
 * Asks the browser not to evict this origin under storage pressure.
 *
 * Worth calling once on the requester's side. Returns whether it was granted —
 * browsers decide by interaction history and installed-app status, so a first
 * visit is usually refused and a daily-use kiosk usually is not.
 *
 * This says nothing about Safari's seven-day ITP eviction, which no API opts
 * out of.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
