import Foundation

/// The parameter keys a reliability weight is given for (`out[m].weights`, js/data.js:363-364; used by `W(p, key)`, js/app.js:204).
public enum WeightKey: String, Sendable, Codable, CaseIterable, Hashable {
    case weather
    case temperature2m = "temperature_2m"
    case precip
    case wind
    case storm
    case cloudCover = "cloud_cover"
    case relativeHumidity2m = "relative_humidity_2m"
    case pressureMSL = "pressure_msl"

    /// The key the web passes for a plain variable (`wpairs(param, …)` with the param's own name, js/app.js:399).
    public static func forVariable(_ v: HourlyVariable) -> WeightKey {
        switch v {
        case .temperature2m, .apparentTemperature: .temperature2m
        case .precipitation: .precip
        case .windSpeed10m, .windGusts10m, .windDirection10m: .wind
        case .cloudCover: .cloudCover
        case .relativeHumidity2m: .relativeHumidity2m
        case .pressureMSL: .pressureMSL
        case .weatherCode, .isDay: .weather
        case .cape: .storm
        }
    }
}

/// Where per-model reliability weights come from (the verification agent's result). Return nil for "no weight": the
/// engine then uses 1, as `W(p, key)` does with a missing, null or zero weight.
public protocol ConsensusWeights: Sendable {
    func weight(model: String, key: WeightKey) -> Double?
}

/// Every model counts the same (the web without verification, or with weighting off).
public struct UniformWeights: ConsensusWeights {
    public init() {}
    public func weight(model: String, key: WeightKey) -> Double? { nil }
}

/// A plain table `model id → key → weight`, the shape of `verify.models[id].weights`.
public struct WeightTable: ConsensusWeights, Codable, Hashable {
    public var weights: [String: [String: Double?]]
    public init(_ weights: [String: [String: Double?]]) { self.weights = weights }
    public func weight(model: String, key: WeightKey) -> Double? { weights[model]?[key.rawValue] ?? nil }
}
