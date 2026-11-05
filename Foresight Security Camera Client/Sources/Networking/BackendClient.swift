//
//  BackendClient.swift
//  Foresight Camera Client
//
//  Thin REST client for the camera's endpoints. All DTOs come from the locked
//  ForesightProtocol contract.
//

import Foundation

enum BackendError: LocalizedError {
    case badURL(String)
    case transport(Error)
    case http(status: Int, message: String?)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .badURL(let s): return "Invalid server URL: \(s)"
        case .transport(let e): return "Network error: \(e.localizedDescription)"
        case .http(let status, let message):
            if let message { return "Server error (\(status)): \(message)" }
            return "Server error (HTTP \(status))"
        case .decoding(let e): return "Unexpected response from server: \(e.localizedDescription)"
        }
    }
}

// Isolated to the main actor because its only callers (PairingViewModel,
// RealtimeSession) are @MainActor. Keeping the client on the same actor avoids
// sending non-Sendable contract DTOs (e.g. CameraCapabilities) across an
// isolation boundary, while the actual network I/O still suspends off-thread
// inside `URLSession.data(for:)`.
@MainActor
struct BackendClient {
    /// e.g. "http://192.168.1.10:3199".
    let serverUrl: String
    var session: URLSession = .shared

    // MARK: Endpoints

    /// POST /pair/claim — exchange a pairing token + detected capabilities for a
    /// registered camera + its long-lived deviceSecret. `cameraPublicKey` is the
    /// camera's E2EE X25519 public key (base64).
    func claimPairing(token: String,
                      name: String,
                      capabilities: CameraCapabilities,
                      cameraPublicKey: String) async throws -> ClaimPairingResponse {
        let body = ClaimPairingRequest(token: token, name: name,
                                       capabilities: capabilities,
                                       cameraPublicKey: cameraPublicKey)
        return try await post(path: "/pair/claim", body: body)
    }

    /// POST /rt/token — mint a LiveKit publisher token for this camera. The
    /// response carries keyEpoch + the caller's sealedHomeKey (E2EE join path).
    func realtimeToken(homeId: String, deviceSecret: String) async throws -> RtTokenResponse {
        let body = RtTokenRequest(homeId: homeId, role: .camera, deviceSecret: deviceSecret)
        return try await post(path: "/rt/token", body: body)
    }

    /// POST /cameras/:id/pubkey — existing-camera migration. A camera
    /// paired before E2EE registers its freshly-generated public key here,
    /// authenticated by its deviceSecret (same auth as the status sink). Success
    /// is any 2xx; a 409 means a DIFFERENT key is already registered (fatal — the
    /// caller must not loop).
    func registerCameraPublicKey(cameraId: String,
                                 deviceSecret: String,
                                 publicKey: String) async throws {
        let body = CameraKeyRegistration(deviceSecret: deviceSecret, publicKey: publicKey)
        try await postExpectingNoContent(path: "/cameras/\(cameraId)/pubkey", body: body)
    }

    /// POST /cameras/:id/unpair — the camera removes ITSELF from its Home,
    /// authenticated by its own device secret (so "Unpair" really removes it
    /// server-side instead of leaving a permanently offline camera behind).
    /// 2xx = removed; 404 = already gone (both are success for the caller).
    func unpairCamera(cameraId: String, deviceSecret: String) async throws {
        struct Body: Encodable { let deviceSecret: String }
        do {
            try await postExpectingNoContent(path: "/cameras/\(cameraId)/unpair", body: Body(deviceSecret: deviceSecret))
        } catch BackendError.http(let status, _) where status == 404 {
            return
        }
    }

    // MARK: Plumbing

    private func post<Body: Encodable, Response: Decodable>(
        path: String, body: Body
    ) async throws -> Response {
        guard let url = URL(string: serverUrl.trimmingTrailingSlash() + path) else {
            throw BackendError.badURL(serverUrl)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw BackendError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw BackendError.http(status: -1, message: "No HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw BackendError.http(status: http.statusCode, message: Self.apiErrorMessage(from: data))
        }

        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw BackendError.decoding(error)
        }
    }

    /// Throws `BackendError.http(status:…)` on any non-2xx, so callers can
    /// pattern-match a specific status (e.g. 409 in the pubkey migration).
    private func postExpectingNoContent<Body: Encodable>(path: String, body: Body) async throws {
        guard let url = URL(string: serverUrl.trimmingTrailingSlash() + path) else {
            throw BackendError.badURL(serverUrl)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw BackendError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw BackendError.http(status: -1, message: "No HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw BackendError.http(status: http.statusCode, message: Self.apiErrorMessage(from: data))
        }
    }

    /// Best-effort extraction of the contract's `ApiError { error, message }`.
    private static func apiErrorMessage(from data: Data) -> String? {
        struct ApiError: Decodable { let error: String?; let message: String? }
        guard let parsed = try? JSONDecoder().decode(ApiError.self, from: data) else {
            return String(data: data, encoding: .utf8)
        }
        return parsed.message ?? parsed.error
    }
}

private extension String {
    func trimmingTrailingSlash() -> String {
        hasSuffix("/") ? String(dropLast()) : self
    }
}
