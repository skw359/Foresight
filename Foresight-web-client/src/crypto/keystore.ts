/**
 * Device key cache — the web analog of the iOS viewer's Face ID Keychain cache
 * (shared/E2EE.md §7.4): lets a restored session (JWT already in
 * localStorage) regain the unlocked identity WITHOUT re-prompting for the
 * password, so the login password is the only password the user ever types.
 * OPT-IN: nothing is persisted unless the user enables "Keep me unlocked on
 * this device" (login form / unlock prompt / Settings) — the preference lives
 * in localStorage via {is,set}KeepUnlockedEnabled below, default off.
 *
 * Storage model: the X25519 keypair (pk32‖sk32) is AES-GCM-encrypted under a
 * NON-EXTRACTABLE WebCrypto key that lives only in IndexedDB (a CryptoKey
 * survives structured clone and stays non-extractable — its raw bytes are never
 * readable by script, ours included). The record is bound to the signed-in user
 * id via GCM additional data, so a cached identity can never be restored into a
 * different account's session.
 *
 * Honest threat framing (posture change from the plan's §7.2 memory-only note,
 * decided 2026-07-04): persisted this way, the identity is recoverable by any
 * code running in this origin while a session exists — the same exposure class
 * as the JWT itself. What the non-extractable wrap prevents is offline reading
 * of the key material out of copied IndexedDB files without also exercising
 * this origin's CryptoKey. Cleared on sign-out and on 401 (E2EEContext.wipe),
 * so "no session ⇒ no key material at rest" still holds.
 *
 * Every function here degrades to "no cache" (null / no-op) rather than
 * throwing — IndexedDB may be unavailable (private mode) and the unlock prompt
 * remains the fallback.
 */
import { E2EE_X25519_KEY_BYTES } from "@foresight/contract";

import type { Identity } from "./identity";

const DB_NAME = "foresight.e2ee";
const DB_VERSION = 1;
const STORE = "keystore";
const WRAP_KEY_ROW = "wrapKey";
const IDENTITY_ROW = "identity";

interface IdentityRow {
  userId: string;
  iv: Uint8Array<ArrayBuffer>;
  /** AES-GCM(pk32 ‖ sk32), additionalData = utf8(userId). */
  cipher: ArrayBuffer;
}

/* ------------------------------------------------------------- IDB plumbing */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db.transaction(STORE, mode).objectStore(STORE));
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------- helpers */

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function getOrCreateWrapKey(store: IDBObjectStore): Promise<CryptoKey> {
  const existing = (await idbRequest(store.get(WRAP_KEY_ROW))) as CryptoKey | undefined;
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await idbRequest(store.put(key, WRAP_KEY_ROW));
  return key;
}

/* ------------------------------------------------------------- public API */

const PREF_KEY = "foresight.keepUnlocked";

/** The opt-in "keep me unlocked on this device" preference. Default OFF. */
export function isKeepUnlockedEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

/** Record the preference. Turning it OFF also drops any cached key material. */
export function setKeepUnlockedEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, enabled ? "1" : "0");
  } catch {
    /* storage unavailable — the default (off) applies */
  }
  if (!enabled) void clearPersistedIdentity();
}

/** Cache the unlocked identity for silent restore on this device. Best-effort. */
export async function persistIdentity(userId: string, identity: Identity): Promise<void> {
  try {
    const plaintext = new Uint8Array(E2EE_X25519_KEY_BYTES * 2);
    plaintext.set(identity.publicKey, 0);
    plaintext.set(identity.privateKey, E2EE_X25519_KEY_BYTES);
    await withStore("readwrite", async (store) => {
      const wrapKey = await getOrCreateWrapKey(store);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) },
        wrapKey,
        plaintext,
      );
      const row: IdentityRow = { userId, iv, cipher };
      await idbRequest(store.put(row, IDENTITY_ROW));
    });
  } catch {
    /* no cache — the unlock prompt covers it */
  }
}

/**
 * Restore the cached identity for `userId`, or null (missing, different user,
 * undecryptable, storage unavailable). A row that fails to decrypt is dropped.
 */
export async function restoreIdentity(userId: string): Promise<Identity | null> {
  try {
    return await withStore("readwrite", async (store) => {
      const row = (await idbRequest(store.get(IDENTITY_ROW))) as IdentityRow | undefined;
      const wrapKey = (await idbRequest(store.get(WRAP_KEY_ROW))) as CryptoKey | undefined;
      if (!row || !wrapKey || row.userId !== userId) return null;
      let plaintext: ArrayBuffer;
      try {
        plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: row.iv, additionalData: new TextEncoder().encode(userId) },
          wrapKey,
          row.cipher,
        );
      } catch {
        // Corrupt/foreign row — drop it so we don't retry forever.
        await idbRequest(store.delete(IDENTITY_ROW));
        return null;
      }
      const bytes = new Uint8Array(plaintext);
      if (bytes.length !== E2EE_X25519_KEY_BYTES * 2) return null;
      const publicKey = bytes.slice(0, E2EE_X25519_KEY_BYTES);
      const privateKey = bytes.slice(E2EE_X25519_KEY_BYTES);
      return { publicKey, privateKey, publicKeyB64: bytesToB64(publicKey) };
    });
  } catch {
    return null;
  }
}

/** Remove all cached key material (sign-out / 401). Best-effort. */
export async function clearPersistedIdentity(): Promise<void> {
  try {
    await withStore("readwrite", (store) => idbRequest(store.clear()));
  } catch {
    /* ignore */
  }
}
