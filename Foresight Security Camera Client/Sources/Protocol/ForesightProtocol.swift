//
//  ForesightProtocol.swift
//  Foresight Security — shared protocol mirror.
//
//  Hand-kept in sync with shared/ts (rest.ts + realtime.ts + e2ee.ts). JSON
//  keys MUST match the TypeScript contract exactly.
//
//  THIS FILE IS CANONICAL. Both Swift apps carry a byte-identical copy
//  (Foresight Security Camera Client/Sources/Protocol/ForesightProtocol.swift
//  and Foresight/Foresight/Models/ForesightProtocol.swift — their Xcode
//  projects reference those paths). Edit here, then run
//  `node shared/scripts/sync-swift-protocol.mjs`; the server test suite fails
//  if any copy drifts.
//

import Foundation

public enum Foresight {
    /// Matches PROTOCOL_VERSION in shared/ts/src/realtime.ts.
    public static let protocolVersion = 1

    // MARK: Identity & room helpers (mirror realtime.ts)
    public static func homeRoom(_ homeId: String) -> String { "home:\(homeId)" }
    public static func cameraIdentity(_ cameraId: String) -> String { "camera:\(cameraId)" }
    public static func viewerIdentity(_ userId: String, _ session: String) -> String { "user:\(userId):\(session)" }

    public struct ParsedIdentity { public let role: ParticipantRole; public let id: String }

    /// Mirrors parseIdentity in realtime.ts: `camera:<id>` and
    /// `user:<userId>:<session>` (the id is the userId, without the session).
    public static func parseIdentity(_ identity: String) -> ParsedIdentity? {
        let parts = identity.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2, !parts[1].isEmpty else { return nil }
        switch parts[0] {
        case "camera": return ParsedIdentity(role: .camera, id: parts[1])
        case "user": return ParsedIdentity(role: .viewer, id: parts[1])
        default: return nil
        }
    }

    /// Mirrors isAuthorizedSender in realtime.ts. `senderIdentity` is the
    /// LiveKit identity that published the packet, or nil for server-originated
    /// data. Every receiver applies this before acting on a message:
    ///   - state / telemetry: only the camera the payload is about;
    ///   - ack: only a camera (receivers also match the commanded camera);
    ///   - command: only a viewer — never another camera, never sender-less;
    ///   - rekey: a viewer (the rotating owner) or the server itself.
    public static func isAuthorizedSender(_ message: DataMessage, senderIdentity: String?) -> Bool {
        let sender = senderIdentity.flatMap(parseIdentity)
        switch message {
        case .state(let m):
            return sender?.role == .camera && sender?.id == m.cameraId
        case .telemetry(let m):
            return sender?.role == .camera && sender?.id == m.cameraId
        case .ack:
            return sender?.role == .camera
        case .command:
            return sender?.role == .viewer
        case .rekey:
            return senderIdentity == nil || sender?.role == .viewer
        }
    }
}

// MARK: - Enums

public enum MemberRole: String, Codable { case owner, member }
public enum ParticipantRole: String, Codable { case camera, viewer }

public enum QualityPreset: String, Codable {
    case auto
    case p480 = "480p"
    case p1080 = "1080p"
    /// True 4K, single-layer (non-simulcast) publish for solo/full-screen
    /// viewing on a 4K-capable camera. Falls back to `.p1080` if 4K fails to
    /// start, or if the camera has no 4K sensor.
    case max
    /// Legacy wire value for the same single-layer 4K as `.max`. Still accepted
    /// by cameras; the viewer UIs no longer send it.
    case pure4k = "pure4k"
}

public enum ThermalState: String, Codable { case nominal, fair, serious, critical }

public enum CommandAction: String, Codable {
    case torch, switchLens, setZoom, setQuality, snapshotHint
    case startRecord, stopRecord, talkStart, talkStop, alarm
}

// MARK: - Shared value types

