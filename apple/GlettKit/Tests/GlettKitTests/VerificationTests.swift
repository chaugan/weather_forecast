import Testing
import Foundation
@testable import GlettKit

/// Hand-computed checks of the reliability maths (js/data.js:209-373) and of the service's requests.
struct VerificationTests {
    /// 2026-10-01T00:00Z.
    static let t0: Double = 1790812800
    static func axis(_ n: Int, from t: Double = t0) -> [String] { (0..<n).map { JS.isoUTC(t + Double($0) * 3600, 16) } }
    static func rows(_ n: Int, _ fill: (Int, inout TruthRow) -> Void) -> [TruthRow] {
        let tm = axis(n)
        return (0..<n).map { i in var r = TruthRow(j: i, tm: tm[i]); fill(i, &r); return r }
    }
    static func near(_ a: Double?, _ b: Double, _ eps: Double = 1e-12) -> Bool { a.map { abs($0 - b) < eps } ?? false }

    @Test func vcatMergesDrizzle() {
        #expect(VerificationEngine.vcat(nil) == nil)
        #expect(VerificationEngine.vcat(0) == "clear" && VerificationEngine.vcat(1.9) == "clear")
        #expect(VerificationEngine.vcat(2) == "partly" && VerificationEngine.vcat(3) == "cloudy" && VerificationEngine.vcat(48) == "fog")
        #expect(VerificationEngine.vcat(51) == "rain" && VerificationEngine.vcat(57) == "rain" && VerificationEngine.vcat(81) == "rain")
        #expect(VerificationEngine.vcat(71) == "snow" && VerificationEngine.vcat(86) == "snow" && VerificationEngine.vcat(95) == "thunder")
        #expect(VerificationEngine.vcat(60) == "cloudy" && VerificationEngine.vcat(10) == "cloudy")
    }

    @Test func evaluateErrorsNeed24Pairs() {
        // model temp = truth + 1 on even hours, truth − 0.5 on odd ones: MAE 0.75, bias 0.25
        let truth = Self.rows(30) { i, r in r.t = Double(i); r.w = i < 23 ? 10 : nil }
        let fc: [String: [Double?]] = [
            "temperature_2m_m": (0..<30).map { Double($0) + ($0 % 2 == 0 ? 1 : -0.5) },
            "wind_speed_10m_m": Array(repeating: 12, count: 30),   // only 23 truth hours: no wind error
        ]
        let s = VerificationEngine.evaluate(series: { fc[$0] }, model: "m", rows: truth)
        #expect(Self.near(s.mae[.temperature2m], 0.75) && Self.near(s.bias[.temperature2m], 0.25))
        #expect(s.mae[.windSpeed10m] == nil && s.n == 30)
        #expect(s.csi == nil && s.rainEvents == nil && s.codeAcc == nil)
        // a null forecast hour is skipped, not counted as 0
        var t2 = fc["temperature_2m_m"]!; t2[0] = nil
        let s2 = VerificationEngine.evaluate(series: { $0 == "temperature_2m_m" ? t2 : nil }, model: "m", rows: truth)
        #expect(s2.n == 29 && Self.near(s2.mae[.temperature2m], (14 * 1 + 15 * 0.5) / 29))
    }

    @Test func csiAndCategoryAccuracy() {
        // 30 hours: truth wet on 0..<10; model wet (>= 0.1) on 5..<15 → hits 5, misses 5, false alarms 5
        let truth = Self.rows(30) { i, r in r.wet = i < 10; r.cat = i < 10 ? "rain" : "cloudy" }
        let pr: [Double?] = (0..<30).map { $0 >= 5 && $0 < 15 ? 0.1 : 0.09 }
        let code: [Double?] = (0..<30).map { $0 < 10 ? 53 : ($0 < 20 ? 3 : 2) }   // drizzle counts as rain; 20..<30 wrong
        let s = VerificationEngine.evaluate(series: { ["precipitation_m": pr, "weather_code_m": code][$0] }, model: "m", rows: truth)
        #expect(Self.near(s.csi, 5.0 / 15) && s.rainEvents == 10)
        #expect(Self.near(s.codeAcc, 20.0 / 30))
        // all dry everywhere: no CSI, but 0 rain events are recorded
        let dry = Self.rows(30) { _, r in r.wet = false }
        let d = VerificationEngine.evaluate(series: { $0 == "precipitation_m" ? Array(repeating: 0, count: 30) : nil }, model: "m", rows: dry)
        #expect(d.csi == nil && d.rainEvents == 0)
    }

