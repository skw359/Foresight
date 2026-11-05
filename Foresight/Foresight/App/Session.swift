//
//  Session.swift
//  Foresight
//
//  App-wide auth + API state. Owns the APIClient, restores the JWT from the
//  Keychain on launch, and drives the root navigation (auth vs. authenticated).
//
//  Also owns the E2EE identity (plan §7.4): on login it unlocks the user's key
//  vault (or runs first-login key generation) and holds the unlocked keypair in
//  an IdentityVault actor. On a cold launch the in-memory key is gone, so it
//  offers a Face ID / password re-unlock. RoomManager reaches this to unseal a
//  Home Media Key before connecting to an E2EE-activated Home.
//

import Foundation
import Combine

@MainActor
final class Session: ObservableObject {
    /// The single app-wide session. Used by SwiftUI (as an EnvironmentObject)
    /// and by view-model initializers that need the live API client.
    static let shared = Session()

    enum Phase: Equatable {
        case unauthenticated
        case authenticated(UserDTO)
    }

    /// State of the in-memory E2EE identity (the unlocked private key).
    enum UnlockPhase: Equatable {
        case locked        // authenticated but the identity key is not in memory
        case unlocking     // Argon2id / biometric in flight (show a spinner)
        case unlocked      // key available; E2EE Homes can decrypt
        case failed(String)
    }

    @Published private(set) var phase: Phase = .unauthenticated
    @Published private(set) var currentUser: UserDTO?

    @Published private(set) var unlockPhase: UnlockPhase = .locked
    /// Drives the root password re-unlock sheet (decoupled from `unlockPhase`
    /// so transient `.unlocking` flips don't dismiss/re-present it).
    @Published var isPresentingPasswordUnlock = false

    let api: APIClient

    /// The unlocked E2EE identity keypair (memory only). Actor so Argon2id runs
    /// off the main actor.
    let vault = IdentityVault()

    /// Stable per-launch session id, used to build a unique viewer identity.
    let sessionId: String = UUID().uuidString

    private init() {
        let restored = Keychain.get(.authToken)
        self.api = APIClient(
            baseURLProvider: { AppConfig.resolveBaseURL() },
            token: restored
        )
        // If we have a token, optimistically treat as authenticated; a failed
        // request later will route the user back to login.
        if restored != nil {
            // We don't persist the user object; leave currentUser nil until a
            // fresh login. Homes list will still load with the bearer token.
            self.phase = .authenticated(UserDTO(id: "", identifier: "", firstName: nil, createdAt: ""))
            // Cold launch: the JWT survived but the in-memory identity key did
            // not. Stay `.locked` and unlock lazily (Face ID / password) the
            // first time an E2EE-activated Home is opened (see RoomManager).
            self.unlockPhase = .locked
        }
    }

    var isAuthenticated: Bool {
        if case .authenticated = phase { return true }
        return false
    }

    var isIdentityUnlocked: Bool { unlockPhase == .unlocked }

    // MARK: - Login / migration

    /// Handle a successful register/login. Persists the token, then sets up the
    /// E2EE identity: unlock the returned vault, or run first-login key
    /// generation when the account has none yet.
    func handleAuthSuccess(_ response: AuthResponse, password: String) async {
        Keychain.set(response.token, for: .authToken)
        await api.setToken(response.token)
        currentUser = response.user
        phase = .authenticated(response.user)
        await setUpIdentity(password: password, keyVault: response.keyVault)
    }

    /// Unlock (existing vault) or migrate (no vault yet). The just-typed password
    /// is available here and nowhere else — the only moment first-login keygen
    /// can wrap the private key.
    private func setUpIdentity(password: String, keyVault: EncryptedKeyVault?) async {
        unlockPhase = .unlocking
        do {
            if let keyVault {
                _ = try await vault.unlock(password: password, vault: keyVault)
            } else {
                // First-login migration: generate + wrap, persist BEFORE caching
                // so a failed upload never leaves an unregistered keypair around.
                let (newVault, _) = try await vault.createVault(password: password)
                do {
                    try await api.setMyKeys(newVault)
                } catch {
                    await vault.wipe()   // discard the unregistered keypair
                    throw error
                }
            }
            if let payload = await vault.biometricPayload() {
                Keychain.cacheIdentityKey(payload)
            }
            unlockPhase = .unlocked
        } catch {
            // The JWT is valid, so stay authenticated; E2EE Homes will show a
            // locked/awaiting state until the identity is unlocked.
            unlockPhase = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }

    // MARK: - Cold-launch re-unlock (biometric → password)

    /// Ensure the E2EE identity key is in memory before an E2EE room connect.
    /// Tries the biometric-cached key first; otherwise raises the password
    /// re-unlock sheet and returns false (the caller shows a locked state and
    /// reconnects when `unlockPhase` becomes `.unlocked`).
    @discardableResult
    func ensureIdentityUnlocked() async -> Bool {
        if await vault.isUnlocked { unlockPhase = .unlocked; return true }

        if Keychain.hasIdentityKey() {
            unlockPhase = .unlocking
            if let payload = await Keychain.loadIdentityKey(reason: "Unlock your Foresight camera keys"),
               payload.count == 64 {
                await vault.load(publicKey: Data(payload.prefix(32)),
                                 privateKey: Data(payload.suffix(32)))
                unlockPhase = .unlocked
                return true
            }
        }
        // No cached identity, or Face ID was cancelled/failed → password path.
        unlockPhase = .locked
        isPresentingPasswordUnlock = true
        return false
    }

    /// Complete a password re-unlock. Fetches the vault (may be web-created —
    /// same libsodium params → opens here) and unlocks it. Returns false on a
    /// bad password so the sheet can show an error and let the user retry.
    @discardableResult
    func completePasswordUnlock(_ password: String) async -> Bool {
        unlockPhase = .unlocking
        do {
            let resp = try await api.getMyKeys()
            if let vaultBlob = resp.keyVault {
                _ = try await vault.unlock(password: password, vault: vaultBlob)
            } else {
                // No server-side vault yet (unmigrated account) → create one.
                let (newVault, _) = try await vault.createVault(password: password)
                try await api.setMyKeys(newVault)
            }
            if let payload = await vault.biometricPayload() {
                Keychain.cacheIdentityKey(payload)
            }
            unlockPhase = .unlocked
            isPresentingPasswordUnlock = false
            return true
        } catch {
            unlockPhase = .locked
            return false
        }
    }

    func cancelPasswordUnlock() {
        isPresentingPasswordUnlock = false
        unlockPhase = .locked
    }

    // MARK: - Teardown

    func signOut() async {
        Keychain.remove(.authToken)
        Keychain.removeIdentityKey()
        await api.setToken(nil)
        await vault.wipe()
        currentUser = nil
        phase = .unauthenticated
        unlockPhase = .locked
        isPresentingPasswordUnlock = false
    }

    /// Called when an authed request returns 401-style failure; forces re-login.
    func sessionExpired() async {
        await signOut()
    }
}
