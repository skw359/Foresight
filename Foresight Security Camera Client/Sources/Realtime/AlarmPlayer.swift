//
//  AlarmPlayer.swift
//  Foresight Camera Client
//
//  Best-effort emergency-alarm sound for the `alarm` command: loops a built-in
//  system alert tone until stopped; no bundled asset.
//

import AudioToolbox
import Foundation

@MainActor
final class AlarmPlayer {
    static let shared = AlarmPlayer()
    private init() {}

    private var isPlaying = false
    private var timer: Timer?

    // 1005 is a built-in alert tone.
    private let systemSoundID: SystemSoundID = 1005

    func play() {
        guard !isPlaying else { return }
        isPlaying = true
        fire()
        let timer = Timer(timeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.fire() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        isPlaying = false
        timer?.invalidate()
        timer = nil
    }

    private func fire() {
        guard isPlaying else { return }
        AudioServicesPlayAlertSound(systemSoundID)
    }
}
