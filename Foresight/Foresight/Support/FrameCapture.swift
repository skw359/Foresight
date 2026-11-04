//
//  FrameCapture.swift
//  Foresight
//
//  Viewer-side snapshot + recording (per PROTOCOL §4: capture is viewer-side in
//  v1). Both attach a lightweight VideoRenderer to the incoming LiveKit track:
//   - FrameGrabber: captures one frame → UIImage.
//   - TrackRecorder: writes incoming frames to an .mp4 via AVAssetWriter.
//

import Foundation
import CoreImage
import CoreVideo
import CoreMedia
import AVFoundation
import UIKit
import LiveKit

// MARK: - Pixel buffer extraction

enum FrameImage {
    /// Convert a LiveKit VideoFrame to a CVPixelBuffer (handles CVPixel + I420).
    static func pixelBuffer(from frame: VideoFrame) -> CVPixelBuffer? {
        if let cv = frame.buffer as? CVPixelVideoBuffer {
            return cv.pixelBuffer
        }
        if let i420 = frame.buffer as? I420VideoBuffer {
            return i420.toPixelBuffer()
        }
        return nil
    }

    static func image(from pixelBuffer: CVPixelBuffer) -> UIImage? {
        let ci = CIImage(cvPixelBuffer: pixelBuffer)
        let context = CIContext(options: nil)
        guard let cg = context.createCGImage(ci, from: ci.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

// MARK: - Snapshot (single frame)

/// Attaches to a VideoTrack, captures the next frame, then detaches.
final class FrameGrabber: NSObject, VideoRenderer, @unchecked Sendable {
    private let onImage: @Sendable (UIImage?) -> Void
    private weak var track: VideoTrack?
    private var captured = false
    private let lock = NSLock()

    init(track: VideoTrack, completion: @escaping @Sendable (UIImage?) -> Void) {
        self.onImage = completion
        self.track = track
        super.init()
        track.add(videoRenderer: self)
        // Safety timeout: if no frame arrives, fail gracefully.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            self?.finish(nil)
        }
    }

    // VideoRenderer
    var isAdaptiveStreamEnabled: Bool { false }
    var adaptiveStreamSize: CGSize { .zero }
    func set(size: CGSize) {}

    func render(frame: VideoFrame) {
        lock.lock()
        if captured { lock.unlock(); return }
        captured = true
        lock.unlock()
        let image = FrameImage.pixelBuffer(from: frame).flatMap(FrameImage.image(from:))
        finish(image)
    }

    func render(frame: VideoFrame, captureDevice: AVCaptureDevice?, captureOptions: VideoCaptureOptions?) {
        render(frame: frame)
    }

    private func finish(_ image: UIImage?) {
        lock.lock()
        let alreadyDone = (track == nil)
        track?.remove(videoRenderer: self)
        let t = track
        track = nil
        lock.unlock()
        if alreadyDone && t == nil { return }
        onImage(image)
    }
}

// MARK: - Recording (track → mp4)

/// Records an incoming VideoTrack to an .mp4 using AVAssetWriter. Video-only in
/// v1 (matches the web dashboard's track capture).
final class TrackRecorder: NSObject, VideoRenderer, @unchecked Sendable {
    private weak var track: VideoTrack?
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var startTime: CMTime?
    private let outputURL: URL
    private let lock = NSLock()
    private var started = false
    private var finished = false

    private(set) var isRecording = false

    init(track: VideoTrack) {
        self.track = track
        let filename = "foresight-\(Int(Date().timeIntervalSince1970)).mp4"
        self.outputURL = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        super.init()
    }

    func start() {
        guard let track else { return }
        isRecording = true
        track.add(videoRenderer: self)
    }

    /// Stops recording and returns the file URL once finalized.
    func stop(completion: @escaping @Sendable (URL?) -> Void) {
        lock.lock()
        guard !finished else { lock.unlock(); completion(nil); return }
        finished = true
        isRecording = false
        track?.remove(videoRenderer: self)
        track = nil
        guard let writer, let input, started else {
            lock.unlock()
            completion(nil)
            return
        }
        lock.unlock()
        input.markAsFinished()
        let url = outputURL
        // Safe to send: `finished` (set under the lock above) guarantees nothing
        // else touches the writer, and the completion runs only after writing ends.
        nonisolated(unsafe) let finishedWriter = writer
        finishedWriter.finishWriting {
            completion(finishedWriter.status == .completed ? url : nil)
        }
    }

    // VideoRenderer
    var isAdaptiveStreamEnabled: Bool { false }
    var adaptiveStreamSize: CGSize { .zero }
    func set(size: CGSize) {}

    func render(frame: VideoFrame) {
        guard isRecording, let pixelBuffer = FrameImage.pixelBuffer(from: frame) else { return }
        lock.lock()
        if !started {
            setupWriter(width: Int(frame.dimensions.width), height: Int(frame.dimensions.height))
            started = true
        }
        guard let writer, let input, let adaptor, writer.status == .writing else { lock.unlock(); return }

        let nowNs = frame.timeStampNs
        let pts: CMTime
        if let start = startTime {
            let elapsed = Double(nowNs) / 1_000_000_000.0 - Double(start.value) / Double(start.timescale)
            pts = CMTime(seconds: max(0, elapsed), preferredTimescale: 600)
        } else {
            startTime = CMTime(value: nowNs, timescale: 1_000_000_000)
            pts = .zero
        }

        if input.isReadyForMoreMediaData {
            adaptor.append(pixelBuffer, withPresentationTime: pts)
        }
        lock.unlock()
    }

    func render(frame: VideoFrame, captureDevice: AVCaptureDevice?, captureOptions: VideoCaptureOptions?) {
        render(frame: frame)
    }

    private func setupWriter(width: Int, height: Int) {
        guard width > 0, height > 0,
              let writer = try? AVAssetWriter(outputURL: outputURL, fileType: .mp4) else { return }
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        let sourceAttrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
        ]
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: sourceAttrs)
        guard writer.canAdd(input) else { return }
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        self.writer = writer
        self.input = input
        self.adaptor = adaptor
    }
}