    @Test func skillsAndScore() {
        var s = ModelStats()
        s.mae[.temperature2m] = 1; s.mae[.windSpeed10m] = 30; s.mae[.pressureMSL] = 1
        s.csi = 0.4; s.rainEvents = 14; s.codeAcc = 0.6
        let sk = VerificationEngine.skills(s, minRain: 15)
        #expect(sk.keys == [.temperature2m, .windSpeed10m, .pressureMSL, .code])   // too few rain events: no precip skill
        #expect(sk[.temperature2m] == 0.75 && sk[.windSpeed10m] == 0 && sk[.pressureMSL] == 0.75 && sk[.code] == 0.6)
        let sk2 = VerificationEngine.skills(s, minRain: 14)
        #expect(sk2[.precip] == 0.4)
        #expect(VerificationEngine.meanScore(sk) == 53)    // (0.75 + 0 + 0.75 + 0.6) / 4 = 0.525 → 53 (JS rounds halves up)
        #expect(VerificationEngine.meanScore(MeasureValues()) == nil)
    }

    @Test func normWeightsMeanOneAndClamped() {
        let a = VerificationEngine.normWeights([("a", 0.5), ("b", 0.85)])   // raw 0.65, 1.0; mean 0.825
        #expect(a.map(\.weight) == [0.788, 1.212])
        let b = VerificationEngine.normWeights([("a", 1), ("b", 0), ("c", 0), ("d", 0), ("e", 0), ("f", 0)])   // 1.15 / 0.31667 = 3.6 → 1.8
        #expect(b.map(\.weight) == [1.8, 0.5, 0.5, 0.5, 0.5, 0.5])
        #expect(VerificationEngine.normWeights([("x", 0.3)]).map(\.weight) == [1])
        #expect(VerificationEngine.normWeights([]).isEmpty)
    }

    @Test func blendTakesTheSecondTruthsShare() {
        let r1 = Self.rows(24) { _, r in r.t = 0; r.h = 50 }
        let r2 = Self.rows(24) { _, r in r.t = 2 }
        let fc: [String: [Double?]] = ["temperature_2m_m": Array(repeating: 1, count: 24), "relative_humidity_2m_m": Array(repeating: 60, count: 24)]
        let b = VerificationEngine.blendSkills(series: { fc[$0] }, model: "m", rows1: r1, rows2: r2, w2: 0.6, minRain1: 15, minRain2: 6)
        // temperature: both truths have MAE 1 → skill 0.75 either way; humidity only in truth 1: 1 − 10/25 = 0.6
        #expect(Self.near(b.sk[.temperature2m], 0.75) && Self.near(b.sk[.relativeHumidity2m], 0.6))
        let r3 = Self.rows(24) { _, r in r.t = 3 }   // MAE 2 → 0.5: 0.6 × 0.5 + 0.4 × 0.75 = 0.6
        let c = VerificationEngine.blendSkills(series: { fc[$0] }, model: "m", rows1: r1, rows2: r3, w2: 0.6, minRain1: 15, minRain2: 6)
        #expect(Self.near(c.sk[.temperature2m], 0.6) && c.b != nil)
        let none = VerificationEngine.blendSkills(series: { fc[$0] }, model: "m", rows1: [], rows2: [], w2: 0, minRain1: 3, minRain2: 3)
        #expect(none.sk.isEmpty && none.b == nil && none.a.mae.isEmpty)
    }

