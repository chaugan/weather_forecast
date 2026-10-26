import Foundation

/// A value with its weight (`{v, w}` of `wpairs`, js/app.js:216).
public struct WeightedValue<V: Sendable>: Sendable {
    public var v: V
    public var w: Double
    public init(v: V, w: Double) { self.v = v; self.w = w }
}

/// A category and its weighted share of the active models.
public struct CategoryShare: Sendable, Hashable {
    public var category: WeatherCategory
    public var share: Double
    public init(category: WeatherCategory, share: Double) { self.category = category; self.share = share }
}

/// The model-agreement maths of js/app.js:147-228 and 360-372, for one forecast and one set of choices.
/// A value type: build one per render (it is cheap) with the current time, the disabled models and the weights.
public struct ConsensusEngine: Sendable {
    // MARK: Constants (js/app.js:147-151, 207)

    /// `TOL` (js/app.js:147): the spread (population sd) at which agreement is 0.
    public static let tolerance: [HourlyVariable: Double] = [.temperature2m: 4, .windSpeed10m: 15, .cloudCover: 50, .relativeHumidity2m: 25, .pressureMSL: 4]
    /// `RAIN_THR` (js/app.js:148): mm per step that counts as rain.
    public static let rainThreshold = 0.2
    /// `WIND_THR` (js/app.js:149): km/h (Beaufort 5).
    public static let windThreshold = 30.0
    /// `GUST_THR` (js/app.js:150): km/h.
    public static let gustThreshold = 60.0
    /// `STRONG_GUST` (js/app.js:151): km/h (~12 m/s); weaker gusts get no summary line.
    public static let strongGust = 43.0
    /// `SHORT_BOOST_HOURS` (js/app.js:207).
    public static let shortBoostHours = 6
    /// `SHORT_BOOST_MAX` (js/app.js:207).
    public static let shortBoostMax = 1.0
    /// `SHORT_BOOST_IDS` (js/app.js:207): MET's observation-corrected short-range forecasts.
    public static let shortBoostIDs: Set<String> = ["metno_seamless", "yr"]
    /// Thunder signal from CAPE alone (js/app.js:371), J/kg.
    public static let capeThunder = 1000.0

    // MARK: State

    public let forecast: Forecast
    /// `activeProviders()` (js/app.js:66-69): unique providers not switched off; all unique ones if that leaves none.
    public let providers: [Provider]
    public let weighted: Bool
    public let weights: (any ConsensusWeights)?
    public let now: Date
    /// `nowIdx()`.
    public let nowIndex: Int

    /// - Parameters:
    ///   - forecast: a prepared forecast (`Forecast.prepare()`; the service returns prepared ones).
    ///   - disabled: model ids the user switched off (`glett.disabled`).
    ///   - weighted: "weight by reliability" (`glett.weighted`, default on).
    ///   - weights: the reliability weights; nil = none loaded yet (the web's `!state.verify`).
    public init(forecast: Forecast, disabled: Set<String> = [], weighted: Bool = true, weights: (any ConsensusWeights)? = nil, now: Date = Date()) {
        self.forecast = forecast.isDay.count == forecast.time.count ? forecast : forecast.prepared()
        let all = self.forecast.uniqueProviders
        let act = all.filter { !disabled.contains($0.id) }
        providers = act.isEmpty ? all : act
        self.weighted = weighted
        self.weights = weights
        self.now = now
        nowIndex = self.forecast.nowIndex(now: now)
    }

    /// `uniqueProviders().length`.
    public var uniqueCount: Int { forecast.uniqueProviders.count }

    public func columns(step: Int = 1, day: Int? = nil) -> [StepColumn] { forecast.columns(step: step, day: day, now: now) }
    public var todayIndex: Int { forecast.todayIndex(now: now) }

    // MARK: Weights (js/app.js:203-219)

