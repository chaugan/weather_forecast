import SwiftUI

/// Glett's own weather icon (js/icons.js, exported as vector SVG into Assets.xcassets/Weather by
/// apple/scripts/icons-export.mjs). Fits its square, never fills, and reads its label aloud.
struct WeatherIcon: View {
    /// One of `WeatherIcon.names`.
    let name: String
    let size: CGFloat
    let label: String

    /// The icon for a WMO weather code, as `WI.svg(code, night)` draws it; the label is the code's text (`wx.<code>`,
    /// else `wx.unknown`), as icons.js:78 `label()`.
    init(code: Int, night: Bool = false, size: CGFloat = 36) {
        name = Self.name(code: code, night: night)
        self.size = size
        label = L10n.has("wx.\(code)") ? L10n.t("wx.\(code)") : L10n.t("wx.unknown")
    }

    /// The icon by name; the label is its category's text (`cat.<category>`).
    init(name: String, size: CGFloat = 36) {
        self.name = name
        self.size = size
        label = L10n.t("cat.\(Self.category(iconName: name))")
    }

    var body: some View {
        Image("Weather/\(name)", bundle: .main)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            // css/style.css:104 `.wi { filter: drop-shadow(0 3px 2px rgba(20, 40, 80, .3)) }`, scaled from 36 pt
            .shadow(color: Color(red: 20 / 255, green: 40 / 255, blue: 80 / 255, opacity: 0.3), radius: size / 36, y: 3 * size / 36)
            .accessibilityElement()
            .accessibilityLabel(Text(verbatim: label))
            .accessibilityAddTraits(.isImage)
    }

    /// The 14 icons in the catalog (brief §5, js/icons.js:41-56).
    static let names = ["clear-day", "clear-night", "partly-day", "partly-night", "cloudy", "fog", "drizzle", "rain",
                        "heavy-rain", "showers-day", "showers-night", "sleet", "snow", "thunder"]

    /// js/icons.js:80 `key(code, night)`. Order matters: 66/67 sleet and 65/82 heavy rain before the general ranges.
    static func name(code: Int, night: Bool) -> String {
        let n = night ? "night" : "day"
        switch code {
        case 0, 1: return "clear-\(n)"
        case 2: return "partly-\(n)"
        case 3: return "cloudy"
        case 45, 48: return "fog"
        case 51...57: return "drizzle"
        case 66, 67: return "sleet"
        case 65, 82: return "heavy-rain"
        case 80...81: return "showers-\(n)"
        case 61...64: return "rain"
        case 71...77, 85, 86: return "snow"
        case 95...: return "thunder"
        default: return "cloudy"
        }
    }

    /// js/icons.js:64 `category(code)` for an icon name, so the label matches the web's categories (`cat.*` keys).
    static func category(iconName: String) -> String {
        switch iconName {
        case "clear-day", "clear-night": "clear"
        case "partly-day", "partly-night": "partly"
        case "fog": "fog"
        case "drizzle": "drizzle"
        case "rain", "heavy-rain", "showers-day", "showers-night", "sleet": "rain"
        case "snow": "snow"
        case "thunder": "thunder"
        default: "cloudy"
        }
    }
}

#Preview("All icons") {
    ScrollView {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 88), spacing: 12)], spacing: 16) {
            ForEach(WeatherIcon.names, id: \.self) { name in
                VStack(spacing: 6) {
                    WeatherIcon(name: name, size: 56)
                    Text(verbatim: name).font(.caption2).foregroundStyle(.glett.muted)
                    Text(L10n.t("cat.\(WeatherIcon.category(iconName: name))")).font(.caption).foregroundStyle(.glett.text)
                }
            }
        }
        .padding()
    }
    .background(Color.glett.bg)
    .glettLanguage()
}

#Preview("From codes", traits: .sizeThatFitsLayout) {
    HStack {
        ForEach([0, 2, 45, 61, 65, 66, 80, 73, 95], id: \.self) { code in
            WeatherIcon(code: code, night: code == 80, size: 28)
        }
    }
    .padding()
}