    @Test func frostAndNetatmoRows() {
        let tm = Self.axis(30)
        let idx = Dictionary(uniqueKeysWithValues: tm.enumerated().map { ($1, $0) })
        var obs: [String: FrostTruth.Row] = [:]
        for (i, k) in tm.enumerated() { obs[k] = .init(t: i == 0 ? 0.5 : 5, w: 10, h: 80, p: 1010, c: i < 25 ? Double(i * 4) : nil, r: i < 2 ? 0.1 : 0) }
        obs["2020-01-01T00:00"] = .init(t: 1, w: nil, h: nil, p: nil, c: 0, r: nil)   // not on the forecast axis
        let rows = VerificationEngine.frostRows(FrostTruth(stations: [:], obs: obs), index: idx)
        #expect(rows.count == 30 && rows.map(\.tm) == tm)
        #expect(rows[0].cat == "snow" && rows[1].cat == "rain")                                  // wet: ≤ 0.5 °C snow
        #expect(rows[9].cat == "clear" && rows[10].cat == "partly" && rows[16].cat == "cloudy")   // 36 / 40 / 64 %
        #expect(rows[26].cat == nil && rows[26].wet == false)                                     // dry without cloud: no type
        // fewer than 24 cloud hours anywhere: no weather type at all
        var few = obs
        for k in tm.prefix(5) { few[k]!.c = nil }
        #expect(VerificationEngine.frostRows(FrostTruth(stations: [:], obs: few), index: idx).allSatisfy { $0.cat == nil })

        let nt = NetatmoHistory(cell: "x", obs: [tm[0]: .init(n: 5, t: 3, h: 90, r: 0.2, ws: 0.3), tm[1]: .init(n: 5, t: 3, h: 90, r: 0.2, ws: 0.29),
                                                 tm[2]: .init(n: 5, t: 3, h: nil, r: nil, ws: 1), tm[3]: .init(n: 5, t: nil, h: nil, r: 0.5, ws: nil)])
        let n = VerificationEngine.netatmoRows(nt, index: idx)
        #expect(n.map(\.wet) == [true, false, nil, false])   // a missing wet share counts as 0
        #expect(n[0].w == nil && n[0].c == nil && n[0].cat == nil && n[0].h == 90)
    }

    @Test func windowDates() {
        let w = VerificationEngine.Window(now: Date(timeIntervalSince1970: 1792922400))   // 2026-10-25T10:00Z
        #expect(w.forecastEnd == "2026-10-24" && w.frostStart == "2026-09-27" && w.era5Start == "2026-09-21" && w.era5End == "2026-10-19")
        #expect(w.recentFrom == "2026-10-18")
        #expect(w.start(frost: true) == "2026-09-27" && w.truthEnd(frost: false) == "2026-10-19")
    }

    /// A small world: 48 hours, ERA5 truth, two real models, one ERA5 copy, one without data.
    static func world() -> (fc: OpenMeteoForecastResponse, truth: OpenMeteoForecastResponse) {
        let n = 48, tm = axis(n)
        let tT: [Double?] = (0..<n).map { Double($0 % 10) }
        var s: [String: [Double?]] = [:]
        // icon: +1 °C everywhere, wind right, pressure +2 hPa; gfs: −2 °C
        s["temperature_2m_icon_seamless"] = tT.map { $0! + 1 }
        s["wind_speed_10m_icon_seamless"] = Array(repeating: 10, count: n)
        s["pressure_msl_icon_seamless"] = Array(repeating: 1012, count: n)
        s["weather_code_icon_seamless"] = (0..<n).map { $0 < 36 ? 3 : 61 }
        s["temperature_2m_gfs_seamless"] = tT.map { $0! - 2 }
        s["weather_code_gfs_seamless"] = Array(repeating: 3, count: n)
        s["temperature_2m_metno_seamless"] = tT   // outside its area the archive repeats ERA5: error 0 → left out
        s["temperature_2m_ukmo_seamless"] = Array(repeating: nil, count: n)
        let fc = OpenMeteoForecastResponse(timezone: "GMT", utcOffsetSeconds: 0, elevation: 10, time: tm, series: s)
        let truth = OpenMeteoForecastResponse(timezone: "GMT", utcOffsetSeconds: 0, elevation: 10, time: tm, series: [
            "temperature_2m": tT, "wind_speed_10m": Array(repeating: 10, count: n), "pressure_msl": Array(repeating: 1010, count: n),
            "weather_code": Array(repeating: 3, count: n), "precipitation": Array(repeating: 0, count: n),
        ])
        return (fc, truth)
    }

