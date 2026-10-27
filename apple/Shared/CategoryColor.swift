import GlettKit
import SwiftUI

extension WeatherCategory {
    /// The category colours of the segmented agreement bar (`--c-<cat>`, css/style.css:560; the same in light and dark).
    var color: Color {
        switch self {
        case .clear: Color(hex: 0xF5B301)
        case .partly: Color(hex: 0xFCD980)
        case .cloudy: Color(hex: 0x94A3B8)
        case .fog: Color(hex: 0xCBD5E1)
        case .drizzle: Color(hex: 0x93C5FD)
        case .rain: Color(hex: 0x3B82F6)
        case .snow: Color(hex: 0x67E8F9)
        case .thunder: Color(hex: 0x8B5CF6)
        }
    }
}

extension Color {
    /// An sRGB colour from 0xRRGGBB, as written in the CSS.
    init(hex: UInt32) {
        self.init(.sRGB, red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}
