/**
 * Recorder identity (shared/E2EE.md §8.2 / §8.3).
 *
 * The recorder is a single global consented key-holder. It owns one X25519
 * keypair; the SECRET KEY at rest IS the consent boundary (§8.3): anyone with
 * the key file + a sealed HMK can decrypt that Home. It is persisted 0600
 * (best-effort on Windows) OUTSIDE the recordings tree the server reads.
 *
 * The public key is registered with the server on boot (POST
 * /internal/recorder-identity); Homes that consent seal their HMK to it. The
 * recorder unseals with the secret key via crypto_box_seal_open — the private
 * key never leaves this process.
 */
import fs from "node:fs";
import path from "node:path";
import {
  E2EE_ENCRYPTION_TYPE,
  E2EE_HMK_BYTES,
  E2EE_KDF_SALT_BYTES,
  E2EE_KEY_INDEX,
  E2EE_KEY_SIZE,
  E2EE_RATCHET_WINDOW_SIZE,
  E2EE_SEALED_HMK_BYTES,
  E2EE_SECRETBOX_NONCE_BYTES,
  E2EE_WRAPPED_PRIVATE_KEY_BYTES,
  E2EE_X25519_KEY_BYTES,
} from "@foresight/contract";
import sodium from "./sodium.js";
import { log as rootLog } from "../log.js";

const log = rootLog.child({ mod: "identity" });

/**
 * Startup self-test: assert the contract constants agree with the installed
 * sodium-native primitive sizes. A mismatch here means a version/ABI skew that
 * would silently corrupt sealing/unsealing — fail fast at boot (plan §3.2).
 */
export function assertCryptoContract(): void {
  const eq = (name: string, actual: unknown, expected: unknown): void => {
    if (actual !== expected) {
      throw new Error(
        `crypto contract self-test failed: ${name} = ${String(actual)}, expected ${String(expected)}`,
      );
    }
  };

  // libsodium primitive sizes must match the contract's declared sizes.
  eq("crypto_box_PUBLICKEYBYTES", sodium.crypto_box_PUBLICKEYBYTES, E2EE_X25519_KEY_BYTES);
  eq("crypto_box_SECRETKEYBYTES", sodium.crypto_box_SECRETKEYBYTES, E2EE_X25519_KEY_BYTES);
  eq("sealed HMK size", E2EE_HMK_BYTES + sodium.crypto_box_SEALBYTES, E2EE_SEALED_HMK_BYTES);
  eq("crypto_secretbox_NONCEBYTES", sodium.crypto_secretbox_NONCEBYTES, E2EE_SECRETBOX_NONCE_BYTES);
  eq(
    "wrapped private key size",
    E2EE_X25519_KEY_BYTES + sodium.crypto_secretbox_MACBYTES,
    E2EE_WRAPPED_PRIVATE_KEY_BYTES,
  );
  eq("crypto_pwhash_SALTBYTES", sodium.crypto_pwhash_SALTBYTES, E2EE_KDF_SALT_BYTES);

  // Locked LiveKit key-application contract values (§3.2).
  eq("E2EE_KEY_SIZE", E2EE_KEY_SIZE, 128);
  eq("E2EE_KEY_INDEX", E2EE_KEY_INDEX, 0);
  eq("E2EE_RATCHET_WINDOW_SIZE", E2EE_RATCHET_WINDOW_SIZE, 0);
  eq("E2EE_ENCRYPTION_TYPE", E2EE_ENCRYPTION_TYPE, "gcm");
}

export class RecorderIdentity {
  /** base64 X25519 public key — registered with the server, sealed to by Homes. */
  readonly publicKey: string;

  private constructor(
    private readonly pk: Buffer,
    private readonly sk: Buffer,
  ) {
    this.publicKey = pk.toString("base64");
  }

  /**
   * Load the persisted identity, or generate + persist a fresh one on first
   * boot. Runs the crypto self-test first. Throws if an existing key file is
   * present but corrupt (we never silently overwrite the consent boundary).
   */
  static loadOrCreate(keyPath: string): RecorderIdentity {
    assertCryptoContract();
    const existing = RecorderIdentity.tryLoad(keyPath);
    if (existing) {
      log.info("loaded recorder identity", { keyPath, publicKey: existing.publicKey });
      return existing;
    }
    const created = RecorderIdentity.generate();
    created.persist(keyPath);
    log.info("generated new recorder identity", { keyPath, publicKey: created.publicKey });
    return created;
  }

  /**
   * Open a sealed HMK (base64, 80 B crypto_box_seal) with the recorder's secret
   * key → raw 32-byte HMK. Throws if the ciphertext is malformed or fails to
   * authenticate (wrong recorder key / corrupt blob).
   */
  unseal(sealedB64: string): Buffer {
    const ciphertext = Buffer.from(sealedB64, "base64");
    if (ciphertext.length !== E2EE_SEALED_HMK_BYTES) {
      throw new Error(
        `sealed HMK wrong size: ${ciphertext.length} B (expected ${E2EE_SEALED_HMK_BYTES})`,
      );
    }
    const message = Buffer.alloc(ciphertext.length - sodium.crypto_box_SEALBYTES);
    const ok = sodium.crypto_box_seal_open(message, ciphertext, this.pk, this.sk);
    if (!ok) {
      throw new Error("crypto_box_seal_open failed (wrong recorder key or corrupt ciphertext)");
    }
    if (message.length !== E2EE_HMK_BYTES) {
      throw new Error(`unsealed HMK wrong size: ${message.length} B (expected ${E2EE_HMK_BYTES})`);
    }
    return message;
  }

  private static generate(): RecorderIdentity {
    const pk = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
    const sk = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
    sodium.crypto_box_keypair(pk, sk);
    return new RecorderIdentity(pk, sk);
  }

  private static tryLoad(keyPath: string): RecorderIdentity | null {
    let raw: string;
    try {
      raw = fs.readFileSync(keyPath, "utf8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const material = Buffer.from(raw, "base64");
    const skLen = sodium.crypto_box_SECRETKEYBYTES;
    const pkLen = sodium.crypto_box_PUBLICKEYBYTES;
    if (material.length !== skLen + pkLen) {
      throw new Error(
        `recorder key file ${keyPath} is corrupt (got ${material.length} B, expected ${skLen + pkLen}) — refusing to overwrite the consent boundary`,
      );
    }
    const sk = Buffer.from(material.subarray(0, skLen));
    const pk = Buffer.from(material.subarray(skLen));
    return new RecorderIdentity(pk, sk);
  }

  /** Persist sk||pk as base64, 0600 (best-effort on Windows). */
  private persist(keyPath: string): void {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    const material = Buffer.concat([this.sk, this.pk]).toString("base64");
    fs.writeFileSync(keyPath, material + "\n", { mode: 0o600 });
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      /* Windows: filesystem may not honor POSIX modes — best-effort per §8.3. */
    }
  }
}
