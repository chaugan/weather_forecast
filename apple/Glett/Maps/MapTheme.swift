import CoreGraphics
import Foundation
import MapKit

/// How every Glett map looks in light and dark (owner, 2026-10-27; DESIGN.md "Maps"). In the dark theme a base map's
/// tiles go through the web's filter (css/style.css:244-245, `.leaflet-tile { filter: invert(1) hue-rotate(180deg)
/// brightness(.92) contrast(.9) }`) on the dark map background (`.leaflet-container`, #0d1420); in the light theme
/// they stay as they are on the page colour (`--bg`, #F3F6FB). Data drawn over a map (radar, wind) keeps its true
/// colours, as on the web (css/style.css:246-248). Apple's own map follows the theme by itself.
enum MapTheme {
    /// The map's background where a base map has no tiles: `--bg` in light, the dark map's #0d1420 in dark.
    static func background(dark: Bool) -> CGColor {
        dark ? CGColor(srgbRed: 0x0D / 255, green: 0x14 / 255, blue: 0x20 / 255, alpha: 1)
            : CGColor(srgbRed: 0xF3 / 255, green: 0xF6 / 255, blue: 0xFB / 255, alpha: 1)
    }

    /// `invert(1) hue-rotate(180deg) brightness(.92) contrast(.9)` as one map of each colour: with H the CSS
    /// hue-rotate(180°) matrix (whose rows sum to 1), the result is 0.878 − 0.828 · H · c.
    private static let h: [Double] = [-0.574, 1.430, 0.144,
                                      0.426, 0.430, 0.144,
                                      0.426, 1.430, -0.856]

    /// A base map tile for the theme: as it is on the light background, or filtered on the dark one. The tile is drawn
    /// with `draw` into a square of `size` pixels.
    static func tile(size: Int, dark: Bool, draw: (CGContext) -> Void) -> CGImage? {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!, info = CGImageAlphaInfo.premultipliedLast.rawValue
        let rect = CGRect(x: 0, y: 0, width: size, height: size)
        guard let out = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: space, bitmapInfo: info)
        else { return nil }
        out.setFillColor(background(dark: dark))
        out.fill(rect)
        guard dark else { draw(out); return out.makeImage() }
        // dark: the tile alone on a clear layer, filtered where it has paint, then laid on the dark background
        guard let layer = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: space, bitmapInfo: info),
              let p = layer.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
        draw(layer)
        for i in stride(from: 0, to: size * size * 4, by: 4) {
            let a = Double(p[i + 3])
            guard a > 0 else { continue }
            let c = [Double(p[i]) / a, Double(p[i + 1]) / a, Double(p[i + 2]) / a]   // unpremultiplied, 0…1
            for k in 0..<3 {
                let v = 0.878 - 0.828 * (h[k * 3] * c[0] + h[k * 3 + 1] * c[1] + h[k * 3 + 2] * c[2])
                p[i + k] = UInt8((min(1, max(0, v)) * a).rounded())
            }
        }
        guard let img = layer.makeImage() else { return nil }
        out.draw(img, in: rect)
        return out.makeImage()
    }
}
