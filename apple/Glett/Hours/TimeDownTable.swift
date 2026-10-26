import GlettKit
import SwiftUI

/// "Tid nedover" (`renderGridVertical`, js/app.js:568-633): one row per step from the chosen day (today: from now),
/// day headers between the days, and a rolling window that grows with "Vis {n} timer til" up to the end of the week.
/// With the models open the table gets one column per model and scrolls sideways under a pinned time column.
struct TimeDownTable: View {
    let table: HourTable
    let day: Int
    let models: [HourTable.Model]
    let unit: WindUnit

    /// Rows shown (`state.vCount`); nil = the first window. The parent resets it with `.id` on a new day or step.
    @State private var count: Int?

    @ScaledMetric(relativeTo: .footnote) private var timeWidth: CGFloat = 52
    @ScaledMetric(relativeTo: .footnote) private var summaryWidth: CGFloat = 98
    @ScaledMetric(relativeTo: .footnote) private var probabilityWidth: CGFloat = 186
    @ScaledMetric(relativeTo: .footnote) private var modelWidth: CGFloat = 88
    @ScaledMetric(relativeTo: .footnote) private var rowHeight: CGFloat = 62

    var body: some View {
        let start = table.startIndex(day: day)
        let window = HourTable.downWindow[table.step] ?? 24, chunk = HourTable.downAppend[table.step] ?? 6
        let end = min(start + (count ?? window), table.columns.count)
        let cols = Array(table.columns[start..<end])
        let scrolls = !models.isEmpty
        let metrics = TimeDownMetrics(time: timeWidth, summary: summaryWidth, probability: probabilityWidth, model: modelWidth, rowHeight: rowHeight)
        VStack(spacing: 10) {
            Group {
                if scrolls {
                    ScrollView(.horizontal) { grid(cols, start: start, metrics: metrics, scrolls: true) }
                        .scrollIndicators(.visible)
                } else {
                    grid(cols, start: start, metrics: metrics, scrolls: false)
                }
            }
            .clipShape(.rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.glett.line))
            footer(last: cols.last, atEnd: end >= table.columns.count) {
                withAnimation(.snappy) { count = min(end + chunk, table.columns.count) - start }
            }
            .padding(.horizontal, 4)
        }
    }

    private func grid(_ cols: [StepColumn], start: Int, metrics: TimeDownMetrics, scrolls: Bool) -> some View {
        VStack(spacing: 0) {
            TimeDownHeaderRow(metrics: metrics, models: models, scrolls: scrolls)
            ForEach(Array(cols.enumerated()), id: \.element.id) { k, c in
                if k == 0 || cols[k - 1].day != c.day {
                    dayRow(c.day, scrolls: scrolls)
                }
                TimeDownRow(table: table, column: c, models: models, metrics: metrics, unit: unit, scrolls: scrolls)
            }
        }
    }

    /// `tr.dayrow` (css/style.css:470-472): the day across the whole table, its pill pinned to the leading edge.
    private func dayRow(_ d: Int, scrolls: Bool) -> some View {
        HStack {
            DayPill(text: Format.dayLabel(d, in: table.forecast, today: table.today), current: d == day)
                .pinnedLeading(scrolls)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.glett.summary)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.glett.line).frame(height: 1) }
    }

    /// `.vfoot` (js/app.js:598, 603-606): "Viser til {d} kl. {h}" or "Slutt på 7-dagersvarselet", and the more button.
    private func footer(last: StepColumn?, atEnd: Bool, more: @escaping () -> Void) -> some View {
        VStack(spacing: 8) {
            if atEnd {
                Text(verbatim: L10n.t("g.end"))
            } else if let last {
                Text(verbatim: L10n.t("g.until", ["d": Format.dayLabel(last.day, in: table.forecast, today: table.today), "h": last.label]))
            }
            if !atEnd {
                Button(action: more) {
                    Text(verbatim: L10n.t("g.more_hours", ["n": "\((HourTable.downAppend[table.step] ?? 6) * table.step)"]))
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(.glett.accent)
            }
        }
        .font(.footnote)
        .foregroundStyle(.glett.muted)
        .frame(maxWidth: .infinity)
    }
}

#Preview {
    let t = HourTable(engine: PreviewSamples.engine, step: 1)
    ScrollView {
        TimeDownTable(table: t, day: t.today, models: [], unit: .ms).padding()
    }
    .background(.glett.bg)
}

#Preview("All models") {
    let t = HourTable(engine: PreviewSamples.engine, step: 3)
    ScrollView {
        TimeDownTable(table: t, day: t.today, models: t.models(weights: nil), unit: .ms).padding()
    }
    .background(.glett.bg)
}