public struct WifiInfo: Codable, Equatable {
    public var level: Int
    public var rssi: Int?
    public var ssid: String?
    public init(level: Int, rssi: Int? = nil, ssid: String? = nil) {
        self.level = level; self.rssi = rssi; self.ssid = ssid
    }
}

public struct CameraCapabilities: Codable, Equatable {
    public struct Resolution: Codable, Equatable {
        public var width: Int
        public var height: Int
        public init(width: Int, height: Int) { self.width = width; self.height = height }
    }
    public var lenses: [Double]
    public var maxDigitalZoom: Double
    public var torch: Bool
    public var maxResolution: Resolution
    public var supportsAudio: Bool
    public init(lenses: [Double], maxDigitalZoom: Double, torch: Bool,
                maxResolution: Resolution, supportsAudio: Bool) {
        self.lenses = lenses; self.maxDigitalZoom = maxDigitalZoom
        self.torch = torch; self.maxResolution = maxResolution
        self.supportsAudio = supportsAudio
    }
}

// MARK: - REST DTOs (mirror rest.ts)

public struct RegisterRequest: Codable { public var identifier: String; public var password: String; public var firstName: String?
    public init(identifier: String, password: String, firstName: String? = nil) { self.identifier = identifier; self.password = password; self.firstName = firstName } }

public struct LoginRequest: Codable { public var identifier: String; public var password: String
    public init(identifier: String, password: String) { self.identifier = identifier; self.password = password } }

public struct UserDTO: Codable, Identifiable, Equatable { public var id: String; public var identifier: String; public var firstName: String?; public var createdAt: String }

public struct AuthResponse: Codable {
    public var token: String
    public var user: UserDTO
    /// The user's encrypted E2EE key vault, or nil when the account has no
    /// keys yet (client then runs first-login key generation → POST /me/keys).
    public var keyVault: EncryptedKeyVault?
}

/// Body for PATCH /me — update the caller's own profile. Send "" or nil to clear.
public struct UpdateProfileRequest: Codable { public var firstName: String?
    public init(firstName: String?) { self.firstName = firstName } }

public struct CreateHomeRequest: Codable { public var name: String
    public init(name: String) { self.name = name } }

public struct HomeDTO: Codable, Identifiable, Equatable {
    public var id: String
    public var name: String
    public var role: MemberRole
    public var createdAt: String
    /// Current Home Media Key epoch; 0 (or nil from a pre-E2EE server) ⇒ E2EE
    /// not activated — the Home runs plaintext exactly as before. Server-side
    /// bookkeeping only, NEVER a LiveKit key index (locked to 0).
    public var keyEpoch: Int?
    /// True when the recorder holds a sealed HMK at the current epoch.
    /// nil from a pre-E2EE server ⇒ treat as false.
    public var recorderConsented: Bool?
}

public struct AddMemberRequest: Codable { public var identifier: String; public var role: MemberRole?
    public init(identifier: String, role: MemberRole? = nil) { self.identifier = identifier; self.role = role } }

/// A single member of a Home (GET /homes/:homeId/members).
public struct HomeMemberDTO: Codable, Identifiable, Equatable {
    public var userId: String
    public var identifier: String
    public var role: MemberRole
    /// base64 X25519 public key, or nil when the member has no key vault yet.
    public var publicKey: String?
    public var id: String { userId }
}

public struct CameraStatus: Codable, Equatable {
    public var battery: Double?
    public var charging: Bool?
    public var wifi: WifiInfo?
    public var thermal: ThermalState?
    public var lastSeen: String?
}

public struct CameraDTO: Codable, Identifiable, Equatable {
    public var id: String
    public var homeId: String
    public var name: String
    public var online: Bool
    public var status: CameraStatus
    public var capabilities: CameraCapabilities?
    public var createdAt: String
}

public struct RenameCameraRequest: Codable { public var name: String
    public init(name: String) { self.name = name } }

public struct PairingTicket: Codable {
    public var serverUrl: String
    public var livekitUrl: String
    public var token: String
    public var homeId: String
    public var expiresAt: String
}