    /// `W(p, key)`: the reliability weight, 1 when weighting is off, nothing is loaded, or the weight is missing/0/NaN.
    public func weight(_ p: Provider, _ key: WeightKey) -> Double {
        guard weighted, let weights, let w = weights.weight(model: p.id, key: key), w != 0, !w.isNaN else { return 1 }
        return w
    }

    /// `shortBoost(p, a)`: MET Nordic and Yr count up to twice for the current hour, fading to 1 over 6 hours.
    /// `a` is the first hour of the step (nil = no step, no boost).
    public func shortBoost(_ p: Provider, _ a: Int?) -> Double {
        guard Self.shortBoostIDs.contains(p.id), let a else { return 1 }
        let n = nowIndex
        if n < 0 { return 1 }
        let h = a - n
        if h < 0 || h >= Self.shortBoostHours { return 1 }
        return 1 + Self.shortBoostMax * (1 - Double(h) / Double(Self.shortBoostHours))
    }

    /// `wpairs(key, fn)`: each active provider's value and weight, without nulls and NaN. `start` is the step's first hour
    /// when `fn` aggregates a step (the web's `aggLastA`), nil when it reads the series directly (no short-range boost).
    public func pairs(_ key: WeightKey, start: Int?, _ fn: (Provider) -> Double?) -> [WeightedValue<Double>] {
        var out: [WeightedValue<Double>] = []
        for p in providers {
            guard let v = fn(p), !v.isNaN else { continue }
            out.append(WeightedValue(v: v, w: weight(p, key) * shortBoost(p, start)))
        }
        return out
    }

    /// `wpairs` for non-numeric values (categories).
    public func pairs<V: Sendable>(_ key: WeightKey, start: Int?, _ fn: (Provider) -> V?) -> [WeightedValue<V>] {
        var out: [WeightedValue<V>] = []
        for p in providers {
            guard let v = fn(p) else { continue }
            out.append(WeightedValue(v: v, w: weight(p, key) * shortBoost(p, start)))
        }
        return out
    }

    /// `wsum(pr)`.
    public static func wsum<V>(_ pr: [WeightedValue<V>]) -> Double { pr.reduce(0) { $0 + $1.w } }
    /// `wmean(pr)`: Σv·w / Σw, nil when empty.
    public static func wmean(_ pr: [WeightedValue<Double>]) -> Double? {
        guard !pr.isEmpty else { return nil }
        return pr.reduce(0) { $0 + $1.v * $1.w } / wsum(pr)
    }
    /// `wshare(pr, f)`: Σw where f / Σw, nil when empty.
    public static func wshare(_ pr: [WeightedValue<Double>], _ f: (Double) -> Bool) -> Double? {
        guard !pr.isEmpty else { return nil }
        return pr.filter { f($0.v) }.reduce(0) { $0 + $1.w } / wsum(pr)
    }

    /// `agg(p, param, c.a, c.b)`.
    public func aggregate(_ p: Provider, _ param: AggregateParam, _ c: StepColumn) -> Double? {
        StepAggregation.aggregate(p, param, c.a, c.b)
    }

    /// The weighted mean of an aggregate over the step: `wmean(wpairs(key, p => agg(p, param, c.a, c.b)))`.
    public func weightedMean(_ param: AggregateParam, key: WeightKey, _ c: StepColumn) -> Double? {
        Self.wmean(pairs(key, start: c.a) { aggregate($0, param, c) })
    }

    /// `nn(P.map(p => agg(p, param, c.a, c.b)))`: the active providers' values, unweighted.
    public func values(_ param: AggregateParam, _ c: StepColumn) -> [Double] {
        JS.nn(providers.map { aggregate($0, param, c) })
    }

    // MARK: Per step (js/app.js:220-228, 272, 286-409)

