//
//  CameraTile.swift
//  Foresight
//
//  A single camera tile in the Home grid. Shows live video (LOW layer), the
//  camera name + online dot, a health badge strip, and a recording indicator.
//  Subscribes to the LOW simulcast layer while visible and pauses when gone.
//

import SwiftUI
import LiveKit

struct CameraTile: View {
    @ObservedObject var camera: LiveCamera
    let room: RoomManager

    var body: some View {
        ZStack(alignment: .top) {
            CameraVideoView(camera: camera)
                .aspectRatio(16.0 / 9.0, contentMode: .fill)
                .clipped()

            topOverlay
            bottomOverlay
        }
        .background(Color.black)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.08)))
        .task {
            // Grid tiles use the LOW layer to keep bandwidth down (PROTOCOL §5).
            await room.subscribeVideo(camera, quality: .low)
        }
        .onDisappear {
            Task { await room.pauseVideo(camera) }
        }
    }

    @ViewBuilder
    private var topOverlay: some View {
        VStack {
            HStack {
                if camera.recording {
                    RecordingDot()
                }
                Spacer(minLength: 0)
                OnlineDot(online: camera.isOnline)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
    }

    private var bottomOverlay: some View {
        VStack {
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 6) {
                Text(camera.name)
                    .font(.montserrat(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .shadow(radius: 2)
                HealthStrip(camera: camera)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                LinearGradient(
                    colors: [.black.opacity(0.0), .black.opacity(0.6)],
                    startPoint: .top, endPoint: .bottom
                )
            )
        }
    }
}

/// Pulsing red dot shown while a camera is recording.
struct RecordingDot: View {
    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(Color.red)
                .frame(width: 8, height: 8)
            Text("REC")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(.black.opacity(0.45), in: Capsule())
        .accessibilityLabel("Recording")
    }
}
