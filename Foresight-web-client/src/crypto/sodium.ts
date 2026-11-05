/**
 * Lazy libsodium-wrappers-sumo loader (shared/E2EE.md §9.2).
 *
 * The ~150 KB gz WASM must NEVER land in the entry bundle, so libsodium is
 * reached only through a dynamic `import()` (a separate async chunk).
 *
 * Export shape: the ESM build attaches the crypto_* functions (and `.ready`) to
 * the module's DEFAULT export; only helpers (to_base64, base64_variants, ...) are
 * named exports. The CJS build used by vitest exposes the same object via
 * `.default`, so `.default ?? mod` covers both.
 *
 * base64: every base64 string in @foresight/contract and the M0 parity vector is
 * STANDARD base64 WITH padding (`base64_variants.ORIGINAL`). libsodium defaults
 * to URLSAFE_NO_PADDING, so the variant MUST be passed explicitly on every call;
 * that is why the b64 helpers below exist.
 */

export type Sodium = typeof import("libsodium-wrappers-sumo");

let sodiumPromise: Promise<Sodium> | null = null;

export function loadSodium(): Promise<Sodium> {
  if (!sodiumPromise) {
    sodiumPromise = import("libsodium-wrappers-sumo").then(async (mod) => {
      const sodium = (mod as unknown as { default?: Sodium }).default ?? (mod as unknown as Sodium);
      await sodium.ready;
      return sodium;
    });
  }
  return sodiumPromise;
}

/** Standard base64 (padded) encode — byte-compatible with the contract vectors. */
export function b64encode(sodium: Sodium, bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

/** Standard base64 (padded) decode. Throws on malformed input. */
export function b64decode(sodium: Sodium, text: string): Uint8Array {
  return sodium.from_base64(text, sodium.base64_variants.ORIGINAL);
}

/**
 * Thrown by the vault worker when a vault's stored publicKey does not match the
 * key derived from the just-unlocked private key. secretbox authenticates only
 * the wrapped sk — publicKey rides beside it unauthenticated — so a mismatch
 * means the vault blob was altered (e.g. a tampering server swapped the pubkey).
 * Lives here (not in vault.worker.ts) so the main thread can match on it without
 * pulling the worker module into the entry bundle.
 */
export const VAULT_TAMPER_MESSAGE =
  "Vault integrity check failed: the stored public key does not match your private key. " +
  "Your key vault may have been tampered with — contact your server operator.";
