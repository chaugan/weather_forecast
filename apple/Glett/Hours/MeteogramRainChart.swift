import Charts
import GlettKit
import SwiftUI

/// The rain panel of one meteogram day (js/app.js:666-671, 682): the wettest model as a light bar, the weighted mean
/// as a solid bar with its amount from 0.25 mm, and MET's radar for the next hours as a dashed outline (amber where it
/// disagrees with the models).
struct MeteogramRainChart: View {
    let slice: MeteogramSlice
    let data: MeteogramData
    let height: CGFloat
    let width: CGFloat

    /// Bars leave this much of the column free on each side (`x = i * CW + 8`, width `CW - 16`).
    private static let inset = 0.18

    var body: some View {
        Chart {
            RuleMark(y: .value("mm", 0)).foregroundStyle(Color.glett.line)
            ForEach(slice.points) { p in
                let x0 = Double(p.index - slice.firstIndex)
                if let mx = p.step.precipitationMax, mx > 0 {
                    RectangleMark(xStart: .value("x", x0 + Self.inset), xEnd: .value("x", x0 + 1 - Self.inset),
                                  yStart: .value("mm", 0), yEnd: .value("mm", mx))
                        .foregroundStyle(Color.glett.rain.opacity(0.22))
                }
                if let m = p.step.precipitation, m >= 0.05 {
                    RectangleMark(xStart: .value("x", x0 + Self.inset), xEnd: .value("x", x0 + 1 - Self.inset),
                                  yStart: .value("mm", 0), yEnd: .value("mm", m))
                        .foregroundStyle(Color.glett.rain)
                        .annotation(position: .top, spacing: 1) {
                            if m >= 0.25 {
                                Text(verbatim: JS.fmt(m, 1)).scaledFont(9.5, weight: .bold).foregroundStyle(.glett.rain).fixedSize()
                            }
                        }
                }
            }
        }
        .chartXScale(domain: slice.domain)
        .chartYScale(domain: 0...data.rainTop * 1.18)
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .chartOverlay { proxy in radar(proxy) }
        .frame(width: width, height: height)
        .clipped()
        .accessibilityHidden(true)
    }

    /// The radar outlines (`rect.rradar`, css/style.css:642-644): Charts has no stroked rectangle mark, so they are
    /// drawn over the plot with the chart's own scales.
    private func radar(_ proxy: ChartProxy) -> some View {
        GeometryReader { geo in
            let origin = proxy.plotFrame.map { geo[$0].origin } ?? .zero
            ForEach(slice.points.filter { $0.radar != nil }) { p in
                let x0 = Double(p.index - slice.firstIndex)
                if let l = proxy.position(forX: x0 + 0.12), let r = proxy.position(forX: x0 + 0.88),
                   let top = proxy.position(forY: max(p.radar ?? 0, 0.04)), let base = proxy.position(forY: 0.0) {
                    Path(CGRect(x: origin.x + l, y: origin.y + top, width: r - l, height: max(1, base - top)))
                        .stroke(p.radarDisagrees ? Color.glett.mid : Color.glett.rain, style: StrokeStyle(lineWidth: 1.2, dash: [3, 2]))
                }
            }
        }
        .allowsHitTesting(false)
    }
}
