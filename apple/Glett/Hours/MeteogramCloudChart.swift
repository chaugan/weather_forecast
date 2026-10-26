import Charts
import GlettKit
import SwiftUI

/// The cloud panel of one meteogram day: the weighted mean cloud cover, 0–100 %, as a soft area.
struct MeteogramCloudChart: View {
    let slice: MeteogramSlice
    let height: CGFloat
    let width: CGFloat
    /// The x the finger picks (`meteogramSelection`), owned by the day.
    @Binding var selection: Double?

    var body: some View {
        Chart {
            ForEach(slice.continuous.filter { $0.cloud != nil }) { p in
                AreaMark(x: .value("x", slice.x(p)), yStart: .value("%", 0), yEnd: .value("%", p.cloud ?? 0))
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(LinearGradient(colors: [Color.glett.cloudTop, Color.glett.cloudBot.opacity(0.6)], startPoint: .top, endPoint: .bottom))
            }
            ForEach(slice.continuous.filter { $0.cloud != nil }) { p in
                LineMark(x: .value("x", slice.x(p)), y: .value("%", p.cloud ?? 0))
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(Color.glett.muted.opacity(0.7))
                    .lineStyle(StrokeStyle(lineWidth: 1))
            }
        }
        .chartXScale(domain: slice.domain)
        .chartYScale(domain: 0...100)
        .meteogramSelection($selection)
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .frame(width: width, height: height)
        .clipped()
        .accessibilityHidden(true)
    }
}
