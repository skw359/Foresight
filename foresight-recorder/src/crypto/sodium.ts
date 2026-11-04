/**
 * Typed facade over the native `sodium-native` addon.
 *
 * `sodium-native` is a CommonJS native addon (`module.exports = { ...binding }`)
 * that ships no type declarations. Rather than rely on ESM/CJS default-import
 * interop for a native module, we load it explicitly with `createRequire` and
 * expose exactly the surface the recorder uses, fully typed.
 *
 * Only the primitives the recorder needs are declared: X25519 keypair +
 * anonymous sealed-box open (unseal an HMK), plus the constants the crypto
 * self-test asserts and the parity vector exercises.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The subset of the sodium-native API surface the recorder depends on. */
export interface SodiumNative {
  readonly crypto_box_PUBLICKEYBYTES: number;
  readonly crypto_box_SECRETKEYBYTES: number;
  readonly crypto_box_SEALBYTES: number;
  readonly crypto_secretbox_NONCEBYTES: number;
  readonly crypto_secretbox_MACBYTES: number;
  readonly crypto_secretbox_KEYBYTES: number;
  readonly crypto_pwhash_SALTBYTES: number;
  readonly crypto_pwhash_ALG_ARGON2ID13: number;
  readonly crypto_pwhash_BYTES_MIN: number;
  readonly crypto_pwhash_BYTES_MAX: number;

  crypto_box_keypair(publicKey: Buffer, secretKey: Buffer): void;
  crypto_box_seal(ciphertext: Buffer, message: Buffer, publicKey: Buffer): void;
  /** Returns true when the ciphertext opened (authenticated), false otherwise. */
  crypto_box_seal_open(
    message: Buffer,
    ciphertext: Buffer,
    publicKey: Buffer,
    secretKey: Buffer,
  ): boolean;
  /** Returns true when the box opened (authenticated), false otherwise. */
  crypto_secretbox_open_easy(
    message: Buffer,
    ciphertext: Buffer,
    nonce: Buffer,
    key: Buffer,
  ): boolean;
  crypto_pwhash(
    out: Buffer,
    password: Buffer,
    salt: Buffer,
    opslimit: number,
    memlimit: number,
    algorithm: number,
  ): void;
  randombytes_buf(buffer: Buffer): void;
  sodium_memzero(buffer: Buffer): void;
}

const sodium = require("sodium-native") as SodiumNative;

export default sodium;
