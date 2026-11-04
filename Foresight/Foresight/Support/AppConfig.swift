//
//  AppConfig.swift
//  Foresight
//
//  Configurable runtime settings. The API base URL is user-editable (Settings
//  screen) and persisted in UserDefaults. Default targets the dev backend on
//  localhost:3199, which is reachable from the iOS Simulator.
//

import Foundation
import Combine

@MainActor
final class AppConfig: ObservableObject {
    static let shared = AppConfig()

    /// Default dev backend. Reachable from the Simulator as-is; on a physical
    /// device change this to the host's LAN IP (e.g. http://192.168.1.20:3199).
    nonisolated static let defaultBaseURL = "http://localhost:3199"

    private enum Keys {
        static let baseURL = "foresight.apiBaseURL"
    }

    @Published var apiBaseURLString: String {
        didSet { UserDefaults.standard.set(apiBaseURLString, forKey: Keys.baseURL) }
    }

    private init() {
        let stored = UserDefaults.standard.string(forKey: Keys.baseURL)
        apiBaseURLString = (stored?.isEmpty == false ? stored! : Self.defaultBaseURL)
    }

    /// Validated base URL, falling back to the default if the stored string is
    /// malformed. Trailing slashes are trimmed so path joining is predictable.
    var apiBaseURL: URL { Self.resolveBaseURL() }

    /// Resolves the current base URL straight from `UserDefaults`, free of any
    /// actor isolation. Used by the `APIClient`'s `@Sendable` provider so it can
    /// pick up user edits (which are persisted to the same key) from any thread.
    nonisolated static func resolveBaseURL() -> URL {
        let stored = UserDefaults.standard.string(forKey: Keys.baseURL)
        let raw = (stored?.isEmpty == false ? stored! : defaultBaseURL)
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        return URL(string: normalized) ?? URL(string: defaultBaseURL)!
    }

    func resetBaseURL() {
        apiBaseURLString = Self.defaultBaseURL
    }
}