public struct ClaimPairingRequest: Codable {
    public var token: String
    public var name: String
    public var capabilities: CameraCapabilities
    /// base64 X25519 public key generated on-device at pairing (E2EE identity).
    public var cameraPublicKey: String
    public init(token: String, name: String, capabilities: CameraCapabilities, cameraPublicKey: String) {
        self.token = token; self.name = name; self.capabilities = capabilities
        self.cameraPublicKey = cameraPublicKey
    }
}

public struct ClaimPairingResponse: Codable {
    public var camera: CameraDTO
    public var deviceSecret: String
    /// True when the Home has E2EE activated and the camera must wait for a
    /// member to seal the Home Media Key to it (arrives via
    /// RtTokenResponse.sealedHomeKey). nil from a pre-E2EE server ⇒ false.
    public var homeKeyPending: Bool?
}

public struct RtTokenRequest: Codable {
    public var homeId: String
    public var role: ParticipantRole
    public var deviceSecret: String?
    public init(homeId: String, role: ParticipantRole, deviceSecret: String? = nil) {
        self.homeId = homeId; self.role = role; self.deviceSecret = deviceSecret
    }
}

public struct RtTokenResponse: Codable {
    public var livekitUrl: String
    public var token: String
    public var room: String
    public var identity: String
    /// The Home's current key epoch. 0 / nil ⇒ E2EE not activated: connect and
    /// publish plaintext exactly as today. ≥ 1 ⇒ the room is E2EE; a nil
    /// sealedHomeKey then means "awaiting key" — NEVER publish plaintext into
    /// an activated Home.
    public var keyEpoch: Int?
    /// The caller's own sealed copy of the Home Media Key (rides the token for
    /// every role — zero extra round-trips on the join path).
    public var sealedHomeKey: SealedKey?
}

public struct ParticipantMetadata: Codable {
    public var role: ParticipantRole
    public var userId: String?
    public var cameraId: String?
    public var displayName: String?
    public init(role: ParticipantRole, userId: String? = nil, cameraId: String? = nil, displayName: String? = nil) {
        self.role = role; self.userId = userId; self.cameraId = cameraId; self.displayName = displayName
    }
}

// MARK: - Realtime data messages (mirror realtime.ts)

public struct CommandArgs: Codable {
    public var on: Bool?
    public var lens: Double?
    public var zoom: Double?
    public var quality: QualityPreset?
    public init(on: Bool? = nil, lens: Double? = nil, zoom: Double? = nil, quality: QualityPreset? = nil) {
        self.on = on; self.lens = lens; self.zoom = zoom; self.quality = quality
    }
}

public struct CommandMessage: Codable {
    public var v: Int = Foresight.protocolVersion
    public var type: String = "command"
    public var id: String
    public var target: String
    public var action: CommandAction
    public var args: CommandArgs?
    public init(id: String = UUID().uuidString, target: String, action: CommandAction, args: CommandArgs? = nil) {
        self.id = id; self.target = target; self.action = action; self.args = args
    }
}

public struct AckMessage: Codable {
    public var v: Int = Foresight.protocolVersion
    public var type: String = "ack"
    public var commandId: String
    public var ok: Bool
    public var error: String?
    public init(commandId: String, ok: Bool, error: String? = nil) {
        self.commandId = commandId; self.ok = ok; self.error = error
    }
}

public struct StateMessage: Codable {
    public var v: Int = Foresight.protocolVersion
    public var type: String = "state"
    public var cameraId: String
    public var torchOn: Bool
    public var lens: Double
    public var zoom: Double
    public var quality: QualityPreset
    public var recording: Bool
    public var talking: Bool
    public init(cameraId: String, torchOn: Bool, lens: Double, zoom: Double,
                quality: QualityPreset, recording: Bool, talking: Bool) {
        self.cameraId = cameraId; self.torchOn = torchOn; self.lens = lens; self.zoom = zoom
        self.quality = quality; self.recording = recording; self.talking = talking
    }
}

