import GlettKit
import SwiftUI

/// The values of the picked step, above the meteogram (the web's tap tooltip, `mgTooltip`, js/app.js:699-714, kept
/// in the layout so it never covers the chart, a finger or a reserved region): "kl. 14 · Regn 62 % enige", then
/// temperature with the models' range, rain with the wettest model, wind with gusts and cloud cover.
struct MeteogramReadout: View {
    let point: MeteogramPoint
    let dayName: String
    let unit: WindUnit
    /// VoiceOver's swipe up / down on the readout: the next or previous step (nil = not adjustable).
    var onAdjust: ((AccessibilityAdjustmentDirection) -> Void)?

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            if let top = point.step.top {
                WeatherIcon(category: top.category, night: point.column.night, size: 34)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: Self.title(point, dayName: dayName)).fontWeight(.semibold).foregroundStyle(.glett.text)
                    if let top = point.step.top {
                        Text(verbatim: Format.category(top.category)).foregroundStyle(.glett.text)
                        Text(verbatim: L10n.t("mg.tip.agree", ["p": "\(Format.percent(top.share) ?? 0)"]))
                            .foregroundStyle(AgreementLevel(meteogramShare: top.share).color)
                            .fontWeight(.semibold)
                    }
                }
                .font(.subheadline)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                Text(verbatim: Self.values(point, unit: unit))
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.glett.muted)
                    .lineLimit(2, reservesSpace: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.glett.summary, in: .rect(cornerRadius: 12))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: Self.spoken(point, dayName: dayName, unit: unit)))
        .accessibilityAdjustableAction { dir in onAdjust?(dir) }
    }

    /// "Nå", else "fre. kl. 14" (`hero.now`, `mg.tip.at`).
    static func title(_ p: MeteogramPoint, dayName: String) -> String {
        p.column.now ? L10n.t("hero.now").capitalized(with: L10n.locale) : "\(dayName) \(L10n.t("mg.tip.at", ["h": p.column.label]))"
    }

    /// js/app.js:705-708, plus cloud cover.
    static func values(_ p: MeteogramPoint, unit: WindUnit) -> String {
        let s = p.step
        var parts: [String] = []
        if s.temperature != nil {
            parts.append(L10n.t("mg.tip.temp", ["v": JS.fmt(s.temperature), "lo": JS.fmt(s.temperatureMin), "hi": JS.fmt(s.temperatureMax)]))
        }
        if let mm = s.precipitation, mm >= 0.05 {
            parts.append(L10n.t("mg.tip.rain", ["v": JS.fmt(mm, 1), "mx": JS.fmt(s.precipitationMax ?? 0, 1)]))
        } else {
            parts.append(L10n.t("mg.tip.norain"))
        }
        if s.wind != nil {
            parts.append(L10n.t("mg.tip.wind", ["v": Format.wind(s.wind, unit), "g": Format.wind(s.gust ?? s.wind, unit), "u": Format.windUnit(unit)]))
        }
        if let c = p.cloud { parts.append("\(L10n.t("p.cloud_cover")) \(JS.fmt(c))\u{00A0}%") }
        return parts.joined(separator: " · ")
    }

    static func spoken(_ p: MeteogramPoint, dayName: String, unit: WindUnit) -> String {
        var s = title(p, dayName: dayName)
        if let top = p.step.top {
            s += ", \(Format.category(top.category)) \(L10n.t("mg.tip.agree", ["p": "\(Format.percent(top.share) ?? 0)"]))"
        }
        return s + ", " + values(p, unit: unit)
    }
}
