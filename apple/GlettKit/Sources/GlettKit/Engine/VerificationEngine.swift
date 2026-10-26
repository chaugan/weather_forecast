import Foundation

/// One truth hour matched to the archived forecast (`rows` of js/data.js:223): `j` is the index on the forecast's time
/// axis, `tm` its "YYYY-MM-DDTHH:MM" (UTC). t °C, w km/h, c %, h %, p hPa; `wet` = measured precipitation; `cat` a
/// verification category name (`vcat`), or whatever METAR's PHP sent.
public struct TruthRow: Sendable, Hashable {
    public var j: Int
    public var tm: String
    public var t: Double?, w: Double?, c: Double?, h: Double?, p: Double?
    public var wet: Bool?
    public var cat: String?

    public init(j: Int, tm: String, t: Double? = nil, w: Double? = nil, c: Double? = nil, h: Double? = nil, p: Double? = nil, wet: Bool? = nil, cat: String? = nil) {
        self.j = j; self.tm = tm; self.t = t; self.w = w; self.c = c; self.h = h; self.p = p; self.wet = wet; self.cat = cat
    }

    /// `r[k]` for a `KEYS` entry.
    public subscript(m: VerificationMeasure) -> Double? {
        switch m {
        case .temperature2m: t
        case .windSpeed10m: w
        case .cloudCover: c
        case .relativeHumidity2m: h
        case .pressureMSL: p
        case .precip, .code: nil
        }
    }
}

/// Values keyed by measurement in insertion order, like a JS object (`Object.values` order decides the summation order
/// of the score, so it is kept).
public struct MeasureValues: Sendable, Hashable {
    public private(set) var pairs: [(key: VerificationMeasure, value: Double)] = []
    public init() {}
    public subscript(k: VerificationMeasure) -> Double? {
        get { pairs.first { $0.key == k }?.value }
        set {
            if let i = pairs.firstIndex(where: { $0.key == k }) {
                if let newValue { pairs[i].value = newValue } else { pairs.remove(at: i) }
            } else if let newValue { pairs.append((k, newValue)) }
        }
    }
    public var keys: [VerificationMeasure] { pairs.map(\.key) }
    public var values: [Double] { pairs.map(\.value) }
    public var isEmpty: Bool { pairs.isEmpty }
    /// `roundMap(o, d)` (js/data.js:259) as the result's string-keyed dictionary.
    public func rounded(_ d: Int) -> [String: Double] {
        Dictionary(uniqueKeysWithValues: pairs.map { ($0.key.rawValue, JS.round($0.value, d)) })
    }
    public static func == (a: Self, b: Self) -> Bool { a.pairs.elementsEqual(b.pairs) { $0.key == $1.key && $0.value == $1.value } }
    public func hash(into h: inout Hasher) { for p in pairs { h.combine(p.key); h.combine(p.value) } }
}

/// One model against one truth (`evaluate`'s `s`, js/data.js:225).
public struct ModelStats: Sendable, Hashable {
    public var mae = MeasureValues()
    public var bias = MeasureValues()
    /// The most pairs of any continuous measurement.
    public var n = 0
    /// Critical success index of wet hours; nil when there was nothing to count.
    public var csi: Double?
    /// Measured wet hours (hits + misses); nil when the model has no precipitation series.
    public var rainEvents: Int?
    public var codeAcc: Double?
    public init() {}
}

