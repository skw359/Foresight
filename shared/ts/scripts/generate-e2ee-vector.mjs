/**
 * M0 parity-gate vector generator (shared/E2EE.md §11 M0).
 *
 * Emits shared/test-vectors/e2ee-parity.json — the cross-platform test vector
 * every codebase's parity test must reproduce byte-for-byte:
 *   - web       (libsodium-wrappers-sumo, WASM)  → Foresight-web-client vitest
 *   - recorder  (sodium-native)                  → foresight-recorder vitest
 *   - camera+iOS (swift-sodium)                  → XCTest, run on a Mac
 *
 * All inputs are deterministic (derived from SHA-256 of fixed labels) EXCEPT
 * `sealedHmkB64`: crypto_box_seal uses an ephemeral keypair, so that field is
 * frozen at generation time. Platforms must OPEN it (seal_open → hmk), never
 * regenerate it. Re-running this script changes only that field.
 *
 * Run:  node shared/ts/scripts/generate-e2ee-vector.mjs
 */
import _sodium from "libsodium-wrappers-sumo";
import { createHash, pbkdf2Sync, createCipheriv, createDecipheriv } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "..", "test-vectors", "e2ee-parity.json");

// Locked contract values (mirror shared/ts/src/e2ee.ts — asserted below).
const OPSLIMIT = 3;
const MEMLIMIT = 67108864; // 64 MiB
const KEY_SIZE_BITS = 128;
const RATCHET_SALT = "LKFrameEncryptionKey";
const PBKDF2_ITERATIONS = 100000;

/** Deterministic "arbitrary" bytes: sha256("foresight-e2ee-parity:" + label), truncated. */
function fixedBytes(label, len) {
  const h = createHash("sha256").update(`foresight-e2ee-parity:${label}`).digest();
  if (len <= 32) return Uint8Array.from(h.subarray(0, len));
  const h2 = createHash("sha256").update(h).digest();
  return Uint8Array.from(Buffer.concat([h, h2]).subarray(0, len));
}

const sodium = await (async () => {
  await _sodium.ready;
  return _sodium;
})();

const b64 = (u8) => Buffer.from(u8).toString("base64");

// ── Inputs ──────────────────────────────────────────────────────────────────
const password = "correct horse battery staple — foresight M0";
const kdfSalt = fixedBytes("kdf-salt", sodium.crypto_pwhash_SALTBYTES); // 16 B
const identitySeed = fixedBytes("identity-seed", sodium.crypto_box_SEEDBYTES); // 32 B
const wrapNonce = fixedBytes("wrap-nonce", sodium.crypto_secretbox_NONCEBYTES); // 24 B
const hmk = fixedBytes("home-media-key", 32);
const gcmIv = fixedBytes("gcm-iv", 12);
const gcmPlaintext = "foresight E2EE M0 parity frame";

// ── 1. Argon2id password → vault key ───────────────────────────────────────
const vaultKey = sodium.crypto_pwhash(
  32,
  password,
  kdfSalt,
  OPSLIMIT,
  MEMLIMIT,
  sodium.crypto_pwhash_ALG_ARGON2ID13,
);

// ── 2. Identity keypair (deterministic from seed) ──────────────────────────
const identity = sodium.crypto_box_seed_keypair(identitySeed);

// ── 3. Wrap the private key: crypto_secretbox_easy(sk, nonce, vaultKey) ────
const wrappedPrivateKey = sodium.crypto_secretbox_easy(identity.privateKey, wrapNonce, vaultKey);

// ── 4. Seal the HMK to the identity pubkey (randomized — frozen once) ──────
const sealedHmk = sodium.crypto_box_seal(hmk, identity.publicKey);

// ── 5. The LiveKit setKey passphrase: base64(HMK) as a STRING ──────────────
const setKeyString = b64(hmk);

// ── 6. LiveKit's derived AES key (installed livekit-client@2.19.2 worker):
//      PBKDF2-SHA-256(utf8(passphrase), utf8(ratchetSalt), 100000) → 128-bit AES-GCM
const derivedAesKey = pbkdf2Sync(
  Buffer.from(setKeyString, "utf8"),
  Buffer.from(RATCHET_SALT, "utf8"),
  PBKDF2_ITERATIONS,
  KEY_SIZE_BITS / 8,
  "sha256",
);

// ── 7. AES-128-GCM sample under the derived key (ciphertext || 16-B tag) ───
const cipher = createCipheriv("aes-128-gcm", derivedAesKey, gcmIv);
const ct = Buffer.concat([cipher.update(gcmPlaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);

// ── Self-checks before writing ──────────────────────────────────────────────
{
  const skRoundTrip = sodium.crypto_secretbox_open_easy(wrappedPrivateKey, wrapNonce, vaultKey);
  if (b64(skRoundTrip) !== b64(identity.privateKey)) throw new Error("secretbox round-trip failed");
  const hmkRoundTrip = sodium.crypto_box_seal_open(sealedHmk, identity.publicKey, identity.privateKey);
  if (b64(hmkRoundTrip) !== b64(hmk)) throw new Error("sealed-box round-trip failed");
  if (wrappedPrivateKey.length !== 48 || sealedHmk.length !== 80) throw new Error("blob size mismatch");
  const dec = createDecipheriv("aes-128-gcm", derivedAesKey, gcmIv);
  dec.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]).toString("utf8");
  if (pt !== gcmPlaintext) throw new Error("AES-GCM round-trip failed");
}

const vector = {
  description:
    "Foresight E2EE M0 cross-platform parity vector. Every platform (libsodium-wrappers-sumo, " +
    "sodium-native, swift-sodium) must derive the SAME vaultKey from `password`+`kdf`, open " +
    "`wrap.wrappedPrivateKeyB64` to `identity.privateKeyB64`, open `sealedHmkB64` to `hmkB64`, and " +
    "apply the HMK to LiveKit as the STRING `livekitSetKeyString` at key index 0. " +
    "`livekit.derivedAesKeyB64` is what livekit-client@2.19.2 derives internally from that string " +
    "(PBKDF2-SHA-256) — assert it where a PBKDF2 implementation is available.",
  generatedBy: "shared/ts/scripts/generate-e2ee-vector.mjs",
  password,
  kdf: { algo: "argon2id", opslimit: OPSLIMIT, memlimit: MEMLIMIT, saltB64: b64(kdfSalt) },
  vaultKeyB64: b64(vaultKey),
  identity: {
    seedB64: b64(identitySeed),
    publicKeyB64: b64(identity.publicKey),
    privateKeyB64: b64(identity.privateKey),
  },
  wrap: { nonceB64: b64(wrapNonce), wrappedPrivateKeyB64: b64(wrappedPrivateKey) },
  hmkB64: b64(hmk),
  livekitSetKeyString: setKeyString,
  sealedHmkB64: b64(sealedHmk),
  livekit: {
    keySize: KEY_SIZE_BITS,
    encryptionType: "gcm",
    ratchetSalt: RATCHET_SALT,
    ratchetWindowSize: 0,
    keyIndex: 0,
    pbkdf2Iterations: PBKDF2_ITERATIONS,
    derivedAesKeyB64: b64(derivedAesKey),
  },
  aesGcmSample: { ivB64: b64(gcmIv), plaintextUtf8: gcmPlaintext, ciphertextWithTagB64: b64(ct) },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(vector, null, 2) + "\n");
console.log(`wrote ${outPath}`);
console.log(`vaultKey  ${vector.vaultKeyB64}`);
console.log(`hmk       ${vector.hmkB64}`);
console.log(`derivedAes ${vector.livekit.derivedAesKeyB64}`);