    @Test func wholeResultAgainstERA5() throws {
        let (fc, truth) = Self.world()
        let now = Date(timeIntervalSince1970: Self.t0 + 8 * 86400)   // recent window from 2026-10-02: the last 24 hours
        let r = try #require(VerificationEngine.result(forecast: fc, truth: truth, frost: nil, netatmo: nil, metar: nil, now: now))
        #expect(r.truth == .era5 && r.hours == 48 && r.obsWeight == 0 && r.station == nil && r.netatmoHours == 0)
        #expect(Set(r.models.keys) == ["icon_seamless", "gfs_seamless"])
        let icon = try #require(r.models["icon_seamless"]), gfs = try #require(r.models["gfs_seamless"])
        // icon: temp 0.75, wind 1, pressure 0.5, code 36/48 = 0.75 → 75; gfs: temp 0.5, code 1 → 75
        #expect(icon.skill == ["temperature_2m": 0.75, "wind_speed_10m": 1, "pressure_msl": 0.5, "code": 0.75])
        #expect(icon.mae == ["temperature_2m": 1, "wind_speed_10m": 0, "pressure_msl": 2] && icon.bias["pressure_msl"] == 2)
        #expect(icon.score == 75 && icon.codeAcc == 0.75 && icon.csi == nil && icon.obs == nil)
        #expect(gfs.skill == ["temperature_2m": 0.5, "code": 1] && gfs.score == 75 && gfs.bias["temperature_2m"] == -2)
        // last 24 hours: icon's code is 12/24 right → (0.75 + 1 + 0.5 + 0.5) / 4 = 0.6875 → 69
        #expect(icon.score7 == 69 && gfs.score7 == 75)
        // weights: temperature (0.9, 0.65)/0.775; code (0.9, 1.15)/1.025; one model only → 1
        #expect(icon.weights["temperature_2m"] == 1.161 && gfs.weights["temperature_2m"] == 0.839)
        #expect(icon.weights["weather"] == 0.878 && icon.weights["storm"] == 0.878 && gfs.weights["weather"] == 1.122)
        #expect(icon.weights["wind"] == 1 && icon.weights["pressure_msl"] == 1)
        #expect(icon.weights.keys.count == 8 && icon.weights["precip"]! == nil && gfs.weights["wind"]! == nil)
        // as consensus weights
        #expect(r.weight(model: "icon_seamless", key: .temperature2m) == 1.161 && r.weight(model: "gfs_seamless", key: .wind) == nil)
        #expect(r.weight(model: "yr", key: .weather) == nil)
        #expect(r.ranked().map(\.id) == ["gfs_seamless", "icon_seamless"])   // both 75: VERIFY_MODELS order
        #expect(r.best() == [.temperature2m: "icon_seamless", .windSpeed10m: "icon_seamless", .pressureMSL: "icon_seamless", .code: "gfs_seamless"])
        #expect(r.best(disabled: ["icon_seamless"]) == [.temperature2m: "gfs_seamless", .code: "gfs_seamless"])
        #expect(VerificationResult.scoreLevel(80) == "hi" && VerificationResult.scoreLevel(60) == "mid" && VerificationResult.scoreLevel(nil) == "lo")
        // nothing to score against
        #expect(VerificationEngine.result(forecast: fc, truth: nil, frost: nil, netatmo: nil, metar: nil, now: now) == nil)
    }

    @Test func metarBlendNeeds48Hours() throws {
        let (fc, truth) = Self.world()
        let now = Date(timeIntervalSince1970: Self.t0 + 9 * 86400)
        var obs: [String: MetarResponse.Row] = [:]
        for (i, k) in fc.time.enumerated() { obs[k] = .init(t: Double(i % 10) + 1, w: nil, c: nil, h: nil, p: nil, wet: false, cat: "cloudy") }
        let st = MetarResponse.Station(id: "ENGM", name: "Gardermoen", km: 30, elev: 200)
        let r = try #require(VerificationEngine.result(forecast: fc, truth: truth, frost: nil, netatmo: nil, metar: MetarResponse(station: st, obs: obs), now: now))
        #expect(r.obsWeight == 0.6 && r.station == .init(id: "ENGM", name: "Gardermoen", km: 30, elev: 200, reports: 48, start: "2026-10-01", end: "2026-10-02"))
        // icon is exactly right against METAR: temp 0.6 × 1 + 0.4 × 0.75 = 0.9
        let icon = try #require(r.models["icon_seamless"])
        #expect(icon.skill["temperature_2m"] == 0.9 && icon.obs?.mae["temperature_2m"] == 0 && icon.obs?.codeAcc == 0.75)
        // 47 hours: METAR is dropped
        var less = obs; less[fc.time[0]] = nil
        let r2 = try #require(VerificationEngine.result(forecast: fc, truth: truth, frost: nil, netatmo: nil, metar: MetarResponse(station: st, obs: less), now: now))
        #expect(r2.obsWeight == 0 && r2.station == nil && r2.models["icon_seamless"]?.obs == nil)
    }

