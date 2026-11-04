/**
 * M0 cross-platform parity gate for the recorder's crypto (sodium-native).
 *
 * Proves the recorder derives byte-identical results to the other E2EE platforms
 * (libsodium-wrappers-sumo / swift-sodium) from the shared test vector, and that
 * the locked LiveKit key-application contract (§3.2) holds end to end:
 *   Argon2id(password) → vaultKey
 *   secretbox_open      → user private key
 *   box_seal_open       → HMK  (this is the recorder's actual unseal path)
 *   base64(HMK)         → the LiveKit setKey STRING, fed as utf8 bytes (the trap)
 *   PBKDF2-SHA-256      → the AES-128 key LiveKit derives from that string
 *   AES-128-GCM         → decrypts a known frame
 */
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sodium from "../src/crypto/sodium.js";
import { liveKitSharedKey } from "../src/crypto/keyManager.js";
import {
  E2EE_ARGON2ID_MEMLIMIT,
  E2EE_ARGON2ID_OPSLIMIT,
  E2EE_ENCRYPTION_TYPE,
  E2EE_HMK_BYTES,
  E2EE_KDF_SALT_BYTES,
  E2EE_KEY_INDEX,
  E2EE_KEY_SIZE,
  E2EE_PBKDF2_ITERATIONS,
  E2EE_RATCHET_SALT,
  E2EE_RATCHET_WINDOW_SIZE,
  E2EE_SEALED_HMK_BYTES,
} from "@foresight/contract";

const here = path.dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vector: any = JSON.parse(
  fs.readFileSync(path.resolve(here, "../../shared/test-vectors/e2ee-parity.json"), "utf8"),
);

const b64 = (s: string): Buffer => Buffer.from(s, "base64");

function deriveVaultKey(): Buffer {
  const out = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES);
  sodium.crypto_pwhash(
    out,
    Buffer.from(vector.password, "utf8"),
    b64(vector.kdf.saltB64),
    vector.kdf.opslimit,
    vector.kdf.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  return out;
}

describe("E2EE parity vector (sodium-native)", () => {
  it("derives the vault key via Argon2id (crypto_pwhash)", () => {
    expect(deriveVaultKey().toString("base64")).toBe(vector.vaultKeyB64);
  });

  it("unwraps the user private key with crypto_secretbox_open_easy", () => {
    const ciphertext = b64(vector.wrap.wrappedPrivateKeyB64);
    const nonce = b64(vector.wrap.nonceB64);
    const message = Buffer.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES);
    const ok = sodium.crypto_secretbox_open_easy(message, ciphertext, nonce, deriveVaultKey());
    expect(ok).toBe(true);
    expect(message.toString("base64")).toBe(vector.identity.privateKeyB64);
  });

  it("unseals the HMK with crypto_box_seal_open (the recorder's unseal path)", () => {
    const pk = b64(vector.identity.publicKeyB64);
    const sk = b64(vector.identity.privateKeyB64);
    const ciphertext = b64(vector.sealedHmkB64);
    const message = Buffer.alloc(ciphertext.length - sodium.crypto_box_SEALBYTES);
    const ok = sodium.crypto_box_seal_open(message, ciphertext, pk, sk);
    expect(ok).toBe(true);
    expect(message.toString("base64")).toBe(vector.hmkB64);
  });

  it("applies the HMK as utf8 bytes of the base64 string, NOT raw bytes (§3.2 trap)", () => {
    // base64(HMK) is the LiveKit setKey string.
    expect(b64(vector.hmkB64).toString("base64")).toBe(vector.livekitSetKeyString);
    // The recorder's helper must produce exactly utf8Bytes(base64(HMK)) — and it
    // must NOT equal the raw 32 HMK bytes.
    const shared = Buffer.from(liveKitSharedKey(vector.livekitSetKeyString));
    expect(shared.equals(Buffer.from(vector.livekitSetKeyString, "utf8"))).toBe(true);
    expect(shared.equals(b64(vector.hmkB64))).toBe(false);
    expect(shared.length).toBe(vector.livekitSetKeyString.length);
  });

  it("derives the same AES-128 key LiveKit does (PBKDF2-SHA-256, index 0)", () => {
    const derived = crypto.pbkdf2Sync(
      Buffer.from(vector.livekitSetKeyString, "utf8"),
      Buffer.from(E2EE_RATCHET_SALT, "utf8"),
      E2EE_PBKDF2_ITERATIONS,
      E2EE_KEY_SIZE / 8,
      "sha256",
    );
    expect(derived.toString("base64")).toBe(vector.livekit.derivedAesKeyB64);
  });

  it("decrypts the AES-128-GCM sample frame with the derived key", () => {
    const key = b64(vector.livekit.derivedAesKeyB64);
    const iv = b64(vector.aesGcmSample.ivB64);
    const blob = b64(vector.aesGcmSample.ciphertextWithTagB64);
    const tag = blob.subarray(blob.length - 16);
    const ciphertext = blob.subarray(0, blob.length - 16);
    const decipher = crypto.createDecipheriv("aes-128-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    expect(plaintext.toString("utf8")).toBe(vector.aesGcmSample.plaintextUtf8);
  });

  it("contract constants match the vector", () => {
    expect(E2EE_KEY_SIZE).toBe(vector.livekit.keySize);
    expect(E2EE_ENCRYPTION_TYPE).toBe(vector.livekit.encryptionType);
    expect(E2EE_RATCHET_SALT).toBe(vector.livekit.ratchetSalt);
    expect(E2EE_RATCHET_WINDOW_SIZE).toBe(vector.livekit.ratchetWindowSize);
    expect(E2EE_KEY_INDEX).toBe(vector.livekit.keyIndex);
    expect(E2EE_PBKDF2_ITERATIONS).toBe(vector.livekit.pbkdf2Iterations);
    expect(E2EE_ARGON2ID_OPSLIMIT).toBe(vector.kdf.opslimit);
    expect(E2EE_ARGON2ID_MEMLIMIT).toBe(vector.kdf.memlimit);
    expect(E2EE_KDF_SALT_BYTES).toBe(b64(vector.kdf.saltB64).length);
    expect(E2EE_HMK_BYTES).toBe(b64(vector.hmkB64).length);
    expect(E2EE_SEALED_HMK_BYTES).toBe(b64(vector.sealedHmkB64).length);
  });
});
