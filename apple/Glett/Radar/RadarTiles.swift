import CoreGraphics
import Foundation
import ImageIO
import MapKit
import Synchronization
import UniformTypeIdentifiers

/// Where a radar frame's tiles come from (js/app.js:2565-2572).
struct RadarSource: Sendable, Hashable {
    enum Kind: Sendable, Hashable {
        /// MET's WMS (`L.tileLayer.wms` with `version: '1.3.0'`): the endpoint and the GetMap parameters without the
        /// box and size.
        case wms(base: String, params: [String: String])
        /// A `{z}/{x}/{y}` template (RainViewer).
        case xyz(String)
    }
    /// `RadarFrame.key`.
    let key: String
    let kind: Kind
    /// The source's highest zoom (Leaflet's `maxNativeZoom`); closer in, its tiles are drawn larger.
    let maxZoom: Int
    /// Levels above the zoom shown the tiles are fetched at: 0 for RainViewer, 2 for MET. As yr.no (tiles.yr.no, z 6 at
    /// most): a MET tile two levels up has about one pixel per two points on screen, as fine as the composite's 1 km
    /// cells from far out, and THREDDS draws every tile on request: 1/16 of the tiles.
    let levelsUp: Int
}

/// One tile of a source.
struct RadarTile: Sendable, Hashable {
    let x: Int, y: Int, z: Int
}

/// The radar's tile maths and addresses, shared with the Kartverket base map.
enum RadarTiles {
    /// How far the map may zoom in (`maxZoom: 18`, `RadarMap`'s limit).
    static let mapMaxZoom = 18
    /// The highest tile zoom the Kartverket overlay is asked for: MapKit takes tiles about one level finer than the
    /// zoom shown, so at the limit it asks for 19. Above its own zoom, tiles are cut from an ancestor.
    static let tileMaxZoom = mapMaxZoom + 2

    /// Half the web-mercator world in metres (EPSG:3857).
    static let halfWorld = 20_037_508.342789244

    /// The tile's box in EPSG:3857 metres: minx, miny, maxx, maxy (WMS 1.3.0 keeps x/y order for this CRS).
    static func bbox(x: Int, y: Int, z: Int) -> (Double, Double, Double, Double) {
        let size = 2 * halfWorld / Double(1 << z)
        let minX = -halfWorld + Double(x) * size, maxY = halfWorld - Double(y) * size
        return (minX, maxY - size, minX + size, maxY)
    }

    /// The zoom a source's tiles are fetched at for a map drawn at `zoomScale` (points per map point): the zoom shown,
    /// as Leaflet counts it with 256 pt tiles, plus the level finer MapKit's own tile overlays take, less `levelsUp`.
    static func zoom(_ s: RadarSource, zoomScale: MKZoomScale) -> Int {
        let shown = log2(MKMapSize.world.width * Double(zoomScale) / 256)
        return min(s.maxZoom, max(0, Int(shown.rounded()) + 1 - s.levelsUp))
    }

    /// The tile's square on the map.
    static func mapRect(_ t: RadarTile) -> MKMapRect {
        let size = MKMapSize.world.width / Double(1 << t.z)
        return MKMapRect(x: Double(t.x) * size, y: Double(t.y) * size, width: size, height: size)
    }

    /// The tiles at zoom z that cover `rect`.
    static func tiles(covering rect: MKMapRect, z: Int) -> [RadarTile] {
        let n = 1 << z, size = MKMapSize.world.width / Double(n)
        let r = rect.intersection(.world)
        guard !r.isNull, !r.isEmpty else { return [] }
        let x0 = max(0, Int(r.minX / size)), x1 = min(n - 1, Int((r.maxX - 1e-6) / size))
        let y0 = max(0, Int(r.minY / size)), y1 = min(n - 1, Int((r.maxY - 1e-6) / size))
        guard x0 <= x1, y0 <= y1 else { return [] }
        return (y0...y1).flatMap { y in (x0...x1).map { RadarTile(x: $0, y: y, z: z) } }
    }

    /// The tile's address: a WMS GetMap for the tile's EPSG:3857 box, or the template filled in.
    static func url(_ s: RadarSource, _ t: RadarTile) -> URL {
        switch s.kind {
        case let .xyz(template):
            return URL(string: template.replacingOccurrences(of: "{z}", with: String(t.z))
                .replacingOccurrences(of: "{x}", with: String(t.x)).replacingOccurrences(of: "{y}", with: String(t.y)))!
        case let .wms(base, params):
            let b = bbox(x: t.x, y: t.y, z: t.z)
            var items = params.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
            items += [URLQueryItem(name: "width", value: "256"), URLQueryItem(name: "height", value: "256"),
                      URLQueryItem(name: "crs", value: "EPSG:3857"),
                      URLQueryItem(name: "bbox", value: [b.0, b.1, b.2, b.3].map { String(format: "%.6f", $0) }.joined(separator: ","))]
            var c = URLComponents(string: base)!
            c.queryItems = items
            return c.url!
        }
    }

