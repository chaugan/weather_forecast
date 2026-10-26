import CoreGraphics
import Foundation
import ImageIO
import MapKit
import UniformTypeIdentifiers

/// Kartverket's topographic map as the base (`KartverketLayer`, js/app.js:1440-1453; URL in brief §3.3). Each tile's
/// outer pixel is cropped and the rest drawn over the whole tile, as the web does, which hides the seams between tiles.
///
/// `@unchecked Sendable`: MapKit calls `loadTile` off the main thread; nothing is stored after `init`.
final class KartverketTileOverlay: MKTileOverlay, @unchecked Sendable {
    /// The WMTS tile URL (web mercator).
    static let template = "https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png"
    /// `maxZoom: 18` of the web's layer.
    static let maxZoom = 18

    init() {
        super.init(urlTemplate: Self.template)
        canReplaceMapContent = true
        maximumZ = Self.maxZoom
    }

    override func loadTile(at path: MKTileOverlayPath) async throws -> Data {
        let (data, response) = try await RadarConfig.session.data(from: url(forTilePath: path))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return Self.cropped(data) ?? data
    }

    /// `drawImage(img, 1, 1, w − 2, h − 2, 0, 0, w, h)`: the tile without its outer pixel, scaled back to full size.
    static func cropped(_ data: Data) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil), img.width > 2, img.height > 2,
              let inner = img.cropping(to: CGRect(x: 1, y: 1, width: img.width - 2, height: img.height - 2)),
              let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(inner, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
        guard let out = ctx.makeImage() else { return nil }
        let buf = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(buf, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, out, nil)
        return CGImageDestinationFinalize(dest) ? buf as Data : nil
    }
}
