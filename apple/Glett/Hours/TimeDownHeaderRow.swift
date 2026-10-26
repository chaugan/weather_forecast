import SwiftUI

/// The column heads of the time-down list (js/app.js:596): "Tid", "Mest sannsynlig vær" with its hint, "Temp. · vind ·
/// nedbør" and, when open, one head per model.
struct TimeDownHeaderRow: View {
    let metrics: TimeDownMetrics
    let models: [HourTable.Model]
    let scrolls: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            Text(verbatim: L10n.t("g.time"))
                .foregroundStyle(.glett.muted)
                .frame(width: metrics.time, alignment: .leading)
                .padding(.leading, 6)
                .background(Color.glett.panel)
                .pinnedLeading(scrolls)
                .zIndex(1)
            VStack(spacing: 1) {
                Text(verbatim: L10n.t("g.prob_weather")).fontWeight(.semibold)
                Text(verbatim: L10n.t("g.prob_weather.hint")).font(.caption2).foregroundStyle(.glett.muted)
            }
            .foregroundStyle(.glett.accent2)
            .frame(width: scrolls ? metrics.probability : nil)
            .frame(maxWidth: scrolls ? nil : .infinity)
            Text(verbatim: L10n.t("g.twr"))
                .fontWeight(.semibold)
                .foregroundStyle(.glett.accent2)
                .frame(width: metrics.summary)
            ForEach(models) { m in
                ModelRowLabel(model: m, alignment: .center).frame(width: metrics.model)
            }
        }
        .font(.caption)
        .multilineTextAlignment(.center)
        .padding(.vertical, 6)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.glett.line).frame(height: 1) }
    }
}
