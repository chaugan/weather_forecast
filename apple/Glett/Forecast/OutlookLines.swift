import GlettKit
import SwiftUI

/// The rain and gust lines for the rest of today (`renderSummary`, js/app.js:931-953): "Nedbør fra ca. kl. 15 (70 %)",
/// "Vindkast opptil 14 m/s om kvelden". Tapping one opens the hours.
struct OutlookLines: View {
    let outlook: TodayOutlook
    let windUnit: WindUnit
    var onTap: () -> Void = {}

    var body: some View {
        if outlook.rain != nil || outlook.gust != nil {
            FlowLayout(spacing: 8, lineSpacing: 8) {
                if let rain = outlook.rain {
                    Button(action: onTap) {
                        SummaryChip(text: rainText(rain), tone: (outlook.rainMax ?? 0) >= 0.5 ? .wet : .dry) {
                            Image(systemName: "drop.fill").foregroundStyle(.glett.rain).imageScale(.small)
                        }
                    }
                    .buttonStyle(.plain)
                }
                if let g = outlook.gust {
                    Button(action: onTap) {
                        SummaryChip(text: L10n.t("s.wind", ["v": Format.wind(g.value, windUnit), "u": Format.windUnit(windUnit), "tod": L10n.t(g.timeOfDayKey)]),
                                    tone: g.strong ? .wet : .plain) {
                            // the web turns the arrow by the hour (js/app.js:946 `WI.arrow(top.c.hour * 15)`)
                            WindArrow(degrees: Double(g.column.hour * 15), size: 16)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func rainText(_ r: TodayOutlook.Rain) -> String {
        switch r {
        case .dry: L10n.t(r.key)
        case .restOfDay(let p): L10n.t(r.key, ["p": String(p)])
        case .from(let c, let p): L10n.t(r.key, ["h": c.label, "p": String(p)])
        case .chance(let p): L10n.t(r.key, ["p": String(p)])
        }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    OutlookLines(outlook: PreviewSamples.engine.todayOutlook(), windUnit: .ms).padding().frame(width: 380)
}
