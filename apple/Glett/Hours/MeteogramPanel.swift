import GlettKit
import SwiftUI

/// The interactive part of the meteogram: the readout of the picked step, the pinned axis and the week of days that
/// scrolls sideways. A tap (or a long press and drag on the charts) picks a step (default: now, or the first step of the picked day); with VoiceOver, swiping up
/// and down on the readout (the panel's one focusable element) moves it. Opens at now (a third in) or at the picked
/// day, like the strip.
struct MeteogramPanel: View {
    let data: MeteogramData
    let table: HourTable
    let day: Int
    let now: Date

    @State private var selected: Int?
    @State private var position = ScrollPosition(edge: .leading)
    @State private var viewport: CGFloat = 0
    @State private var regions = ReservedRegions()

    @ScaledMetric(relativeTo: .caption2) private var axisWidth: CGFloat = 38

    var body: some View {
        let layout = MeteogramLayout(column: MeteogramLayout.column(step: table.step, viewport: viewport))
        let pick = selected ?? defaultIndex
        VStack(alignment: .leading, spacing: 10) {
            if let i = pick, data.points.indices.contains(i) {
                let p = data.points[i]
                MeteogramReadout(point: p, dayName: Format.dayName(p.column.day, in: table.forecast, today: table.today), unit: data.unit) { dir in
                    switch dir {
                    case .increment: selected = min(data.points.count - 1, i + 1)
                    case .decrement: selected = max(0, i - 1)
                    @unknown default: break
                    }
                }
            }
            HStack(alignment: .top, spacing: 0) {
                MeteogramAxis(data: data, layout: layout, width: axisWidth)
                ScrollView(.horizontal) {
                    LazyHStack(alignment: .top, spacing: 0) {
                        ForEach(data.days, id: \.day) { d in
                            MeteogramDay(slice: MeteogramSlice(data: data, day: d.day, range: d.range), data: data, layout: layout,
                                         today: table.today, currentDay: day, selected: pick, now: now, regions: regions,
                                         dayLabel: Format.dayLabel(d.day, in: table.forecast, today: table.today)) { i in
                                selected = i
                            }
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollPosition($position)
                .scrollIndicators(.visible)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { w in
                    let first = viewport == 0
                    viewport = w
                    if first { scrollToDay(viewport: w, animated: false) }
                }
                .onGeometryChange(for: ReservedRegions.self) { ReservedRegions($0) } action: { regions = $0 }
            }
        }
        .onChange(of: day) { _, _ in
            selected = nil
            scrollToDay(viewport: viewport, animated: true)
        }
        .onChange(of: table.step) { _, _ in
            selected = nil
            scrollToDay(viewport: viewport, animated: false)
        }
        .glettHaptic(.selection, trigger: selected)
        .accessibilityElement(children: .contain)
    }

    /// Now when today is shown, else the first step of the picked day.
    private var defaultIndex: Int? {
        if day == table.today, let n = data.nowIndex { return n }
        return data.days.first { $0.day == day }?.range.lowerBound ?? data.nowIndex
    }

    private func scrollToDay(viewport w: CGFloat, animated: Bool) {
        let cw = MeteogramLayout.column(step: table.step, viewport: w)
        let x: CGFloat
        if day == table.today, let i = data.nowIndex {
            x = CGFloat(i) * cw - (w - cw) * 0.35
        } else {
            x = CGFloat(data.days.first { $0.day == day }?.range.lowerBound ?? 0) * cw
        }
        if animated { withAnimation(.snappy) { position.scrollTo(x: max(0, x)) } } else { position.scrollTo(x: max(0, x)) }
    }
}