public struct TelemetryMessage: Codable {
    public var v: Int = Foresight.protocolVersion
    public var type: String = "telemetry"
    public var cameraId: String
    public var battery: Double?
    public var charging: Bool?
    public var wifi: WifiInfo?
    public var thermal: ThermalState?
    public var viewerCount: Int
    public init(cameraId: String, battery: Double?, charging: Bool?, wifi: WifiInfo?,
                thermal: ThermalState?, viewerCount: Int) {
        self.cameraId = cameraId; self.battery = battery; self.charging = charging
        self.wifi = wifi; self.thermal = thermal; self.viewerCount = viewerCount
    }
}

/// rotating-client → room (reliable, broadcast). The Home Media Key rotated to
/// `epoch`: re-fetch the sealed copy and re-apply `setKey(base64(HMK′))` —
/// still at LiveKit key index 0 (`epoch` is server bookkeeping, never a key
/// index). Clients that don't know this type ignore it (ForesightCodec.decode
/// returns nil) and recover on their next reconnect. `epoch` 0 (sent by the
/// server) means E2EE was turned off: if the server confirms it, a keyed client
/// reconnects plaintext.
public struct RekeyMessage: Codable {
    public var v: Int = Foresight.protocolVersion
    public var type: String = "rekey"
    /// The new Home.keyEpoch.
    public var epoch: Int
    public init(epoch: Int) { self.epoch = epoch }
}

/// Discriminated union over `type`, mirroring DataMessage in realtime.ts.
public enum DataMessage: Codable {
    case command(CommandMessage)
    case ack(AckMessage)
    case state(StateMessage)
    case telemetry(TelemetryMessage)
    case rekey(RekeyMessage)

    private enum TypeKey: String, CodingKey { case type }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: TypeKey.self)
        switch try c.decode(String.self, forKey: .type) {
        case "command": self = .command(try CommandMessage(from: decoder))
        case "ack": self = .ack(try AckMessage(from: decoder))
        case "state": self = .state(try StateMessage(from: decoder))
        case "telemetry": self = .telemetry(try TelemetryMessage(from: decoder))
        case "rekey": self = .rekey(try RekeyMessage(from: decoder))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c, debugDescription: "Unknown data message type: \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .command(let m): try m.encode(to: encoder)
        case .ack(let m): try m.encode(to: encoder)
        case .state(let m): try m.encode(to: encoder)
        case .telemetry(let m): try m.encode(to: encoder)
        case .rekey(let m): try m.encode(to: encoder)
        }
    }

    public var version: Int {
        switch self {
        case .command(let m): return m.v
        case .ack(let m): return m.v
        case .state(let m): return m.v
        case .telemetry(let m): return m.v
        case .rekey(let m): return m.v
        }
    }
}

/// JSON (de)serialization helpers for LiveKit data payloads.
public enum ForesightCodec {
    public static func encode(_ msg: DataMessage) -> Data? { try? JSONEncoder().encode(msg) }
    /// nil for malformed payloads, unknown types, and any other protocol version.
    public static func decode(_ data: Data) -> DataMessage? {
        guard let msg = try? JSONDecoder().decode(DataMessage.self, from: data),
              msg.version == Foresight.protocolVersion else { return nil }
        return msg
    }
}

// MARK: - E2EE (mirror e2ee.ts)
//
// THE LOCKED LIVEKIT KEY-APPLICATION CONTRACT (shared/E2EE.md §3.2).
// A divergence on ANY value below produces SILENT decryption failure (black
// video, no error). The HMK is applied as `setKey(base64(HMK))` — a base64
// STRING (LiveKit's PBKDF2 path), never raw bytes — and ALWAYS at key index 0
// (`keyEpoch`/`SealedKey.epoch` are server bookkeeping, never a key index).
// Swift SDKs do NOT hardcode ratchetWindowSize — set it explicitly from here.

