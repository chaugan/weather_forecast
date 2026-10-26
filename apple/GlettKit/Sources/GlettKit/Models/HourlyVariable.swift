import Foundation

/// The hourly variables of the forecast request, in the order of `VARS` (js/data.js:31-32).
public enum HourlyVariable: String, CaseIterable, Codable, Sendable, Hashable {
    case temperature2m = "temperature_2m"
    case apparentTemperature = "apparent_temperature"
    case precipitation
    case windSpeed10m = "wind_speed_10m"
    case windGusts10m = "wind_gusts_10m"
    case windDirection10m = "wind_direction_10m"
    case cloudCover = "cloud_cover"
    case relativeHumidity2m = "relative_humidity_2m"
    case pressureMSL = "pressure_msl"
    case weatherCode = "weather_code"
    case cape
    case isDay = "is_day"
}

/// One provider's hourly series on the forecast's time axis; `nil` where the model has no value.
/// Encoded as the web's `hourly` object (`{"temperature_2m": [...], ..., "code": [...]}`).
public struct Hourly: Sendable, Codable, Equatable {
    public var values: [HourlyVariable: [Double?]]
    /// `hourly.code` of js/app.js:99: the model's weather code, or the derived one where it has none. Set by `Forecast.prepare()`.
    public var code: [Double?]

    public init(values: [HourlyVariable: [Double?]], count: Int, code: [Double?]? = nil) {
        var v = values
        for k in HourlyVariable.allCases where v[k] == nil { v[k] = Array(repeating: nil, count: count) }
        self.values = v
        self.code = code ?? Array(repeating: nil, count: count)
    }

    public subscript(_ v: HourlyVariable) -> [Double?] {
        get { values[v] ?? [] }
        set { values[v] = newValue }
    }

    public var count: Int { values[.temperature2m]?.count ?? code.count }

    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ s: String) { stringValue = s }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        var v: [HourlyVariable: [Double?]] = [:]
        var n = 0
        for k in HourlyVariable.allCases {
            if let a = try c.decodeIfPresent([Double?].self, forKey: Key(k.rawValue)) { v[k] = a; n = max(n, a.count) }
        }
        let code = try c.decodeIfPresent([Double?].self, forKey: Key("code"))
        self.init(values: v, count: max(n, code?.count ?? 0), code: code)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        for k in HourlyVariable.allCases { try c.encode(self[k], forKey: Key(k.rawValue)) }
        try c.encode(code, forKey: Key("code"))
    }
}