    /// `weatherShares(c)`: the weighted share of each category of the step's highest code, largest first (ties keep the
    /// providers' order). `[0]` is the most likely weather and its agreement.
    public func weatherShares(_ c: StepColumn) -> [CategoryShare]? {
        let pr: [WeightedValue<WeatherCategory>] = pairs(.weather, start: c.a) { WeatherCategory(code: aggregate($0, .code, c)) }
        guard !pr.isEmpty else { return nil }
        let tot = Self.wsum(pr)
        var order: [WeatherCategory] = [], cnt: [WeatherCategory: Double] = [:]
        for x in pr {
            if cnt[x.v] == nil { order.append(x.v) }
            cnt[x.v] = (cnt[x.v] ?? 0) + x.w
        }
        let shares = order.map { CategoryShare(category: $0, share: cnt[$0]! / tot) }
        return JS.stableSorted(shares) { $0.share > $1.share }
    }

    /// `rainChance(c)`: weighted share of models with ≥ 0.2 mm in the step.
    public func rainChance(_ c: StepColumn) -> Double? {
        Self.wshare(pairs(.precip, start: c.a) { aggregate($0, .precip, c) }) { $0 >= Self.rainThreshold }
    }

    /// The weighted mean precipitation of the step (mm), as the rain lane shows it.
    public func precipitation(_ c: StepColumn) -> Double? { weightedMean(.precip, key: .precip, c) }

    /// The weighted mean temperature.
    public func temperature(_ c: StepColumn) -> Double? { weightedMean(.mean(.temperature2m), key: .temperature2m, c) }

    /// The weighted mean apparent temperature (weight key temperature, js/app.js:1074).
    public func feelsLike(_ c: StepColumn) -> Double? { weightedMean(.mean(.apparentTemperature), key: .temperature2m, c) }

    /// The weighted mean wind speed (km/h).
    public func wind(_ c: StepColumn) -> Double? { weightedMean(.mean(.windSpeed10m), key: .wind, c) }

    /// `gustMean(c)` (js/app.js:272): the weighted mean of each model's highest gust (km/h).
    public func gustMean(_ c: StepColumn) -> Double? { weightedMean(.gust, key: .wind, c) }

    /// The arrow of the summary: the unweighted circular mean of the models' step directions (js/app.js:297-298).
    public func direction(_ c: StepColumn) -> Double? {
        let dd = values(.dir, c)
        return dd.isEmpty ? nil : StepAggregation.circularMean(dd, weights: dd.map { _ in 1 })
    }

    /// The wind tab's probability (js/app.js:358-360): weighted share with mean wind ≥ 30 km/h.
    public func windChance(_ c: StepColumn) -> Double? {
        guard !values(.mean(.windSpeed10m), c).isEmpty else { return nil }
        return Self.wshare(pairs(.wind, start: c.a) { aggregate($0, .mean(.windSpeed10m), c) }) { $0 >= Self.windThreshold }
    }

    /// The gust line (js/app.js:361-362): the unweighted share of models whose highest gust is ≥ 60 km/h. The web shows `round(× 100)`.
    public func gustShare(_ c: StepColumn) -> Double? {
        let g = values(.gust, c)
        guard !g.isEmpty else { return nil }
        return Double(g.filter { $0 >= Self.gustThreshold }.count) / Double(g.count)
    }

    /// The thunder signal of one provider (js/app.js:366-372): 1 when its own code says thunder (≥ 95), else 0.5 with
    /// CAPE ≥ 1000, else 0; nil when it has neither a code of its own nor CAPE.
    public func thunderSignal(_ p: Provider, _ c: StepColumn) -> Double? {
        let code = aggregate(p, .code, c), cape = aggregate(p, .cape, c)
        let raw = p.hourly[.weatherCode]
        let lo = max(0, min(c.a, raw.count)), hi = max(lo, min(c.b, raw.count))
        let hasRaw = raw[lo..<hi].contains { $0 != nil }
        let thunder: Bool? = hasRaw ? (code ?? -Double.infinity) >= 95 : nil
        if thunder == nil && cape == nil { return nil }
        return thunder == true ? 1 : (cape.map { $0 >= Self.capeThunder } ?? false) ? 0.5 : 0
    }