    @Test func resultRoundTripsInTheWebShape() throws {
        let (fc, truth) = Self.world()
        let r = try #require(VerificationEngine.result(forecast: fc, truth: truth, frost: nil, netatmo: nil, metar: nil, now: Date(timeIntervalSince1970: Self.t0 + 9 * 86400)))
        let data = try JSONEncoder().encode(r)
        let o = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(o["recent_from"] as? String == "2026-10-03" && o["obs_weight"] as? Double == 0 && o["truth"] as? String == "era5")
        let w = try #require(((o["models"] as? [String: Any])?["gfs_seamless"] as? [String: Any])?["weights"] as? [String: Any])
        #expect(w["wind"] is NSNull && w["weather"] as? Double == 1.122)
        #expect(try JSONDecoder().decode(VerificationResult.self, from: data) == r)
    }

    @Test func consensusUsesTheWeights() {
        let n = 24
        let a = provider("icon_seamless", n) { $0[.temperature2m] = Array(repeating: 10, count: n) }
        let b = provider("gfs_seamless", n) { $0[.temperature2m] = Array(repeating: 0, count: n) }
        let f = forecast([a, b], hours: n)
        let m = ModelVerification(score: 80, score7: 80, skill: [:], mae: [:], bias: [:], csi: nil, codeAcc: nil, obs: nil, weights: ["temperature_2m": 1.5])
        let g = ModelVerification(score: 50, score7: 50, skill: [:], mae: [:], bias: [:], csi: nil, codeAcc: nil, obs: nil, weights: ["temperature_2m": 0.5])
        let v = VerificationResult(truth: .era5, start: "", end: "", hours: 0, recentFrom: "", frost: nil, netatmoHours: 0, station: nil, obsWeight: 0,
                                   models: ["icon_seamless": m, "gfs_seamless": g])
        let e = ConsensusEngine(forecast: f, weighted: true, weights: v, now: localDate(hour: 1))
        let col = e.columns(step: 1)[3]
        #expect(Self.near(e.temperature(col), 7.5))   // (10 × 1.5 + 0 × 0.5) / 2
        let off = ConsensusEngine(forecast: f, weighted: false, weights: v, now: localDate(hour: 1))
        #expect(Self.near(off.temperature(off.columns(step: 1)[3]), 5))
    }

    // MARK: the service

