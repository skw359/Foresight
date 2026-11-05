//
//  CameraController.swift
//  Foresight Camera Client
//
//  Owns the local capture pipeline (camera + microphone tracks) and the hardware
//  controls (torch, digital zoom, lens switch), reached through the track's
//  CameraCapturer.device.
//
//  `480p`/`auto`/`1080p` publish a simulcast ladder; `max` publishes a single
//  true-4K layer on devices whose sensor supports it. The capturer is reused
//  across lens switches so the published track SID is stable for viewers.
//

import AVFoundation
import Foundation
import LiveKit

/// Quality-preset → capture dimensions + publish layers. Adaptive presets use a
/// simulcast ladder; `max` publishes a single non-simulcast 4K layer.
private struct QualityProfile {
    let captureDimensions: Dimensions
    /// The simulcast ladder (low → high). For a non-simulcast profile (`max` on
    /// a 4K-capable device) this holds the single encoding layer to publish.
    let simulcastLayers: [VideoParameters]
    let simulcast: Bool

    init(captureDimensions: Dimensions, simulcastLayers: [VideoParameters], simulcast: Bool = true) {
        self.captureDimensions = captureDimensions
        self.simulcastLayers = simulcastLayers
        self.simulcast = simulcast
    }

    static func profile(for preset: QualityPreset, maxResolution: CameraCapabilities.Resolution) -> QualityProfile {
        // Layer building blocks (16:9). Custom-built because the SDK presets are internal.
        let low = VideoParameters(dimensions: Dimensions(width: 480, height: 270),
                                  encoding: VideoEncoding(maxBitrate: 300_000, maxFps: 20))
        let med = VideoParameters(dimensions: Dimensions(width: 960, height: 540),
                                  encoding: VideoEncoding(maxBitrate: 1_000_000, maxFps: 30))
        let high = VideoParameters(dimensions: Dimensions(width: 1920, height: 1080),
                                   encoding: VideoEncoding(maxBitrate: 3_000_000, maxFps: 30))

        // Same resolution as `high`, more bits.
        let highMax = VideoParameters(dimensions: Dimensions(width: 1920, height: 1080),
                                      encoding: VideoEncoding(maxBitrate: 6_000_000, maxFps: 30))
        // Published by both `1080p` and the non-4K fallback for `max`.
        let ladder1080 = QualityProfile(captureDimensions: Dimensions(width: 1920, height: 1080),
                                        simulcastLayers: [low, med, highMax])

        switch preset {
        case .p480:
            return QualityProfile(captureDimensions: Dimensions(width: 854, height: 480),
                                  simulcastLayers: [low])
        case .p1080:
            // WebRTC simulcast caps at 3 layers and the top layer is always the
            // capture resolution, so the extra bits go to the top layer.
            return ladder1080
        case .max, .pure4k:
            // True 4K as a SINGLE non-simulcast layer (solo/full-screen mode).
            // `pure4k` is the legacy wire value for the same thing, kept so older
            // viewers keep working.
            //
            // Devices whose capability detection can't confirm 4K30 video get
            // the 1080p ladder instead of a 4K publish that would only fail;
            // RealtimeSession also falls back to `.p1080` if 4K fails to start.
            guard supports4K(maxResolution) else { return ladder1080 }
            let ultra = VideoParameters(dimensions: Dimensions(width: 3840, height: 2160),
                                        encoding: VideoEncoding(maxBitrate: 8_000_000, maxFps: 30))
            return QualityProfile(captureDimensions: Dimensions(width: 3840, height: 2160),
                                  simulcastLayers: [ultra],
                                  simulcast: false)
        case .auto:
            // Adaptive: publish a full ladder and let dynacast/adaptiveStream pick.
            return QualityProfile(captureDimensions: Dimensions(width: 1920, height: 1080),
                                  simulcastLayers: [low, med, high])
        }
    }

    /// Whether the sensor this device reports can capture true 4K video. Mirrors
    /// the check the viewer UIs use to decide whether "Max" means 4K.
    static func supports4K(_ maxResolution: CameraCapabilities.Resolution) -> Bool {
        maxResolution.width >= 3840 || maxResolution.height >= 2160
    }
}

@MainActor
final class CameraController {
    /// The published video track (preview renders this so it matches the wire).
    private(set) var videoTrack: LocalVideoTrack?
    private(set) var audioTrack: LocalAudioTrack?

    private let lenses: [LensOption]
    private let capabilities: CameraCapabilities

    private(set) var activeLens: Double
    private(set) var activeZoom: Double = 1.0
    private(set) var torchOn: Bool = false

    init(capabilities: CameraCapabilities) {
        self.capabilities = capabilities
        self.lenses = CameraCapabilityDetector.availableLenses()
        // Default to the back wide (1x) camera; else first available.
        self.activeLens = lenses.contains(where: { $0.factor == 1 }) ? 1.0 : (lenses.first?.factor ?? 1.0)
    }

    private var activeCaptureDevice: AVCaptureDevice? {
        (videoTrack?.capturer as? CameraCapturer)?.device
    }

    // MARK: Track lifecycle

    /// Tracks are created but not yet published; the RealtimeSession publishes them.
    func makeTracks(quality: QualityPreset) -> (video: LocalVideoTrack, audio: LocalAudioTrack) {
        let captureOptions = cameraCaptureOptions(forFactor: activeLens, quality: quality)
        let video = LocalVideoTrack.createCameraTrack(options: captureOptions)
        let audio = LocalAudioTrack.createTrack()
        self.videoTrack = video
        self.audioTrack = audio
        return (video, audio)
    }

