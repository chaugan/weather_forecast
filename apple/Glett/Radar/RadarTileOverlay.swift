import CoreGraphics
import Foundation
import ImageIO
import MapKit
import Synchronization
import UniformTypeIdentifiers

/// A radar frame's tiles: loaded through `RadarConfig.session` and reported, so the frame list knows which frames
/// exist (Leaflet's `tileload` / `tileerror`, js/app.js:2571-2572). RainViewer frames use it with a URL template;
/// MET's WMS frames are `WMSTileOverlay`.
///
/// `@unchecked Sendable`: MapKit calls `loadTile` off the main thread; every stored property is a `let` (the load
/// counts and the release behind a `Mutex`).
class RadarTileOverlay: MKTileOverlay, @unchecked Sendable {
    /// The frame's key (`RadarFrame.key`).
    let frameKey: String
    /// Called after each tile: true when it loaded, false when it failed.
    let onTile: @Sendable (_ key: String, _ ok: Bool) -> Void

    /// The source's highest zoom (Leaflet's `maxNativeZoom`); above it a tile is cut from its ancestor and scaled up.
    let nativeMaxZoom: Int
    /// Levels above the asked zoom the source's tiles are fetched at, and cut and scaled up from: 0 for RainViewer, 2
    /// for MET (`WMSTileOverlay`).
    let levelsUp: Int
    /// How far the map may zoom in (`maxZoom: 18`, `RadarMap`'s limit).
    static let mapMaxZoom = 18
    /// The highest tile zoom MapKit asks for: it takes tiles about one level finer than the zoom shown, so at the
    /// limit it asks for 19 and the layer was gone. Above the source's own zoom, tiles are cut from an ancestor.
    static let tileMaxZoom = mapMaxZoom + 2

    init(frameKey: String, urlTemplate: String?, maxZoom: Int, levelsUp: Int = 0, onTile: @escaping @Sendable (String, Bool) -> Void) {
        self.frameKey = frameKey
        self.onTile = onTile
        nativeMaxZoom = maxZoom
        self.levelsUp = levelsUp
        super.init(urlTemplate: urlTemplate)
        maximumZ = Self.tileMaxZoom
        canReplaceMapContent = false
    }

    override func loadTile(at path: MKTileOverlayPath) async throws -> Data {
        let dz = path.z - min(nativeMaxZoom, max(0, path.z - levelsUp))
        guard dz > 0 else { return try await fetch(path) }
        var parent = path
        parent.z -= dz; parent.x = path.x >> dz; parent.y = path.y >> dz
        let data = try await fetch(parent)
        let n = 1 << dz
        return Self.scaledPart(of: data, column: path.x - (parent.x << dz), row: path.y - (parent.y << dz), of: n,
                               quality: .none) ?? data   // radar pixels stay pixels, as Leaflet scales them
    }

    private func fetch(_ path: MKTileOverlayPath) async throws -> Data {
        let url = url(forTilePath: path)
        // MET's WMS answers carry no cache headers, so URLCache keeps nothing: MapKit asks again for every tile of a
        // frame whose overlay comes back into the window, and without this each loop of the playback downloads anew.
        if let hit = Self.cache.object(forKey: url.absoluteString as NSString) {
            state.withLock { $0.loaded += 1 }
            onTile(frameKey, true)
            return hit as Data
        }
        // Not this frame's turn: no tile now. MapKit loads only a few tiles at a time, so waiting here would hold
        // up the frames that may load; `release()` has the renderer ask again.
        guard isReleased else { throw CancellationError() }
        state.withLock { $0.pending += 1 }
        defer { state.withLock { $0.pending -= 1 } }
        let (data, response) = try await Self.download(url)
        // Only the server's own "no" counts against the frame (a slot or issue not published yet answers with an
        // error status); a dropped connection or a cancelled tile says nothing about the frame.
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, http.mimeType?.hasPrefix("image/") ?? false else {
            onTile(frameKey, false)
            throw URLError(.badServerResponse)
        }
        Self.cache.setObject(data as NSData, forKey: url.absoluteString as NSString, cost: data.count)
        state.withLock { $0.loaded += 1 }
        onTile(frameKey, true)
        return data
    }

    /// Downloads under way, by URL: zoomed in, the tiles cut from one ancestor (16 × 16 of them at z 12 from MET's
    /// z 8) all ask for it at once, and it is fetched once.
    private static let inFlight = Mutex<[String: Task<(Data, URLResponse), any Error>]>([:])

