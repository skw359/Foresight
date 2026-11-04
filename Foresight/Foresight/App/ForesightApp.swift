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
                .tint(.accentColor)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var session: Session

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            if session.isAuthenticated {
                HomesListView()
                    .transition(.opacity)
            } else {
                AuthView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.5), value: session.isAuthenticated)
        .preferredColorScheme(.dark)
        // Cold-launch E2EE re-unlock, raised from anywhere the identity key is
        // needed but absent and Face ID was unavailable/declined (plan §7.4).
        .sheet(isPresented: $session.isPresentingPasswordUnlock) {
            UnlockView()
        }
    }
}
