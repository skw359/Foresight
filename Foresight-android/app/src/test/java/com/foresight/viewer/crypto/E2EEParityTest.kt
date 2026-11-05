/*
 * E2EE M0 cross-platform parity — the gate that retires the project's #1 risk
 * (silent decryption failure from a key-parameter mismatch, plan §3.2/§11).
 *
 * Asserts against the FROZEN vector at shared/test-vectors/e2ee-parity.json
 * (located by walking up from the module directory, so the canonical file is
 * used — never a copy that could drift):
 *   1. Argon2id(password, kdf-from-blob)          == vaultKey
 *   2. secretbox_open(wrappedPrivateKey)          == identity privateKey
 *   3. crypto_box_seal_open(sealedHmk)            == HMK
 *   4. base64(HMK)                                == the LiveKit setKey STRING
 *   5. locked constants                           == vector's livekit block
 *   6. PBKDF2-SHA256(setKeyString, ratchetSalt)   == LiveKit's derived AES key
 *   7. AES-128-GCM decrypt of the sample frame    == known plaintext
 * plus an IdentityVault round-trip (create → unlock → unseal path) on the same
 * libsodium engine the app logic runs through.
 */
package com.foresight.viewer.crypto

import com.foresight.viewer.contract.EncryptedKeyVault
import com.foresight.viewer.contract.ForesightE2EE
import com.foresight.viewer.contract.KdfParams
import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import com.goterl.lazysodium.interfaces.Box
import java.io.File
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class E2EEParityTest {

    companion object {
        private lateinit var vector: JsonObject
        private lateinit var sodium: SodiumOps
        private lateinit var vault: IdentityVault

        @JvmStatic
        @BeforeClass
        fun setUp() {
            vector = Json.parseToJsonElement(locateVector().readText()).jsonObject
            sodium = LazySodiumOps(loadLazySodium())
            vault = IdentityVault(sodium)
        }

        /**
         * lazysodium's bundled resource-loader fails with
         * FileSystemNotFoundException when the classpath jar lives under a path
         * containing spaces (e.g. C:\Users\First Last\.gradle). Extract the
         * bundled libsodium ourselves and hand SodiumJava an explicit path.
         */
        private fun loadLazySodium(): LazySodiumJava {
            val os = System.getProperty("os.name").orEmpty().lowercase()
            val arch = System.getProperty("os.arch").orEmpty().lowercase()
            val resource = when {
                os.contains("win") -> "/windows64/libsodium.dll"
                os.contains("mac") ->
                    if (arch.contains("aarch64")) "/mac/aarch64/libsodium.dylib" else "/mac/intel/libsodium.dylib"
                arch.contains("aarch64") -> "/arm64/libsodium.so"
                else -> "/linux64/libsodium.so"
            }
            val stream = E2EEParityTest::class.java.getResourceAsStream(resource)
                ?: return LazySodiumJava(SodiumJava()) // unexpected platform: try the default loader
            val suffix = resource.substringAfterLast('.')
            val extracted = File.createTempFile("libsodium-parity", ".$suffix")
            extracted.deleteOnExit()
            stream.use { input -> extracted.outputStream().use { input.copyTo(it) } }
            return LazySodiumJava(SodiumJava(extracted.absolutePath))
        }

        /**
         * Walk up from the working directory (the app module) to the monorepo
         * root that contains shared/test-vectors/e2ee-parity.json.
         */
        private fun locateVector(): File {
            var dir: File? = File("").absoluteFile
            repeat(8) {
                val candidate = File(dir, "shared/test-vectors/e2ee-parity.json")
                if (candidate.isFile) return candidate
                dir = dir?.parentFile ?: return@repeat
            }
            throw AssertionError(
                "shared/test-vectors/e2ee-parity.json not found above ${File("").absolutePath} — " +
                    "run the tests from within the foresight monorepo",
            )
        }
    }

    private fun b64(value: String): ByteArray = Base64.getDecoder().decode(value)
    private fun str(key: String): String = vector[key]!!.jsonPrimitive.content
    private fun obj(key: String): JsonObject = vector[key]!!.jsonObject

    private val password get() = str("password")
    private val kdf get() = obj("kdf")
    private val identity get() = obj("identity")
    private val wrap get() = obj("wrap")
    private val livekit get() = obj("livekit")

    @Test
    fun `1 - Argon2id derives the exact vault key`() {
        val derived = sodium.argon2id(
            password = password.encodeToByteArray(),
            salt = b64(kdf["saltB64"]!!.jsonPrimitive.content),
            opslimit = kdf["opslimit"]!!.jsonPrimitive.int,
            memlimit = kdf["memlimit"]!!.jsonPrimitive.int,
            outLen = 32,
        )
        assertArrayEquals(b64(str("vaultKeyB64")), derived)
    }

    @Test
    fun `2 - secretbox opens the wrapped private key`() {
        val opened = sodium.secretBoxOpen(
            cipherText = b64(wrap["wrappedPrivateKeyB64"]!!.jsonPrimitive.content),
            nonce = b64(wrap["nonceB64"]!!.jsonPrimitive.content),
            key = b64(str("vaultKeyB64")),
        )
        assertArrayEquals(b64(identity["privateKeyB64"]!!.jsonPrimitive.content), opened)
    }

    @Test
    fun `3 - IdentityVault unlock opens the vector vault end-to-end`() = runBlocking {
        val blob = EncryptedKeyVault(
            publicKey = identity["publicKeyB64"]!!.jsonPrimitive.content,
            wrappedPrivateKey = wrap["wrappedPrivateKeyB64"]!!.jsonPrimitive.content,
            nonce = wrap["nonceB64"]!!.jsonPrimitive.content,
            kdf = KdfParams(
                opslimit = kdf["opslimit"]!!.jsonPrimitive.int,
                memlimit = kdf["memlimit"]!!.jsonPrimitive.int,
                saltB64 = kdf["saltB64"]!!.jsonPrimitive.content,
            ),
        )
        val privateKey = vault.unlock(password, blob)
        assertArrayEquals(b64(identity["privateKeyB64"]!!.jsonPrimitive.content), privateKey)
        assertTrue(vault.isUnlocked())
    }

    @Test
    fun `4 - sealed HMK opens to the vector HMK, retained and stateless`() = runBlocking {
        val pub = b64(identity["publicKeyB64"]!!.jsonPrimitive.content)
        val priv = b64(identity["privateKeyB64"]!!.jsonPrimitive.content)

        val stateless = vault.unseal(str("sealedHmkB64"), pub, priv)
        assertArrayEquals(b64(str("hmkB64")), stateless)

        vault.load(pub, priv)
        val retained = vault.unsealRetained(str("sealedHmkB64"))
        assertArrayEquals(b64(str("hmkB64")), retained)
    }

    @Test
    fun `5 - LiveKit receives base64 of the HMK as a STRING at key index 0`() {
        val hmk = b64(str("hmkB64"))
        // The exact value RoomManager passes to BaseKeyProvider.setSharedKey.
        assertEquals(str("livekitSetKeyString"), B64.encode(hmk))

        // The locked constant set (divergence == silent black video, plan §3.2).
        assertEquals(livekit["keySize"]!!.jsonPrimitive.int, ForesightE2EE.KEY_SIZE)
        assertEquals(livekit["encryptionType"]!!.jsonPrimitive.content, ForesightE2EE.ENCRYPTION_TYPE)
        assertEquals(livekit["ratchetSalt"]!!.jsonPrimitive.content, ForesightE2EE.RATCHET_SALT)
        assertEquals(livekit["ratchetWindowSize"]!!.jsonPrimitive.int, ForesightE2EE.RATCHET_WINDOW_SIZE)
        assertEquals(livekit["keyIndex"]!!.jsonPrimitive.int, ForesightE2EE.KEY_INDEX)
        assertEquals(livekit["pbkdf2Iterations"]!!.jsonPrimitive.int, ForesightE2EE.PBKDF2_ITERATIONS)
        assertEquals(kdf["opslimit"]!!.jsonPrimitive.int, ForesightE2EE.ARGON2ID_OPSLIMIT)
        assertEquals(kdf["memlimit"]!!.jsonPrimitive.int, ForesightE2EE.ARGON2ID_MEMLIMIT)
    }

    @Test
    fun `6 - PBKDF2 over the setKey string derives LiveKit's AES key`() {
        val spec = PBEKeySpec(
            str("livekitSetKeyString").toCharArray(),
            ForesightE2EE.RATCHET_SALT.encodeToByteArray(),
            ForesightE2EE.PBKDF2_ITERATIONS,
            ForesightE2EE.KEY_SIZE,
        )
        val derived = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            .generateSecret(spec).encoded
        assertArrayEquals(b64(livekit["derivedAesKeyB64"]!!.jsonPrimitive.content), derived)
    }

    @Test
    fun `7 - the AES-GCM sample frame decrypts with the derived key`() {
        val sample = obj("aesGcmSample")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(b64(livekit["derivedAesKeyB64"]!!.jsonPrimitive.content), "AES"),
            GCMParameterSpec(128, b64(sample["ivB64"]!!.jsonPrimitive.content)),
        )
        val plaintext = cipher.doFinal(b64(sample["ciphertextWithTagB64"]!!.jsonPrimitive.content))
        assertEquals(sample["plaintextUtf8"]!!.jsonPrimitive.content, plaintext.decodeToString())
    }

    @Test
    fun `createVault round-trips through unlock and rejects a wrong password`() = runBlocking {
        val fresh = IdentityVault(sodium)
        val (blob, privateKey) = fresh.createVault("hunter2 — but with entropy")

        assertEquals(ForesightE2EE.X25519_KEY_BYTES, b64(blob.publicKey).size)
        assertEquals(ForesightE2EE.WRAPPED_PRIVATE_KEY_BYTES, b64(blob.wrappedPrivateKey).size)
        assertEquals(ForesightE2EE.SECRETBOX_NONCE_BYTES, b64(blob.nonce).size)
        assertEquals(ForesightE2EE.KDF_SALT_BYTES, b64(blob.kdf.saltB64).size)
        assertEquals("argon2id", blob.kdf.algo)

        val reopened = IdentityVault(sodium)
        assertArrayEquals(privateKey, reopened.unlock("hunter2 — but with entropy", blob))

        val wrongPassword = IdentityVault(sodium)
        val result = runCatching { wrongPassword.unlock("wrong", blob) }
        assertTrue(result.exceptionOrNull() is VaultException)
    }

    @Test
    fun `sealed boxes from this engine open with the vault identity (viewer consumes web grants)`() = runBlocking {
        val fresh = IdentityVault(sodium)
        val (blob, _) = fresh.createVault("pw")
        val hmk = sodium.randomBytes(ForesightE2EE.HMK_BYTES)

        // Seal to the new identity the way the web dashboard would (crypto_box_seal).
        val lazySodium = loadLazySodium()
        val sealed = ByteArray(hmk.size + Box.SEALBYTES)
        assertTrue(
            (lazySodium as Box.Native).cryptoBoxSeal(sealed, hmk, hmk.size.toLong(), b64(blob.publicKey)),
        )
        assertEquals(ForesightE2EE.SEALED_HMK_BYTES, sealed.size)

        val opened = fresh.unsealRetained(B64.encode(sealed))
        assertArrayEquals(hmk, opened)

        // After wipe, unsealing must fail closed (locked → "awaiting unlock" UX).
        fresh.wipe()
        assertNull(fresh.unsealRetained(B64.encode(sealed)))
    }
}