    /// The part (column, row) of an n × n split of the image, scaled to the image's full size (the Kartverket base map
    /// past z 18). The whole image is drawn n times larger and shifted, so a part smaller than a pixel still comes out.
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

/// The radar's tiles: downloaded through `RadarConfig.session` in the order the controller plans (the shown frame
/// first, then the next ones), a few at a time, kept decoded for drawing. Each outcome is reported, so the frame list
/// knows which frames exist (Leaflet's `tileload` / `tileerror`).
///
/// `@unchecked Sendable`: the renderer reads it while drawing off the main thread; its state is behind a `Mutex`.
final class RadarTileStore: @unchecked Sendable {
    /// Called on the main actor after each download: the frame's key, and whether the server sent the tile.
    private let onLoaded: @MainActor (_ key: String, _ ok: Bool) -> Void

    private struct Job: Sendable { let source: RadarSource; let tile: RadarTile; let url: String }
    private struct State {
        /// Tiles to fetch, first first.
        var queue: [Job] = []
        var running: Set<String> = []
        /// Tiles the server refused (an error status): done, nothing to draw.
        var failed: Set<String> = []
    }
    private let state = Mutex(State())

    /// Decoded tiles by address. MET's answers carry no cache headers, so nothing would be kept otherwise; a loop of the
    /// playback draws them all again.
    private let images: NSCache<NSString, CGImage> = {
        let c = NSCache<NSString, CGImage>()
        c.totalCostLimit = 96 << 20
        return c
    }()

    /// Downloads at a time: MET's server is HTTP/1.1, and `RadarConfig.session` opens this many connections.
    static let parallel = 6

    init(onLoaded: @escaping @MainActor (String, Bool) -> Void) { self.onLoaded = onLoaded }

    func image(_ s: RadarSource, _ t: RadarTile) -> CGImage? {
        images.object(forKey: RadarTiles.url(s, t).absoluteString as NSString)
    }

    /// The tile is in, or the server refused it: nothing more will come.
    func isDone(_ s: RadarSource, _ t: RadarTile) -> Bool {
        let u = RadarTiles.url(s, t).absoluteString
        return images.object(forKey: u as NSString) != nil || state.withLock { $0.failed.contains(u) }
    }

    /// Fetch these, in this order, before whatever was asked for earlier and not started yet (that stays behind them:
    /// tiles being drawn asked for themselves, and a new plan must not drop them, or they were asked for again and
    /// again and never fetched).
    func plan(_ wanted: [(RadarSource, RadarTile)]) {
        let jobs = wanted.map { Job(source: $0.0, tile: $0.1, url: RadarTiles.url($0.0, $0.1).absoluteString) }
            .filter { images.object(forKey: $0.url as NSString) == nil }
        state.withLock { s in
            var seen = s.running.union(s.failed)
            let first = jobs.filter { seen.insert($0.url).inserted }
            s.queue = first + s.queue.filter { seen.insert($0.url).inserted }.prefix(Self.keepQueued)
        }
        pump()
    }

    /// Earlier asks kept behind a new plan, at most.
    static let keepQueued = 300

    /// Fetch this next: a tile being drawn and missing.
    func urgent(_ s: RadarSource, _ t: RadarTile) {
        let u = RadarTiles.url(s, t).absoluteString
        guard images.object(forKey: u as NSString) == nil else { return }
        let added = state.withLock { st -> Bool in
            guard !st.failed.contains(u), !st.running.contains(u), st.queue.first?.url != u else { return false }
            st.queue.removeAll { $0.url == u }
            st.queue.insert(Job(source: s, tile: t, url: u), at: 0)
            return true
        }
        if added { pump() }
    }

    /// Nothing more to fetch (the radar is down or closed).
    func cancelAll() { state.withLock { $0.queue = [] } }

    private func pump() {
        while let job = state.withLock({ s -> Job? in
            guard s.running.count < Self.parallel, !s.queue.isEmpty else { return nil }
            let j = s.queue.removeFirst()
            s.running.insert(j.url)
            return j
        }) {
            Task.detached { [weak self] in await self?.fetch(job) }
        }
    }

