import Charts
import GlettKit
import SwiftUI

/// The wind panel of one meteogram day: the weighted mean wind as a line, the strongest gusts (the models' mean of
/// their highest gust, `gustMean`) as a dashed line over a light area, in the chosen unit.
struct MeteogramWindChart: View {
    let slice: MeteogramSlice
    let data: MeteogramData
    let height: CGFloat
    let width: CGFloat

    var body: some View {
        let u = data.unit
        Chart {
            RuleMark(y: .value("v", 0)).foregroundStyle(Color.glett.line)
            ForEach(slice.continuous.filter { $0.step.gust != nil }) { p in
                AreaMark(x: .value("x", slice.x(p)), yStart: .value("v", 0), yEnd: .value("v", u.value(p.step.gust) ?? 0),
                         series: .value("s", "gustArea"))
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(HoursColor.wind.opacity(0.12))
                LineMark(x: .value("x", slice.x(p)), y: .value("v", u.value(p.step.gust) ?? 0), series: .value("s", "gust"))
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(HoursColor.wind.opacity(0.75))
                    .lineStyle(StrokeStyle(lineWidth: 1.2, dash: [4, 3]))
            }
            ForEach(slice.continuous.filter { $0.step.wind != nil }) { p in
                LineMark(x: .value("x", slice.x(p)), y: .value("v", u.value(p.step.wind) ?? 0), series: .value("s", "wind"))
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(HoursColor.wind)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
        }
        .chartXScale(domain: slice.domain)
        .chartYScale(domain: 0...data.windTop)
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .frame(width: width, height: height)
        .clipped()
        .accessibilityHidden(true)
    }
}