/// The reliability maths of js/data.js:209-373: archived forecasts against measured truth, skill per measurement,
/// a 0–100 score and the consensus weights. Pure functions; `VerificationService` does the fetching and caching.
public enum VerificationEngine {
    /// `WINDOW_DAYS` (js/data.js:14): the comparison window.
    public static let windowDays = 28
    /// `LAG_DAYS` (js/data.js:15): ERA5 is published a few days late.
    public static let lagDays = 6
    /// `MIN_OBS` (js/data.js:16): matched METAR hours needed.
    public static let minObs = 48
    /// `OBS_WEIGHT` (js/data.js:17): METAR's share of the blended skill (the rest ERA5).
    public static let obsWeight = 0.6
    /// `NETATMO_WEIGHT` (js/data.js:18): Norway, Netatmo's share (the rest MET stations via Frost).
    public static let netatmoWeight = 0.3
    /// `RECENT_DAYS` (js/data.js:19): the "last 7 days" score.
    public static let recentDays = 7
    /// `VERIFY_VARS` (js/data.js:35): the hourly variables of both requests.
    public static let verifyVars = ["temperature_2m", "precipitation", "wind_speed_10m", "cloud_cover", "relative_humidity_2m", "pressure_msl", "weather_code"]
    /// `cnt >= 24` (js/data.js:230, 243): pairs needed for an error or an accuracy.
    public static let minPairs = 24
    /// Frost must give at least a week of hours to be the truth (js/data.js:309).
    public static let minFrostHours = 24 * 7
    /// Netatmo rows needed to be blended in (js/data.js:328).
    public static let minNetatmoRows = 24
    /// A wet hour: 0.1 mm (js/data.js:235, 267, 335).
    public static let wetThreshold = 0.1
    /// Netatmo's rain gauges: wet from 0.2 mm with at least 30 % of the stations wet (js/data.js:281).
    public static let netatmoWetMM = 0.2
    public static let netatmoWetShare = 0.3
    /// Frost: snow at or below 0.5 °C, cloud ≤ 37.5 % clear, ≤ 62.5 % partly (js/data.js:270-271).
    public static let snowTemperature = 0.5
    public static let clearCloud = 37.5
    public static let partlyCloud = 62.5
    /// `normWeights` (js/data.js:254-258): skill + 0.15 over its mean, clamped to [0.5, 1.8].
    public static let weightOffset = 0.15
    public static let weightMin = 0.5
    public static let weightMax = 1.8
    /// MAEs summing to less than this mean the archive returned a copy of ERA5 (js/data.js:352).
    public static let era5CopyMAE = 0.001
    /// Rain events needed for the precip skill: whole window Frost 10 / ERA5 15, second truth 6, last 7 days 3 (js/data.js:350, 353).
    public static let minRainFrost = 10, minRainERA5 = 15, minRainObs = 6, minRainRecent = 3

    // MARK: per model (js/data.js:211-293)

    /// `vcat(c)` (js/data.js:211-222) as the category name.
    public static func vcat(_ c: Double?) -> String? { WeatherCategory.verification(code: c)?.rawValue }

    /// `evaluate(fc, m, rows)` (js/data.js:224-246). `series` gives the archived forecast's `<variable>_<model>` array.
    public static func evaluate(series: (String) -> [Double?]?, model m: String, rows: [TruthRow]) -> ModelStats {
        var s = ModelStats()
        func at(_ a: [Double?], _ j: Int) -> Double? { j >= 0 && j < a.count ? a[j] : nil }
        for v in VerificationMeasure.continuous {
            guard let a = series("\(v.rawValue)_\(m)") else { continue }
            var acc = 0.0, bias = 0.0, cnt = 0
            for r in rows {
                guard let x = at(a, r.j), let y = r[v] else { continue }
                let d = x - y
                acc += abs(d); bias += d; cnt += 1
            }
            if cnt >= minPairs { s.mae[v] = acc / Double(cnt); s.bias[v] = bias / Double(cnt); s.n = max(s.n, cnt) }
        }
        if let p = series("precipitation_\(m)") {   // rain: critical success index over wet hours (model >= 0.1 mm)
            var hit = 0, miss = 0, fa = 0
            for r in rows {
                guard let x = at(p, r.j), let wet = r.wet else { continue }
                let f = x >= wetThreshold
                if wet && f { hit += 1 } else if wet { miss += 1 } else if f { fa += 1 }
            }
            if hit + miss + fa > 0 { s.csi = Double(hit) / Double(hit + miss + fa) }
            s.rainEvents = hit + miss
        }
        if let c = series("weather_code_\(m)") {   // weather category agreement
            var ok = 0, tot = 0
            for r in rows {
                guard let x = at(c, r.j), let cat = r.cat else { continue }
                tot += 1
                if vcat(x) == cat { ok += 1 }
            }
            if tot >= minPairs { s.codeAcc = Double(ok) / Double(tot) }
        }
        return s
    }

