/**
 * Home Media Key (HMK) sealing helpers + identity fingerprint (§3, §10.5).
 *
 * These are cheap enough for the main thread, but must still go through the lazy
 * sodium module (never a static libsodium import). Only the Argon2id KDF must be
 * off-thread (see vault.worker.ts).
 *
 * The string LiveKit's `setKey` receives is EXACTLY `base64(HMK)` (§3.2), so an
 * unsealed HMK's base64 form is both the cached value and the value handed to
 * LiveKit.
 */
import { E2EE_HMK_BYTES, E2EE_SEALED_HMK_BYTES } from "@foresight/contract";

import { b64decode, b64encode, loadSodium } from "./sodium";

/** A freshly generated Home Media Key: raw bytes + its base64 (LiveKit) form. */
export interface FreshHmk {
  /** Raw 32 random bytes — seal these to holder pubkeys. */
  raw: Uint8Array;
  /** base64(HMK) — the exact string fed to LiveKit `setKey` (§3.2). */
  base64: string;
}

/** Generate a random 32-byte HMK (activation / rotation). */
export async function generateHmk(): Promise<FreshHmk> {
  const sodium = await loadSodium();
  const raw = sodium.randombytes_buf(E2EE_HMK_BYTES);
  return { raw, base64: b64encode(sodium, raw) };
}

/**
 * Generate an X25519 keypair (base64). Used by the in-browser dev camera to
 * satisfy the pairing claim's `cameraPublicKey`. A real camera generates its
 * pair on-device and keeps the sk in the Keychain (§7.3) — not this path.
 */
export async function generateBoxKeypairB64(): Promise<{ publicKeyB64: string; privateKeyB64: string }> {
  const sodium = await loadSodium();
  const kp = sodium.crypto_box_keypair();
  return { publicKeyB64: b64encode(sodium, kp.publicKey), privateKeyB64: b64encode(sodium, kp.privateKey) };
}

/**
 * Seal a raw HMK to a holder's X25519 public key (base64) via crypto_box_seal.
 * Returns the base64 sealed box (E2EE_SEALED_HMK_BYTES = 80 bytes).
 */
export async function sealHmkTo(rawHmk: Uint8Array, holderPublicKeyB64: string): Promise<string> {
  const sodium = await loadSodium();
  const pk = b64decode(sodium, holderPublicKeyB64);
  const sealed = sodium.crypto_box_seal(rawHmk, pk);
  return b64encode(sodium, sealed);
}

/**
 * Open a sealed HMK (base64 crypto_box_seal) with the caller's identity keypair.
 * Returns `base64(HMK)` — ready for LiveKit `setKey` and for the in-memory cache.
 * Throws if the sealed box does not open under this identity.
 */
export async function unsealHmkToBase64(
  sealedB64: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): Promise<string> {
  const sodium = await loadSodium();
  const sealed = b64decode(sodium, sealedB64);
  if (sealed.length !== E2EE_SEALED_HMK_BYTES) {
    throw new Error(`sealed HMK has ${sealed.length} bytes, expected ${E2EE_SEALED_HMK_BYTES}`);
  }
  const raw = sodium.crypto_box_seal_open(sealed, publicKey, privateKey);
  return b64encode(sodium, raw);
}

/** Re-seal from an already-base64 HMK (e.g. when rotating a cached key). */
export async function sealHmkBase64To(hmkBase64: string, holderPublicKeyB64: string): Promise<string> {
  const sodium = await loadSodium();
  return sealHmkTo(b64decode(sodium, hmkBase64), holderPublicKeyB64);
}

/**
 * Identity fingerprint for out-of-band comparison (§10.5, recorder consent UI).
 *
 * FORMAT (documented for the report + ops runbook): the first 8 groups of 4 hex
 * chars of SHA-256(raw pubkey bytes), space-separated — i.e. the first 16 bytes
 * of the digest, e.g. "a1b2 c3d4 e5f6 0718 293a 4b5c 6d7e 8f90". Ops records the
 * expected value at deploy time and compares out-of-band.
 */
export async function pubkeyFingerprint(publicKeyB64: string): Promise<string> {
  const sodium = await loadSodium();
  const raw = new Uint8Array(b64decode(sodium, publicKeyB64));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) groups.push(hex.slice(i * 4, (i + 1) * 4));
  return groups.join(" ");
}
