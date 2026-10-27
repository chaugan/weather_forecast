import GlettKit
import MapKit
import Synchronization
import UIKit

/// The wind's colours by speed (js/windmap.js `STOPS`): pale cyan through blue and indigo to magenta, away from the
/// temperature map's yellow and orange; calm air nearly see-through so the map still reads.
enum WindColors {
    private static let stops: [(Double, (Double, Double, Double), Double)] = [
        (0, (205, 236, 245), 0.10), (2, (168, 222, 240), 0.28), (5, (96, 182, 230), 0.42), (8, (52, 140, 214), 0.52),
        (11, (40, 100, 196), 0.58), (14, (58, 70, 178), 0.62), (17, (88, 50, 164), 0.65), (21, (122, 40, 150), 0.68),
        (25, (160, 36, 134), 0.7), (30, (196, 30, 108), 0.72), (36, (222, 28, 76), 0.74),
    ]

    /// 0.1 m/s steps up to 40 m/s: r, g, b, a (0-255), alpha premultiplied for a bitmap.
    static let lut: [UInt8] = {
        var out = [UInt8](repeating: 0, count: 401 * 4)
        for k in 0...400 {
            let s = Double(k) / 10
            var i = 0
            while i < stops.count - 2 && s > stops[i + 1].0 { i += 1 }
            let (s0, c0, a0) = stops[i], (s1, c1, a1) = stops[i + 1]
            let f = max(0, min(1, (s - s0) / (s1 - s0)))
            let a = a0 + (a1 - a0) * f
            let rgb = [c0.0 + (c1.0 - c0.0) * f, c0.1 + (c1.1 - c0.1) * f, c0.2 + (c1.2 - c0.2) * f]
            for j in 0..<3 { out[k * 4 + j] = UInt8((rgb[j] * a).rounded()) }
            out[k * 4 + 3] = UInt8((255 * a).rounded())
        }
        return out
    }()

    /// The colour of a speed, opaque (the legend).
    static func color(_ ms: Double) -> UIColor {
        let k = min(400, Int((ms * 10).rounded())) * 4, a = max(1, Double(lut[k + 3]))
        return UIColor(red: Double(lut[k]) / a, green: Double(lut[k + 1]) / a, blue: Double(lut[k + 2]) / a, alpha: 1)
    }
}

/// The wind's colour field on the map: one overlay over the whole world, drawn by `WindRenderer` under the place's marker.
final class WindLayer: NSObject, MKOverlay {
    let coordinate = CLLocationCoordinate2D(latitude: 0, longitude: 0)
    let boundingMapRect = MKMapRect.world
}

/// Draws the speed at every few points from the hour shown (or on the way to the next one), blurred a little as the
/// web's canvas scales its quarter-size field. `@unchecked Sendable`: MapKit draws off the main thread; the frames are
/// behind a `Mutex`.
final class WindRenderer: MKOverlayRenderer, @unchecked Sendable {
    private struct Show { var a: WindFrame?; var b: WindFrame?; var tau: Double }
    private let show = Mutex(Show(a: nil, b: nil, tau: 0))

    /// The field's cell, in points.
    static let cell = 4.0

    func display(_ a: WindFrame?, _ b: WindFrame?, tau: Double) {
        show.withLock { $0 = Show(a: a, b: b, tau: tau) }
        setNeedsDisplay()
    }

    override func draw(_ mapRect: MKMapRect, zoomScale: MKZoomScale, in context: CGContext) {
        let s = show.withLock { $0 }
        guard s.a != nil else { return }
        let step = Self.cell / Double(zoomScale)   // map points per cell
        let gw = max(1, Int((mapRect.width / step).rounded(.up))), gh = max(1, Int((mapRect.height / step).rounded(.up)))
        var px = [UInt8](repeating: 0, count: gw * gh * 4)
        let lut = WindColors.lut
        for y in 0..<gh {
            for x in 0..<gw {
                let c = MKMapPoint(x: mapRect.minX + (Double(x) + 0.5) * step, y: mapRect.minY + (Double(y) + 0.5) * step).coordinate
                guard let uv = WindController.wind(s.a, s.b, tau: s.tau, lat: c.latitude, lon: c.longitude) else { continue }
                let k = min(400, Int((hypot(uv.u, uv.v) * 10).rounded())) * 4, o = (y * gw + x) * 4
                px[o] = lut[k]; px[o + 1] = lut[k + 1]; px[o + 2] = lut[k + 2]; px[o + 3] = lut[k + 3]
            }
        }
        guard let provider = CGDataProvider(data: Data(px) as CFData),
              let img = CGImage(width: gw, height: gh, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: gw * 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                                provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
        else { return }
        context.interpolationQuality = .medium
        UIGraphicsPushContext(context)
        UIImage(cgImage: img).draw(in: rect(for: MKMapRect(x: mapRect.minX, y: mapRect.minY, width: Double(gw) * step, height: Double(gh) * step)))
        UIGraphicsPopContext()
    }
}
