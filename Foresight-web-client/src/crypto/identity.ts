/**
 * Main-thread API over the KDF worker (vault.worker.ts) + the E2EE startup
 * self-test.
 *
 * Holds nothing itself — it produces an in-memory {publicKey, privateKey}
 * Identity that the E2EE context owns and wipes. The worker is created lazily on
 * first use (so nothing spins up a worker or loads WASM just by importing this).
 */
import {
  E2EE_ENCRYPTION_TYPE,
  E2EE_HMK_BYTES,
  E2EE_KDF_SALT_BYTES,
  E2EE_KEY_INDEX,
  E2EE_KEY_SIZE,
  E2EE_PBKDF2_ITERATIONS,
  E2EE_RATCHET_SALT,
  E2EE_RATCHET_WINDOW_SIZE,
  E2EE_SEALED_HMK_BYTES,
  E2EE_SECRETBOX_NONCE_BYTES,
  E2EE_WRAPPED_PRIVATE_KEY_BYTES,
  E2EE_X25519_KEY_BYTES,
  type EncryptedKeyVault,
} from "@foresight/contract";

import { b64decode, loadSodium } from "./sodium";
import type { VaultWorkerResponse } from "./vault.worker";

/** The unlocked user identity — private key lives in memory only, never stored. */
export interface Identity {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  /** base64 of the public key (as stored in the vault / sent to the server). */
  publicKeyB64: string;
}

/* ------------------------------------------------------------- worker plumbing */

let worker: Worker | null = null;
let seq = 0;
type OkResponse = Extract<VaultWorkerResponse, { ok: true }>;
const pending = new Map<number, { resolve: (r: OkResponse) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./vault.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (ev: MessageEvent<VaultWorkerResponse>) => {
      const res = ev.data;
      const p = pending.get(res.id);
      if (!p) return;
      pending.delete(res.id);
      if (res.ok) p.resolve(res);
      else p.reject(new Error(res.error));
    });
    worker.addEventListener("error", (ev) => {
      const err = new Error(ev.message || "Vault worker crashed");
      for (const [, p] of pending) p.reject(err);
      pending.clear();
    });
  }
  return worker;
}

function callWorker(
  payload:
    | { op: "create"; password: string }
    | { op: "unlock"; password: string; vault: EncryptedKeyVault }
    | { op: "rewrap"; password: string; newPassword: string; vault: EncryptedKeyVault },
): Promise<OkResponse> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise<OkResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, ...payload });
  });
}

async function toIdentity(publicKeyB64: string, privateKeyB64: string): Promise<Identity> {
  const sodium = await loadSodium();
  return {
    publicKey: b64decode(sodium, publicKeyB64),
    privateKey: b64decode(sodium, privateKeyB64),
    publicKeyB64,
  };
}

/* ------------------------------------------------------------- public API */

/** Register / first-login: generate a keypair + wrap it under `password` (in-worker). */
export async function createVault(password: string): Promise<{ vault: EncryptedKeyVault; identity: Identity }> {
  await ensureSelfTest();
  const res = await callWorker({ op: "create", password });
  if (!res.vault) throw new Error("Vault creation returned no vault");
  const identity = await toIdentity(res.publicKey, res.privateKey);
  return { vault: res.vault, identity };
}

/** Login-unlock: derive + open the wrapped private key under `password` (in-worker). */
export async function unlockVault(password: string, vault: EncryptedKeyVault): Promise<Identity> {
  await ensureSelfTest();
  const res = await callWorker({ op: "unlock", password, vault });
  return toIdentity(res.publicKey, res.privateKey);
}

/**
 * Password change: re-wrap the SAME keypair under `newPassword` (in-worker).
 * Throws if `password` doesn't open the vault.
 */
export async function rewrapVault(
  password: string,
  newPassword: string,
  vault: EncryptedKeyVault,
): Promise<EncryptedKeyVault> {
  await ensureSelfTest();
  const res = await callWorker({ op: "rewrap", password, newPassword, vault });
  if (!res.vault) throw new Error("Vault re-wrap returned no vault");
  return res.vault;
}

/* ------------------------------------------------------------- startup self-test */

let selfTestPromise: Promise<void> | null = null;

/** Run the §3.2 self-test at most once; subsequent calls await the same result. */
export function ensureSelfTest(): Promise<void> {
  if (!selfTestPromise) selfTestPromise = runE2EESelfTest();
  return selfTestPromise;
}

/**
 * Assert the locked §3.2 contract constants (from @foresight/contract) and the
 * libsodium size constants agree before any crypto runs — a mismatch here is the
 * silent-black-video class of bug (§3, §10.4#1). Throws on any divergence.
 */
export async function runE2EESelfTest(): Promise<void> {
  const checks: Array<readonly [boolean, string]> = [
    [E2EE_KEY_SIZE === 128, "E2EE_KEY_SIZE must be 128"],
    [E2EE_KEY_INDEX === 0, "E2EE_KEY_INDEX must be 0"],
    [E2EE_RATCHET_WINDOW_SIZE === 0, "E2EE_RATCHET_WINDOW_SIZE must be 0"],
    [E2EE_RATCHET_SALT === "LKFrameEncryptionKey", 'E2EE_RATCHET_SALT must be "LKFrameEncryptionKey"'],
    [E2EE_ENCRYPTION_TYPE === "gcm", 'E2EE_ENCRYPTION_TYPE must be "gcm"'],
    [E2EE_PBKDF2_ITERATIONS === 100000, "E2EE_PBKDF2_ITERATIONS must be 100000"],
    [E2EE_HMK_BYTES === 32, "E2EE_HMK_BYTES must be 32"],
    [E2EE_X25519_KEY_BYTES === 32, "E2EE_X25519_KEY_BYTES must be 32"],
    [E2EE_WRAPPED_PRIVATE_KEY_BYTES === 48, "E2EE_WRAPPED_PRIVATE_KEY_BYTES must be 48"],
    [E2EE_SEALED_HMK_BYTES === 80, "E2EE_SEALED_HMK_BYTES must be 80"],
    [E2EE_SECRETBOX_NONCE_BYTES === 24, "E2EE_SECRETBOX_NONCE_BYTES must be 24"],
    [E2EE_KDF_SALT_BYTES === 16, "E2EE_KDF_SALT_BYTES must be 16"],
  ];

  const sodium = await loadSodium();
  checks.push(
    [sodium.crypto_box_SEALBYTES === 48, "libsodium crypto_box_SEALBYTES must be 48"],
    [
      E2EE_SEALED_HMK_BYTES === E2EE_HMK_BYTES + sodium.crypto_box_SEALBYTES,
      "sealed HMK size must equal HMK + SEALBYTES",
    ],
    [sodium.crypto_box_PUBLICKEYBYTES === E2EE_X25519_KEY_BYTES, "libsodium pubkey size mismatch"],
    [sodium.crypto_secretbox_NONCEBYTES === E2EE_SECRETBOX_NONCE_BYTES, "libsodium secretbox nonce size mismatch"],
    [sodium.crypto_pwhash_SALTBYTES === E2EE_KDF_SALT_BYTES, "libsodium pwhash salt size mismatch"],
    [sodium.crypto_secretbox_KEYBYTES === 32, "libsodium secretbox key size must be 32"],
  );

  const failed = checks.filter(([ok]) => !ok).map(([, msg]) => msg);
  if (failed.length > 0) {
    throw new Error(`E2EE self-test failed: ${failed.join("; ")}`);
  }
}
