//
//  E2EEParityTests.swift
//  ForesightTests
//
//  M0 cross-platform E2EE parity gate (shared/E2EE.md §11). Proves that
//  swift-sodium on iOS derives the SAME vault key, opens the SAME private key,
//  and unseals the SAME Home Media Key as the web (libsodium-wrappers-sumo) and
//  recorder (sodium-native) builds — and that the HMK is applied to LiveKit as
//  the exact base64 STRING at key index 0 (plan §3.2).
//
//  The frozen values below are hand-copied from:
//      shared/test-vectors/e2ee-parity.json
//  Keep them in sync if that file is regenerated. IdentityVault performs these
//  exact same libsodium calls; this test locks the primitives + parameters.
//
//  Runs on a Mac only (`xcodebuild test`). A Mac must also re-run `xcodegen`.
//

import XCTest
import Sodium

final class E2EEParityTests: XCTestCase {

    // MARK: - Frozen vector (shared/test-vectors/e2ee-parity.json)

    private let password = "correct horse battery staple — foresight M0"
    private let kdfOpslimit = 3
    private let kdfMemlimit = 67_108_864
    private let saltB64  = "wfkgIOHuV4vUeKvR9g4Pqw=="
    private let vaultKeyB64 = "S2JpU9Z88Dh0G7UxArcyHg5L+0ijpF+rc+MDRO+kTuY="
    private let seedB64 = "iESHuCb2y9JdZHe4KIHhg7noTjLsrMhJEIfriK+a1qg="
    private let publicKeyB64  = "BnTzuuX2LXGptq6HuBIDNiGi+gUroXCOiXeSwLd8yAg="
    private let privateKeyB64 = "HxiL9OB2G3kVAJb4rbKwM2+e1OcJ4tZTzF7KzoaMoA0="
    private let nonceB64 = "kSGjM3kcsDev6pYpvPB1DxGW/AYFyhXR"
    private let wrappedPrivateKeyB64 = "TZTA2fVfqzJHLns1ME/tepnhW91CcDuvcejWdHyzp01Lx+1V+e+4hZWSCRaVXeZg"
    private let hmkB64 = "pD+rpYrZqguuD2s4wCCNQt8EdvRqByCLa0jwD+/bbqE="
    private let livekitSetKeyString = "pD+rpYrZqguuD2s4wCCNQt8EdvRqByCLa0jwD+/bbqE="
    private let sealedHmkB64 = "WxXa71hPfQcjlJejQgHgfxJPnXKRr2crNAOg9gKXyjxQUDk5biabNjSwZEt3FSTAepLKDHa/TVG8A7ZFhuuu4r9vVPZD9hXlHYDogbvB/zA="

    private let sodium = Sodium()

    private func bytes(_ b64: String) throws -> [UInt8] {
        [UInt8](try XCTUnwrap(Data(base64Encoded: b64), "invalid base64: \(b64)"))
    }

    // MARK: - Argon2id vault key

    func testArgon2idVaultKey() throws {
        let key = sodium.pwHash.hash(outputLength: sodium.secretBox.KeyBytes,
                                     passwd: [UInt8](Data(password.utf8)),
                                     salt: try bytes(saltB64),
                                     opsLimit: kdfOpslimit,
                                     memLimit: kdfMemlimit,
                                     alg: .Argon2ID13)
        XCTAssertEqual(Data(try XCTUnwrap(key)).base64EncodedString(), vaultKeyB64)
    }

    // MARK: - Deterministic keypair from the seed (sanity for the vector)

    func testKeypairFromSeed() throws {
        let kp = try XCTUnwrap(sodium.box.keyPair(seed: try bytes(seedB64)))
        XCTAssertEqual(Data(kp.publicKey).base64EncodedString(), publicKeyB64)
        XCTAssertEqual(Data(kp.secretKey).base64EncodedString(), privateKeyB64)
    }

    // MARK: - crypto_secretbox_open → private key

    func testSecretboxOpenPrivateKey() throws {
        let opened = sodium.secretBox.open(authenticatedCipherText: try bytes(wrappedPrivateKeyB64),
                                           secretKey: try bytes(vaultKeyB64),
                                           nonce: try bytes(nonceB64))
        XCTAssertEqual(Data(try XCTUnwrap(opened)).base64EncodedString(), privateKeyB64)
    }

    // MARK: - crypto_box_seal_open → Home Media Key

    func testSealedBoxOpenHMK() throws {
        let hmk = sodium.box.open(anonymousCipherText: try bytes(sealedHmkB64),
                                  recipientPublicKey: try bytes(publicKeyB64),
                                  recipientSecretKey: try bytes(privateKeyB64))
        XCTAssertEqual(Data(try XCTUnwrap(hmk)).base64EncodedString(), hmkB64)
    }

    // MARK: - LiveKit setKey string == base64(HMK) (the locked application form)

    func testLiveKitSetKeyStringIsBase64HMK() throws {
        let hmk = try XCTUnwrap(sodium.box.open(anonymousCipherText: try bytes(sealedHmkB64),
                                                recipientPublicKey: try bytes(publicKeyB64),
                                                recipientSecretKey: try bytes(privateKeyB64)))
        // This exact STRING is what RoomManager hands to keyProvider.setKey — a
        // base64 string (LiveKit PBKDF2 path), never the raw 32 bytes (plan §3.2).
        XCTAssertEqual(Data(hmk).base64EncodedString(), livekitSetKeyString)
    }
}
