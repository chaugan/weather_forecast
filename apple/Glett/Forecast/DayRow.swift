import GlettKit
import SwiftUI

/// One day of the week list (`renderDays`, js/app.js:890-921; css/style.css:736-760): name and date, icon, high/low,
/// rain chance with mm (on a dry day the chance muted over the amount to one decimal, js/app.js:908, 5d6cb3c), thunder
/// from 20 %, the strongest gust.
struct DayRow: View {
    let day: DaySummary
    let name: String
    let date: String
    let windUnit: WindUnit
    let selected: Bool
    let columns: DaysList.Columns

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: name).font(.body.weight(selected ? .semibold : .medium))
                    .foregroundStyle(selected ? Color.glett.accent : Color.glett.muted)
                    .minimumScaleFactor(0.6)
                Text(verbatim: date).font(.caption).foregroundStyle(.glett.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Group {
                if let c = day.category { WeatherIcon(category: c, night: false, size: 30, animated: true) } else { Color.clear }
            }
            .frame(width: columns.icon)
            HStack(spacing: 4) {
                Text(verbatim: Format.temp(day.high)).fontWeight(.semibold).foregroundStyle(.glett.text)
                Text(verbatim: Format.temp(day.low)).foregroundStyle(.glett.muted)
            }
            .font(.body)
            .monospacedDigit()
            .minimumScaleFactor(0.7)
            .frame(width: columns.hilo, alignment: .trailing)
            rain.frame(width: columns.rain, alignment: .trailing)
            gust.frame(width: columns.gust, alignment: .trailing)
        }
        .lineLimit(1)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: spoken))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    /// What VoiceOver reads, each value with its column's name (the header row is hidden from it): "tor., 26. okt.,
    /// Regn, Høy / lav 7° / 2°, Nedbør 42 %, 1,2 mm, Torden 25 %, Kast 8 m/s".
    private var spoken: String {
        var parts = [name, date]
        if let c = day.category { parts.append(Format.category(c)) }
        parts.append("\(L10n.t("wk.hilo")) \(Format.temp(day.high)) / \(Format.temp(day.low))")
        if let p = day.rainChance {
            parts.append("\(L10n.t("wk.rain")) \(Format.percentText(p)), \(day.isDry ? Self.dryMM(day.precipitation) ?? "" : Format.mm(day.precipitation))")
        }
        if let s = Format.percent(day.thunderChance), s >= 20 { parts.append("\(L10n.t("p.storm")) \(s)\u{00A0}%") }
        if let g = day.gust { parts.append("\(L10n.t("wk.gust")) \(Format.wind(g, windUnit)) \(Format.windUnit(windUnit))") }
        if day.restOfDay { parts.append(L10n.t("wk.rest")) }
        return parts.joined(separator: ", ")
    }

    private var rain: some View {
        VStack(alignment: .trailing, spacing: 0) {
            if let p = day.rainChance {
                if day.isDry {
                    Text(verbatim: Format.percentText(p)).foregroundStyle(.glett.muted)
                    if let mm = Self.dryMM(day.precipitation) { Text(verbatim: mm).font(.caption).foregroundStyle(.glett.muted) }
                } else {
                    Text(verbatim: Format.percentText(p)).fontWeight(.semibold).foregroundStyle(.glett.accent)
                    Text(verbatim: Format.mm(day.precipitation)).font(.caption).foregroundStyle(.glett.muted)
                }
            }
            if let s = Format.percent(day.thunderChance), s >= 20 {
                HStack(spacing: 2) {
                    Image(systemName: "bolt.fill").imageScale(.small).foregroundStyle(.glett.bolt)
                    Text(verbatim: "\(s)\u{00A0}%")
                }
                .font(.caption)
                .foregroundStyle(.glett.muted)
            }
        }
        .font(.footnote)
        .monospacedDigit()
        .minimumScaleFactor(0.7)
    }

    /// A dry day's amount: one decimal, "0 mm" below 0.05 (`fmt(mm, mm < 0.05 ? 0 : 1)`).
    static func dryMM(_ v: Double?) -> String? {
        v.map { "\(JS.fmt($0, $0 < 0.05 ? 0 : 1))\u{00A0}mm" }
    }

    @ViewBuilder
    private var gust: some View {
        if let g = day.gust {
            HStack(spacing: 2) {
                WindArrow(degrees: 0, size: 12)
                Text(verbatim: Format.wind(g, windUnit)).font(.footnote.weight(.medium)).foregroundStyle(.glett.text)
            }
            .monospacedDigit()
        }
    }
}
