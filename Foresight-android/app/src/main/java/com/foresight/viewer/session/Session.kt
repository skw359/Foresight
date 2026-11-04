/*
 * App-wide auth + API state. Owns the ApiClient, restores the JWT from the
 * secure store on launch, and drives root navigation (auth vs. authenticated).
 *
 * Also owns the E2EE identity (plan §7.4): on login it unlocks the user's key
 * vault (or runs first-login key generation) and holds the unlocked keypair in
 * an IdentityVault. On a cold launch the in-memory key is gone, so it offers a
 * biometric → password re-unlock. RoomManager reaches this to unseal a Home
 * Media Key before connecting to an E2EE-activated Home.
 *
 * Port of the iOS Session (@MainActor ObservableObject → StateFlows).
 */
package com.foresight.viewer.session

import androidx.fragment.app.FragmentActivity
import com.foresight.viewer.contract.AuthResponse
import com.foresight.viewer.contract.EncryptedKeyVault
import com.foresight.viewer.contract.ForesightE2EE
import com.foresight.viewer.contract.UserDTO
import com.foresight.viewer.crypto.IdentityVault
import com.foresight.viewer.network.ApiClient
import com.foresight.viewer.securestore.BiometricKeyCache
import com.foresight.viewer.securestore.SecureStore
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class Session(
    val api: ApiClient,
    val vault: IdentityVault,
    private val secureStore: SecureStore,
    private val biometricCache: BiometricKeyCache,
) {
    sealed interface Phase {
        data object Unauthenticated : Phase
        data class Authenticated(val user: UserDTO) : Phase
    }

    /** State of the in-memory E2EE identity (the unlocked private key). */
    sealed interface UnlockPhase {
        data object Locked : UnlockPhase      // authenticated but no identity key in memory
        data object Unlocking : UnlockPhase   // Argon2id / biometric in flight
        data object Unlocked : UnlockPhase    // key available; E2EE Homes can decrypt
        data class Failed(val message: String) : UnlockPhase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Unauthenticated)
    val phase: StateFlow<Phase> = _phase

    private val _unlockPhase = MutableStateFlow<UnlockPhase>(UnlockPhase.Locked)
    val unlockPhase: StateFlow<UnlockPhase> = _unlockPhase

    /**
     * Drives the root password re-unlock sheet (decoupled from unlockPhase so
     * transient Unlocking flips don't dismiss/re-present it).
     */
    private val _isPresentingPasswordUnlock = MutableStateFlow(false)
    val isPresentingPasswordUnlock: StateFlow<Boolean> = _isPresentingPasswordUnlock

    private val _currentUser = MutableStateFlow<UserDTO?>(null)
    val currentUser: StateFlow<UserDTO?> = _currentUser

    /** Stable per-launch session id (viewer identity uniqueness). */
    val sessionId: String = UUID.randomUUID().toString()

    /**
     * Supplies the foreground activity for BiometricPrompt (registered by
     * MainActivity). Null when the app is backgrounded → password fallback.
     */
    @Volatile
    var activityProvider: () -> FragmentActivity? = { null }

    init {
        val restored = secureStore.getToken()
        if (restored != null) {
            api.setToken(restored)
            // Optimistically authenticated; a failed request routes back to login.
            // The user object isn't persisted — a placeholder until fresh login.
            _phase.value = Phase.Authenticated(UserDTO(id = "", identifier = "", createdAt = ""))
            // Cold launch: JWT survived but the in-memory identity did not. Stay
            // Locked and unlock lazily the first time an E2EE Home is opened.
            _unlockPhase.value = UnlockPhase.Locked
        }
    }

    val isAuthenticated: Boolean get() = _phase.value is Phase.Authenticated
    val isIdentityUnlocked: Boolean get() = _unlockPhase.value == UnlockPhase.Unlocked

    // MARK: - Login / migration

    /**
     * Handle a successful register/login. Persists the token, then sets up the
     * E2EE identity: unlock the returned vault, or run first-login key
     * generation when the account has none yet.
     */
    suspend fun handleAuthSuccess(response: AuthResponse, password: String) {
        secureStore.setToken(response.token)
        api.setToken(response.token)
        _currentUser.value = response.user
        _phase.value = Phase.Authenticated(response.user)
        setUpIdentity(password, response.keyVault)
    }

    /**
     * Unlock (existing vault) or migrate (no vault yet). The just-typed password
     * is available here and nowhere else — the only moment first-login keygen
     * can wrap the private key.
     */
    private suspend fun setUpIdentity(password: String, keyVault: EncryptedKeyVault?) {
        _unlockPhase.value = UnlockPhase.Unlocking
        try {
            if (keyVault != null) {
                vault.unlock(password, keyVault)
            } else {
                // First-login migration: generate + wrap, persist BEFORE caching so
                // a failed upload never leaves an unregistered keypair around.
                val (newVault, _) = vault.createVault(password)
                try {
                    api.setMyKeys(newVault)
                } catch (e: Exception) {
                    vault.wipe() // discard the unregistered keypair
                    throw e
                }
            }
            vault.biometricPayload()?.let { biometricCache.cache(it) }
            _unlockPhase.value = UnlockPhase.Unlocked
        } catch (e: Exception) {
            // The JWT is valid, so stay authenticated; E2EE Homes show a locked/
            // awaiting state until the identity is unlocked.
            _unlockPhase.value = UnlockPhase.Failed(e.message ?: "Could not unlock your keys.")
        }
    }

    // MARK: - Cold-launch re-unlock (biometric → password)

    /**
     * Ensure the E2EE identity key is in memory before an E2EE room connect.
     * Tries the biometric-cached key first; otherwise raises the password
     * re-unlock sheet and returns false (the caller shows a locked state and
     * reconnects when unlockPhase becomes Unlocked).
     */
    suspend fun ensureIdentityUnlocked(): Boolean {
        if (vault.isUnlocked()) {
            _unlockPhase.value = UnlockPhase.Unlocked
            return true
        }

        val activity = activityProvider()
        if (biometricCache.hasCachedIdentity() && activity != null) {
            _unlockPhase.value = UnlockPhase.Unlocking
            val payload = biometricCache.load(
                activity,
                title = "Unlock your Foresight camera keys",
                subtitle = "Decrypt this Home's cameras on this device",
            )
            if (payload != null && payload.size == 2 * ForesightE2EE.X25519_KEY_BYTES) {
                vault.load(
                    publicKey = payload.copyOfRange(0, ForesightE2EE.X25519_KEY_BYTES),
                    privateKey = payload.copyOfRange(ForesightE2EE.X25519_KEY_BYTES, payload.size),
                )
                _unlockPhase.value = UnlockPhase.Unlocked
                return true
            }
        }
        // No cached identity, or biometrics cancelled/failed → password path.
        _unlockPhase.value = UnlockPhase.Locked
        _isPresentingPasswordUnlock.value = true
        return false
    }

    /**
     * Complete a password re-unlock. Fetches the vault (may be web-created —
     * same libsodium params → opens here) and unlocks it. Returns false on a
     * bad password so the sheet can show an error and let the user retry.
     */
    suspend fun completePasswordUnlock(password: String): Boolean {
        _unlockPhase.value = UnlockPhase.Unlocking
        return try {
            val resp = api.getMyKeys()
            val vaultBlob = resp.keyVault
            if (vaultBlob != null) {
                vault.unlock(password, vaultBlob)
            } else {
                // No server-side vault yet (unmigrated account) → create one.
                val (newVault, _) = vault.createVault(password)
                api.setMyKeys(newVault)
            }
            vault.biometricPayload()?.let { biometricCache.cache(it) }
            _unlockPhase.value = UnlockPhase.Unlocked
            _isPresentingPasswordUnlock.value = false
            true
        } catch (_: Exception) {
            _unlockPhase.value = UnlockPhase.Locked
            false
        }
    }

    /** User dismissed the password sheet without unlocking. */
    fun cancelPasswordUnlock() {
        _isPresentingPasswordUnlock.value = false
        _unlockPhase.value = UnlockPhase.Locked
    }

    // MARK: - Teardown

    suspend fun signOut() {
        secureStore.removeToken()
        biometricCache.remove()
        api.setToken(null)
        vault.wipe()
        _currentUser.value = null
        _phase.value = Phase.Unauthenticated
        _unlockPhase.value = UnlockPhase.Locked
        _isPresentingPasswordUnlock.value = false
    }

    /** Called when an authed request returns 401-style failure; forces re-login. */
    suspend fun sessionExpired() = signOut()
}
