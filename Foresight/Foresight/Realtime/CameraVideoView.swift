//
//  CameraVideoView.swift
//  Foresight
//
//  Wraps LiveKit's VideoView with a graceful placeholder for when a camera has
//  no track yet (offline, paused, or still subscribing).
//
//  The video is rendered through `AdaptiveVideoView` rather than the stock
//  `SwiftUIVideoView` so we can cap the adaptive-stream pixel density — the lever
//  that keeps a 4K source from being decoded at full resolution into a
//  phone-sized view (see `AdaptiveVideoView`).
//

import SwiftUI
import LiveKit

struct CameraVideoView: View {
    @ObservedObject var camera: LiveCamera
    var layoutMode: VideoView.LayoutMode = .fill

    var body: some View {
        ZStack {
            Color.black
            if let track = camera.videoTrack {
                AdaptiveVideoView(track: track, layoutMode: layoutMode)
                if camera.e2eeDecrypting {
                    decryptingOverlay
                }
            } else {
                placeholder
            }
        }
    }

    /// Shown over a live track while LiveKit can't decrypt it yet (missing or
    /// rotating E2EE key). Better than a frozen black frame (plan §10.3).
    private var decryptingOverlay: some View {
        ZStack {
            Color.black.opacity(0.55)
            VStack(spacing: 8) {
                ProgressView().tint(.white)
                Text("Decrypting…")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.85))
            }
        }
    }

    private var placeholder: some View {
        VStack(spacing: 10) {
            Image(systemName: camera.isOnline ? "video.fill" : "video.slash.fill")
                .font(.system(size: 26))
                .foregroundStyle(.white.opacity(0.5))
            Text(camera.isOnline ? "Connecting…" : "Offline")
                .font(.caption)
                .foregroundStyle(.white.opacity(0.6))
        }
    }
}

/// A LiveKit `VideoView` bridged into SwiftUI that pins the adaptive-stream pixel
/// density to 1× (point size).
///
/// LiveKit's default density follows the screen scale (2–3× on retina). With
/// adaptive stream on, a `VideoView` asks the server for a layer sized for
/// `points × density`; on a full-screen retina view that target (~1290×2796 px)
/// is taller than the 1080p simulcast layer, so adaptive stream *upgrades* the
/// subscription to the 4K layer and the phone decodes a 3840×2160 stream into a
/// phone-sized view. That 4K decode/render is what spikes memory until iOS
/// jettisons the app.
///
/// Capping density at 1× makes the view request only what it can actually show:
/// full-screen settles on the 1080p layer and grid tiles settle on the low
/// layer. The "Max" preset is unaffected — on a 4K-capable camera it publishes a
/// single 4K layer with no smaller alternative, so it remains the one deliberate
/// 4K path.
private struct AdaptiveVideoView: UIViewRepresentable {
    let track: VideoTrack
    let layoutMode: VideoView.LayoutMode

    func makeUIView(context: Context) -> VideoView {
        let view = VideoView()
        view.layoutMode = layoutMode
        view.mirrorMode = .off
        view.adaptiveStreamPixelDensity = .fixed(1.0)
        view.track = track
        return view
    }

    func updateUIView(_ view: VideoView, context: Context) {
        view.layoutMode = layoutMode
        view.adaptiveStreamPixelDensity = .fixed(1.0)
        view.track = track
    }

    static func dismantleUIView(_ view: VideoView, coordinator: ()) {
        // Detach the renderer so the decoder/Metal resources are released and the
        // subscription can be paused once the tile/full-screen goes away.
        view.track = nil
    }
}
