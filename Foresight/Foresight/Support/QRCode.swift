//
//  QRCode.swift
//  Foresight
//
//  Generates a QR image from a string payload (the PairingTicket JSON). The
//  viewer displays it; a Camera Client scans it to pair — mirrors the web flow.
//

import Foundation
import CoreImage.CIFilterBuiltins
import UIKit

enum QRCode {
    static func image(from string: String, scale: CGFloat = 12) -> UIImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let transformed = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = context.createCGImage(transformed, from: transformed.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

extension PairingTicket {
    /// Canonical QR payload: the ticket encoded as JSON (same shape the camera
    /// expects to decode). Keys match the contract exactly.
    func qrPayload() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(self),
              let json = String(data: data, encoding: .utf8) else { return "" }
        return json
    }
}