    /// `skills(s, minRain)` (js/data.js:247-253): `max(0, 1 − MAE/VTOL)`, precip = CSI with enough rain events, code = accuracy.
    public static func skills(_ s: ModelStats, minRain: Int) -> MeasureValues {
        var sk = MeasureValues()
        for v in VerificationMeasure.continuous { if let e = s.mae[v], let tol = v.tolerance { sk[v] = max(0, 1 - e / tol) } }
        if let csi = s.csi, (s.rainEvents ?? 0) >= minRain { sk[.precip] = csi }
        if let a = s.codeAcc { sk[.code] = a }
        return sk
    }

    /// `normWeights(vals)` (js/data.js:254-258): mean 1, limited to [0.5, 1.8], 3 decimals. Pairs in model order.
    public static func normWeights(_ vals: [(model: String, skill: Double)]) -> [(model: String, weight: Double)] {
        guard !vals.isEmpty else { return [] }
        let raw = vals.map { $0.skill + weightOffset }
        var total = 0.0
        for x in raw { total += x }
        let mean = total / Double(raw.count)
        return vals.indices.map { (vals[$0].model, JS.round(min(weightMax, max(weightMin, raw[$0] / mean)), 3)) }
    }

    /// `blendSkills` (js/data.js:286-292): skill from the main truth and an optional second one with share `w2`.
    public static func blendSkills(series: (String) -> [Double?]?, model m: String, rows1: [TruthRow], rows2: [TruthRow], w2: Double,
                                   minRain1: Int, minRain2: Int) -> (a: ModelStats, b: ModelStats?, sk: MeasureValues) {
        let a = rows1.isEmpty ? ModelStats() : evaluate(series: series, model: m, rows: rows1)
        let b = rows2.isEmpty ? nil : evaluate(series: series, model: m, rows: rows2)
        let s1 = skills(a, minRain: minRain1), s2 = b.map { skills($0, minRain: minRain2) } ?? MeasureValues()
        var sk = MeasureValues()
        var seen = Set<VerificationMeasure>()
        for v in s1.keys + s2.keys where seen.insert(v).inserted {
            if let x1 = s1[v], let x2 = s2[v] { sk[v] = w2 * x2 + (1 - w2) * x1 } else { sk[v] = s1[v] ?? s2[v] }
        }
        return (a, b, sk)
    }

    /// `meanScore(sk)` (js/data.js:293): `round(mean × 100)`, nil without skills.
    public static func meanScore(_ sk: MeasureValues) -> Int? {
        let vals = sk.values
        guard !vals.isEmpty else { return nil }
        var total = 0.0
        for x in vals { total += x }
        return Int(JS.round(total / Double(vals.count) * 100))
    }

    // MARK: truth rows (js/data.js:261-284, 331-344)

    /// `frostRows(frost, fIdx)` (js/data.js:262-275): MET stations, weather type from precipitation, else cloud cover.
    public static func frostRows(_ frost: FrostTruth, index fIdx: [String: Int]) -> [TruthRow] {
        let hasCloud = frost.obs.values.filter { $0.c != nil }.count >= minPairs   // no cloud station nearby: no weather-type check
        var rows: [TruthRow] = []
        for hk in frost.obs.keys.sorted() {   // api/frost.php sends the hours sorted (ksort)
            let o = frost.obs[hk]!
            guard let j = fIdx[hk] else { continue }
            let wet = o.r.map { $0 >= wetThreshold }
            var cat: String?
            if !hasCloud { cat = nil }
            else if wet == true { cat = (o.t.map { $0 <= snowTemperature } ?? false) ? "snow" : "rain" }
            else if wet == false, let c = o.c { cat = c <= clearCloud ? "clear" : c <= partlyCloud ? "partly" : "cloudy" }
            rows.append(TruthRow(j: j, tm: hk, t: o.t, w: o.w, c: o.c, h: o.h, p: o.p, wet: wet, cat: cat))
        }
        return rows
    }

    /// `netatmoRows(nt, fIdx)` (js/data.js:277-284): temperature, humidity and wet hours from Glett's snapshots.
    public static func netatmoRows(_ nt: NetatmoHistory, index fIdx: [String: Int]) -> [TruthRow] {
        var rows: [TruthRow] = []
        for hk in nt.obs.keys.sorted() {
            let o = nt.obs[hk]!
            guard let j = fIdx[hk] else { continue }
            let wet = o.r.map { $0 >= netatmoWetMM && (o.ws ?? 0) >= netatmoWetShare }
            rows.append(TruthRow(j: j, tm: hk, t: o.t, h: o.h, wet: wet))
        }
        return rows
    }

