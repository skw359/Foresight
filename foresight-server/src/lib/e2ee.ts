/**
 * E2EE wire validation — SHAPE AND SIZE ONLY. The server is zero-knowledge (see
 * shared/E2EE.md §7.1): it stores and serves opaque base64 blobs and NEVER
 * seals, unseals, or derives anything. These zod schemas assert only that a
 * value is valid base64 decoding to the exact byte length the contract fixes for
 * each blob (public key 32 B, sealed key 80 B, wrapped private key 48 B, nonce
 * 24 B, KDF salt 16 B). A vitest greps this whole tree to prove no unsealing /
 * KDF primitive names ever appear here.
 */
import { z } from "zod";
import {
  E2EE_KDF_SALT_BYTES,
  E2EE_SEALED_HMK_BYTES,
  E2EE_SECRETBOX_NONCE_BYTES,
  E2EE_WRAPPED_PRIVATE_KEY_BYTES,
  E2EE_X25519_KEY_BYTES,
  type EncryptedKeyVault,
  type SetKeyVaultRequest,
} from "@foresight/contract";

/** Canonical base64 alphabet with 0–2 padding chars. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A zod string that must be base64 decoding to EXACTLY `bytes` bytes. This is
 * the server's only "understanding" of a blob: its length. No decryption.
 */
export function b64Bytes(bytes: number): z.ZodType<string> {
  return z.string().refine(
    (s) => BASE64.test(s) && Buffer.from(s, "base64").length === bytes,
    { message: `must be base64 encoding exactly ${bytes} bytes` },
  );
}

export const publicKeySchema = b64Bytes(E2EE_X25519_KEY_BYTES);
export const sealedKeySchema = b64Bytes(E2EE_SEALED_HMK_BYTES);
export const wrappedPrivateKeySchema = b64Bytes(E2EE_WRAPPED_PRIVATE_KEY_BYTES);
export const nonceSchema = b64Bytes(E2EE_SECRETBOX_NONCE_BYTES);
export const kdfSaltSchema = b64Bytes(E2EE_KDF_SALT_BYTES);

/**
 * KDF params are stored per-blob so they can be retuned later without bricking
 * old vaults (§3.1) — so we validate shape only, NOT specific opslimit/memlimit
 * values.
 */
export const kdfParamsSchema = z.object({
  algo: z.literal("argon2id"),
  opslimit: z.number().int().positive(),
  memlimit: z.number().int().positive(),
  saltB64: kdfSaltSchema,
});

const vaultShape = {
  publicKey: publicKeySchema,
  wrappedPrivateKey: wrappedPrivateKeySchema,
  nonce: nonceSchema,
  kdf: kdfParamsSchema,
};

export const encryptedKeyVaultSchema: z.ZodType<EncryptedKeyVault> = z.object(vaultShape);

/** POST /me/keys body: the vault plus (when replacing one) the account password. */
export const setKeyVaultSchema: z.ZodType<SetKeyVaultRequest> = z.object({
  ...vaultShape,
  currentPassword: z.string().min(1).max(1024).optional(),
});

export const holderTypeSchema = z.enum(["user", "camera", "recorder"]);

export const sealedKeyUploadSchema = z.object({
  holderType: holderTypeSchema,
  holderId: z.string().min(1),
  sealedKey: sealedKeySchema,
});

export const submitSealedKeysSchema = z.object({
  epoch: z.number().int().nonnegative(),
  keys: z.array(sealedKeyUploadSchema).min(1),
});

export const initHomeKeySchema = z.object({
  keys: z.array(sealedKeyUploadSchema).min(1),
});

export const rotateHomeKeySchema = z.object({
  fromEpoch: z.number().int().nonnegative(),
  keys: z.array(sealedKeyUploadSchema).min(1),
});

export const recorderConsentSchema = z.object({
  enabled: z.boolean(),
  sealedKey: sealedKeySchema.optional(),
});

export const cameraKeyRegistrationSchema = z.object({
  deviceSecret: z.string().min(1),
  publicKey: publicKeySchema,
});

export const recorderIdentitySchema = z.object({
  publicKey: publicKeySchema,
});
