//
//  CameraTile.swift
//  Foresight
//
//  A camera on the wall: live video and a name, with anything else shown only when
//  it needs attention. Tiles are content-layer, so they use a scrim rather than
//  glass. Subscribes to the LOW simulcast layer while visible and pauses when gone.
//

import SwiftUI
import LiveKit

struct CameraTile: View {
    enum Style { case large, compact }

    @ObservedObject var camera: LiveCamera
    let room: RoomManager
    var style: Style = .large
    /// Set when the whole room can't deliver video; shown instead of "Connecting…".
    var roomIssue: String?

    private var shape: RoundedRectangle {
        RoundedRectangle(
            cornerRadius: style == .large ? Theme.Radius.tile : Theme.Radius.compactTile,
            style: .continuous
        )
    }

    var body: some View {
        Color.clear
            .aspectRatio(16.0 / 9.0, contentMode: .fit)
            .overlay {
                CameraVideoView(
                    camera: camera,
                    roomIssue: roomIssue,
                    backdrop: Theme.placeholder,
                    isCompact: style == .compact
                )
            }
            .overlay(alignment: .bottom) { caption }
            .overlay(alignment: .topLeading) {
                if camera.recording {
                    RecordingBadge()
                        .padding(style == .large ? 12 : 8)
                }
            }
            .clipShape(shape)
            .overlay { shape.strokeBorder(Theme.hairline, lineWidth: 0.5) }
            .contentShape(shape)
            .dynamicTypeSize(...(style == .large ? DynamicTypeSize.accessibility2 : DynamicTypeSize.xxxLarge))
            .task {
                // Grid tiles use the LOW layer to keep bandwidth down (PROTOCOL §5).
                await room.subscribeVideo(camera, quality: .low)
            }
            .onDisappear {
                Task { await room.pauseVideo(camera) }
            }
    }

    private var caption: some View {
        HStack(spacing: style == .large ? 8 : 6) {
            StatusDot(isOnline: camera.isOnline)
            Text(camera.name)
                .font(style == .large ? .subheadline.weight(.semibold) : .caption.weight(.semibold))
                .lineLimit(1)
                // Footage can be bright right behind the name.
                .shadow(color: .black.opacity(0.55), radius: 2, y: 1)
            Spacer(minLength: 6)
            CameraAlertChips(alerts: camera.alerts)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, style == .large ? 14 : 10)
        .padding(.top, style == .large ? 28 : 20)
        .padding(.bottom, style == .large ? 12 : 8)
        .background(alignment: .bottom) {
            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0), location: 0),
                    .init(color: .black.opacity(0.4), location: 0.45),
                    .init(color: .black.opacity(0.78), location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
    }
}

/// Long-press preview of a camera: live video with its full health readout, so the
/// numbers the wall leaves out are one gesture away.
struct CameraPeek: View {
    @ObservedObject var camera: LiveCamera

    var body: some View {
        VStack(spacing: 0) {
            CameraVideoView(camera: camera, backdrop: Theme.placeholder)
                .aspectRatio(16.0 / 9.0, contentMode: .fit)

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    StatusDot(isOnline: camera.isOnline)
                    Text(camera.name)
                        .font(.headline)
                        .lineLimit(1)
                }
                HealthStrip(camera: camera)
                    .font(.footnote.weight(.medium))
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(width: 340)
        .background(Theme.surface)
    }
}

/// Gently scales a camera tile down while pressed for tactile feedback.
struct TilePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.975 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

struct TileSkeleton: View {
    var style: CameraTile.Style = .large

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        RoundedRectangle(
            cornerRadius: style == .large ? Theme.Radius.tile : Theme.Radius.compactTile,
            style: .continuous
        )
        .fill(Theme.placeholder)
        .aspectRatio(16.0 / 9.0, contentMode: .fit)
        .phaseAnimator(reduceMotion ? [1.0] : [1.0, 0.55]) { view, opacity in
            view.opacity(opacity)
        } animation: { _ in
            .easeInOut(duration: 0.9)
        }
        .accessibilityHidden(true)
    }
}
