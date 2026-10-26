import GlettKit
import SwiftUI

/// "Temp. · vind · nedbør" in the time-down list (`g.twr`, js/app.js:294-299): the weighted temperature, the wind with
/// the strongest gust, and the rain chance with the mean amount.
struct TimeDownSummaryCell: View {
    let step: StepConsensus
    let unit: WindUnit

    var body: some View {
        VStack(spacing: 1) {
            Text(verbatim: Format.temp(step.temperature))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.glett.text)
            WindValue(wind: step.wind, gust: step.gust, direction: step.direction, unit: unit, showsUnit: true, arrowSize: 11)
                .font(.caption2)
                .foregroundStyle(.glett.text)
            if let pct = Format.percent(step.rainChance) {
                Text(verbatim: rainText(pct))
                    .font(.caption2.weight(pct == 0 ? .regular : .semibold))
                    .foregroundStyle(pct == 0 ? Color.glett.muted : Color.glett.accent)
            }
        }
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .padding(.horizontal, 4)
    }

    /// `${pct} % · ${fmt(mm, 1)} mm`, the amount only from 0.05 mm (js/app.js:298).
    private func rainText(_ pct: Int) -> String {
        var s = "\(pct)\u{00A0}%"
        if let mm = step.precipitation, mm >= 0.05 { s += " · \(JS.fmt(mm, 1))\(L10n.t("u.mm"))" }
        return s
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    let e = PreviewSamples.engine
    TimeDownSummaryCell(step: e.step(e.columns(step: 3)[3]), unit: .ms).frame(width: 96).padding()
}
