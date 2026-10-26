import Foundation
import Testing
@testable import GlettKit

// Golden fixtures (Fixtures/README.md): what the web's own JS computed from recorded API answers. The tests replay
// the raw answers through the app's own clients (WeatherService → OpenMeteoClient/METClient, NowcastClient) and hold
// the Swift engine's output against the expected files.

/// Floating-point tolerance of brief §12 (shares, chances, means, aggregates).
let goldenTolerance = 1e-9

// MARK: Files

enum Golden {
    static func url(_ name: String, _ ext: String, _ dir: String) -> URL? {
        Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Fixtures/\(dir)")
    }

    /// A file by its path relative to `Fixtures/` (`raw/oslo.openmeteo.json`, `raw/nowcast/bergen.0.json`).
    static func data(fixturePath p: String) throws -> Data {
        let base = try #require(Bundle.module.resourceURL, "no test resources")
        return try Data(contentsOf: base.appendingPathComponent("Fixtures/" + p))
    }

    static func decode<T: Decodable>(_ t: T.Type, _ name: String, _ dir: String) throws -> T {
        let u = try #require(url(name, "json", dir), "missing fixture \(dir)/\(name).json")
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: u))
    }

    static let manifest: GManifest? = try? decode(GManifest.self, "manifest", "raw")
    /// The recorded places (oslo bergen tromso finse london).
    static let slugs: [String] = manifest?.places.map(\.slug) ?? []
    static let steps = StepAggregation.steps
    static let runs = ["unweighted", "synthetic"]
}

/// Caches the decoded expected files and the forecasts built from the raw answers, so the parameterised tests do the
/// work once per place.
actor GoldenStore {
    static let shared = GoldenStore()
    private var expected: [String: GExpected] = [:]
    private var forecasts: [String: Forecast] = [:]

    func expected(_ slug: String) throws -> GExpected {
        if let e = expected[slug] { return e }
        let e = try Golden.decode(GExpected.self, slug, "expected")
        expected[slug] = e
        return e
    }

    func forecast(_ slug: String) async throws -> Forecast {
        if let f = forecasts[slug] { return f }
        let f = try await GoldenReplay.forecast(slug).forecast
        forecasts[slug] = f
        return f
    }
}

// MARK: Replay

enum GoldenReplay {
    /// A transport that answers each recorded URL with its recorded status and body, and 404 for anything else.
    /// `base` is the folder (under `Fixtures/`) the requests' `file` names are relative to.
    static func transport(_ requests: [GRequest], base: String = "raw/") throws -> StubTransport {
        var table: [String: (Int, Data)] = [:]
        for r in requests { table[r.url] = (r.status, try Golden.data(fixturePath: base + r.file)) }
        let answers = table
        return StubTransport { req in
            guard let a = answers[req.url!.absoluteString] else { return (404, Data(), [:]) }
            return (a.0, a.1, ["Content-Type": "application/json"])
        }
    }

    /// The forecast for a recorded place through `WeatherService.forecast`, the app's path: Open-Meteo decoding and
    /// provider filtering, the Yr conversion, then `prepare()`.
    static func forecast(_ slug: String) async throws -> (forecast: Forecast, transport: StubTransport, place: GPlace) {
        let m = try #require(Golden.manifest, "raw/manifest.json does not decode")
        let p = try #require(m.places.first { $0.slug == slug })
        let stub = try transport([p.openMeteo] + (p.met.map { [$0] } ?? []))
        let service = WeatherService(transport: stub, cache: ForecastCache(directory: tempDir()), gate: nil)
        let bundle = try await service.forecast(lat: p.lat, lon: p.lon)
        return (bundle.forecast, stub, p)
    }
}

// MARK: Comparing

/// Collects mismatches with their path and reports them as one issue (the first 40), so a broken formula does not
/// produce thousands of lines.
struct GoldenDiff {
    let name: String
    private(set) var checked = 0
    private(set) var failures: [String] = []
    private var count = 0

    init(_ name: String) { self.name = name }

    mutating func fail(_ path: String, _ got: Any?, _ want: Any?) {
        count += 1
        if failures.count < 40 { failures.append("\(path): got \(show(got)), want \(show(want))") }
    }

    private func show(_ v: Any?) -> String { v.map { "\($0)" } ?? "nil" }

    mutating func num(_ path: @autoclosure () -> String, _ got: Double?, _ want: Double?) {
        checked += 1
        switch (got, want) {
        case (nil, nil): return
        case let (g?, w?) where abs(g - w) <= goldenTolerance: return
        default: fail(path(), got, want)
        }
    }

