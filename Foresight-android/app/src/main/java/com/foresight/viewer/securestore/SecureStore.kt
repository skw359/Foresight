/*
 * Android Keystore-backed persistence for the auth JWT (the Keychain analog).
 * The token is AES-GCM encrypted under a non-exportable Keystore key and the
 * ciphertext lives in SharedPreferences — readable only by this app, opaque in
 * backups (allowBackup is off anyway).
 */
package com.foresight.viewer.securestore

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.foresight.viewer.crypto.B64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("foresight.secure", Context.MODE_PRIVATE)

    companion object {
        private const val KEY_ALIAS = "com.foresight.viewer.token"
        private const val PREF_TOKEN = "authToken"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    }

    private fun keystoreKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    fun getToken(): String? {
        val stored = prefs.getString(PREF_TOKEN, null) ?: return null
        return try {
            val blob = B64.decode(stored) ?: return null
            val iv = blob.copyOfRange(0, 12)
            val cipherText = blob.copyOfRange(12, blob.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, iv))
            cipher.doFinal(cipherText).decodeToString()
        } catch (_: Exception) {
            // Key invalidated / corrupt blob: treat as signed out.
            prefs.edit().remove(PREF_TOKEN).apply()
            null
        }
    }

    fun setToken(token: String) {
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, keystoreKey())
            val cipherText = cipher.doFinal(token.encodeToByteArray())
            prefs.edit().putString(PREF_TOKEN, B64.encode(cipher.iv + cipherText)).apply()
        } catch (_: Exception) {
            // Keystore unavailable: fail closed (no persistence, session-only auth).
        }
    }

    fun removeToken() {
        prefs.edit().remove(PREF_TOKEN).apply()
    }
}