    /// ERA5 as truth (js/data.js:331-336).
    public static func era5Rows(_ truth: OpenMeteoForecastResponse, index fIdx: [String: Int]) -> [TruthRow] {
        func v(_ k: String, _ i: Int) -> Double? { guard let a = truth.series[k], i < a.count else { return nil }; return a[i] }
        var rows: [TruthRow] = []
        for (i, tm) in truth.time.enumerated() {
            guard let j = fIdx[tm] else { continue }
            rows.append(TruthRow(j: j, tm: tm, t: v("temperature_2m", i), w: v("wind_speed_10m", i), c: v("cloud_cover", i),
                                 h: v("relative_humidity_2m", i), p: v("pressure_msl", i),
                                 wet: v("precipitation", i).map { $0 >= wetThreshold }, cat: vcat(v("weather_code", i))))
        }
        return rows
    }

    /// METAR hours as rows (js/data.js:338).
    public static func metarRows(_ metar: MetarResponse, index fIdx: [String: Int]) -> [TruthRow] {
        metar.obs.keys.sorted().compactMap { hk in
            guard let j = fIdx[hk] else { return nil }
            let o = metar.obs[hk]!
            return TruthRow(j: j, tm: hk, t: o.t, w: o.w, c: o.c, h: o.h, p: o.p, wet: o.wet, cat: o.cat)
        }
    }

    // MARK: the window (js/data.js:299, 303, 312-313, 346)

    /// The dates of one run ("YYYY-MM-DD", UTC), from the moment it starts.
    public struct Window: Sendable, Hashable {
        /// Yesterday: the last day of archived forecasts (and of Frost).
        public var forecastEnd: String
        /// 28 days back: Frost's first day, and the window's start with Frost.
        public var frostStart: String
        /// 34 days back: the window's start with ERA5.
        public var era5Start: String
        /// 6 days back: ERA5's last day.
        public var era5End: String
        /// 7 days back.
        public var recentFrom: String

        public init(now: Date) {
            let t = now.timeIntervalSince1970, day = 86400.0
            forecastEnd = JS.isoUTC(t - day, 10)
            frostStart = JS.isoUTC(t - Double(VerificationEngine.windowDays) * day, 10)
            era5Start = JS.isoUTC(t - Double(VerificationEngine.lagDays + VerificationEngine.windowDays) * day, 10)
            era5End = JS.isoUTC(t - Double(VerificationEngine.lagDays) * day, 10)
            recentFrom = JS.isoUTC(t - Double(VerificationEngine.recentDays) * day, 10)
        }

        public func start(frost: Bool) -> String { frost ? frostStart : era5Start }
        public func truthEnd(frost: Bool) -> String { frost ? forecastEnd : era5End }
    }

    // MARK: the whole result (js/data.js:323-370)

