//
//  ForesightCameraApp.swift
//  Foresight Camera Client
//
//  App entry point. Configures the LiveKit audio session early so PTT playback
//  and mic capture share one correctly-categorized session.
//

import LiveKit
import SwiftUI
import UIKit

@main
struct ForesightCameraApp: App {
    @StateObject private var model = AppModel()

    init() {
        // Simultaneous record + playback over the loudspeaker, so mic capture and
        // viewer PTT audio coexist.
        AudioManager.shared.isSpeakerOutputPreferred = true

        // LiveKit's camera capturer derives the published frame rotation from the
        // physical device orientation and stamps it onto the stream (the web +
        // iOS viewers then rotate to match). But `UIDevice.current.orientation`
        // reports `.unknown` until *someone* turns on its accelerometer-backed
        // notifications — and nothing in this app did. With orientation unknown,
        // the capturer fell back to portrait, so a horizontally-mounted phone
        // streamed sideways (rotated 90°) to every viewer.
        //
        // Enabling it before any capture starts means the orientation is already
        // resolved when the capturer reads it. We never call `endGenerating…`: a
        // security camera wants orientation tracked for its whole lifetime.
        if !UIDevice.current.isGeneratingDeviceOrientationNotifications {
            UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        }

        // Fail loudly at startup (DEBUG) if libsodium's sealed-box round-trip or
        // the locked byte sizes drift — a silent mismatch would otherwise surface
        // only as black video in the field.
        #if DEBUG
        CameraKeyManager.assertConstants()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)   // burn-in-safe, dark everywhere
        }
    }
}
