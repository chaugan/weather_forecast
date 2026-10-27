import GlettKit
import SwiftUI
import WidgetKit

/// The widgets' faces, one view per family. They take a `GlettSnapshot` and nothing else, so the widget extension
/// and the app's widget gallery (debug builds, `-GlettScreen widgets`) draw the same thing.

// MARK: Pieces

extension NextGlett {
    /// The short "neste glett" for the widgets: "Regn fra ca. 14:20", "Opphold neste 90 min" (`app.w.*`).
    var shortText: String {
        let h = time.map(Format.time) ?? ""
        switch kind {
        case .dryUntil: return AppText.t("app.w.dry.now", ["h": h])
        case .wetUntil: return AppText.t("app.w.wet.now", ["h": h])
        case .blip: return AppText.t("app.w.dry.blip", ["h": h])
        case .dryAll: return AppText.t("app.w.dry.all")
        case .wetAll: return AppText.t("app.w.wet.all")
        }
    }

    /// The SF Symbol beside it: a drop when rain is on its way or falling, a sun-and-cloud when it stays dry.
    var symbol: String {
        switch kind {
        case .dryAll: "cloud.sun"
        case .wetAll, .wetUntil: "umbrella.fill"
        case .dryUntil, .blip: "drop.fill"
        }
    }

    /// Minutes from `now` until rain starts or stops, when that happens within the nowcast.
    func minutes(from now: Date) -> Int? {
        time.map { max(0, Int(($0.timeIntervalSince(now) / 60).rounded())) }
    }
}

/// The "neste glett" line with its symbol.
struct NextGlettLabel: View {
    let next: NextGlett
    var font: Font = .caption

    var body: some View {
        Label {
            Text(verbatim: next.shortText).lineLimit(1).minimumScaleFactor(0.8)
        } icon: {
            Image(systemName: next.symbol).foregroundStyle(next.wetNow || next.time != nil ? Color.glett.rain : Color.glett.sun)
        }
        .font(font)
    }
}

/// The place name, small and bold, as a widget's title.
struct WidgetPlaceTitle: View {
    let name: String
    var body: some View {
        Text(verbatim: name)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.glett.text)
            .lineLimit(1)
    }
}

// MARK: Home Screen

/// systemSmall: the now card in miniature: place, icon, temperature, what most models expect, the verdict dots and
/// "neste glett". Also StandBy.
struct NowSmallView: View {
    let s: GlettSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                WidgetPlaceTitle(name: s.place)
                Spacer(minLength: 4)
            }
            HStack(alignment: .center, spacing: 6) {
                Text(verbatim: Format.temp(s.temperature))
                    .font(.system(size: 40, weight: .heavy).monospacedDigit())
                    .foregroundStyle(.glett.text)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let icon = s.icon { WeatherIcon(name: icon, size: 46) }
            }
            .padding(.top, 2)
            if let c = s.category {
                Text(verbatim: Format.category(c))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.glett.text)
                    .lineLimit(1)
            }
            if let v = s.verdict {
                HStack(spacing: 5) {
                    VerdictDots(dots: v.dots, level: v.level, size: 7)
                    Text(verbatim: "\(s.agreeing)/\(s.activeCount)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.glett.muted)
                }
                .padding(.top, 3)
            }
            Spacer(minLength: 4)
            if let n = s.next { NextGlettLabel(next: n, font: .caption2.weight(.medium)).foregroundStyle(.glett.text) }
        }
    }
}

/// systemMedium: now on the left, the next six hours as columns with the agreement bar under each, "neste glett"
/// along the foot.
struct HoursMediumView: View {
    let s: GlettSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    WidgetPlaceTitle(name: s.place)
                    HStack(spacing: 2) {
                        Text(verbatim: Format.temp(s.temperature))
                            .font(.system(size: 34, weight: .heavy).monospacedDigit())
                            .foregroundStyle(.glett.text)
                            .minimumScaleFactor(0.6)
                            .lineLimit(1)
                        if let icon = s.icon { WeatherIcon(name: icon, size: 32) }
                    }
                    if let c = s.category {
                        Text(verbatim: Format.category(c))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.glett.text)
                            .lineLimit(1)
                    }
                    if let v = s.verdict {
                        HStack(spacing: 4) {
                            VerdictDots(dots: v.dots, level: v.level, size: 6)
                            Text(verbatim: "\(s.agreeing)/\(s.activeCount)")
                                .font(.system(size: 10).monospacedDigit())
                                .foregroundStyle(.glett.muted)
                        }
                    }
                }
                .frame(width: 96, alignment: .leading)
                HStack(spacing: 0) {
                    ForEach(s.hours) { h in
                        VStack(spacing: 5) {
                            Text(verbatim: String(h.label.prefix(2)))
                                .font(.caption2.weight(.semibold).monospacedDigit())
                                .foregroundStyle(.glett.muted)
                            if let icon = h.icon { WeatherIcon(name: icon, size: 28) } else { Color.clear.frame(width: 28, height: 28) }
                            Text(verbatim: Format.temp(h.temperature))
                                .font(.footnote.weight(.semibold).monospacedDigit())
                                .foregroundStyle(.glett.text)
                            AgreementBar(shares: h.shares, height: 4)
                                .padding(.horizontal, 5)
                            Text(verbatim: Format.percentText(h.rainChance))
                                .font(.system(size: 9).monospacedDigit())
                                .foregroundStyle((h.rainChance ?? 0) >= 0.5 ? Color.glett.accent : Color.glett.muted)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }
            Spacer(minLength: 4)
            if let n = s.next { NextGlettLabel(next: n, font: .caption2.weight(.medium)).foregroundStyle(.glett.text) }
        }
    }
}

