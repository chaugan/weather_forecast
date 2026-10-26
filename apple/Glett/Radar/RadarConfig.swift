import Foundation
import GlettKit

/// The radar map's sources and timing, `RM` of js/app.js:2427-2436: MET Norway's 1 km Nordic composite (THREDDS WMS,
/// a frame every 5 minutes) and MET's radar nowcast in the Nordic area, RainViewer's composite elsewhere.
enum RadarConfig {
    /// `RM.metBase`: the observed frames, one file per 5-minute slot.
    static let metBase = "https://thredds.met.no/thredds/wms/remotesensing/reflectivity-nordic/latest/"
    /// `RM.metFile(d)`, d = `rmSlotName(t)`.
    static func metFile(_ d: String) -> String { "yrwms-nordic.mos.pcappi-0-dbz.noclass-clfilter-novpr-clcorr-block.nordiclcc-1000.\(d).nc" }
    /// `RM.ncBase`: MET's radar nowcast, one file per 5-minute issue with 24 steps (2 h), served by `time`.
    static let ncBase = "https://thredds.met.no/thredds/wms/radarnowcasting/"
    /// `RM.ncFile(d)`.
    static func ncFile(_ d: String) -> String { "yrwms-nordic.mos.pcappi-0-rr.noclass-clfilter-novpr-clcorr-block.nordiclcc-1000.\(d).nc" }
    /// `RM.ncSteps`: nowcast steps shown after the newest observed frame (90 minutes).
    static let ncSteps = 18
    /// `RM.metParams`: the WMS GetMap parameters (layer, MET's rainbow scale, log scale from 0.1 to 40 mm/h).
    static let metParams: [(String, String)] = [
        ("service", "WMS"), ("request", "GetMap"), ("version", "1.3.0"),
        ("layers", "lwe_precipitation_rate"), ("styles", "default-scalar/x-Rainbow"),
        ("format", "image/png"), ("transparent", "true"),
        ("colorscalerange", "0.1,40"), ("logscale", "true"), ("numcolorbands", "250"), ("belowmincolor", "transparent"),
    ]
    /// `maxNativeZoom: 12` of the MET layers (js/app.js:2569-2570): above it the z 12 tiles are scaled up.
    static let metMaxZoom = 12

    /// `RM.rvHost`: the only RainViewer tile host the web accepts.
    static let rvHost = "https://tilecache.rainviewer.com"
    /// RainViewer's frame list (js/data.js:737).
    static let rvFrames = URL(string: "https://api.rainviewer.com/public/weather-maps.json")!
    /// `RM.rvTile(h, p)`: 512 px tiles for the standard 256 px grid (Leaflet's `zoomOffset: -1`).
    static func rvTile(_ host: String, _ path: String) -> String { "\(host)\(path)/512/{z}/{x}/{y}/2/1_1.png" }
    /// `maxNativeZoom: 8` with `zoomOffset: -1`: tile z 7 at most.
    static let rvMaxZoom = 7

    /// `RM.stepMs`, `RM.holdMs`, `RM.loops`: 470 ms a frame, 1.6 s on the newest observed and the last frame, three loops.
    static let step: Duration = .milliseconds(470)
    static let hold: Duration = .milliseconds(1600)
    static let loops = 3
    /// `RM.staleMin`: the newest frame is called old after 20 minutes.
    static let staleMinutes = 20.0
    /// `RM.lagMin`: MET's newest slot is asked for 5 minutes back.
    static let lagMinutes = 5.0
    /// `RM.n()`: observed frames, 12 with room (the web's ≥ 700 px), else 7.
    static func frameCount(wide: Bool) -> Int { wide ? 12 : 7 }
    /// `RM.alpha()`: the radar's opacity, lighter on the dark map.
    static func alpha(dark: Bool) -> Double { dark ? 0.72 : 0.82 }
    /// `RM_WINDOW` (js/app.js:2563): frames on each side of the shown one that exist as layers.
    static let window = 2
    /// The wait for the next frame's tiles while playing (js/app.js:2626, 2.5 s); the app waits for all of them, the web for one.
    static let tileWait: Duration = .milliseconds(2500)
    /// How long the frames beside the shown one wait for its tiles before they load too.
    static let firstWait: Duration = .milliseconds(1500)

    /// `inNordic` (js/app.js:2426): where MET's radar composite is used.
    static func inNordic(lat: Double, lon: Double) -> Bool { lat >= 54 && lat <= 72.5 && lon >= -2 && lon <= 33 }

    /// `rmSlotName(unix)` (js/app.js:2445): "20261025T143500Z".
    static func slotName(_ unix: Double) -> String {
        let d = Date(timeIntervalSince1970: unix)
        var c = Calendar(identifier: .gregorian); c.timeZone = .gmt
        let p = c.dateComponents([.year, .month, .day, .hour, .minute], from: d)
        return String(format: "%04d%02d%02dT%02d%02d00Z", p.year!, p.month!, p.day!, p.hour!, p.minute!)
    }

    /// The legend (js/app.js:2489-2490): MET's rainbow, or RainViewer's colours.
    static func legend(met: Bool) -> [(color: UInt32, key: String)] {
        met ? [(0x0043FF, "rm.lg.light"), (0x05FEF9, "rm.lg.mod"), (0xFF8300, "rm.lg.heavy"), (0xC60000, "rm.lg.severe")]
            : [(0x00A3E0, "rm.lg.light"), (0x005588, "rm.lg.mod"), (0xFFAA00, "rm.lg.heavy"), (0xC10000, "rm.lg.severe")]
    }

    /// The map credits as the web's Leaflet attribution writes them (js/app.js:2464-2465, 2565). Names, not text to translate.
    static let kartverketCredit = (name: "© Kartverket", url: URL(string: "https://www.kartverket.no/")!)
    static let metCredit = (name: "© Meteorologisk institutt", url: URL(string: "https://www.met.no/")!)
    static let rainViewerCredit = (name: "RainViewer", url: URL(string: "https://www.rainviewer.com/")!)

    /// One session for radar and map tiles: the identifying User-Agent (brief §3.3) and a tile cache.
    static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.httpAdditionalHeaders = ["User-Agent": ClientIdentity.current.userAgent]
        c.urlCache = URLCache(memoryCapacity: 24 << 20, diskCapacity: 96 << 20)
        c.requestCachePolicy = .useProtocolCachePolicy
        c.timeoutIntervalForRequest = 20
        // MET's THREDDS speaks HTTP/1.1: a browser's 6 connections rather than iOS's 4, so a frame's tiles queue less
        c.httpMaximumConnectionsPerHost = 6
        return URLSession(configuration: c)
    }()
}
