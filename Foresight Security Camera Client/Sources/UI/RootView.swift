//
//  RootView.swift
//  Foresight Camera Client
//
//  Phase router: loading → pairing → camera.
//

import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch model.phase {
            case .loading:
                ProgressView()
                    .tint(.white)
            case .pairing:
                PairingView()
            case .camera:
                if let session = model.session {
                    CameraModeView(session: session, telemetry: model.telemetry)
                } else {
                    ProgressView().tint(.white)
                }
            }
        }
    }
}