    /// Whether the given preset publishes a single non-simulcast layer (true 4K)
    /// on THIS device. Drives the republish path in RealtimeSession: crossing
    /// this boundary is the only quality change that alters publish *structure*.
    func publishesSingleLayer(for quality: QualityPreset) -> Bool {
        !QualityProfile.profile(for: quality, maxResolution: capabilities.maxResolution).simulcast
    }

    /// Build a FRESH camera video track and adopt it as the active track. Used
    /// only when the publish *structure* has to change — entering or leaving
    /// single-layer 4K ("Max") — because re-publishing an already-unpublished `LocalVideoTrack` instance
    /// does not reliably re-propagate to subscribers. Within the simulcast family
    /// we never rebuild: `applyQuality` reconfigures the live capturer instead, so
    /// the published track SID stays stable and viewers never lose their feed.
    ///
    /// The old track is stopped first so we don't briefly hold two capture
    /// sessions on the same physical camera.
    func rebuildVideoTrack(quality: QualityPreset) async -> LocalVideoTrack {
        if let old = videoTrack { try? await old.stop() }
        let captureOptions = cameraCaptureOptions(forFactor: activeLens, quality: quality)
        let video = LocalVideoTrack.createCameraTrack(options: captureOptions)
        self.videoTrack = video
        return video
    }

    func publishOptions(for quality: QualityPreset) -> VideoPublishOptions {
        let profile = QualityProfile.profile(for: quality, maxResolution: capabilities.maxResolution)
        guard profile.simulcast else {
            // Preserve resolution over framerate; image quality is the point of 4K.
            return VideoPublishOptions(
                encoding: profile.simulcastLayers.last?.encoding,
                simulcast: false,
                simulcastLayers: [],
                degradationPreference: .maintainResolution
            )
        }
        return VideoPublishOptions(
            encoding: profile.simulcastLayers.last?.encoding,
            simulcast: true,
            simulcastLayers: profile.simulcastLayers,
            degradationPreference: .maintainFramerate
        )
    }

    private func cameraCaptureOptions(forFactor factor: Double, quality: QualityPreset) -> CameraCaptureOptions {
        let profile = QualityProfile.profile(for: quality, maxResolution: capabilities.maxResolution)
        let lens = lenses.first(where: { $0.factor == factor })
        return CameraCaptureOptions(
            deviceType: lens?.deviceType,
            device: lens?.device,
            position: .back,
            dimensions: profile.captureDimensions,
            fps: 30
        )
    }

    // MARK: Controls

    @discardableResult
    func setTorch(on: Bool) -> Bool {
        guard capabilities.torch, let device = activeCaptureDevice, device.hasTorch else { return false }
        do {
            try device.lockForConfiguration()
            defer { device.unlockForConfiguration() }
            if on {
                if device.isTorchModeSupported(.on) {
                    try device.setTorchModeOn(level: 1.0)
                    device.torchMode = .on
                }
            } else {
                device.torchMode = .off
            }
            torchOn = on
            return true
        } catch {
            return false
        }
    }

    /// Set digital zoom (clamped to [1, capabilities.maxDigitalZoom] and device cap).
    @discardableResult
    func setZoom(_ zoom: Double) -> Bool {
        guard let device = activeCaptureDevice else { return false }
        let hardwareMax = Double(device.activeFormat.videoMaxZoomFactor)
        let ceiling = min(capabilities.maxDigitalZoom, hardwareMax)
        let clamped = min(max(1.0, zoom), max(1.0, ceiling))
        do {
            try device.lockForConfiguration()
            defer { device.unlockForConfiguration() }
            device.videoZoomFactor = CGFloat(clamped)
            activeZoom = clamped
            return true
        } catch {
            return false
        }
    }

    /// Switch to a different optical lens by reconfiguring the live capturer.
    /// Resets digital zoom to 1.0 (a fresh optical baseline). Torch is reapplied.
    @discardableResult
    func switchLens(toFactor factor: Double, quality: QualityPreset) async -> Bool {
        guard lenses.contains(where: { $0.factor == factor }),
              let capturer = videoTrack?.capturer as? CameraCapturer
        else { return false }

        let wasTorchOn = torchOn
        let newOptions = cameraCaptureOptions(forFactor: factor, quality: quality)
        do {
            _ = try await capturer.set(options: newOptions)
            activeLens = factor
            activeZoom = 1.0
            // Torch state is tied to the device; reapply after the switch.
            if wasTorchOn { _ = setTorch(on: true) }
            return true
        } catch {
            return false
        }
    }

    /// Publish-layer changes are applied by republishing in RealtimeSession.
    @discardableResult
    func applyQuality(_ quality: QualityPreset) async -> Bool {
        guard let capturer = videoTrack?.capturer as? CameraCapturer else { return false }
        let options = cameraCaptureOptions(forFactor: activeLens, quality: quality)
        do {
            _ = try await capturer.set(options: options)
            // Re-apply zoom (capture reconfig can reset it) and torch.
            _ = setZoom(activeZoom)
            if torchOn { _ = setTorch(on: true) }
            return true
        } catch {
            return false
        }
    }
}
