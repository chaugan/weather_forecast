import CoreGraphics
import Foundation
import ImageIO
import MapKit
import UniformTypeIdentifiers

/// Kartverket's topographic map as the base (`KartverketLayer`, js/app.js:1440-1453; URL in brief §3.3). Each tile's
/// outer pixel is cropped and the rest drawn over the whole tile, as the web does, which hides the seams between tiles,
/// on the web's light page colour (`--bg`, the map's background there): outside Norway the tiles are transparent.
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
        maximumZ = RadarTileOverlay.tileMaxZoom
    }

    /// Above z 18 (MapKit asks one level finer than the zoom shown) the tile is cut from its z 18 ancestor.
    override func loadTile(at path: MKTileOverlayPath) async throws -> Data {
        let dz = path.z - Self.maxZoom
        guard dz > 0 else { return try await tile(path) }
        var parent = path
        parent.z = Self.maxZoom; parent.x = path.x >> dz; parent.y = path.y >> dz
        let data = try await tile(parent)
        return RadarTileOverlay.scaledPart(of: data, column: path.x - (parent.x << dz), row: path.y - (parent.y << dz),
                                           of: 1 << dz, quality: .high) ?? data
    }

    private func tile(_ path: MKTileOverlayPath) async throws -> Data {
        let url = url(forTilePath: path), key = url.absoluteString as NSString
        if let hit = Self.cache.object(forKey: key) { return hit as Data }
        let (data, response) = try await RadarConfig.session.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        let tile = Self.cropped(data) ?? data
        Self.cache.setObject(tile as NSData, forKey: key, cost: tile.count)
        return tile
    }

    /// The finished tiles, by URL: MapKit draws the base again whenever a radar frame's overlay is added, and from
    /// here it does so at once, without a round through the URL cache, PNG decoding and the crop. `NSCache` is
    /// thread-safe, so `nonisolated(unsafe)`.
    nonisolated(unsafe) static let cache: NSCache<NSString, NSData> = {
        let c = NSCache<NSString, NSData>()
        c.totalCostLimit = 32 << 20
        return c
    }()

    /// `drawImage(img, 1, 1, w − 2, h − 2, 0, 0, w, h)`: the tile without its outer pixel, scaled back to full size, on `--bg`.
    static func cropped(_ data: Data) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil), img.width > 2, img.height > 2,
              let inner = img.cropping(to: CGRect(x: 1, y: 1, width: img.width - 2, height: img.height - 2)),
              let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        ctx.setFillColor(red: 0xF3 / 255, green: 0xF6 / 255, blue: 0xFB / 255, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: img.width, height: img.height))
        ctx.interpolationQuality = .high
        ctx.draw(inner, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
        guard let out = ctx.makeImage() else { return nil }
        let buf = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(buf, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, out, nil)
        return CGImageDestinationFinalize(dest) ? buf as Data : nil
    }
}
