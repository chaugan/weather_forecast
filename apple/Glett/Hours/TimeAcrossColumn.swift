import GlettKit
import SwiftUI

/// One step of the time-across strip (js/app.js:319-325, 846-860): the time, then the lanes (weather, agreement, temperature, rain, wind) and, when open, every model. Built lazily, so
/// a week of hours with all models costs only the columns on screen.
struct TimeAcrossColumn: View {
    let table: HourTable
    let column: StepColumn
    let models: [HourTable.Model]
    let metrics: TimeAcrossMetrics
    let unit: WindUnit
    let nowcast: NowcastSeries?

    var body: some View {
        let s = table.engine.step(column)
        VStack(spacing: 0) {
            timeCell
            Group {
                weatherCell(s).frame(height: metrics.weather)
                agreeCell(s).frame(height: metrics.agree)
                Text(verbatim: Format.temp(s.temperature))
                    .font(.callout.weight(.bold))
                    .foregroundStyle(.glett.text)
                    .frame(height: metrics.temp)
                rainCell(s).frame(height: metrics.rain)
                windCell(s).frame(height: metrics.wind)
                    .overlay(alignment: .bottom) { Rectangle().fill(Color.glett.line).frame(height: 1) }
                ForEach(models) { m in
                    ModelCellView(cell: table.cell(m.provider, column), night: column.night, unit: unit)
                        .frame(width: metrics.column, height: metrics.model)
                        .background(m.isHeadline ? Color.glett.accent.opacity(0.06) : Color.clear)
                        .overlay(alignment: .bottom) { Rectangle().fill(Color.glett.line.opacity(0.6)).frame(height: 1) }
                }
            }
            .frame(width: metrics.column)
            .background(column.night ? HoursColor.night : Color.clear)
        }
        .monospacedDigit()
        .overlay {
            if column.now { Color.glett.accent.opacity(0.07).allowsHitTesting(false) }
        }
        .overlay(alignment: .leading) {
            if column.first { Rectangle().fill(Color.glett.line).frame(width: 1) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: accessibilityText(s)))
    }

    private var timeCell: some View {
        Text(verbatim: column.label)
            .font(.caption.weight(column.now ? .bold : .medium))
            .foregroundStyle(column.now ? Color.glett.accent : Color.glett.muted)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(width: metrics.column, height: metrics.time)
            .background(column.now ? Color.glett.accent.opacity(0.08) : Color.clear)
            .overlay(alignment: .bottom) {
                Rectangle().fill(column.now ? Color.glett.accent : Color.glett.line).frame(height: column.now ? 3 : 1)
            }
    }

    @ViewBuilder private func weatherCell(_ s: StepConsensus) -> some View {
        if let top = s.top { WeatherIcon(category: top.category, night: column.night, size: 34, animated: true, date: column.start) } else { dash }
    }

    /// `ln.agree` (js/app.js:322): the top share, bold from 70 %, over the segmented bar.
    @ViewBuilder private func agreeCell(_ s: StepConsensus) -> some View {
        if let shares = s.shares, let top = shares.first {
            let p = Format.percent(top.share) ?? 0
            VStack(spacing: 3) {
                Text(verbatim: "\(p)\u{00A0}%")
                    .font(.caption.weight(p >= AgreementLevel.laneStrongPercent ? .semibold : .regular))
                    .foregroundStyle(p >= AgreementLevel.laneStrongPercent ? Color.glett.text : Color.glett.muted)
                AgreementBar(shares: shares, height: 4).frame(width: min(44, metrics.column - 12))
            }
        } else { dash }
    }

    /// `rainCell` (js/app.js:313-318): the chance, the mean amount from 0.05 mm and the radar pill.
    @ViewBuilder private func rainCell(_ s: StepConsensus) -> some View {
        if let pct = Format.percent(s.rainChance) {
            VStack(spacing: 1) {
                Text(verbatim: "\(pct)\u{00A0}%")
                    .font(.footnote.weight(pct == 0 ? .regular : .semibold))
                    .foregroundStyle(pct == 0 ? Color.glett.muted : Color.glett.text)
                if let mm = s.precipitation, mm >= 0.05 {
                    Text(verbatim: "\(JS.fmt(mm, 1))\(L10n.t("u.mm"))").font(.caption2).foregroundStyle(.glett.muted)
                }
                if let b = RadarBadge.badge(for: column, nowcast: nowcast, rainChance: s.rainChance) {
                    RadarBadgeView(badge: b).scaleEffect(0.9)
                }
            }
        } else { dash }
    }

    /// `ln.wind` (js/app.js:324): the arrow and mean speed, "kast" with the gust under it.
    @ViewBuilder private func windCell(_ s: StepConsensus) -> some View {
        if s.wind != nil {
            VStack(spacing: 1) {
                WindValue(wind: s.wind, direction: s.direction, unit: unit, arrowSize: 14)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.glett.text)
                if s.gust != nil {
                    Text(verbatim: "\(L10n.t("ln.gust")) \(Format.wind(s.gust, unit))").font(.caption2).foregroundStyle(.glett.muted)
                }
            }
        } else { dash }
    }

    private var dash: some View { Text(verbatim: "–").foregroundStyle(.glett.muted) }

    private func accessibilityText(_ s: StepConsensus) -> String {
        var parts = ["\(Format.dayName(column.day, in: table.forecast, today: table.today)) \(column.label)"]
        if let top = s.top { parts.append("\(Format.category(top.category)) \(L10n.t("mg.tip.agree", ["p": "\(Format.percent(top.share) ?? 0)"]))") }
        parts.append(Format.temp(s.temperature))
        parts.append("\(L10n.t("ln.rain")) \(Format.percentText(s.rainChance))")
        if s.wind != nil {
            parts.append(L10n.t("mg.tip.wind", ["v": Format.wind(s.wind, unit), "g": Format.wind(s.gust ?? s.wind, unit), "u": Format.windUnit(unit)]))
        }
        return parts.joined(separator: ", ")
    }
}