    private func fetch(_ job: Job) async {
        var ok: Bool?
        if let (data, response) = try? await RadarConfig.session.data(from: URL(string: job.url)!) {
            // Only the server's own "no" counts against the frame (a slot or issue not published yet answers with an
            // error status); a dropped connection says nothing about the frame, and the tile is asked for again later.
            if let http = response as? HTTPURLResponse, http.statusCode == 200, http.mimeType?.hasPrefix("image/") ?? false,
               let src = CGImageSourceCreateWithData(data as CFData, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) {
                images.setObject(img, forKey: job.url as NSString, cost: img.bytesPerRow * img.height)
                ok = true
            } else {
                ok = false
            }
        }
        state.withLock { s in
            s.running.remove(job.url)
            if ok == false { s.failed.insert(job.url) }
        }
        pump()
        if let ok {
            let key = job.source.key, report = onLoaded
            await MainActor.run { report(key, ok) }
        }
    }
}

/// The radar on the map: one overlay over the whole world, drawn by `RadarRenderer`.
final class RadarLayer: NSObject, MKOverlay {
    let coordinate = CLLocationCoordinate2D(latitude: 0, longitude: 0)
    let boundingMapRect = MKMapRect.world
}

/// Draws the shown frame's tiles from the store. MapKit's own tile overlays could not do this: a level redraws all its
/// overlays whenever one joins or leaves it (the frames flashed on top of each other at each refresh), and a tile
/// overlay keeps the tiles it has, so one overlay cannot change frame. Here a new frame is one redraw; a tile not in
/// yet is drawn from the frame shown before (or a coarser tile of the same frame), so the map never goes empty.
///
/// `@unchecked Sendable`: MapKit draws off the main thread; what to show is behind a `Mutex`.
final class RadarRenderer: MKOverlayRenderer, @unchecked Sendable {
    private struct Show { var current: RadarSource?; var previous: RadarSource? }
    private let show = Mutex(Show())
    private let store: RadarTileStore

    init(layer: RadarLayer, store: RadarTileStore) {
        self.store = store
        super.init(overlay: layer)
    }

    /// Draws `source` from now on (nil: nothing); tiles not in yet come from the frame shown until now.
    func display(_ source: RadarSource?) {
        let changed = show.withLock { s in
            guard s.current != source else { return false }
            s.previous = source == nil ? nil : s.current
            s.current = source
            return true
        }
        if changed { setNeedsDisplay() }
    }

    /// A tile of `key` came in: drawn if it belongs to the shown frame (or the one drawn under it).
    func loaded(_ key: String) {
        if show.withLock({ $0.current?.key == key || $0.previous?.key == key }) { setNeedsDisplay() }
    }

    override func draw(_ mapRect: MKMapRect, zoomScale: MKZoomScale, in context: CGContext) {
        let s = show.withLock { $0 }
        guard let cur = s.current else { return }
        let z = RadarTiles.zoom(cur, zoomScale: zoomScale)
        context.interpolationQuality = .none   // radar pixels stay pixels, as Leaflet scales them
        UIGraphicsPushContext(context)
        defer { UIGraphicsPopContext() }
        for t in RadarTiles.tiles(covering: mapRect, z: z) {
            if let img = store.image(cur, t) { draw(img, t); continue }
            if !store.isDone(cur, t) { store.urgent(cur, t) }
            if let prev = s.previous, drawStandIn(prev, t, z: RadarTiles.zoom(prev, zoomScale: zoomScale)) { continue }
            _ = drawStandIn(cur, t, z: z - 1)
        }
    }

    /// Draws `source`'s tiles at zoom z, or up to two levels coarser, where tile t is; true when it could.
    private func drawStandIn(_ source: RadarSource, _ t: RadarTile, z: Int) -> Bool {
        guard z >= 0 else { return false }
        for zz in stride(from: z, through: max(0, z - 2), by: -1) {
            let covering = RadarTiles.tiles(covering: RadarTiles.mapRect(t), z: zz)
            let imgs = covering.compactMap { c in store.image(source, c).map { (c, $0) } }
            if !imgs.isEmpty, imgs.count == covering.count {
                for (c, img) in imgs { draw(img, c) }
                return true
            }
        }
        return false
    }

    private func draw(_ img: CGImage, _ t: RadarTile) {
        UIImage(cgImage: img).draw(in: rect(for: RadarTiles.mapRect(t)))
    }
}
