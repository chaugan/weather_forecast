import Foundation

/// The measurements a model is scored on, in the order the web marks the best model per column
/// (`renderReliability`, js/app.js:521). Raw values are the web's skill keys.
public enum VerificationMeasure: String, Sendable, Codable, CaseIterable, Hashable {
    case temperature2m = "temperature_2m"
    case windSpeed10m = "wind_speed_10m"
    case cloudCover = "cloud_cover"
    case relativeHumidity2m = "relative_humidity_2m"
    case pressureMSL = "pressure_msl"
    /// Rain: the critical success index over wet hours.
    case precip
    /// Weather type: the share of hours in the right category.
    case code

    /// The continuous ones, `KEYS` / `VTOL` order (js/data.js:36-37).
    public static let continuous: [VerificationMeasure] = [.temperature2m, .windSpeed10m, .cloudCover, .relativeHumidity2m, .pressureMSL]

    /// `VTOL` (js/data.js:36): the mean absolute error at which skill reaches 0 (°C, km/h, %, %, hPa); nil for precip/code.
    public var tolerance: Double? {
        switch self {
        case .temperature2m: 4.0
        case .windSpeed10m: 15.0
        case .cloudCover: 50.0
        case .relativeHumidity2m: 25.0
        case .pressureMSL: 4.0
        case .precip, .code: nil
        }
    }
}

/// The reliability of the models at one 0.1° cell: the web's `fetchVerify` result (js/data.js:368-370), in the same
/// JSON shape, so the `vf3:` cache entry is the web's body. Conforms to `ConsensusWeights`: pass it straight to
/// `ForecastBundle.consensus(settings:weights:)`.
public struct VerificationResult: Sendable, Codable, Hashable, ConsensusWeights {
    /// What the models were scored against: MET stations through Frost (Norway) or the ERA5 reanalysis.
    public enum Truth: String, Sendable, Codable, Hashable { case frost, era5 }

    /// The METAR station used as the second truth outside Norway (js/data.js:341).
    public struct Station: Sendable, Codable, Hashable {
        public var id: String
        public var name: String?
        public var km: Double?
        public var elev: Double?
        /// Matched hours.
        public var reports: Int
        /// First and last day of the station's reports ("YYYY-MM-DD").
        public var start: String
        public var end: String
    }

    public struct FrostInfo: Sendable, Codable, Hashable {
        /// Which station measured what, keyed t/w/h/p/c/r (`r.legend.frost`).
        public var stations: [String: FrostTruth.Station]
    }

    public var truth: Truth
    /// First day of the window and last day of the truth ("YYYY-MM-DD").
    public var start: String
    public var end: String
    /// Matched hours of the main truth.
    public var hours: Int
    /// First day of the "last 7 days" score.
    public var recentFrom: String
    public var frost: FrostInfo?
    /// Netatmo hours blended in (Norway); 0 elsewhere.
    public var netatmoHours: Int
    /// The METAR station (outside Norway), nil when none had enough reports.
    public var station: Station?
    /// The second truth's share of the blended skill (0, 0.3 Netatmo or 0.6 METAR).
    public var obsWeight: Double
    /// Model id → its scores. Models outside their coverage are left out.
    public var models: [String: ModelVerification]

    enum CodingKeys: String, CodingKey {
        case truth, start, end, hours, frost, station, models
        case recentFrom = "recent_from", netatmoHours = "netatmo_hours", obsWeight = "obs_weight"
    }

    public init(truth: Truth, start: String, end: String, hours: Int, recentFrom: String, frost: FrostInfo?, netatmoHours: Int,
                station: Station?, obsWeight: Double, models: [String: ModelVerification]) {
        self.truth = truth; self.start = start; self.end = end; self.hours = hours; self.recentFrom = recentFrom; self.frost = frost
        self.netatmoHours = netatmoHours; self.station = station; self.obsWeight = obsWeight; self.models = models
    }

    /// `verify.models[id].weights[key]` (js/app.js:204); nil when the model or the key has no weight.
    public func weight(model: String, key: WeightKey) -> Double? {
        models[model]?.weights[key.rawValue] ?? nil
    }

    /// The weights alone, `model → key → weight` (for the widgets/watch, which may get them from the phone).
    public var weightTable: WeightTable { WeightTable(models.mapValues(\.weights)) }