    private static func download(_ url: URL) async throws -> (Data, URLResponse) {
        let key = url.absoluteString
        let task = inFlight.withLock { m in
            if let t = m[key] { return t }
            let t = Task { try await RadarConfig.session.data(from: url) }
            m[key] = t
            return t
        }
        defer { inFlight.withLock { _ = $0.removeValue(forKey: key) } }
        return try await task.value
    }

    /// Tiles in flight and tiles loaded from the network or the cache.
    private struct LoadState { var pending = 0; var loaded = 0 }
    private let state = Mutex(LoadState())

    /// Tiles load once the controller lets this frame load (`release()`): every frame is on the map from the start,
    /// and the shown one and the next ones go first.
    private let released = Mutex(false)
    var isReleased: Bool { released.withLock { $0 } }

    /// Lets this frame's tiles load; true the first time.
    func release() -> Bool {
        released.withLock { r in defer { r = true }; return !r }
    }

    /// Every tile MapKit has asked for so far is in (one at least, none in flight): the frame shows whole, not as a
    /// patchwork of tiles still loading.
    var isComplete: Bool { state.withLock { $0.pending == 0 && $0.loaded > 0 } }

    /// The radar tiles of this session, by URL (frames are not stored on disk: they are minutes old). `NSCache` is
    /// thread-safe, so `nonisolated(unsafe)`.
    nonisolated(unsafe) static let cache: NSCache<NSString, NSData> = {
        let c = NSCache<NSString, NSData>()
        c.totalCostLimit = 48 << 20
        return c
    }()

    /// The part (column, row) of an n × n split of the image, scaled to the image's full size. The whole image is drawn
    /// n times larger and shifted, so a part smaller than a pixel (z 20 from MET's z 8) still comes out.
    static func scaledPart(of data: Data, column: Int, row: Int, of n: Int, quality: CGInterpolationQuality) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil),
              let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        let w = CGFloat(img.width), h = CGFloat(img.height)
        ctx.interpolationQuality = quality
        // Core Graphics counts y from the bottom, rows from the top
        ctx.draw(img, in: CGRect(x: -CGFloat(column) * w, y: -CGFloat(n - 1 - row) * h, width: w * CGFloat(n), height: h * CGFloat(n)))
        guard let out = ctx.makeImage() else { return nil }
        let buf = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(buf, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, out, nil)
        return CGImageDestinationFinalize(dest) ? buf as Data : nil
    }
}

/// A WMS layer as map tiles (brief §3.4): `url(forTilePath:)` asks for the tile's EPSG:3857 box, as Leaflet's
/// `L.tileLayer.wms` does with `version: '1.3.0'` (js/app.js:2569-2570). `@unchecked Sendable` as its superclass: only `let`s.
final class WMSTileOverlay: RadarTileOverlay, @unchecked Sendable {
    /// The WMS endpoint (the dataset's file).
    let base: String
    /// The GetMap parameters without the box and size.
    let params: [(String, String)]

    init(frameKey: String, base: String, params: [(String, String)], maxZoom: Int, onTile: @escaping @Sendable (String, Bool) -> Void) {
        self.base = base
        self.params = params
        // As yr.no (tiles.yr.no, z 6 at most): a MET tile two levels up has about one pixel per two points on screen,
        // as fine as the composite's 1 km cells from far out, and THREDDS draws every tile on request: 1/16 of the tiles.
        super.init(frameKey: frameKey, urlTemplate: nil, maxZoom: maxZoom, levelsUp: 2, onTile: onTile)
    }

    /// Half the web-mercator world in metres (EPSG:3857).
    static let halfWorld = 20_037_508.342789244

    /// The tile's box in EPSG:3857 metres: minx, miny, maxx, maxy (WMS 1.3.0 keeps x/y order for this CRS).
    static func bbox(x: Int, y: Int, z: Int) -> (Double, Double, Double, Double) {
        let size = 2 * halfWorld / Double(1 << z)
        let minX = -halfWorld + Double(x) * size, maxY = halfWorld - Double(y) * size
        return (minX, maxY - size, minX + size, maxY)
    }

    override func url(forTilePath path: MKTileOverlayPath) -> URL {
        let b = Self.bbox(x: path.x, y: path.y, z: path.z)
        let side = Int(tileSize.width)
        var items = params.map { URLQueryItem(name: $0.0, value: $0.1) }
        items += [URLQueryItem(name: "width", value: String(side)), URLQueryItem(name: "height", value: String(side)),
                  URLQueryItem(name: "crs", value: "EPSG:3857"),
                  URLQueryItem(name: "bbox", value: [b.0, b.1, b.2, b.3].map { String(format: "%.6f", $0) }.joined(separator: ","))]
        var c = URLComponents(string: base)!
        c.queryItems = items
        return c.url!
    }
}
