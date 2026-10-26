import Charts
import GlettKit
import SwiftUI

/// The temperature panel of one meteogram day (js/app.js:672-680): the weighted mean as a smooth line, the spread
/// between the models (lowest to highest) as a band, grid lines and a label every third hour.
struct MeteogramTemperatureChart: View {
    let slice: MeteogramSlice
    let data: MeteogramData
    let height: CGFloat
    let width: CGFloat

    /// A label every third hour (`i % 3 === 1`, js/app.js:677); every step when steps are 3 h or longer.
    private var labelEvery: Int { max(1, 3 / max(1, slice.points.first?.column.hours ?? 1)) }

    var body: some View {
        Chart {
            ForEach(data.temperatureTicks, id: \.self) { v in
                RuleMark(y: .value("°", v))
                    .foregroundStyle(Color.glett.line)
                    .lineStyle(StrokeStyle(lineWidth: 1))
            }
            ForEach(slice.continuous.filter { $0.step.temperatureMin != nil && $0.step.temperatureMax != nil }) { p in
                AreaMark(x: .value("x", slice.x(p)),
                         yStart: .value("min", p.step.temperatureMin ?? 0),
                         yEnd: .value("max", p.step.temperatureMax ?? 0),
                         series: .value("s", "band"))
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(HoursColor.temperature.opacity(0.14))
            }
            ForEach(slice.continuous.filter { $0.step.temperature != nil }) { p in
                LineMark(x: .value("x", slice.x(p)), y: .value("°", p.step.temperature ?? 0), series: .value("s", "mean"))
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(HoursColor.temperature)
                    .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
            }
            ForEach(slice.points.filter { $0.step.temperature != nil && ($0.index - slice.firstIndex) % labelEvery == labelEvery / 2 }) { p in
                PointMark(x: .value("x", slice.x(p)), y: .value("°", p.step.temperature ?? 0))
                    .symbolSize(0)
                    .annotation(position: .top, spacing: 3) {
                        Text(verbatim: Format.temp(p.step.temperature))
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.glett.text)
                    }
            }
        }
        .chartXScale(domain: slice.domain)
        .chartYScale(domain: data.temperature)
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .frame(width: width, height: height)
        .clipped()
        .accessibilityHidden(true)
    }
}