    mutating func nums(_ path: String, _ got: [Double?], _ want: [Double?]) {
        guard got.count == want.count else { return fail("\(path).count", got.count, want.count) }
        for i in want.indices { num("\(path)[\(i)]", got[i], want[i]) }
    }

    mutating func eq<T: Equatable>(_ path: @autoclosure () -> String, _ got: T?, _ want: T?) {
        checked += 1
        if got != want { fail(path(), got, want) }
    }

    func report(sourceLocation: SourceLocation = #_sourceLocation) {
        #expect(checked > 0, "\(name): nothing compared", sourceLocation: sourceLocation)
        if ProcessInfo.processInfo.environment["GLETT_GOLDEN_VERBOSE"] == "1" { print("golden \(name): \(checked) values, \(count) differ") }
        guard count > 0 else { return }
        let text = "\(name): \(count) of \(checked) values differ from the JS\n" + failures.joined(separator: "\n")
        Issue.record(Comment(rawValue: text), sourceLocation: sourceLocation)
    }
}

// MARK: The fixture formats (Fixtures/README.md)

struct GRequest: Decodable, Sendable { var url: String; var status: Int; var file: String }

struct GPlace: Decodable, Sendable {
    var slug: String
    var name: String
    var lat: Double
    var lon: Double
    var openMeteo: GRequest
    var met: GRequest?
}

struct GManifest: Decodable, Sendable {
    struct Nowcast: Decodable, Sendable {
        var slug: String
        var lat: Double
        var lon: Double
        var now: Double
        var wet: Bool
        var model: Bool
        var requests: [GRequest]
    }
    /// A recorded reliability run (`fetchVerify`): every request it made, at `now`.
    struct Verify: Decodable, Sendable {
        var slug: String
        var lat: Double
        var lon: Double
        var now: Double
        var truth: String
        var requests: [GRequest]
    }
    var forecastNow: Double
    var userAgent: String
    var places: [GPlace]
    var nowcast: [Nowcast]
    var verify: [Verify]?
}

struct GExpected: Decodable, Sendable {
    struct DataBlock: Decodable, Sendable {
        var lat: Double
        var lon: Double
        var timezone: String?
        var utc_offset_seconds: Int
        var elevation: Double?
        var time: [String]
        var dates: [String]
        var isDay: [Double]
    }
    struct Prov: Decodable, Sendable { var id: String; var dupOf: String?; var code: [Double?] }
    struct Weights: Decodable, Sendable {
        struct Verify: Decodable, Sendable {
            struct Model: Decodable, Sendable { var weights: [String: Double?] }
            var models: [String: Model]
        }
        var synthetic: Verify?
    }
    struct Hero: Decodable, Sendable { var step: Int; var a: Int? }

    var now: Double
    var data: DataBlock
    var nowIdx: Int
    var providers: [Prov]
    var dupOf: [String: String]
    var active: [String]
    var yr: [String: [Double?]]?
    var weights: Weights
    var heroColumn: Hero
    var steps: [String: GStep]
    /// The day cards and today's lines at a few times (`renderDays`, `renderSummary`).
    var daily: [GDaily]?

    /// `state.verify` of a run as the engine's weights; nil = no weights (`unweighted`).
    func weights(run: String) -> WeightTable? {
        guard run == "synthetic", let v = weights.synthetic else { return nil }
        return WeightTable(v.models.mapValues(\.weights))
    }
}

struct GColumn: Decodable, Sendable {
    var a: Int, b: Int, day: Int
    var first: Bool
    var label: String
    var hour: Int
    var past: Bool, now: Bool, night: Bool
}

struct GAgg: Decodable, Sendable {
    var temperature_2m: [Double?]
    var apparent_temperature: [Double?]
    var precip: [Double?]
    var wind_speed_10m: [Double?]
    var gust: [Double?]
    var dir: [Double?]
    var cloud_cover: [Double?]
    var relative_humidity_2m: [Double?]
    var pressure_msl: [Double?]
    var cape: [Double?]
    var code: [Double?]
    var category: [String?]
    var icon: [String?]
    var thunder: [Double?]

