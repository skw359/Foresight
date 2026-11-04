//
//  ForesightApp.swift
//  Foresight — iOS Viewing App for Foresight Security.
//
//  Entry point. Owns the app-wide Session and routes between the auth flow and
//  the authenticated Homes experience.
//

import SwiftUI

@main
struct ForesightApp: App {
    @StateObject private var session = Session.shared
    @StateObject private var config = AppConfig.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(config)
                .tint(Theme.accent)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var session: Session

    var body: some View {
        ZStack {
            Theme.canvas.ignoresSafeArea()

            if session.isAuthenticated {
                HomeRootView()
                    .transition(.opacity)
            } else {
                AuthView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.5), value: session.isAuthenticated)
        // Permanently dark, as the HIG suggests for immersive media apps: the UI
        // recedes around the footage, and it's easy on the eyes when checking a
        // camera at night.
        .preferredColorScheme(.dark)
        // Cold-launch E2EE re-unlock, raised from anywhere the identity key is
        // needed but absent and Face ID was unavailable/declined (plan §7.4).
        .sheet(isPresented: $session.isPresentingPasswordUnlock) {
            UnlockView()
        }
    }
}
