import Foundation

/// Glett's weather categories (`category(code)`, js/icons.js:64-75), in the web's key names (`cat.<rawValue>` in i18n).
public enum WeatherCategory: String, Sendable, Codable, CaseIterable, Hashable {
    case clear, partly, cloudy, fog, drizzle, rain, snow, thunder

    /// `category(code)` of js/icons.js:64-75; nil for no code.
    public init?(code: Double?) {
        guard let code else { return nil }
        if code <= 1 { self = .clear }
        else if code == 2 { self = .partly }
        else if code == 3 { self = .cloudy }
        else if code == 45 || code == 48 { self = .fog }
        else if code >= 51 && code <= 57 { self = .drizzle }
        else if (code >= 61 && code <= 67) || (code >= 80 && code <= 82) { self = .rain }
        else if (code >= 71 && code <= 77) || code == 85 || code == 86 { self = .snow }
        else if code >= 95 { self = .thunder }
        else { self = .cloudy }
    }

    /// `CAT_CODE` (js/icons.js:76): the code drawn for a category.
    public var representativeCode: Int {
        switch self {
        case .clear: 0
        case .partly: 2
        case .cloudy: 3
        case .fog: 45
        case .drizzle: 51
        case .rain: 63
        case .snow: 73
        case .thunder: 95
        }
    }

    /// The localisation key (`cat.<id>`).
    public var key: String { "cat.\(rawValue)" }

    /// `vcat(c)` of js/data.js:211-222: the verification category, drizzle merged into rain, the code truncated first.
    public static func verification(code: Double?) -> WeatherCategory? {
        guard let code0 = code else { return nil }
        let c = code0 < 0 ? code0.rounded(.up) : code0.rounded(.down)
        if c <= 1 { return .clear }
        if c == 2 { return .partly }
        if c == 3 { return .cloudy }
        if c == 45 || c == 48 { return .fog }
        if (c >= 51 && c <= 57) || (c >= 61 && c <= 67) || (c >= 80 && c <= 82) { return .rain }
        if (c >= 71 && c <= 77) || c == 85 || c == 86 { return .snow }
        if c >= 95 { return .thunder }
        return .cloudy
    }
}

/// The 14 weather icons (`key(code, night)`, js/icons.js:80-95); the raw value is the asset name in Shared/Assets.xcassets/Weather.
public enum WeatherIcon: String, Sendable, Codable, CaseIterable {
    case clearDay = "clear-day", clearNight = "clear-night", partlyDay = "partly-day", partlyNight = "partly-night", cloudy, fog, drizzle, rain
    case heavyRain = "heavy-rain", showersDay = "showers-day", showersNight = "showers-night", sleet, snow, thunder

    /// `key(code, night)` of js/icons.js:80-95. The order matters: 66/67 → sleet and 65/82 → heavy rain before the ranges.
    public init?(code: Double?, night: Bool) {
        guard let code else { return nil }
        if code == 0 || code == 1 { self = night ? .clearNight : .clearDay }
        else if code == 2 { self = night ? .partlyNight : .partlyDay }
        else if code == 3 { self = .cloudy }
        else if code == 45 || code == 48 { self = .fog }
        else if code >= 51 && code <= 57 { self = .drizzle }
        else if code == 66 || code == 67 { self = .sleet }
        else if code == 65 || code == 82 { self = .heavyRain }
        else if code >= 80 && code <= 81 { self = night ? .showersNight : .showersDay }
        else if code >= 61 && code <= 64 { self = .rain }
        else if (code >= 71 && code <= 77) || code == 85 || code == 86 { self = .snow }
        else if code >= 95 { self = .thunder }
        else { self = .cloudy }
    }

    /// The icon of a category (the web draws `WI.svg(CAT_CODE[cat], night)`).
    public init(category: WeatherCategory, night: Bool) {
        self = WeatherIcon(code: Double(category.representativeCode), night: night) ?? .cloudy
    }

    /// Night icons draw the moon on the web (v1 may use a static one).
    public var isNight: Bool { self == .clearNight || self == .partlyNight || self == .showersNight }

    /// The localisation key of the code's label (`wx.<code>`, falling back to `wx.unknown`, js/icons.js:78).
    public static func labelKey(code: Int) -> String { "wx.\(code)" }
}
