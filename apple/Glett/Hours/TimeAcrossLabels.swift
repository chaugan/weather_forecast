import GlettKit
import SwiftUI

/// The pinned first column of the time-across strip (`.rowh`, css/style.css:75, 777): the lane names and, when open,
/// the model names.
struct TimeAcrossLabels: View {
    let metrics: TimeAcrossMetrics
    let models: [HourTable.Model]
    let unit: WindUnit

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: metrics.day)
            label(L10n.t("g.time"), metrics.time)
            label(L10n.t("ln.weather"), metrics.weather)
            label(L10n.t("ln.agree"), metrics.agree)
            label(L10n.t("ln.temp"), metrics.temp)
            label(L10n.t("ln.rain"), metrics.rain)
            label(L10n.t("ln.wind", ["u": Format.windUnit(unit)]), metrics.wind, thick: true)
            ForEach(models) { m in
                ModelRowLabel(model: m, inLane: true)
                    .padding(.horizontal, 8)
                    .frame(width: metrics.label, height: metrics.model, alignment: .leading)
                    .background(m.isHeadline ? Color.glett.accent.opacity(0.06) : Color.clear)
                    .overlay(alignment: .bottom) { Rectangle().fill(Color.glett.line).frame(height: 1) }
            }
        }
        .frame(width: metrics.label)
        .background(Color.glett.panel)
        .shadow(color: Color(red: 15 / 255, green: 30 / 255, blue: 60 / 255).opacity(0.18), radius: 4, x: 3)
        .accessibilityHidden(true)   // each column reads its own values with their names
    }

    private func label(_ text: String, _ height: CGFloat, thick: Bool = false) -> some View {
        Text(verbatim: text)
            .font(.caption.weight(.medium))
            .foregroundStyle(.glett.muted)
            .lineLimit(2)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, 8)
            .frame(width: metrics.label, height: height, alignment: .leading)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.glett.line).frame(height: thick ? 2 : 1) }
    }
}
