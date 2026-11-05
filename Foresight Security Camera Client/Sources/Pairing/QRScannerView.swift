//
//  QRScannerView.swift
//  Foresight Camera Client
//
//  SwiftUI wrapper around an AVCaptureSession that scans QR codes and emits the
//  decoded string via `onCode`.
//

import AVFoundation
import SwiftUI

struct QRScannerView: UIViewControllerRepresentable {
    /// Called once with the first decoded QR payload. The parent decides whether
    /// to keep scanning (we stop the session after the first hit).
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let vc = QRScannerViewController()
        vc.onCode = onCode
        return vc
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?

    // nonisolated(unsafe): startRunning/stopRunning are hopped off the main
    // actor onto `sessionQueue` (they block), and AVCaptureSession is
    // documented thread-safe for them. Configuration happens once on the main
    // thread (viewDidLoad) before the first start, so no access races it.
    private nonisolated(unsafe) let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let sessionQueue = DispatchQueue(label: "com.foresight.qr.session")
    private var hasReported = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureSession()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        startRunning()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [weak self] in
            if self?.session.isRunning == true { self?.session.stopRunning() }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.layer.bounds
    }

    private func configureSession() {
        session.beginConfiguration()

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else {
            session.commitConfiguration()
            return
        }
        session.addInput(input)

        let metadataOutput = AVCaptureMetadataOutput()
        if session.canAddOutput(metadataOutput) {
            session.addOutput(metadataOutput)
            metadataOutput.setMetadataObjectsDelegate(self, queue: .main)
            metadataOutput.metadataObjectTypes = [.qr]
        }
        session.commitConfiguration()

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.layer.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview
    }

    private func startRunning() {
        hasReported = false
        sessionQueue.async { [weak self] in
            guard let self, !self.session.isRunning else { return }
            self.session.startRunning()
        }
    }

    // The delegate callback is delivered on the main queue (set via
    // `setMetadataObjectsDelegate(_:queue: .main)`), but the protocol itself is
    // not main-actor annotated, so the method must be `nonisolated`. We decode
    // the (non-Sendable) metadata objects here, then re-enter main-actor
    // isolation with only the extracted `String` to touch UI/state — which is
    // safe because the callback already runs on the main queue.
    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput,
                                    didOutput metadataObjects: [AVMetadataObject],
                                    from connection: AVCaptureConnection) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let value = object.stringValue
        else { return }

        MainActor.assumeIsolated {
            guard !hasReported else { return }
            hasReported = true
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            sessionQueue.async { [weak self] in
                self?.session.stopRunning()
            }
            onCode?(value)
        }
    }
}
