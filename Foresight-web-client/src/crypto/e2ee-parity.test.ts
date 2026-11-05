/**
 * M0 cross-platform parity gate for the WASM build (shared/E2EE.md §11).
 *
 * Proves the web (libsodium-wrappers-sumo) crypto derives byte-identical values
 * to the shared cross-platform vector, and that livekit-client's internal
 * setKey derivation (PBKDF2-SHA-256 → AES-128-GCM) round-trips the sample frame.
 * If this ever goes red, do NOT ship — it is the single biggest-risk regression
 * (silent black video from a cross-platform key mismatch, §10.4#1).
 */
import { createDecipheriv, createCipheriv, pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  E2EE_ARGON2ID_MEMLIMIT,
  E2EE_ARGON2ID_OPSLIMIT,
  E2EE_ENCRYPTION_TYPE,
  E2EE_KEY_INDEX,
  E2EE_KEY_SIZE,
  E2EE_PBKDF2_ITERATIONS,
  E2EE_RATCHET_SALT,
  E2EE_RATCHET_WINDOW_SIZE,
} from "@foresight/contract";

import { b64decode, b64encode, loadSodium } from "./sodium";

interface ParityVector {
  password: string;
  kdf: { algo: string; opslimit: number; memlimit: number; saltB64: string };
  vaultKeyB64: string;
  identity: { seedB64: string; publicKeyB64: string; privateKeyB64: string };
  wrap: { nonceB64: string; wrappedPrivateKeyB64: string };
  hmkB64: string;
  livekitSetKeyString: string;
  sealedHmkB64: string;
  livekit: {
    keySize: number;
    encryptionType: string;
    ratchetSalt: string;
    ratchetWindowSize: number;
    keyIndex: number;
    pbkdf2Iterations: number;
    derivedAesKeyB64: string;
  };
  aesGcmSample: { ivB64: string; plaintextUtf8: string; ciphertextWithTagB64: string };
}

const vector: ParityVector = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../shared/test-vectors/e2ee-parity.json", import.meta.url)), "utf8"),
);

const std = (b64: string): Buffer => Buffer.from(b64, "base64");

describe("E2EE M0 parity vector (libsodium-wrappers-sumo)", () => {
  it("derives the vault key via Argon2id", async () => {
    const sodium = await loadSodium();
    const salt = b64decode(sodium, vector.kdf.saltB64);
    const vaultKey = sodium.crypto_pwhash(
      sodium.crypto_secretbox_KEYBYTES,
      vector.password,
      salt,
      vector.kdf.opslimit,
      vector.kdf.memlimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    expect(b64encode(sodium, vaultKey)).toBe(vector.vaultKeyB64);
  });

  it("unwraps the private key with the derived vault key", async () => {
    const sodium = await loadSodium();
    const vaultKey = b64decode(sodium, vector.vaultKeyB64);
    const opened = sodium.crypto_secretbox_open_easy(
      b64decode(sodium, vector.wrap.wrappedPrivateKeyB64),
      b64decode(sodium, vector.wrap.nonceB64),
      vaultKey,
    );
    expect(b64encode(sodium, opened)).toBe(vector.identity.privateKeyB64);
  });

  it("unseals the HMK with crypto_box_seal_open", async () => {
    const sodium = await loadSodium();
    const hmk = sodium.crypto_box_seal_open(
      b64decode(sodium, vector.sealedHmkB64),
      b64decode(sodium, vector.identity.publicKeyB64),
      b64decode(sodium, vector.identity.privateKeyB64),
    );
    expect(b64encode(sodium, hmk)).toBe(vector.hmkB64);
  });

  it("uses base64(HMK) verbatim as the LiveKit setKey string", async () => {
    const sodium = await loadSodium();
    const hmk = b64decode(sodium, vector.hmkB64);
    expect(b64encode(sodium, hmk)).toBe(vector.livekitSetKeyString);
  });

  it("matches livekit-client's PBKDF2-SHA-256 AES key derivation", () => {
    // livekit-client@2.19.2 derives the frame key from the base64 setKey STRING:
    // PBKDF2-SHA-256(utf8(string), salt = utf8(ratchetSalt), 100000, keySize/8).
    const derived = pbkdf2Sync(
      Buffer.from(vector.livekitSetKeyString, "utf8"),
      Buffer.from(vector.livekit.ratchetSalt, "utf8"),
      vector.livekit.pbkdf2Iterations,
      vector.livekit.keySize / 8,
      "sha256",
    );
    expect(derived.toString("base64")).toBe(vector.livekit.derivedAesKeyB64);
  });

  it("round-trips the AES-128-GCM sample frame under the derived key", () => {
    const key = std(vector.livekit.derivedAesKeyB64);
    const iv = std(vector.aesGcmSample.ivB64);
    const blob = std(vector.aesGcmSample.ciphertextWithTagB64);
    const tag = blob.subarray(blob.length - 16);
    const ciphertext = blob.subarray(0, blob.length - 16);

    const decipher = createDecipheriv("aes-128-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    expect(plaintext.toString("utf8")).toBe(vector.aesGcmSample.plaintextUtf8);

    // And the reverse direction produces the identical ciphertext+tag.
    const cipher = createCipheriv("aes-128-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(vector.aesGcmSample.plaintextUtf8, "utf8")), cipher.final()]);
    expect(Buffer.concat([ct, cipher.getAuthTag()]).toString("base64")).toBe(vector.aesGcmSample.ciphertextWithTagB64);
  });

  it("agrees with the @foresight/contract locked constants", () => {
    expect(E2EE_KEY_SIZE).toBe(vector.livekit.keySize);
    expect(E2EE_ENCRYPTION_TYPE).toBe(vector.livekit.encryptionType);
    expect(E2EE_RATCHET_SALT).toBe(vector.livekit.ratchetSalt);
    expect(E2EE_RATCHET_WINDOW_SIZE).toBe(vector.livekit.ratchetWindowSize);
    expect(E2EE_KEY_INDEX).toBe(vector.livekit.keyIndex);
    expect(E2EE_PBKDF2_ITERATIONS).toBe(vector.livekit.pbkdf2Iterations);
    expect(E2EE_ARGON2ID_OPSLIMIT).toBe(vector.kdf.opslimit);
    expect(E2EE_ARGON2ID_MEMLIMIT).toBe(vector.kdf.memlimit);
  });
});
