import Foundation

/// The settings keys, named after the web's localStorage keys so a change there can be found here by grep. Use them
/// with `@AppStorage(SettingsKey.windUnit, store: UserDefaults(suiteName: AppGroup.identifier))`.
public enum SettingsKey {
    /// `glett.wind` (js/app.js:30): `WindUnit`, default m/s.
    public static let windUnit = "glett.wind"
    /// `glett.weighted` (js/app.js:27): weight by reliability, default on.
    public static let weighted = "glett.weighted"
    /// `glett.disabled` (js/app.js:29): JSON array of model ids switched off.
    public static let disabledModels = "glett.disabled"
    /// `glett.orient2` (js/app.js:57): `HourView`, default time down.
    public static let hourView = "glett.orient2"
    /// The hour table's step (1/3/6/12, `stepSelect`); the web does not store it, the app may.
    public static let step = "glett.step"
    /// `glett.lang` (js/i18n.js:616): `AppLanguage`, default the device's.
    public static let language = "glett.lang"
    /// `glett.theme` (js/theme.js:2): `AppTheme`.
    public static let theme = "glett.theme"
    /// `glett.map`: the map base layer.
    public static let mapBase = "glett.map"
}

/// Wind unit: the data is km/h, Norwegians read m/s (js/app.js:79-82).
public enum WindUnit: String, Sendable, Codable, CaseIterable {
    case ms, kmh
    public static let `default`: WindUnit = .ms
    /// `wv(kmh)`: the value in this unit.
    public func value(_ kmh: Double?) -> Double? { kmh.map { self == .ms ? $0 / 3.6 : $0 } }
    /// `u.ms` / `u.kmh`.
    public var key: String { self == .ms ? "u.ms" : "u.kmh" }
}

/// The hour view (`glett.orient2`): v = time runs down (default), h = time across, m = meteogram.
public enum HourView: String, Sendable, Codable, CaseIterable {
    case timeDown = "v", timeAcross = "h", meteogram = "m"
    public static let `default`: HourView = .timeDown
}

/// Language: follows the device unless overridden (brief §5 i18n).
public enum AppLanguage: String, Sendable, Codable, CaseIterable {
    case system, nb, en
    public static let `default`: AppLanguage = .system

    /// The web's `LANG`: "nb" or "en". `system` picks nb for Norwegian (nb/nn/no), else en (`detectLang`, js/i18n.js).
    public func resolved(preferred: [String] = Locale.preferredLanguages) -> String {
        switch self {
        case .nb: return "nb"
        case .en: return "en"
        case .system:
            for l in preferred {
                let p = l.lowercased().prefix(2)
                if p == "nb" || p == "nn" || p == "no" { return "nb" }
                if p == "en" { return "en" }
            }
            return "en"
        }
    }

    /// `dateLocale()` (js/i18n.js:626).
    public func dateLocale(preferred: [String] = Locale.preferredLanguages) -> Locale {
        Locale(identifier: resolved(preferred: preferred) == "nb" ? "nb-NO" : "en-GB")
    }
}

/// Theme (`glett.theme`): system, or forced light/dark.
public enum AppTheme: String, Sendable, Codable, CaseIterable {
    case system, light, dark
    public static let `default`: AppTheme = .system
}

/// The settings that change the forecast numbers, in one value (pass it to `ForecastBundle.consensus`).
public struct ForecastSettings: Sendable, Codable, Hashable {
    public var weighted: Bool
    public var disabledModels: Set<String>
    public var windUnit: WindUnit
    public var step: Int

    public init(weighted: Bool = true, disabledModels: Set<String> = [], windUnit: WindUnit = .default, step: Int = 1) {
        self.weighted = weighted; self.disabledModels = disabledModels; self.windUnit = windUnit; self.step = step
    }

    /// Decodes the `glett.disabled` string (a JSON array).
    public static func decodeDisabled(_ s: String?) -> Set<String> {
        guard let s, let d = s.data(using: .utf8), let a = try? JSONDecoder().decode([String].self, from: d) else { return [] }
        return Set(a)
    }
    public static func encodeDisabled(_ s: Set<String>) -> String {
        (try? String(data: JSONEncoder().encode(s.sorted()), encoding: .utf8)) ?? "[]"
    }

    /// The web's toggle rule (js/app.js:1043-1047): a model may be switched off only while another unique one stays on.
    public static func canDisableAnother(disabled: Set<String>, forecast: Forecast) -> Bool {
        forecast.uniqueProviders.filter { !disabled.contains($0.id) }.count > 1
    }
}
