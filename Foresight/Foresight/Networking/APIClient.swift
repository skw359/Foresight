//
//  APIClient.swift
//  Foresight
//
//  Typed REST client for the Foresight backend. Every method maps 1:1 to an
//  endpoint in shared/PROTOCOL.md. The JWT (when present) is attached as
//  `Authorization: Bearer <token>` automatically.
//

import Foundation

/// Error returned by the backend `{ error, message }`, plus transport errors.
struct APIError: LocalizedError, Decodable {
    var error: String
    var message: String

    var errorDescription: String? { message.isEmpty ? error : message }

    static func transport(_ message: String) -> APIError {
        APIError(error: "transport", message: message)
    }
}

/// Thread-safe holder for the bearer token. The client reads it on each request.
actor TokenStore {
    private var token: String?

    init(token: String?) { self.token = token }

    func current() -> String? { token }
    func update(_ newToken: String?) { token = newToken }
}

final class APIClient: @unchecked Sendable {
    private let session: URLSession
    private let baseURLProvider: @Sendable () -> URL
    private let tokenStore: TokenStore

    /// - Parameters:
    ///   - baseURLProvider: returns the (possibly user-changed) base URL per call.
    ///   - token: initial bearer token (e.g. restored from Keychain).
    init(baseURLProvider: @escaping @Sendable () -> URL, token: String? = nil) {
        self.baseURLProvider = baseURLProvider
        self.tokenStore = TokenStore(token: token)
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        self.session = URLSession(configuration: config)
    }

    func setToken(_ token: String?) async {
        await tokenStore.update(token)
    }

    // MARK: - Auth

    func register(identifier: String, password: String) async throws -> AuthResponse {
        try await post("/auth/register", body: RegisterRequest(identifier: identifier, password: password), authed: false)
    }

    func login(identifier: String, password: String) async throws -> AuthResponse {
        try await post("/auth/login", body: LoginRequest(identifier: identifier, password: password), authed: false)
    }

    // MARK: - Homes

    func listHomes() async throws -> [HomeDTO] {
        try await get("/homes")
    }

    func createHome(name: String) async throws -> HomeDTO {
        try await post("/homes", body: CreateHomeRequest(name: name))
    }

    func addMember(homeId: String, identifier: String, role: MemberRole? = nil) async throws -> HomeDTO {
        try await post("/homes/\(homeId)/members", body: AddMemberRequest(identifier: identifier, role: role))
    }

    // MARK: - Cameras

    func listCameras(homeId: String) async throws -> [CameraDTO] {
        try await get("/homes/\(homeId)/cameras")
    }

    func pairCamera(homeId: String) async throws -> PairingTicket {
        try await post("/homes/\(homeId)/cameras/pair", body: EmptyBody())
    }

    func renameCamera(cameraId: String, name: String) async throws -> CameraDTO {
        try await patch("/cameras/\(cameraId)", body: RenameCameraRequest(name: name))
    }

    func removeCamera(cameraId: String) async throws {
        try await deleteNoContent("/cameras/\(cameraId)")
    }

    // MARK: - Realtime token

    func rtToken(homeId: String, role: ParticipantRole = .viewer) async throws -> RtTokenResponse {
        try await post("/rt/token", body: RtTokenRequest(homeId: homeId, role: role))
    }

    // MARK: - E2EE key vault / Home keys (plan §5, §7.4)

    /// The caller's encrypted key vault (nil ⇒ run first-login key generation).
    /// Used on cold-launch password re-unlock (AuthResponse.keyVault carries it
    /// on the login path; this fetches it when only the JWT survives).
    func getMyKeys() async throws -> MeKeysResponse {
        try await get("/me/keys")
    }

    /// Upload a freshly-generated key vault (first-login migration). The server
    /// stores the opaque blob; the response body (if any) is ignored.
    func setMyKeys(_ vault: EncryptedKeyVault) async throws {
        _ = try await sendRaw("/me/keys", method: "POST", body: vault, authed: true)
    }

    /// The caller's own sealed HMK copy at the Home's current epoch. Used to
    /// re-fetch after a `.rekey` data message (rotation). epoch 0 ⇒ not
    /// activated; sealedKey nil with epoch ≥ 1 ⇒ "waiting for access".
    func homeKey(homeId: String) async throws -> HomeKeyResponse {
        try await get("/homes/\(homeId)/key")
    }

    // MARK: - Verbs

    private func get<R: Decodable>(_ path: String, authed: Bool = true) async throws -> R {
        try await send(path, method: "GET", body: Optional<EmptyBody>.none, authed: authed)
    }

    private func post<B: Encodable, R: Decodable>(_ path: String, body: B, authed: Bool = true) async throws -> R {
        try await send(path, method: "POST", body: body, authed: authed)
    }

    private func patch<B: Encodable, R: Decodable>(_ path: String, body: B, authed: Bool = true) async throws -> R {
        try await send(path, method: "PATCH", body: body, authed: authed)
    }

    private func deleteNoContent(_ path: String, authed: Bool = true) async throws {
        _ = try await sendRaw(path, method: "DELETE", body: Optional<EmptyBody>.none, authed: authed)
    }

    // MARK: - Core

    private func send<B: Encodable, R: Decodable>(_ path: String, method: String, body: B?, authed: Bool) async throws -> R {
        let data = try await sendRaw(path, method: method, body: body, authed: authed)
        if R.self == EmptyResponse.self {
            return EmptyResponse() as! R
        }
        do {
            return try Self.decoder.decode(R.self, from: data)
        } catch {
            throw APIError.transport("Could not parse server response: \(error.localizedDescription)")
        }
    }

    private func sendRaw<B: Encodable>(_ path: String, method: String, body: B?, authed: Bool) async throws -> Data {
        let url = baseURLProvider().appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if authed, let token = await tokenStore.current() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let body, !(body is EmptyBody) {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try Self.encoder.encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("Invalid response from server.")
        }

        guard (200..<300).contains(http.statusCode) else {
            if let apiError = try? Self.decoder.decode(APIError.self, from: data) {
                throw apiError
            }
            throw APIError(error: "http_\(http.statusCode)", message: "Request failed (HTTP \(http.statusCode)).")
        }

        return data
    }

    // MARK: - Coders

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        return e
    }()

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()
}

/// Sentinel for endpoints that take no JSON body.
struct EmptyBody: Codable {}
/// Sentinel for endpoints with no JSON response (e.g. 204).
struct EmptyResponse: Codable {}
