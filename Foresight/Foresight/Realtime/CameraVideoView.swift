//
//  CameraVideoView.swift
//  Foresight
//
//  Wraps LiveKit's VideoView with a graceful placeholder for when a camera has
//  no track yet (offline, paused, or still subscribing).
//

import SwiftUI
import LiveKit

struct CameraVideoView: View {
    @ObservedObject var camera: LiveCamera
    var layoutMode: VideoView.LayoutMode = .fill
    /// Why the whole Home can't deliver video right now (locked, not connected…).
    /// Takes precedence over the camera's own state, so a tile never claims to be
    /// "Connecting…" when it's actually waiting on something else.
    var roomIssue: String?
    var backdrop: Color = .black
    /// Tighter placeholder for small grid tiles.
    var isCompact: Bool = false

    var body: some View {
        ZStack {
            backdrop
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

    @ViewBuilder
    private var placeholder: some View {
        VStack(spacing: isCompact ? 4 : 8) {
            if let roomIssue {
                Image(systemName: "video.badge.ellipsis")
                    .font(isCompact ? .body : .title3)
                    .foregroundStyle(.white.opacity(0.5))
                Text(roomIssue)
                    .foregroundStyle(.white.opacity(0.7))
            } else if camera.isOnline {
                ProgressView()
                    .tint(.white.opacity(0.7))
                Text("Connecting…")
                    .foregroundStyle(.white.opacity(0.7))
            } else {
                Image(systemName: "video.slash.fill")
                    .font(isCompact ? .body : .title3)
                    .foregroundStyle(.white.opacity(0.5))
                Text("Offline")
                    .fontWeight(.medium)
                    .foregroundStyle(.white.opacity(0.8))
                if !isCompact, let lastSeen = ForesightDate.parse(camera.info.status.lastSeen) {
                    Text("Last seen \(lastSeen.formatted(.relative(presentation: .named)))")
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.6))
                }
            }
        }
        .font(.caption)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 8)
    }
}

/// A LiveKit `VideoView` bridged into SwiftUI that pins the adaptive-stream pixel
/// density to 1× (point size).
///
/// LiveKit's default density follows the screen scale (2–3× on retina), so on a
/// full-screen view the requested layer (~1290×2796 px) exceeds the 1080p simulcast
/// layer and adaptive stream upgrades to the 4K layer, decoding 3840×2160 into a
/// phone-sized view and spiking memory until iOS jettisons the app. At 1×,
/// full-screen settles on the 1080p layer and grid tiles on the low layer. The
/// "Max" preset is unaffected: a 4K-capable camera publishes a single 4K layer, the
/// one deliberate 4K path.
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
