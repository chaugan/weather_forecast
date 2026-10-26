import GlettKit
import SwiftUI

/// The radar pill on a step where MET's radar disagrees with the models (`radarBadge(c)`, js/app.js:238-244;
/// css/style.css:638-640): "radar: 0,4 mm" when radar sees rain the models miss, "radar: opphold" the other way.
struct RadarBadgeView: View {
    let badge: RadarBadge

    var body: some View {
        Text(verbatim: text)
            .font(.caption2.weight(.bold))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .foregroundStyle(wet ? Color.glett.rain : Color.glett.muted)
            .background(wet ? Color.glett.rain.opacity(0.18) : Color.glett.summary, in: Capsule())
            .accessibilityLabel(Text(verbatim: "\(text). \(L10n.t("radar.src"))"))
    }

    private var wet: Bool { if case .rain = badge { true } else { false } }

    private var text: String {
        switch badge {
        case .rain(let mm):
            // `mm.toLocaleString(dateLocale(), { maximumFractionDigits: 1 })`
            L10n.t("radar.badge.rain", ["mm": mm.formatted(.number.precision(.fractionLength(0...1)).rounded(rule: .toNearestOrAwayFromZero).locale(L10n.locale))])
        case .dry:
            L10n.t("radar.badge.dry")
        }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    VStack { RadarBadgeView(badge: .rain(mm: 0.42)); RadarBadgeView(badge: .dry) }.padding()
}
