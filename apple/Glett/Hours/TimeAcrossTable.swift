import GlettKit
import SwiftUI

/// "Tid bortover" (`renderGrid` with lanes, js/app.js:842-873): the whole week as one strip that scrolls sideways
/// under pinned lane names. It opens at the current step (a third in, `centerNow`, js/app.js:414) or at the first
/// step of the day picked in the week list (`scrollToDay`, js/app.js:425).
struct TimeAcrossTable: View {
    let table: HourTable
    let day: Int
    let models: [HourTable.Model]
    let unit: WindUnit
    let nowcast: NowcastSeries?

    @State private var position = ScrollPosition(edge: .leading)
    @State private var viewport: CGFloat = 0

    @ScaledMetric(relativeTo: .caption) private var labelWidth: CGFloat = 88
    @ScaledMetric(relativeTo: .caption) private var columnWidth: CGFloat = 62
    @ScaledMetric(relativeTo: .caption) private var dayHeight: CGFloat = 28
    @ScaledMetric(relativeTo: .caption) private var timeHeight: CGFloat = 26
    @ScaledMetric(relativeTo: .caption) private var weatherHeight: CGFloat = 46
    @ScaledMetric(relativeTo: .caption) private var agreeHeight: CGFloat = 38
    @ScaledMetric(relativeTo: .caption) private var tempHeight: CGFloat = 32
    @ScaledMetric(relativeTo: .caption) private var rainHeight: CGFloat = 56
    @ScaledMetric(relativeTo: .caption) private var windHeight: CGFloat = 44
    @ScaledMetric(relativeTo: .caption) private var modelHeight: CGFloat = 62

    var body: some View {
        let m = TimeAcrossMetrics(label: labelWidth, column: columnWidth, day: dayHeight, time: timeHeight, weather: weatherHeight,
                                  agree: agreeHeight, temp: tempHeight, rain: rainHeight, wind: windHeight, model: modelHeight)
        let cols = table.columns
        // steps per day, in order: the day row is drawn whole (7 views), so a day's label is there even when the lazy
        // columns of its first hours are not
        let perDay = cols.reduce(into: [(day: Int, n: Int)]()) { acc, c in
            if acc.last?.day == c.day { acc[acc.count - 1].n += 1 } else { acc.append((c.day, 1)) }
        }
        HStack(alignment: .top, spacing: 0) {
            TimeAcrossLabels(metrics: m, models: models, unit: unit).zIndex(1)
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 0) {
                        ForEach(perDay, id: \.day) { d in
                            let w = CGFloat(d.n) * m.column
                            DayPill(text: Format.dayLabel(d.day, in: table.forecast, today: table.today), current: d.day == day)
                                .padding(.leading, 4)
                                .pinnedLeading(span: w - 4)
                                .frame(width: w, height: m.day, alignment: .leading)
                                .clipped()
                        }
                    }
                    LazyHStack(alignment: .top, spacing: 0) {
                        ForEach(cols) { c in
                            TimeAcrossColumn(table: table, column: c, models: models, metrics: m, unit: unit, nowcast: nowcast)
                        }
                    }
                }
            }
            .scrollPosition($position)
            .scrollIndicators(.visible)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { w in
                let first = viewport == 0
                viewport = w
                if first { scrollToDay(m.column, animated: false) }
            }
            .onChange(of: day) { _, _ in scrollToDay(m.column, animated: true) }
            .onChange(of: table.step) { _, _ in scrollToDay(m.column, animated: false) }
        }
        .clipShape(.rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.glett.line))
    }

    private func scrollToDay(_ columnWidth: CGFloat, animated: Bool) {
        let cols = table.columns
        let x: CGFloat
        if day == table.today, let i = table.nowIndex {
            x = CGFloat(i) * columnWidth - (viewport - columnWidth) * 0.35
        } else {
            x = CGFloat(cols.firstIndex { $0.day == day } ?? 0) * columnWidth
        }
        let target = max(0, x)
        if animated { withAnimation(.snappy) { position.scrollTo(x: target) } } else { position.scrollTo(x: target) }
    }
}

#Preview {
    let t = HourTable(engine: PreviewSamples.engine, step: 1)
    ScrollView {
        TimeAcrossTable(table: t, day: t.today, models: Array(t.models(weights: nil).prefix(3)), unit: .ms, nowcast: nil).padding()
    }
    .background(.glett.bg)
}
