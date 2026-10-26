import GlettKit
import SwiftUI

/// One day of the meteogram (`meteogramDay(d)`, js/app.js:658-697), at the chosen step: the day label, the hours,
/// the most likely weather with its agreement and the segmented bar, then temperature, rain, wind (line, arrows) and
/// cloud. Night columns are shaded, a line marks now; a tap (or, on the charts, a long press and drag) picks a step for
/// the readout and the cursor.
struct MeteogramDay: View {
    let slice: MeteogramSlice
    let data: MeteogramData
    let layout: MeteogramLayout
    let today: Int
    let currentDay: Int
    let selected: Int?
    let now: Date
    let regions: ReservedRegions
    let dayLabel: String
    let onSelect: (Int) -> Void

    var body: some View {
        let w = layout.column * CGFloat(slice.count)
        VStack(alignment: .leading, spacing: 0) {
            DayPill(text: dayLabel, current: slice.day == currentDay)
                .padding(.leading, 6)
                .pinnedLeading(span: w - 6)
                .frame(width: w, height: layout.header, alignment: .leading)
            VStack(spacing: 0) {
                row(layout.hours) { p in
                    Text(verbatim: hourLabel(p.column))
                        .scaledFont(11, weight: p.column.now ? .bold : .regular, relativeTo: .caption2, monospacedDigit: true)
                        .foregroundStyle(p.column.now ? Color.glett.accent : Color.glett.muted)
                }
                row(layout.icon) { p in
                    if let top = p.step.top { WeatherIcon(category: top.category, night: p.column.night, size: 24, animated: true, date: p.column.start) }
                }
                row(layout.agree) { p in
                    if let top = p.step.top {
                        Text(verbatim: "\(Format.percent(top.share) ?? 0)%")
                            .scaledFont(10.5, weight: .bold, monospacedDigit: true)
                            .foregroundStyle(AgreementLevel(meteogramShare: top.share).color)
                    }
                }
                row(layout.strip) { p in
                    if let shares = p.step.shares { AgreementBar(shares: shares, height: 4).padding(.horizontal, 5) }
                }
                MeteogramTemperatureChart(slice: slice, data: data, height: layout.temperature, width: w)
                MeteogramRainChart(slice: slice, data: data, height: layout.rain, width: w)
                MeteogramWindChart(slice: slice, data: data, height: layout.wind, width: w)
                row(layout.arrows) { p in
                    VStack(spacing: 0) {
                        WindValue(wind: p.step.wind, direction: p.step.direction, unit: data.unit, arrowSize: 11)
                            .scaledFont(11, weight: .medium, relativeTo: .caption2)
                            .foregroundStyle(.glett.text)
                        if p.step.gust != nil {
                            Text(verbatim: Format.wind(p.step.gust, data.unit)).scaledFont(9.5).foregroundStyle(.glett.muted)
                        }
                    }
                }
                MeteogramCloudChart(slice: slice, height: layout.cloud, width: w)
            }
            .background(alignment: .leading) { nightShading }
            .overlay(alignment: .topLeading) { nowLine }
            .overlay(alignment: .topLeading) { cursor }
        }
        .frame(width: w, alignment: .leading)
        .overlay(alignment: .leading) {
            if slice.firstIndex > 0 {
                Rectangle().fill(Color.glett.line).frame(width: 1).padding(.top, layout.header - 4)
            }
        }
        .contentShape(Rectangle())
        // a tap picks the step; nothing here may hold a sideways swipe, which scrolls the week (owner, 2026-10-26)
        .onTapGesture { location in
            let k = Int(location.x / layout.column)
            if k >= 0 && k < slice.count { onSelect(slice.firstIndex + k) }
        }
        .accessibilityHidden(true)   // the readout above speaks for the picked step
    }

    /// One cell per step, the width of a column.
    private func row<C: View>(_ height: CGFloat, @ViewBuilder _ cell: @escaping (MeteogramPoint) -> C) -> some View {
        HStack(spacing: 0) {
            ForEach(slice.points) { p in cell(p).frame(width: layout.column, height: height) }
        }
    }

    /// "14" for hours (`s.c.label.slice(0, 2)`), "06–09" for longer steps.
    private func hourLabel(_ c: StepColumn) -> String { c.hours == 1 ? String(c.label.prefix(2)) : c.label }

    /// `rect.nt` (js/app.js:679, css/style.css:582, 589): night columns behind every row.
    private var nightShading: some View {
        HStack(spacing: 0) {
            ForEach(slice.points) { p in (p.column.night ? HoursColor.night : Color.clear).frame(width: layout.column) }
        }
    }

    /// `line.nowl` (js/app.js:680-681): at the current time within the current step. It moves every minute by the
    /// clock; `now` (the engine's time) places it when the clock is outside the step (previews, fixtures).
    @ViewBuilder private var nowLine: some View {
        if let p = slice.points.first(where: { $0.column.now }) {
            let span = Double(p.column.hours) * 3600
            TimelineView(.everyMinute) { ctx in
                let live = ctx.date.timeIntervalSince(p.column.start)
                let elapsed = (0...span).contains(live) ? live : now.timeIntervalSince(p.column.start)
                let frac = min(1, max(0, elapsed / span))
                Rectangle()
                    .fill(Color.glett.accent)
                    .frame(width: 1.5, height: layout.body)
                    .offset(x: (CGFloat(p.index - slice.firstIndex) + frac) * layout.column - 0.75)
                    .allowsHitTesting(false)
            }
        }
    }

    @ViewBuilder private var cursor: some View {
        if let s = selected, slice.points.contains(where: { $0.index == s }) {
            MeteogramCursor(width: layout.column, height: layout.body, regions: regions)
                .offset(x: CGFloat(s - slice.firstIndex) * layout.column)
        }
    }
}