    /// The models best first, as the reliability table lists them (js/app.js:517): by score, highest first, a missing
    /// score last; ties keep the `VERIFY_MODELS` order.
    public func ranked() -> [(id: String, model: ModelVerification)] {
        let known = ModelCatalog.verifyModels.filter { models[$0] != nil }
        let other = models.keys.filter { !ModelCatalog.verifyModels.contains($0) }.sorted()
        let ids = JS.stableSorted(known + other) { (models[$0]!.score ?? -1) > (models[$1]!.score ?? -1) }
        return ids.map { ($0, models[$0]!) }
    }

    /// The model with the highest blended skill per measurement, the disabled ones left out (the "best" marker,
    /// js/app.js:519-524). On a tie the higher ranked model keeps it.
    public func best(disabled: Set<String> = []) -> [VerificationMeasure: String] {
        var out: [VerificationMeasure: String] = [:], top: [VerificationMeasure: Double] = [:]
        for (id, m) in ranked() where !disabled.contains(id) {
            for k in VerificationMeasure.allCases {
                guard let x = m.skill[k.rawValue] else { continue }
                if let b = top[k], !(x > b) { continue }
                top[k] = x; out[k] = id
            }
        }
        return out
    }

    /// `scoreCls(v)` of js/app.js:506: "hi" from 80, "mid" from 60, else "lo" (also for no score).
    public static func scoreLevel(_ score: Int?) -> String {
        guard let score else { return "lo" }
        return score >= 80 ? "hi" : score >= 60 ? "mid" : "lo"
    }
}

/// One model's scores (`out[m]`, js/data.js:355-366). Dictionaries are keyed by `VerificationMeasure` raw values.
/// Wind errors are in km/h (convert for display, as js/app.js:529 does).
public struct ModelVerification: Sendable, Codable, Hashable {
    /// The second truth's figures (METAR or Netatmo), when it was used.
    public struct Observed: Sendable, Codable, Hashable {
        public var mae: [String: Double]
        public var bias: [String: Double]
        public var csi: Double?
        public var codeAcc: Double?
        enum CodingKeys: String, CodingKey { case mae, bias, csi, codeAcc = "code_acc" }
        public init(mae: [String: Double], bias: [String: Double], csi: Double?, codeAcc: Double?) {
            self.mae = mae; self.bias = bias; self.csi = csi; self.codeAcc = codeAcc
        }
    }

    /// 0–100 over the whole window, nil without any skill.
    public var score: Int?
    /// 0–100 over the last 7 days.
    public var score7: Int?
    /// Blended skill 0–1 per measurement (3 decimals).
    public var skill: [String: Double]
    /// Against the main truth: mean absolute error and bias per continuous measurement (2 decimals).
    public var mae: [String: Double]
    public var bias: [String: Double]
    /// Rain CSI and weather-type accuracy against the main truth (3 decimals).
    public var csi: Double?
    public var codeAcc: Double?
    public var obs: Observed?
    /// The consensus weights, keyed by `WeightKey` raw values; nil = no weight for that key (counts as 1).
    public var weights: [String: Double?]

    enum CodingKeys: String, CodingKey { case score, score7, skill, mae, bias, csi, obs, weights, codeAcc = "code_acc" }

    public init(score: Int?, score7: Int?, skill: [String: Double], mae: [String: Double], bias: [String: Double], csi: Double?,
                codeAcc: Double?, obs: Observed?, weights: [String: Double?]) {
        self.score = score; self.score7 = score7; self.skill = skill; self.mae = mae; self.bias = bias; self.csi = csi
        self.codeAcc = codeAcc; self.obs = obs; self.weights = weights
    }

    /// The JSON keeps `null` for a key without a weight, as the web's object does.
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(score, forKey: .score)
        try c.encode(score7, forKey: .score7)
        try c.encode(skill, forKey: .skill)
        try c.encode(mae, forKey: .mae)
        try c.encode(bias, forKey: .bias)
        try c.encode(csi, forKey: .csi)
        try c.encode(codeAcc, forKey: .codeAcc)
        try c.encode(obs, forKey: .obs)
        try c.encode(weights, forKey: .weights)
    }

    public func skill(_ m: VerificationMeasure) -> Double? { skill[m.rawValue] }
    public func weight(_ key: WeightKey) -> Double? { weights[key.rawValue] ?? nil }
}
