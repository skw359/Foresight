/*
 * Biometric-gated E2EE identity cache — the Android analog of the iOS
 * Face-ID Keychain item (plan §7.4).
 *
 * Caches the DECRYPTED identity keypair (publicKey(32) || privateKey(32)) so a
 * cold launch (JWT restored but the in-memory key gone) can restore the
 * identity without re-typing the password.
 *
 * Mechanism: a Keystore RSA-OAEP keypair with setUserAuthenticationRequired +
 * setInvalidatedByBiometricEnrollment(true). RSA is used (not AES) because the
 * auth requirement applies to PRIVATE-key operations only: caching (public-key
 * encrypt) is silent, reading requires a BiometricPrompt with the decrypt
 * Cipher as its CryptoObject, and enrolling a new fingerprint/face permanently
 * invalidates the key — the exact semantics of the iOS `.biometryCurrentSet`
 * access control.
 */
package com.foresight.viewer.securestore

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.foresight.viewer.crypto.B64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.MGF1ParameterSpec
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

class BiometricKeyCache(private val context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("foresight.secure", Context.MODE_PRIVATE)

    companion object {
        private const val KEY_ALIAS = "com.foresight.viewer.e2eeIdentity"
        private const val PREF_BLOB = "e2ee.identityBlob"
        /** Non-secret hint so the UI can offer biometrics without touching the gated key. */
        private const val PREF_CACHED_FLAG = "e2ee.hasCachedIdentity"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORM = "RSA/ECB/OAEPWithSHA-256AndMGF1Padding"

        /**
         * Explicit OAEP parameters for BOTH sides. The public-key encrypt runs in
         * the software provider (Conscrypt), which defaults the MGF1 mask digest
         * to the primary digest (SHA-256); AndroidKeyStore, which performs the
         * gated decrypt, always uses MGF1-SHA1. Without pinning MGF1 to SHA-1,
         * doFinal fails AFTER a successful BiometricPrompt and the app falls
         * back to the password sheet.
         */
        private val OAEP_PARAMS = OAEPParameterSpec(
            "SHA-256",
            "MGF1",
            MGF1ParameterSpec.SHA1,
            PSource.PSpecified.DEFAULT,
        )
    }

    private fun biometricsAvailable(): Boolean =
        BiometricManager.from(context)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

    /**
     * Store the identity payload behind biometrics. Best-effort: without
     * enrolled biometrics the item simply isn't created and the app falls back
     * to a password re-unlock (mirrors Keychain.cacheIdentityKey).
     */
    fun cache(payload: ByteArray) {
        remove()
        if (!biometricsAvailable()) return
        try {
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEYSTORE)
            generator.initialize(
                KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(2048)
                    .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
                    .setUserAuthenticationRequired(true)
                    .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                    .setInvalidatedByBiometricEnrollment(true)
                    .build(),
            )
            val keyPair = generator.generateKeyPair()
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, keyPair.public, OAEP_PARAMS)
            val blob = cipher.doFinal(payload)
            prefs.edit()
                .putString(PREF_BLOB, B64.encode(blob))
                .putBoolean(PREF_CACHED_FLAG, true)
                .apply()
        } catch (_: Exception) {
            remove()
        }
    }

    /** True when a biometric identity item was cached (non-secret hint, no prompt). */
    fun hasCachedIdentity(): Boolean = prefs.getBoolean(PREF_CACHED_FLAG, false)

    /**
     * Read the cached identity payload, prompting for biometrics. Returns null
     * if absent, denied, cancelled, or invalidated (→ password path).
     */
    suspend fun load(activity: FragmentActivity, title: String, subtitle: String): ByteArray? {
        val stored = prefs.getString(PREF_BLOB, null) ?: return null
        val blob = B64.decode(stored) ?: return null

        val cipher = try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            val privateKey = keyStore.getKey(KEY_ALIAS, null) ?: return null
            Cipher.getInstance(TRANSFORM).apply { init(Cipher.DECRYPT_MODE, privateKey, OAEP_PARAMS) }
        } catch (_: KeyPermanentlyInvalidatedException) {
            // Biometric enrollment changed — the cache is gone by design.
            remove()
            return null
        } catch (_: Exception) {
            return null
        }

        return suspendCancellableCoroutine { continuation ->
            val prompt = BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        val payload = try {
                            result.cryptoObject?.cipher?.doFinal(blob)
                        } catch (_: Exception) {
                            null
                        }
                        if (continuation.isActive) continuation.resume(payload)
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        if (continuation.isActive) continuation.resume(null)
                    }
                },
            )
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setNegativeButtonText("Use password")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .build()
            prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
            continuation.invokeOnCancellation { prompt.cancelAuthentication() }
        }
    }

    fun remove() {
        prefs.edit().remove(PREF_BLOB).putBoolean(PREF_CACHED_FLAG, false).apply()
        try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            keyStore.deleteEntry(KEY_ALIAS)
        } catch (_: Exception) {
            // Nothing to delete / Keystore unavailable — the pref flag is cleared.
        }
    }
}
