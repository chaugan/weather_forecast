import SwiftUI
import UIKit

/// Colours the hour views add to the shared palette (`Color.glett`), from css/style.css.
enum HoursColor {
    /// `--night` (css/style.css:674-676): the night rows of the list and the night columns of the strip and meteogram.
    static let night = dynamic(light: 0xF1F3F7, dark: 0x111A29)
    /// `--accent-soft` (css/style.css:674-676): quiet pills (the radar badge when dry, day labels).
    static let accentSoft = dynamic(light: 0xE8EFFF, dark: 0x1A2740)
    /// The meteogram's temperature line and band (css/style.css:592-593, `#dc2626`), the same in both themes.
    static let temperature = Color(hex: 0xDC2626)
    /// The wind colour of the web's wind tab (`hsla(170, 70%, 40%)`, js/app.js:363).
    static let wind = Color(hue: 170 / 360, saturation: 0.82, brightness: 0.62)

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        func ui(_ hex: UInt32) -> UIColor {
            UIColor(red: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        }
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
    }
}