    @Test func exactURLs() {
        let la = VerificationService.cell(59.9139), lo = VerificationService.cell(10.7522)
        #expect(la == 59.9 && lo == 10.8 && CacheKey.verify(lat: la, lon: lo) == "vf3:59.9:10.8")
        #expect(VerificationService.historicalURL(lat: la, lon: lo, start: "2026-09-27", end: "2026-10-24").absoluteString ==
                "https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=59.9&longitude=10.8&hourly=temperature_2m%2Cprecipitation%2Cwind_speed_10m%2Ccloud_cover%2Crelative_humidity_2m%2Cpressure_msl%2Cweather_code&timezone=UTC&start_date=2026-09-27&end_date=2026-10-24&models=ecmwf_aifs025_single%2Cecmwf_ifs025%2Cgfs_seamless%2Cicon_seamless%2Cgem_seamless%2Cmeteofrance_seamless%2Cukmo_seamless%2Cjma_seamless%2Ccma_grapes_global%2Cknmi_seamless%2Cdmi_seamless%2Cmetno_seamless")
        #expect(VerificationService.archiveURL(lat: 51.5, lon: -0.1, start: "2026-09-21", end: "2026-10-19").absoluteString ==
                "https://archive-api.open-meteo.com/v1/archive?latitude=51.5&longitude=-0.1&hourly=temperature_2m%2Cprecipitation%2Cwind_speed_10m%2Ccloud_cover%2Crelative_humidity_2m%2Cpressure_msl%2Cweather_code&timezone=UTC&start_date=2026-09-21&end_date=2026-10-19")
    }

    // Test bodies are literal dictionaries; a failure here is a broken test, so it may trap.
    // swiftlint:disable:next force_try
    static func json(_ o: Any) -> Data { try! JSONSerialization.data(withJSONObject: o) }
    static func omBody(_ r: OpenMeteoForecastResponse) -> Data {
        var h: [String: Any] = ["time": r.time]
        for (k, v) in r.series { h[k] = v.map { $0 ?? NSNull() as Any } }
        return json(["latitude": 0, "longitude": 0, "hourly": h])
    }

    /// Norway, Frost with too few hours: falls back to ERA5 + METAR; the result is cached under vf3.
    @Test func norwayFallsBackToERA5AndCaches() async throws {
        let (fc, truth) = Self.world()
        let now = Date(timeIntervalSince1970: 1792922400)   // 2026-10-25T10:00Z
        let fcBody = Self.omBody(fc), truthBody = Self.omBody(truth)
        let stub = StubTransport { req in
            let u = req.url!.absoluteString
            if u.contains("frost.php") { return (200, Self.json(["stations": [:], "obs": ["2026-10-01T00:00": ["t": 1]]]), [:]) }
            if u.contains("netatmo.php") { return (200, Self.json(["cell": "x", "obs": [:]]), [:]) }
            if u.contains("metar.php") { return (200, Self.json(["station": NSNull(), "obs": []]), [:]) }
            if u.contains("historical-forecast-api") { return (200, fcBody, [:]) }
            if u.contains("archive-api") { return (200, truthBody, [:]) }
            return (404, Data(), [:])
        }
        let http = HTTPClient(transport: stub, gate: nil, identity: ClientIdentity(version: "1.2", build: "7"))
        let svc = VerificationService(http: http, cache: ForecastCache(directory: tempDir(), clock: { now }), clock: { now })
        let r = try await svc.verification(lat: 59.9139, lon: 10.7522)
        #expect(r.truth == .era5 && r.start == "2026-09-21" && r.end == "2026-10-19" && r.models.count == 2)
        let urls = stub.requests.map { $0.url!.absoluteString }
        #expect(urls.filter { $0.contains("frost.php") } == Array(repeating: "https://glett.no/api/frost.php?truth=1&lat=59.9&lon=10.8&from=2026-09-27&to=2026-10-24", count: 1))
        #expect(urls.contains("https://glett.no/api/netatmo.php?history=1&lat=59.9&lon=10.8&days=28"))
        #expect(urls.contains("https://glett.no/api/metar.php?lat=59.9&lon=10.8"))
        #expect(urls.contains(VerificationService.historicalURL(lat: 59.9, lon: 10.8, start: "2026-09-21", end: "2026-10-24").absoluteString))
        #expect(urls.contains(VerificationService.archiveURL(lat: 59.9, lon: 10.8, start: "2026-09-21", end: "2026-10-19").absoluteString))
        let glett = stub.requests.first { $0.url!.host == "glett.no" }!
        #expect(glett.value(forHTTPHeaderField: "User-Agent") == "Glett-iOS/1.2 (+https://glett.no; mail@hauganmg.no)")
        #expect(glett.value(forHTTPHeaderField: "X-Glett-Client") == "ios/7")
        let count = stub.requests.count
        let again = try await svc.verification(lat: 59.94, lon: 10.76)   // same 0.1° cell: from the cache
        #expect(again == r && stub.requests.count == count)
        #expect(await svc.cachedVerification(lat: 59.9, lon: 10.8) == r)
    }

    /// Norway with a week of Frost hours: Frost is the truth, Netatmo blended in, no ERA5 and no METAR asked.
    @Test func norwayWithFrost() async throws {
        let now = Date(timeIntervalSince1970: 1792922400)
        let n = 200, tm = Self.axis(n, from: 1790467200)   // from 2026-09-27
        let tT: [Double?] = (0..<n).map { Double($0 % 7) }
        let fcBody = Self.omBody(OpenMeteoForecastResponse(timezone: "GMT", utcOffsetSeconds: 0, elevation: 0, time: tm, series: ["temperature_2m_icon_seamless": tT.map { $0! + 2 }]))
        var obs: [String: Any] = [:], nt: [String: Any] = [:]
        for (i, k) in tm.enumerated() { obs[k] = ["t": tT[i]!]; if i < 30 { nt[k] = ["n": 6, "t": tT[i]! + 2, "h": 80] } }
        let frostBody = Self.json(["stations": ["t": ["id": "SN18700", "name": "Oslo - Blindern", "km": 3.1]], "obs": obs])
        let ntBody = Self.json(["cell": "x", "obs": nt])
        let stub = StubTransport { req in
            let u = req.url!.absoluteString
            if u.contains("frost.php") { return (200, frostBody, [:]) }
            if u.contains("netatmo.php") { return (200, ntBody, [:]) }
            if u.contains("historical-forecast-api") { return (200, fcBody, [:]) }
            return (500, Data(), [:])
        }
        let svc = VerificationService(http: HTTPClient(transport: stub, gate: nil, identity: ClientIdentity(version: "1", build: "1")),
                                      cache: ForecastCache(directory: tempDir(), clock: { now }), clock: { now })
        let r = try await svc.verification(lat: 59.9139, lon: 10.7522)
        #expect(r.truth == .frost && r.start == "2026-09-27" && r.end == "2026-10-24" && r.hours == 200 && r.netatmoHours == 30 && r.obsWeight == 0.3)
        #expect(r.frost?.stations["t"]?.name == "Oslo - Blindern")
        // MAE 2 vs Frost (0.5), 0 vs Netatmo (1): 0.3 × 1 + 0.7 × 0.5 = 0.65
        #expect(r.models["icon_seamless"]?.skill["temperature_2m"] == 0.65 && r.models["icon_seamless"]?.score == 65)
        #expect(!stub.requests.contains { $0.url!.host == "archive-api.open-meteo.com" || $0.url!.path.hasSuffix("metar.php") })
    }

    @Test func noERA5IsAnError() async throws {
        let (fc, _) = Self.world()
        let fcBody = Self.omBody(fc)
        let stub = StubTransport { req in
            let u = req.url!.absoluteString
            if u.contains("historical-forecast-api") { return (200, fcBody, [:]) }
            if u.contains("archive-api") { return (400, Self.json(["error": true, "reason": "Parameter end_date out of range"]), [:]) }
            return (500, Data(), [:])
        }
        let svc = VerificationService(http: HTTPClient(transport: stub, gate: nil, identity: ClientIdentity(version: "1", build: "1")), cache: ForecastCache(directory: tempDir()))
        await #expect(throws: GlettError.http(host: "archive-api.open-meteo.com", status: 400, reason: "Parameter end_date out of range")) {
            try await svc.verification(lat: 51.5, lon: -0.12)
        }
        let empty = StubTransport { _ in (200, Self.json(["hourly": ["time": []]]), [:]) }
        let svc2 = VerificationService(http: HTTPClient(transport: empty, gate: nil, identity: ClientIdentity(version: "1", build: "1")), cache: ForecastCache(directory: tempDir()))
        await #expect(throws: VerificationError.unavailable) { try await svc2.verification(lat: 51.5, lon: -0.12) }
    }

    @Test func weatherServiceHook() async throws {
        let (fc, truth) = Self.world()
        let fcBody = Self.omBody(fc), truthBody = Self.omBody(truth)
        let stub = StubTransport { req in
            let u = req.url!.absoluteString
            if u.contains("historical-forecast-api") { return (200, fcBody, [:]) }
            if u.contains("archive-api") { return (200, truthBody, [:]) }
            return (500, Data(), [:])
        }
        let ws = WeatherService(transport: stub, cache: ForecastCache(directory: tempDir()), gate: nil, identity: ClientIdentity(version: "1", build: "1"))
        let london = Place(id: "x", name: "London", lat: 51.5072, lon: -0.1276)
        async let a = ws.verification(for: london)
        async let b = ws.verification(for: london)
        let (ra, rb) = try await (a, b)
        #expect(ra == rb && ra.models.count == 2)
        #expect(stub.requests.filter { $0.url!.host == "historical-forecast-api.open-meteo.com" }.count == 1)   // one run shared
        #expect(await ws.cachedVerification(for: london) == ra)
    }
}
