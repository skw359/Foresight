//
//  CameraCapabilityDetector.swift
//  Foresight Camera Client
//
//  Detects this iPhone's back-camera capabilities and maps them onto the
//  contract's `CameraCapabilities`:
//    - lenses:        optical factors derived from the discovered device types
//                     (ultra-wide → 0.5, wide → 1, tele → 2/3/5 as available)
//    - torch:         whether any usable back camera has a torch
//    - maxResolution: from the highest-resolution active-format candidate
//    - supportsAudio: always true (every iPhone has a mic)
//    - maxDigitalZoom: from videoMaxZoomFactor, capped at ~6
//
//  The same `LensOption` table is reused at runtime to resolve `switchLens`
//  commands back to a concrete AVCaptureDevice.
//

import AVFoundation
import Foundation

/// A selectable optical lens: the contract factor + the device that provides it.
struct LensOption: Equatable {
    let factor: Double                 // 0.5, 1, 2, 3, 5 ...
    let deviceType: AVCaptureDevice.DeviceType
    let device: AVCaptureDevice

    static func == (lhs: LensOption, rhs: LensOption) -> Bool {
        lhs.factor == rhs.factor && lhs.device.uniqueID == rhs.device.uniqueID
    }
}

enum CameraCapabilityDetector {
    /// Digital-zoom cap so the slider stays in a sane, sharp range.
    static let maxDigitalZoomCap: Double = 6.0

    /// Device types we care about on the back, in ascending field-of-view order.
    private static let backDeviceTypes: [AVCaptureDevice.DeviceType] = [
        .builtInUltraWideCamera,
        .builtInWideAngleCamera,
        .builtInTelephotoCamera,
    ]

    /// Discover the available back-camera lenses, de-duplicated by factor.
    static func availableLenses() -> [LensOption] {
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: backDeviceTypes,
            mediaType: .video,
            position: .back
        )

        var byFactor: [Double: LensOption] = [:]
        for device in session.devices {
            let factor = opticalFactor(for: device)
            // Keep the first device discovered for each factor.
            if byFactor[factor] == nil {
                byFactor[factor] = LensOption(factor: factor, deviceType: device.deviceType, device: device)
            }
        }
        return byFactor.values.sorted { $0.factor < $1.factor }
    }

    /// Build the full capabilities payload reported at pairing.
    static func detectCapabilities() -> CameraCapabilities {
        let lenses = availableLenses()

        // Reference device for resolution / zoom / torch: prefer wide (1x),
        // else the first available lens, else any default video device.
        let reference = lenses.first(where: { $0.factor == 1 })?.device
            ?? lenses.first?.device
            ?? AVCaptureDevice.default(for: .video)

        let factors = lenses.map(\.factor)
        let torch = lenses.contains { $0.device.hasTorch } || (reference?.hasTorch ?? false)

        let maxResolution = highestResolution(across: lenses, fallback: reference)

        let maxZoomRaw = reference?.activeFormat.videoMaxZoomFactor ?? 1.0
        let maxDigitalZoom = min(max(1.0, Double(maxZoomRaw)), maxDigitalZoomCap)

        return CameraCapabilities(
            lenses: factors.isEmpty ? [1.0] : factors,
            maxDigitalZoom: maxDigitalZoom,
            torch: torch,
            maxResolution: maxResolution,
            supportsAudio: true
        )
    }

    // MARK: Mapping helpers

    /// Map a device to its conventional optical factor.
    static func opticalFactor(for device: AVCaptureDevice) -> Double {
        switch device.deviceType {
        case .builtInUltraWideCamera:
            return 0.5
        case .builtInWideAngleCamera:
            return 1.0
        case .builtInTelephotoCamera:
            // Telephoto factor varies by model (2x / 3x / 5x). Derive it from the
            // device's minimum zoom relative to the wide camera when possible;
            // otherwise read the secondary switch-over factor.
            return telephotoFactor(for: device)
        default:
            return 1.0
        }
    }

    /// Best-effort telephoto factor. iPhones expose the optical zoom of a tele
    /// lens via `secondaryNativeResolutionZoomFactors` on virtual devices, but a
    /// standalone tele device reports its own native scale. We approximate by
    /// rounding the device's minimum useful zoom; common values are 2, 3, 5.
    private static func telephotoFactor(for device: AVCaptureDevice) -> Double {
        // On most iPhones the tele lens, considered on its own, has a min zoom of
        // 1.0 but represents a 2x/3x/5x crop of the scene. There's no fully
        // public way to read the exact multiplier from the standalone device, so
        // map by focal-length heuristics where available, else default to 2.
        let factors = device.virtualDeviceSwitchOverVideoZoomFactors.map { Double(truncating: $0) }
        if let maxSwitch = factors.max(), maxSwitch >= 2 {
            // Round to the nearest common tele factor.
            let candidates: [Double] = [2, 3, 5]
            return candidates.min(by: { abs($0 - maxSwitch) < abs($1 - maxSwitch) }) ?? 2
        }
        return 2
    }

    /// Highest still/active-format resolution across candidate devices.
    private static func highestResolution(
        across lenses: [LensOption],
        fallback: AVCaptureDevice?
    ) -> CameraCapabilities.Resolution {
        let devices: [AVCaptureDevice] = lenses.isEmpty
            ? [fallback].compactMap { $0 }
            : lenses.map(\.device)

        var best = CameraCapabilities.Resolution(width: 1920, height: 1080)
        var bestPixels = best.width * best.height

        for device in devices {
            for format in device.formats {
                // Only count true VIDEO formats. High-megapixel still/photo
                // formats also appear in `device.formats` and would otherwise
                // inflate maxResolution (e.g. 4032×3024), falsely implying 4K
                // video support. Require a frame-rate range reaching ≥ 30 fps so
                // maxResolution reflects what the device can actually capture as
                // 4K30 video — which is what gates the Pure 4K option.
                let supportsVideo30 = format.videoSupportedFrameRateRanges.contains {
                    $0.maxFrameRate >= 30
                }
                guard supportsVideo30 else { continue }

                let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
                let pixels = Int(dims.width) * Int(dims.height)
                if pixels > bestPixels {
                    bestPixels = pixels
                    best = CameraCapabilities.Resolution(width: Int(dims.width), height: Int(dims.height))
                }
            }
        }
        return best
    }
}
