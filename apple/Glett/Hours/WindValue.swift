import GlettKit
import SwiftUI

/// Wind as the hour table prints it (js/app.js:297-299): the arrow, the mean in the chosen unit, the strongest gust
/// in brackets and optionally the unit ("↗ 5 (11) m/s").
struct WindValue: View {
    let wind: Double?
    var gust: Double?
    let direction: Double?
    let unit: WindUnit
    var showsUnit = false
    var arrowSize: CGFloat = 13

    var body: some View {
        if wind != nil {
            HStack(spacing: 2) {
                WindArrow(degrees: direction, size: arrowSize, opacity: 0.75)
                Text(verbatim: text).monospacedDigit()
            }
            .lineLimit(1)
            .accessibilityElement(children: .combine)
        }
    }

    private var text: String {
        var s = Format.wind(wind, unit)
        if let gust { s += " (\(Format.wind(gust, unit)))" }
        if showsUnit { s += " \(Format.windUnit(unit))" }
        return s
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    VStack(alignment: .leading) {
        WindValue(wind: 18, gust: 40, direction: 225, unit: .ms, showsUnit: true)
        WindValue(wind: 18, direction: 90, unit: .kmh)
    }
    .padding()
}
