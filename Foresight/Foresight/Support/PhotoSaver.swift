//
//  PhotoSaver.swift
//  Foresight
//
//  Saves snapshots (UIImage) and recordings (file URL) to the Photos library,
//  requesting add-only authorization as needed.
//

import Foundation
import Photos
import UIKit

enum PhotoSaver {
    enum SaveError: LocalizedError {
        case denied
        case failed(String)
        var errorDescription: String? {
            switch self {
            case .denied: return "Photos access was denied. Enable it in Settings."
            case .failed(let m): return m
            }
        }
    }

    static func save(image: UIImage) async throws {
        try await ensureAuthorized()
        try await perform { PHAssetChangeRequest.creationRequestForAsset(from: image) }
    }

    static func saveVideo(at url: URL) async throws {
        try await ensureAuthorized()
        try await perform { PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url) }
    }

    private static func ensureAuthorized() async throws {
        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        switch status {
        case .authorized, .limited:
            return
        case .notDetermined:
            let granted = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
            guard granted == .authorized || granted == .limited else { throw SaveError.denied }
        default:
            throw SaveError.denied
        }
    }

    private static func perform(_ changeBlock: @escaping () -> Void) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges(changeBlock) { success, error in
                if success {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: SaveError.failed(error?.localizedDescription ?? "Could not save to Photos."))
                }
            }
        }
    }
}
