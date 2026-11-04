/*
 * Thin seam over libsodium so the same vault logic runs on-device
 * (lazysodium-android) and in JVM unit tests (lazysodium-java). Both artifacts
 * expose the identical LazySodium base class + Native interfaces, so one
 * implementation covers both — only the constructed engine differs.
 *
 * libsodium (not Conscrypt/Tink/BouncyCastle hand-rolls): nothing in the
 * platform can open a libsodium sealed box (crypto_box_seal / XSalsa20), and
 * cross-platform byte parity with web/iOS/recorder is load-bearing
 * (E2EE_MODEL_B_PLAN.md §3.1).
 */
package com.foresight.viewer.crypto

import com.goterl.lazysodium.LazySodium
import com.goterl.lazysodium.interfaces.Box
import com.goterl.lazysodium.interfaces.PwHash
import com.goterl.lazysodium.interfaces.SecretBox
import com.sun.jna.NativeLong

interface SodiumOps {
    /** crypto_pwhash Argon2id (ALG_ARGON2ID13) → [outLen] bytes, or null on failure. */
    fun argon2id(password: ByteArray, salt: ByteArray, opslimit: Int, memlimit: Int, outLen: Int): ByteArray?

    /** crypto_secretbox_open_easy — null on MAC failure (wrong key / corrupt blob). */
    fun secretBoxOpen(cipherText: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray?

    /** crypto_secretbox_easy. */
    fun secretBoxSeal(message: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray?

    /** crypto_box_keypair → (publicKey 32B, privateKey 32B), or null. */
    fun boxKeypair(): Pair<ByteArray, ByteArray>?

    /** crypto_box_seal_open — null when the sealed box doesn't open for this keypair. */
    fun sealOpen(cipherText: ByteArray, publicKey: ByteArray, privateKey: ByteArray): ByteArray?

    /** randombytes_buf. */
    fun randomBytes(length: Int): ByteArray
}

/**
 * LazySodium-backed implementation. Pass LazySodiumAndroid(SodiumAndroid()) on
 * device, LazySodiumJava(SodiumJava()) in JVM tests.
 */
class LazySodiumOps(private val sodium: LazySodium) : SodiumOps {

    override fun argon2id(
        password: ByteArray,
        salt: ByteArray,
        opslimit: Int,
        memlimit: Int,
        outLen: Int,
    ): ByteArray? {
        val out = ByteArray(outLen)
        val ok = (sodium as PwHash.Native).cryptoPwHash(
            out, out.size, password, password.size, salt,
            opslimit.toLong(), NativeLong(memlimit.toLong()), PwHash.Alg.PWHASH_ALG_ARGON2ID13,
        )
        return if (ok) out else null
    }

    override fun secretBoxOpen(cipherText: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray? {
        if (cipherText.size < SecretBox.MACBYTES) return null
        val message = ByteArray(cipherText.size - SecretBox.MACBYTES)
        val ok = (sodium as SecretBox.Native)
            .cryptoSecretBoxOpenEasy(message, cipherText, cipherText.size.toLong(), nonce, key)
        return if (ok) message else null
    }

    override fun secretBoxSeal(message: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray? {
        val cipher = ByteArray(message.size + SecretBox.MACBYTES)
        val ok = (sodium as SecretBox.Native)
            .cryptoSecretBoxEasy(cipher, message, message.size.toLong(), nonce, key)
        return if (ok) cipher else null
    }

    override fun boxKeypair(): Pair<ByteArray, ByteArray>? {
        val publicKey = ByteArray(Box.PUBLICKEYBYTES)
        val privateKey = ByteArray(Box.SECRETKEYBYTES)
        val ok = (sodium as Box.Native).cryptoBoxKeypair(publicKey, privateKey)
        return if (ok) publicKey to privateKey else null
    }

    override fun sealOpen(cipherText: ByteArray, publicKey: ByteArray, privateKey: ByteArray): ByteArray? {
        if (cipherText.size < Box.SEALBYTES) return null
        val message = ByteArray(cipherText.size - Box.SEALBYTES)
        val ok = (sodium as Box.Native)
            .cryptoBoxSealOpen(message, cipherText, cipherText.size.toLong(), publicKey, privateKey)
        return if (ok) message else null
    }

    override fun randomBytes(length: Int): ByteArray = sodium.randomBytesBuf(length)
}
