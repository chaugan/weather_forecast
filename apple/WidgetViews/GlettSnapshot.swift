import Foundation
import GlettKit

/// What a widget shows at one moment, as plain data: the now card in brief, "neste glett", the next hours and the
/// days. Made from the same consensus and nowcast as the app (`make`), so a widget never says something the app does
/// not; the views only lay it out.
struct GlettSnapshot: Sendable {
    struct Hour: Sendable, Identifiable {
        var id: Date { start }
        var start: Date
        /// "14" (the hour) for the column head.
        var label: String
        var icon: String?
        var night: Bool
        var temperature: Double?
        var rainChance: Double?
        var precipitation: Double?
        /// How the models split by weather type (the agreement bar).
        var shares: [CategoryShare]
    }

    /// The precipitation rate (mm/h) for each step of the nowcast from now, as the radar strip draws it.
    struct Rain: Sendable {
        /// The widgets' "neste 90 min".
        static let span: TimeInterval = 90 * 60
        var rates: [Double]
        var start: Date
        var stepSeconds: Double

        /// Rain falls in some step (≥ `NextGlett.wetRate`).
        var wet: Bool { rates.contains { $0 >= NextGlett.wetRate } }
        var end: Date { start.addingTimeInterval(Double(rates.count) * stepSeconds) }
    }

    struct Day: Sendable, Identifiable {
        var id: Int
        /// "I dag", "I morgen", "tor.".
        var name: String
        var icon: String?
        var high: Double?
        var low: Double?
        var rainChance: Double?
        var precipitation: Double?
        var gust: Double?

        /// Under 0.5 mm, as `DaySummary.isDry`.
        var isDry: Bool { (precipitation ?? 0) < 0.5 }
    }

    var place: String
    var date: Date
    var temperature: Double?
    var feelsLike: Double?
    var showsFeelsLike: Bool
    var icon: String?
    var night: Bool
    var category: WeatherCategory?
    var verdict: Verdict?
    var agreeing: Int
    var activeCount: Int
    var wind: Double?
    var gust: Double?
    var windUnit: WindUnit
    /// "Neste glett" (MET's radar nowcast, or Open-Meteo's 15-minute model outside radar cover).
    var next: NextGlett?
    var hours: [Hour]
    var days: [Day]
    /// The next 90 minutes (MET's radar nowcast, or the model's 15-minute steps); nil without a nowcast.
    var rain: Rain?

    /// The snapshot at `now`: the engine's now column, the next `hourCount` hours from it and the days ahead.
    static func make(place: String, bundle: ForecastBundle, nowcast: NowcastSeries?, settings: ForecastSettings,
                     weights: (any ConsensusWeights)?, now: Date, hourCount: Int = 6) -> GlettSnapshot? {
        let engine = bundle.consensus(settings: settings, weights: weights, now: now)
        guard let s = engine.nowSummary() else { return nil }
        let f = bundle.forecast
        let today = engine.todayIndex
        let columns = engine.columns(step: 1).filter { !$0.past }
        let hours = columns.prefix(hourCount).map { c -> Hour in
            let shares = engine.weatherShares(c) ?? []
            return Hour(start: c.start, label: c.label, icon: shares.first.map { WeatherIcon.name(code: $0.category.representativeCode, night: c.night) },
                        night: c.night, temperature: engine.temperature(c), rainChance: engine.rainChance(c),
                        precipitation: engine.precipitation(c), shares: shares)
        }
        let days = engine.days().filter { $0.day >= today }.map { d in
            Day(id: d.day, name: Format.dayName(d.day, in: f, today: today), icon: d.icon?.rawValue, high: d.high, low: d.low,
                rainChance: d.rainChance, precipitation: d.precipitation, gust: d.gust)
        }
        return GlettSnapshot(place: place, date: now, temperature: s.temperature, feelsLike: s.feelsLike,
                             showsFeelsLike: s.showsFeelsLike, icon: s.icon?.rawValue, night: s.column.night,
                             category: s.top?.category, verdict: s.verdict, agreeing: s.agreeing, activeCount: s.activeCount,
                             wind: s.wind, gust: s.gust, windUnit: settings.windUnit,
                             next: NextGlett.evaluate(nowcast, now: now), hours: Array(hours), days: days,
                             rain: RadarStrip.make(nowcast, now: now).map { strip in
                                 let start = strip.points.first?.date ?? now
                                 let steps = strip.points.prefix { $0.date < start.addingTimeInterval(Rain.span) }
                                 return Rain(rates: steps.map(\.rate), start: start, stepSeconds: strip.stepSeconds)
                             })
    }

    /// Made-up values for the widget gallery's placeholder (drawn redacted) and previews.
    static let placeholder: GlettSnapshot = {
        let now = Date()
        let hours = (0..<6).map { i in
            Hour(start: now.addingTimeInterval(Double(i) * 3600), label: String(format: "%02d:00", (Calendar.current.component(.hour, from: now) + i) % 24),
                 icon: "partly-day", night: false, temperature: 9 - Double(i) * 0.5, rainChance: 0.2, precipitation: 0,
                 shares: [.init(category: .partly, share: 0.6), .init(category: .cloudy, share: 0.4)])
        }
        let days = (0..<7).map { i in Day(id: i, name: "—", icon: "partly-day", high: 10, low: 3, rainChance: 0.3, precipitation: 0.4, gust: 30) }
        return GlettSnapshot(place: "Oslo", date: now, temperature: 9, feelsLike: 7, showsFeelsLike: true, icon: "partly-day", night: false,
                             category: .partly, verdict: nil, agreeing: 9, activeCount: 13, wind: 11, gust: 25, windUnit: .ms,
                             next: nil, hours: hours, days: days)
    }()
}