public enum ForesightE2EE {
    /// AES key size in bits — 128 is the only value all LiveKit SDKs support.
    public static let keySize = 128
    /// Frame-encryption algorithm; must match the publisher (camera).
    public static let encryptionType = "gcm"
    /// LiveKit key-derivation ratchet salt (SDK default — keep on ALL platforms).
    public static let ratchetSalt = "LKFrameEncryptionKey"
    /// No automatic ratcheting in v1; rotation = re-seal a fresh HMK + re-setKey.
    public static let ratchetWindowSize = 0
    /// LOCKED to 0 in v1 — every platform, every rotation.
    public static let keyIndex = 0
    /// Reserved for the v2 seamless-rotation ring. NEVER fed to LiveKit in v1.
    public static let keyRingSize = 16
    /// PBKDF2 iterations LiveKit derives the AES key with (informational; self-tests only).
    public static let pbkdf2Iterations = 100_000

    /// Argon2id password→vault-key parameters (stored per-blob in KdfParams).
    public static let argon2idOpslimit = 3
    public static let argon2idMemlimit = 67_108_864

    /// libsodium byte sizes (startup self-test assertions).
    public static let x25519KeyBytes = 32
    public static let hmkBytes = 32
    public static let sealedHmkBytes = 80
    public static let wrappedPrivateKeyBytes = 48
    public static let secretboxNonceBytes = 24
    public static let kdfSaltBytes = 16
}

/// Who a sealed copy of a Home's Media Key belongs to.
public enum KeyHolderType: String, Codable { case user, camera, recorder }

/// Argon2id parameters stored alongside each wrapped vault (retunable without
/// bricking old vaults). `algo` is always "argon2id" (libsodium ALG_ARGON2ID13).
public struct KdfParams: Codable, Equatable {
    public var algo: String
    public var opslimit: Int
    public var memlimit: Int
    /// base64, ForesightE2EE.kdfSaltBytes bytes.
    public var saltB64: String
    public init(algo: String = "argon2id", opslimit: Int, memlimit: Int, saltB64: String) {
        self.algo = algo; self.opslimit = opslimit; self.memlimit = memlimit; self.saltB64 = saltB64
    }
}

/// A user's identity keypair at rest: X25519 public key in the clear, private
/// key wrapped under Argon2id(password) via crypto_secretbox_easy. The server
/// stores this blob verbatim and can never open it.
public struct EncryptedKeyVault: Codable, Equatable {
    /// base64 X25519 public key (32 B).
    public var publicKey: String
    /// base64 crypto_secretbox_easy(privateKey) — 48 B.
    public var wrappedPrivateKey: String
    /// base64 secretbox nonce (24 B).
    public var nonce: String
    public var kdf: KdfParams
    public init(publicKey: String, wrappedPrivateKey: String, nonce: String, kdf: KdfParams) {
        self.publicKey = publicKey; self.wrappedPrivateKey = wrappedPrivateKey
        self.nonce = nonce; self.kdf = kdf
    }
}

/// A sealed copy of a Home Media Key for one holder. `epoch` is Home.keyEpoch —
/// a server-side delivery/consistency counter, NEVER a LiveKit key index
/// (that is locked to ForesightE2EE.keyIndex = 0 in v1).
public struct SealedKey: Codable, Equatable {
    /// base64 crypto_box_seal(HMK → holder pubkey) — 80 B.
    public var ciphertext: String
    public var epoch: Int
    public init(ciphertext: String, epoch: Int) { self.ciphertext = ciphertext; self.epoch = epoch }
}

/// Response to GET /me/keys. keyVault nil ⇒ run first-login key generation.
public struct MeKeysResponse: Codable {
    public var keyVault: EncryptedKeyVault?
}

/// Response to GET /homes/:homeId/key — the caller's own sealed HMK copy at
/// the Home's current epoch. epoch 0 ⇒ E2EE not activated. sealedKey nil with
/// epoch ≥ 1 ⇒ activated but nobody sealed to the caller yet ("waiting for access").
public struct HomeKeyResponse: Codable {
    public var epoch: Int
    /// base64 sealed box (80 B) or nil.
    public var sealedKey: String?
}