    /// The thunder chance (js/app.js:385-387): the weighted mean of the signals, weight key `storm`.
    public func thunderChance(_ c: StepColumn) -> Double? {
        Self.wmean(pairs(.storm, start: c.a) { thunderSignal($0, c) })
    }

    /// The weighted mean of a plain variable with its own weight key (temperature, cloud, humidity, pressure tabs).
    public func mean(_ v: HourlyVariable, _ c: StepColumn) -> Double? {
        weightedMean(.mean(v), key: WeightKey.forVariable(v), c)
    }

    /// The population standard deviation of the models' step means (the ±sd under temperature, js/app.js:406); nil below 2 values.
    public func spread(_ v: HourlyVariable, _ c: StepColumn) -> Double? {
        let vals = values(.mean(v), c)
        guard vals.count > 1, let m = JS.mean(vals) else { return nil }
        return Foundation.sqrt(JS.mean(vals.map { ($0 - m) * ($0 - m) })!)
    }

    /// `agreementPill(vals, tol)` (js/app.js:165-170): `round(clamp(1 − sd/tol) × 100)`; nil ("–") with fewer than 2 values.
    public func agreement(_ v: HourlyVariable, _ c: StepColumn) -> Int? {
        guard let tol = Self.tolerance[v] else { return nil }
        return Self.agreement(values(.mean(v), c), tolerance: tol)
    }

    public static func agreement(_ vals: [Double], tolerance tol: Double) -> Int? {
        guard vals.count >= 2, let m = JS.mean(vals) else { return nil }
        let sd = Foundation.sqrt(JS.mean(vals.map { ($0 - m) * ($0 - m) })!)
        return Int(JS.round(JS.clamp(1 - sd / tol) * 100))
    }

    /// Everything the summary rows and lanes show for one step.
    public func step(_ c: StepColumn) -> StepConsensus {
        let temps = values(.mean(.temperature2m), c)
        let winds = values(.mean(.windSpeed10m), c)
        let mm = values(.precip, c)
        return StepConsensus(
            column: c, shares: weatherShares(c), temperature: temperature(c), temperatureMin: temps.min(), temperatureMax: temps.max(),
            temperatureSpread: spread(.temperature2m, c), feelsLike: feelsLike(c),
            wind: wind(c), windMin: winds.min(), windMax: winds.max(), gust: gustMean(c), direction: direction(c),
            rainChance: rainChance(c), precipitation: precipitation(c), precipitationMax: mm.max(),
            windChance: windChance(c), gustShare: gustShare(c), thunderChance: thunderChance(c),
            temperatureAgreement: agreement(.temperature2m, c))
    }
}

/// One step's consensus (the summary and probability rows of the hour table and the strip's lanes).
public struct StepConsensus: Sendable {
    public var column: StepColumn
    /// Most likely weather: categories by weighted share, largest first.
    public var shares: [CategoryShare]?
    public var temperature: Double?
    public var temperatureMin: Double?
    public var temperatureMax: Double?
    /// Population sd of the models' temperatures (°C), nil below 2 models.
    public var temperatureSpread: Double?
    public var feelsLike: Double?
    /// km/h, weighted mean.
    public var wind: Double?
    public var windMin: Double?
    public var windMax: Double?
    /// km/h, weighted mean of the models' highest gusts.
    public var gust: Double?
    /// Degrees the wind comes from (unweighted circular mean).
    public var direction: Double?
    public var rainChance: Double?
    /// mm, weighted mean.
    public var precipitation: Double?
    /// mm, the wettest model ("opptil").
    public var precipitationMax: Double?
    public var windChance: Double?
    public var gustShare: Double?
    public var thunderChance: Double?
    public var temperatureAgreement: Int?

    /// The most likely category.
    public var top: CategoryShare? { shares?.first }
    /// The icon for the step (category icon, night aware).
    public var icon: WeatherIcon? { top.map { WeatherIcon(category: $0.category, night: column.night) } }
}
