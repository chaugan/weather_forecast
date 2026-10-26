import GlettKit
import SwiftUI

/// MET's warning triangle (`warnIcon`, js/app.js:51-55): the level's colour with a dark rim and the symbol for the kind
/// of weather, as MET and Yr draw it. Drawn from the web's own 30×27 SVG, scaled to `width`.
struct WarningTriangle: View {
    /// "yellow", "orange", "red" or "green".
    let level: String
    /// `MetAlert.symbol`: "wind", "rain", "snow", "ice", "thunder", "coastalevent", "forestfire" or "".
    let symbol: String
    var width: CGFloat = 30

    init(level: String, symbol: String, width: CGFloat = 30) {
        self.level = level; self.symbol = symbol; self.width = width
    }

    init(_ alert: MetAlert, width: CGFloat = 30) {
        self.init(level: alert.level, symbol: alert.symbol, width: width)
    }

    /// `AW_FILL` (js/app.js:41): the triangle's fill per level; slate when the level is unknown.
    static let fill: [String: Color] = [
        "yellow": Color(hex: 0xF5C518), "orange": Color(hex: 0xF97316), "red": Color(hex: 0xDC2626), "green": Color(hex: 0x22C55E),
    ]
    static let unknownFill = Color(hex: 0xCBD5E1)
    /// The rim and symbol colour (`#1f2937`).
    static let ink = Color(hex: 0x1F2937)

    /// `AW_SYM` (js/app.js:42-50): the symbols' path data in the triangle's 30×27 box.
    static let symbols: [String: String] = [
        "wind": "M9 15.5h8.5a2 2 0 1 0-2-2M9 19h11.5a2 2 0 1 1-2 2",
        "rain": "M11 15.5l-1.4 3M15 13.5l-1.4 3M19 15.5l-1.4 3M13 19.5l-1.4 3M17 19.5l-1.4 3",
        "snow": "M15 12.5v10M10.7 15l8.6 5M10.7 20l8.6-5",
        "ice": "M9.5 15h11l-1.6 3.5h-7.8zM12 18.5v3M15 18.5v4M18 18.5v3",
        "thunder": "M16.5 11.5 12.5 18h4l-2 5",
        "coastalevent": "M8.5 17.5c1.6-1.6 3.2-1.6 4.8 0s3.2 1.6 4.8 0 3.2-1.6 3.4-.2M8.5 21.5c1.6-1.6 3.2-1.6 4.8 0s3.2 1.6 4.8 0 3.2-1.6 3.4-.2",
        "forestfire": "M15 23c-2.6 0-4-1.6-4-3.6 0-2.2 2-3.2 2-5.6 1.8 1 2.4 2.4 2.2 3.8 1-.6 1.5-1.4 1.6-2.4 1.4 1.2 2.2 2.6 2.2 4.2 0 2-1.4 3.6-4 3.6z",
        "": "M15 12v6M15 21.2v.3",
    ]
    private static let triangle = "M15 1.5 28.5 25.5H1.5Z"

    var body: some View {
        Canvas { ctx, size in
            let s = size.width / 30
            ctx.scaleBy(x: s, y: s)
            let tri = SVGPath.path(Self.triangle)
            ctx.fill(tri, with: .color(Self.fill[level] ?? Self.unknownFill))
            ctx.stroke(tri, with: .color(Self.ink), style: StrokeStyle(lineWidth: 1.6, lineJoin: .round))
            let sym = SVGPath.path(Self.symbols[symbol] ?? Self.symbols[""]!)
            ctx.stroke(sym, with: .color(Self.ink), style: StrokeStyle(lineWidth: 1.7, lineCap: .round, lineJoin: .round))
        }
        .frame(width: width, height: width * 27 / 30)
        .accessibilityHidden(true)
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    let kinds = ["wind", "rain", "snow", "ice", "thunder", "coastalevent", "forestfire", ""]
    VStack(spacing: 10) {
        ForEach(["yellow", "orange", "red"], id: \.self) { level in
            HStack(spacing: 10) {
                ForEach(kinds, id: \.self) { WarningTriangle(level: level, symbol: $0, width: 44) }
            }
        }
    }
    .padding()
}
