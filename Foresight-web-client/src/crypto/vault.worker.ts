/**
 * Dedicated KDF Web Worker (E2EE_MODEL_B_PLAN.md §9.2).
 *
 * At memlimit=64 MiB the Argon2id WASM KDF takes ~0.5–2 s and BLOCKS its calling
 * thread, so vault CREATE (register / first-login) and vault UNLOCK both run
 * fully in here — the render thread never freezes; the UI just shows a spinner.
 * libsodium is dynamically imported inside this worker (via ./sodium), so its
 * ~150 KB WASM lands in the worker chunk, never the entry bundle.
 *
 * Instantiated from the main thread with the Vite worker convention:
 *   new Worker(new URL("./vault.worker.ts", import.meta.url), { type: "module" })
 *
 * Protocol: main posts a {id, op, …} request; the worker replies {id, ok, …}.
 * Only base64 crosses the boundary — the raw private key is decoded on the main
 * thread and held there (never persisted).
 */
import {
  E2EE_ARGON2ID_MEMLIMIT,
  E2EE_ARGON2ID_OPSLIMIT,
  E2EE_KDF_SALT_BYTES,
  E2EE_SECRETBOX_NONCE_BYTES,
  type EncryptedKeyVault,
  type KdfParams,
} from "@foresight/contract";

import { b64decode, b64encode, loadSodium, VAULT_TAMPER_MESSAGE } from "./sodium";

interface CreateRequest {
  id: number;
  op: "create";
  password: string;
}
interface UnlockRequest {
  id: number;
  op: "unlock";
  password: string;
  vault: EncryptedKeyVault;
}
interface RewrapRequest {
  id: number;
  op: "rewrap";
  password: string;
  newPassword: string;
  vault: EncryptedKeyVault;
}
type WorkerRequest = CreateRequest | UnlockRequest | RewrapRequest;

export type VaultWorkerResponse =
  | { id: number; ok: true; vault: EncryptedKeyVault | null; publicKey: string; privateKey: string }
  | { id: number; ok: false; error: string };

// The project's tsconfig ships the DOM lib (not WebWorker) to keep one config
// for the whole app; cast `self` to just the two members we use so this file
// type-checks without pulling in a conflicting WebWorker lib.
const ctx = self as unknown as {
  postMessage(message: VaultWorkerResponse): void;
  addEventListener(type: "message", listener: (ev: MessageEvent<WorkerRequest>) => void): void;
};

/** Wrap `privateKey` under `password` with a fresh salt + nonce at the current KDF params. */
async function wrap(
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  password: string,
): Promise<EncryptedKeyVault> {
  const sodium = await loadSodium();
  const salt = sodium.randombytes_buf(E2EE_KDF_SALT_BYTES);
  const vaultKey = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    password,
    salt,
    E2EE_ARGON2ID_OPSLIMIT,
    E2EE_ARGON2ID_MEMLIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const nonce = sodium.randombytes_buf(E2EE_SECRETBOX_NONCE_BYTES);
  const wrapped = sodium.crypto_secretbox_easy(privateKey, nonce, vaultKey);
  sodium.memzero(vaultKey);
  return {
    publicKey: b64encode(sodium, publicKey),
    wrappedPrivateKey: b64encode(sodium, wrapped),
    nonce: b64encode(sodium, nonce),
    kdf: {
      algo: "argon2id",
      opslimit: E2EE_ARGON2ID_OPSLIMIT,
      memlimit: E2EE_ARGON2ID_MEMLIMIT,
      saltB64: b64encode(sodium, salt),
    },
  };
}

/**
 * Password change: open the vault with the CURRENT password, then re-wrap the
 * same keypair under the new one. The identity (public key) is unchanged, so
 * every sealed Home key keeps working and no TOFU pin changes.
 */
async function rewrap(password: string, newPassword: string, vault: EncryptedKeyVault): Promise<VaultWorkerResponse> {
  const sodium = await loadSodium();
  const opened = await unlock(password, vault);
  if (!opened.ok) return opened;
  const privateKey = b64decode(sodium, opened.privateKey);
  const next = await wrap(b64decode(sodium, vault.publicKey), privateKey, newPassword);
  sodium.memzero(privateKey);
  return { id: 0, ok: true, vault: next, publicKey: vault.publicKey, privateKey: opened.privateKey };
}

/** Register / first-login: generate an X25519 identity + wrap it under the password. */
async function create(password: string): Promise<VaultWorkerResponse> {
  const sodium = await loadSodium();
  const keypair = sodium.crypto_box_keypair();
  const salt = sodium.randombytes_buf(E2EE_KDF_SALT_BYTES);
  const vaultKey = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    password,
    salt,
    E2EE_ARGON2ID_OPSLIMIT,
    E2EE_ARGON2ID_MEMLIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const nonce = sodium.randombytes_buf(E2EE_SECRETBOX_NONCE_BYTES);
  const wrapped = sodium.crypto_secretbox_easy(keypair.privateKey, nonce, vaultKey);
  sodium.memzero(vaultKey);

  const kdf: KdfParams = {
    algo: "argon2id",
    opslimit: E2EE_ARGON2ID_OPSLIMIT,
    memlimit: E2EE_ARGON2ID_MEMLIMIT,
    saltB64: b64encode(sodium, salt),
  };
  const vault: EncryptedKeyVault = {
    publicKey: b64encode(sodium, keypair.publicKey),
    wrappedPrivateKey: b64encode(sodium, wrapped),
    nonce: b64encode(sodium, nonce),
    kdf,
  };
  return {
    id: 0,
    ok: true,
    vault,
    publicKey: vault.publicKey,
    privateKey: b64encode(sodium, keypair.privateKey),
  };
}

/** Login-unlock: derive the vault key from the stored params and open the private key. */
async function unlock(password: string, vault: EncryptedKeyVault): Promise<VaultWorkerResponse> {
  const sodium = await loadSodium();
  const salt = b64decode(sodium, vault.kdf.saltB64);
  // Use the params stored PER-BLOB (kdf.*), not the current constants, so vaults
  // wrapped under retuned params still open (§3.1).
  const vaultKey = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    password,
    salt,
    vault.kdf.opslimit,
    vault.kdf.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const nonce = b64decode(sodium, vault.nonce);
  const wrapped = b64decode(sodium, vault.wrappedPrivateKey);
  // Throws (wrong password / tampered blob) → surfaced as ok:false below.
  const privateKey = sodium.crypto_secretbox_open_easy(wrapped, nonce, vaultKey);
  sodium.memzero(vaultKey);
  // secretbox authenticated only the wrapped sk; verify the unauthenticated
  // publicKey against the sk we just opened so a swapped pubkey is a loud
  // tamper alarm, not silently un-openable sealed boxes ("awaiting key").
  if (b64encode(sodium, sodium.crypto_scalarmult_base(privateKey)) !== vault.publicKey) {
    throw new Error(VAULT_TAMPER_MESSAGE);
  }
  return {
    id: 0,
    ok: true,
    vault: null,
    publicKey: vault.publicKey,
    privateKey: b64encode(sodium, privateKey),
  };
}

ctx.addEventListener("message", (ev) => {
  const req = ev.data;
  void (async () => {
    try {
      const result =
        req.op === "create"
          ? await create(req.password)
          : req.op === "rewrap"
            ? await rewrap(req.password, req.newPassword, req.vault)
            : await unlock(req.password, req.vault);
      ctx.postMessage({ ...result, id: req.id });
    } catch (err) {
      ctx.postMessage({
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : "Vault operation failed",
      });
    }
  })();
});