/// systemLarge: the place now at the top, then seven days with icon, high and low, chance and amount, and gust.
struct DaysLargeView: View {
    let s: GlettSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    WidgetPlaceTitle(name: s.place)
                    if let n = s.next { NextGlettLabel(next: n, font: .caption2.weight(.medium)).foregroundStyle(.glett.text) }
                }
                Spacer(minLength: 4)
                Text(verbatim: Format.temp(s.temperature))
                    .font(.system(size: 30, weight: .heavy).monospacedDigit())
                    .foregroundStyle(.glett.text)
                if let icon = s.icon { WeatherIcon(name: icon, size: 34) }
            }
            Text(verbatim: L10n.t("wk.title"))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.glett.muted)
            VStack(spacing: 0) {
                ForEach(Array(s.days.prefix(7).enumerated()), id: \.element.id) { i, d in
                    if i > 0 { Divider().overlay(Color.glett.line) }
                    DayLine(d: d, windUnit: s.windUnit)
                        .frame(maxHeight: .infinity)
                }
            }
        }
    }
}

/// One day of the large widget.
private struct DayLine: View {
    let d: GlettSnapshot.Day
    let windUnit: WindUnit

    var body: some View {
        HStack(spacing: 8) {
            Text(verbatim: d.name)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.glett.text)
                .lineLimit(1)
                .frame(width: 66, alignment: .leading)
            if let icon = d.icon { WeatherIcon(name: icon, size: 24) } else { Color.clear.frame(width: 24, height: 24) }
            HStack(spacing: 3) {
                Text(verbatim: Format.temp(d.high)).foregroundStyle(.glett.text)
                Text(verbatim: Format.temp(d.low)).foregroundStyle(.glett.muted)
            }
            .font(.footnote.weight(.semibold).monospacedDigit())
            .frame(width: 62, alignment: .leading)
            // as the app's day list: the chance, strong when wet, and the amount
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(verbatim: Format.percentText(d.rainChance))
                    .font(.caption.weight(d.isDry ? .regular : .semibold).monospacedDigit())
                    .foregroundStyle(d.isDry ? Color.glett.muted : Color.glett.accent)
                // a dry day's trace as the app's (`DayRow.dryMM`): "0 mm", "0.3 mm"
                Text(verbatim: d.isDry ? d.precipitation.map { "\(JS.fmt($0, $0 < 0.05 ? 0 : 1))\u{00A0}mm" } ?? "" : Format.mm(d.precipitation))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.glett.muted)
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            if let g = d.gust {
                Text(verbatim: "\(Format.wind(g, windUnit)) \(Format.windUnit(windUnit))")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.glett.muted)
                    .lineLimit(1)
            }
        }
    }
}

// MARK: Lock Screen

/// accessoryRectangular: place and temperature, the verdict dots, "neste glett". The most useful single widget.
struct LockRectangularView: View {
    let s: GlettSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                if let icon = s.icon { WeatherIcon(name: icon, size: 18) }
                Text(verbatim: "\(Format.temp(s.temperature)) \(s.place)")
                    .font(.headline)
                    .lineLimit(1)
                    .widgetAccentable()
            }
            if let c = s.category, let v = s.verdict {
                HStack(spacing: 4) {
                    Text(verbatim: Format.category(c)).lineLimit(1)
                    VerdictDots(dots: v.dots, level: v.level, size: 5)
                }
                .font(.caption)
            }
            if let n = s.next {
                Text(verbatim: n.shortText).font(.caption).lineLimit(1).minimumScaleFactor(0.8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// accessoryCircular: the temperature with the weather icon.
struct LockCircularView: View {
    let s: GlettSnapshot

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: -2) {
                if let icon = s.icon { WeatherIcon(name: icon, size: 24) }
                Text(verbatim: Format.temp(s.temperature))
                    .font(.system(size: 17, weight: .semibold).monospacedDigit())
                    .minimumScaleFactor(0.7)
            }
        }
    }
}

/// accessoryCircular, "Regn om": a ring that fills as the rain (or the dry spell) gets closer, minutes in the middle;
/// the temperature when nothing changes within the nowcast.
struct LockRingView: View {
    let s: GlettSnapshot

    var body: some View {
        if let n = s.next, let m = n.minutes(from: s.date) {
            Gauge(value: Double(max(0, 90 - m)), in: 0...90) {
                Image(systemName: n.wetNow ? "umbrella" : "drop.fill")
            } currentValueLabel: {
                VStack(spacing: -3) {
                    Image(systemName: n.wetNow ? "sun.max.fill" : "drop.fill").font(.system(size: 10))
                    Text(verbatim: "\(m)").font(.system(size: 16, weight: .semibold).monospacedDigit())
                    Text(verbatim: "min").font(.system(size: 8))
                }
            }
            .gaugeStyle(.accessoryCircularCapacity)
            .tint(n.wetNow ? Color.glett.sun : Color.glett.rain)
        } else {
            LockCircularView(s: s)
        }
    }
}

/// accessoryInline: "9° · Opphold neste 90 min" above the clock.
struct LockInlineView: View {
    let s: GlettSnapshot

    var body: some View {
        Text(verbatim: [Format.temp(s.temperature), s.next?.shortText ?? s.category.map(Format.category)]
            .compactMap { $0 }.joined(separator: " · "))
    }
}