/// One holder lacking a sealed HMK copy at the Home's current epoch
/// (GET /homes/:homeId/key/pending).
public struct PendingKeyHolder: Codable, Equatable {
    public var holderType: KeyHolderType
    public var holderId: String
    /// base64 X25519 public key to seal to.
    public var publicKey: String
    /// Human-readable label for grant UIs.
    public var label: String
    /// True when this holder never held a key for this Home at any epoch
    /// (first-contact grant — owner-only, §10.5). False for epoch backfill.
    public var firstContact: Bool
}

/// Response to GET /homes/:homeId/key/pending. At epoch 0 (not activated)
/// `pending` is the ACTIVATION candidate list — every member/camera with a
/// registered pubkey, all firstContact — consumed by the owner's activation
/// precheck and as the key/init seal targets.
public struct PendingKeyHoldersResponse: Codable {
    public var epoch: Int
    public var pending: [PendingKeyHolder]
}

/// One sealed HMK copy being uploaded for a holder.
public struct SealedKeyUpload: Codable {
    public var holderType: KeyHolderType
    public var holderId: String
    /// base64 crypto_box_seal(HMK → holder pubkey) — 80 B.
    public var sealedKey: String
    public init(holderType: KeyHolderType, holderId: String, sealedKey: String) {
        self.holderType = holderType; self.holderId = holderId; self.sealedKey = sealedKey
    }
}

/// Body of POST /homes/:homeId/key — sealed copies for pending holders at
/// `epoch` (must equal the Home's current epoch; idempotent per holder).
public struct SubmitSealedKeysRequest: Codable {
    public var epoch: Int
    public var keys: [SealedKeyUpload]
    public init(epoch: Int, keys: [SealedKeyUpload]) { self.epoch = epoch; self.keys = keys }
}

/// Body of POST /homes/:homeId/key/init — explicit owner activation (epoch 0→1).
public struct InitHomeKeyRequest: Codable {
    public var keys: [SealedKeyUpload]
    public init(keys: [SealedKeyUpload]) { self.keys = keys }
}

/// Body of POST /homes/:homeId/key/rotate. fromEpoch is an optimistic-
/// concurrency guard (409 when stale).
public struct RotateHomeKeyRequest: Codable {
    public var fromEpoch: Int
    public var keys: [SealedKeyUpload]
    public init(fromEpoch: Int, keys: [SealedKeyUpload]) { self.fromEpoch = fromEpoch; self.keys = keys }
}

/// Response to key/init and key/rotate.
public struct HomeKeyEpochResponse: Codable {
    public var keyEpoch: Int
}

/// Body of POST /homes/:homeId/recorder-consent (owner only). enable ⇒
/// sealedKey (HMK sealed to the recorder pubkey) required; disable ⇒ server
/// drops the recorder's keys + disarms recording, then the owner rotates.
public struct RecorderConsentRequest: Codable {
    public var enabled: Bool
    /// base64 sealed box — required when enabled.
    public var sealedKey: String?
    public init(enabled: Bool, sealedKey: String? = nil) { self.enabled = enabled; self.sealedKey = sealedKey }
}

/// Response to the recorder-consent toggle.
public struct RecorderConsentResponse: Codable {
    public var recorderConsented: Bool
    public var keyEpoch: Int
}

/// Response to GET /e2ee/recorder-identity. publicKey nil ⇒ no recorder registered.
public struct RecorderIdentityResponse: Codable {
    /// base64 X25519 public key of the global recorder, or nil.
    public var publicKey: String?
}

/// Body of POST /cameras/:cameraId/pubkey — existing-camera migration
/// (deviceSecret-authed, same as the camera status sink). A camera paired
/// before E2EE registers its keypair here on first post-update boot.
public struct CameraKeyRegistration: Codable {
    public var deviceSecret: String
    /// base64 X25519 public key (32 B).
    public var publicKey: String
    public init(deviceSecret: String, publicKey: String) {
        self.deviceSecret = deviceSecret; self.publicKey = publicKey
    }
}