    /// The numeric fields with the `agg()` parameter each one is.
    var numeric: [(String, AggregateParam, [Double?])] {
        [("temperature_2m", .mean(.temperature2m), temperature_2m), ("apparent_temperature", .mean(.apparentTemperature), apparent_temperature),
         ("precip", .precip, precip), ("wind_speed_10m", .mean(.windSpeed10m), wind_speed_10m), ("gust", .gust, gust), ("dir", .dir, dir),
         ("cloud_cover", .mean(.cloudCover), cloud_cover), ("relative_humidity_2m", .mean(.relativeHumidity2m), relative_humidity_2m),
         ("pressure_msl", .mean(.pressureMSL), pressure_msl), ("cape", .cape, cape), ("code", .code, code)]
    }
}

struct GShare: Decodable, Sendable { var cat: String; var share: Double }

struct GVerdict: Decodable, Sendable {
    var level: String
    var dots: Int
    var k: Int
    var n: Int
    var cat: String
    var minT: Double?
    var maxT: Double?
    var min: String
    var max: String
}

struct GRun: Decodable, Sendable {
    var shares: [[GShare]?]
    var icon: [String?]
    var rainChance: [Double?]
    var windChance: [Double?]
    var gustPct: [Int?]
    var thunderChance: [Double?]
    var temp: [Double?]
    var feels: [Double?]
    var wind: [Double?]
    var gust: [Double?]
    var precip: [Double?]
    var dir: [Double?]
    var verdict: [GVerdict?]
}

struct GStep: Decodable, Sendable {
    var columns: [GColumn]
    var boost: [String: [Double]]
    var agg: [String: GAgg]
    var agreement: [String: [Int?]]
    var sd: [String: [Double?]]
    var runs: [String: GRun]
}

// nowcast.json

/// A `{key, params}` the stubbed `t()` recorded. `params.h` is a unix second, or "" when the web passes no time.
struct GText: Decodable, Sendable {
    var key: String
    var hasParams: Bool
    var h: Double?

    private enum CodingKeys: String, CodingKey { case key, params }
    private enum P: String, CodingKey { case h }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        guard (try? c.decodeNil(forKey: .params)) == false, let p = try? c.nestedContainer(keyedBy: P.self, forKey: .params) else {
            hasParams = false; h = nil; return
        }
        hasParams = true
        h = try? p.decode(Double.self, forKey: .h)   // "" → nil
    }
}

struct GEval: Decodable, Sendable {
    struct Summary: Decodable, Sendable {
        var rainingNow: Bool
        var change: Int
        var changeT: Double?
        var blipT: Double?
        var t: [GText]
    }
    struct Here: Decodable, Sendable { var wetNow: Bool; var t: [GText] }
    var now: Double
    var summary: Summary?
    var here: Here?
}

struct GNowcastFile: Decodable, Sendable {
    struct Recorded: Decodable, Sendable {
        struct P: Decodable, Sendable { var slug: String; var lat: Double; var lon: Double }
        var place: P
        var now: Double
        var model: Bool
        var sources: [GRequest]
        var nowcast: NowcastSeries
        var evaluations: [GEval]
    }
    struct Synthetic: Decodable, Sendable {
        var name: String
        var now: Double
        var nowcast: NowcastSeries
        var evaluations: [GEval]
    }
    var recorded: [Recorded]
    var synthetic: [Synthetic]
}

// <slug>.json "daily"

struct GDaily: Decodable, Sendable {
    struct Day: Decodable, Sendable {
        var top: String?
        var hi: Double?, lo: Double?
        var rp: Double?
        var rain: Int?
        var sp: Double?
        var storm: Int
        var mm: Double?
        var gust: Double?
        var rest: Bool
        var dry: Bool
    }
    struct Outlook: Decodable, Sendable {
        struct Rain: Decodable, Sendable {
            var maxP: Double
            var pct: Int
            var firstA: Int?
            var firstHour: Int?
            var key: String
            /// `s.rain.from`'s {h}: the column label.
            var h: String?
        }
        struct Gust: Decodable, Sendable {
            var g: Double
            var a: Int
            var hour: Int
            var shown: Bool
            var strong: Bool
            var v: String?
            var tod: String?
        }
        var partial: Bool
        var rain: Rain?
        var gust: Gust?
    }
    struct Run: Decodable, Sendable { var days: [Day]; var outlook: Outlook }
    var now: Double
    var nowIdx: Int
    var todayIdx: Int
    var runs: [String: Run]
}

// verify.json

struct GVerifyFile: Decodable, Sendable {
    struct Entry: Decodable, Sendable {
        struct P: Decodable, Sendable { var slug: String; var lat: Double; var lon: Double }
        var place: P
        var now: Double
        var sources: [GRequest]
        var result: VerificationResult
    }
    var places: [Entry]
}