    /// Scores every `VERIFY_MODELS` model from the fetched inputs. `frost` must already have passed `usableFrost`;
    /// without it `truth` (ERA5) is required. Returns nil when there is nothing to score against.
    public static func result(forecast fc: OpenMeteoForecastResponse, truth: OpenMeteoForecastResponse?, frost: FrostTruth?,
                              netatmo nt: NetatmoHistory?, metar: MetarResponse?, now: Date) -> VerificationResult? {
        let useFrost = frost != nil
        guard !fc.time.isEmpty, useFrost || !(truth?.time.isEmpty ?? true) else { return nil }
        let win = Window(now: now)
        var fIdx: [String: Int] = [:]
        for (i, tm) in fc.time.enumerated() { fIdx[tm] = i }   // `new Map(...)`: a repeated time keeps the last index
        var rows1: [TruthRow] = [], rows2: [TruthRow] = [], w2 = 0.0
        var stationInfo: VerificationResult.Station?
        if let frost {
            rows1 = frostRows(frost, index: fIdx)
            rows2 = nt.map { netatmoRows($0, index: fIdx) } ?? []
            if rows2.count < minNetatmoRows { rows2 = [] }
            w2 = rows2.isEmpty ? 0 : netatmoWeight
        } else if let truth {
            rows1 = era5Rows(truth, index: fIdx)
            if let metar, let st = metar.station {
                rows2 = metarRows(metar, index: fIdx)
                if rows2.count >= minObs {
                    let times = metar.obs.keys.sorted()
                    stationInfo = .init(id: st.id, name: st.name, km: st.km, elev: st.elev, reports: rows2.count,
                                        start: String(times[0].prefix(10)), end: String(times[times.count - 1].prefix(10)))
                    w2 = obsWeight
                } else { rows2 = [] }
            }
        }
        let recent = { (rows: [TruthRow]) in rows.filter { $0.tm >= win.recentFrom } }
        let series = { (k: String) in fc.series[k] }
        var out: [String: ModelVerification] = [:]
        var blend: [(model: String, sk: MeasureValues)] = []
        for m in ModelCatalog.verifyModels {
            let (a, b, sk) = blendSkills(series: series, model: m, rows1: rows1, rows2: rows2, w2: w2,
                                         minRain1: useFrost ? minRainFrost : minRainERA5, minRain2: minRainObs)
            let maes = a.mae.values
            var total = 0.0
            for x in maes { total += x }
            if maes.isEmpty || total < era5CopyMAE { continue }   // outside coverage: the archive returns a copy of ERA5 (error 0)
            let r7 = blendSkills(series: series, model: m, rows1: recent(rows1), rows2: recent(rows2), w2: w2, minRain1: minRainRecent, minRain2: minRainRecent)
            blend.append((m, sk))
            out[m] = ModelVerification(
                score: meanScore(sk), score7: meanScore(r7.sk), skill: sk.rounded(3), mae: a.mae.rounded(2), bias: a.bias.rounded(2),
                csi: a.csi.map { JS.round($0, 3) }, codeAcc: a.codeAcc.map { JS.round($0, 3) },
                obs: b.map { .init(mae: $0.mae.rounded(2), bias: $0.bias.rounded(2), csi: $0.csi.map { JS.round($0, 3) }, codeAcc: $0.codeAcc.map { JS.round($0, 3) }) },
                weights: [:])
        }
        // weights per measurement across the scored models (js/data.js:359-362)
        var byParam: [(key: VerificationMeasure, vals: [(model: String, skill: Double)])] = []
        for (m, ps) in blend {
            for (v, x) in ps.pairs {
                if let i = byParam.firstIndex(where: { $0.key == v }) { byParam[i].vals.append((m, x)) } else { byParam.append((v, [(m, x)])) }
            }
        }
        var W: [String: [VerificationMeasure: Double]] = [:]
        for (v, vals) in byParam { for (m, w) in normWeights(vals) { W[m, default: [:]][v] = w } }
        for m in out.keys {
            out[m]!.weights = weights(W[m] ?? [:])
        }
        return VerificationResult(truth: useFrost ? .frost : .era5, start: win.start(frost: useFrost), end: win.truthEnd(frost: useFrost),
                                  hours: rows1.count, recentFrom: win.recentFrom, frost: frost.map { .init(stations: $0.stations) },
                                  netatmoHours: useFrost ? rows2.count : 0, station: stationInfo, obsWeight: w2, models: out)
    }

    /// `out[m].weights` (js/data.js:365-366): the measurement weights under the consensus keys (`weather` and `storm`
    /// both use the weather-type skill).
    public static func weights(_ w: [VerificationMeasure: Double]) -> [String: Double?] {
        [
            WeightKey.weather.rawValue: w[.code], WeightKey.temperature2m.rawValue: w[.temperature2m], WeightKey.precip.rawValue: w[.precip],
            WeightKey.wind.rawValue: w[.windSpeed10m], WeightKey.storm.rawValue: w[.code], WeightKey.cloudCover.rawValue: w[.cloudCover],
            WeightKey.relativeHumidity2m.rawValue: w[.relativeHumidity2m], WeightKey.pressureMSL.rawValue: w[.pressureMSL],
        ]
    }

    /// js/data.js:309: Frost counts as truth only with at least a week of hours.
    public static func usableFrost(_ f: FrostTruth?) -> FrostTruth? {
        guard let f, f.obs.count >= minFrostHours else { return nil }
        return f
    }
}
