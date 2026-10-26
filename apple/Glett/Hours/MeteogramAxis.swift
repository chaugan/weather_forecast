import GlettKit
import SwiftUI

/// The pinned left edge of the meteogram (`.mglabels`, js/app.js:724, put beside the rows they name): what each row
/// is, with the temperature grid values, the top of the rain axis and the units.
struct MeteogramAxis: View {
    let data: MeteogramData
    let layout: MeteogramLayout
    let width: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: layout.header + layout.hours + layout.icon)
            title(L10n.t("mg.agree")).frame(height: layout.agree)
            Color.clear.frame(height: layout.strip)
            temperature.frame(height: layout.temperature)
            panel(L10n.t("mg.rain"), L10n.t("u.mm").trimmingCharacters(in: .whitespaces), top: JS.fmt(data.rainTop, data.rainTop < 10 ? 1 : 0)).frame(height: layout.rain)
            panel(L10n.t("mg.wind"), Format.windUnit(data.unit), top: JS.fmt(data.windTop)).frame(height: layout.wind)
            title(L10n.t("mg.gust")).frame(height: layout.arrows, alignment: .bottom).padding(.bottom, 2)
            panel(L10n.t("p.cloud_cover"), "%", top: nil).frame(height: layout.cloud)
        }
        .padding(.trailing, 3)   // keeps a long name ("Skydekke") off the chart's edge
        .frame(width: width, alignment: .leading)
        .accessibilityHidden(true)
    }

    private func title(_ s: String) -> some View {
        Text(verbatim: s).scaledFont(10, weight: .semibold).foregroundStyle(.glett.muted).lineLimit(1).minimumScaleFactor(0.6)
    }

    /// The three grid values at their heights (js/app.js:678 `text.gt`) and the name between the upper two.
    private var temperature: some View {
        GeometryReader { geo in
            let h = geo.size.height, r = data.temperature
            ForEach(data.temperatureTicks, id: \.self) { v in
                let y = h * (1 - (v - r.lowerBound) / (r.upperBound - r.lowerBound))
                Text(verbatim: "\(JS.fmt(v))°")
                    .scaledFont(10, monospacedDigit: true)
                    .foregroundStyle(.glett.muted)
                    .position(x: width / 2, y: min(h - 9, max(7, y)))
            }
            title(L10n.t("mg.temp")).position(x: width / 2, y: h * 0.27)
        }
    }

    private func panel(_ name: String, _ unit: String, top: String?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let top { Text(verbatim: top).scaledFont(10, monospacedDigit: true).foregroundStyle(.glett.muted).padding(.top, 6) }
            Spacer(minLength: 0)
            title(name)
            Text(verbatim: unit).scaledFont(9.5).foregroundStyle(.glett.muted).lineLimit(1).minimumScaleFactor(0.6)
        }
        .padding(.vertical, 2)
    }
}
