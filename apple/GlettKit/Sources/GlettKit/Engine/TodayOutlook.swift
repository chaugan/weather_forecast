import Foundation

/// The practical one-liners of the now card for today (`renderSummary`, js/app.js:931-953), as data.
public struct TodayOutlook: Sendable {
    public enum Rain: Sendable, Hashable {
        /// Max chance < 20 %: `s.dry` (whole day) or `s.dry.rest` (rest of the day).
        case dry(restOfDay: Bool)
        /// The first hour ahead already ≥ 50 %: `s.rain.rest` {p}.
        case restOfDay(percent: Int)
        /// ≥ 50 % from a later hour: `s.rain.from` {h: label} {p}.
        case from(column: StepColumn, percent: Int)
        /// Some chance, never 50 %: `s.rain` {p}.
        case chance(percent: Int)

        public var key: String {
            switch self {
            case .dry(let r): r ? "s.dry.rest" : "s.dry"
            case .restOfDay: "s.rain.rest"
            case .from: "s.rain.from"
            case .chance: "s.rain"
            }
        }
    }
    public struct Gust: Sendable, Hashable {
        /// km/h.
        public var value: Double
        public var column: StepColumn
        /// ≥ 60 km/h (the web colours it as a warning).
        public var strong: Bool
        /// `s.tod.<night|morning|midday|afternoon|evening>` for the hour (js/app.js:929).
        public var timeOfDayKey: String
    }
    public var rain: Rain?
    /// The hour a tap scrolls to (the first ≥ 50 % hour).
    public var rainHour: Int?
    /// The highest chance ahead (0…1); the web marks the line wet from 50 %.
    public var rainMax: Double?
    /// Only when the strongest gust ahead reaches 43 km/h (`s.wind` {v} {u} {tod}).
    public var gust: Gust?

    /// `timeOfDay(h)` of js/app.js:929.
    public static func timeOfDayKey(_ h: Int) -> String {
        h < 6 ? "s.tod.night" : h < 11 ? "s.tod.morning" : h < 14 ? "s.tod.midday" : h < 18 ? "s.tod.afternoon" : "s.tod.evening"
    }
}

extension ConsensusEngine {
    /// `renderSummary()`'s rain and gust lines, for today's remaining hours.
    public func todayOutlook() -> TodayOutlook {
        let all = columns(step: 1, day: todayIndex)
        let cols = all.filter { !$0.past || $0.now }
        let partial = cols.count < all.count
        var out = TodayOutlook()
        guard !cols.isEmpty else { return out }
        let rain = cols.compactMap { c in rainChance(c).map { (c, $0) } }
        if !rain.isEmpty {
            let maxP = rain.map(\.1).max()!
            let pct = Int(JS.round(maxP * 100))
            let first = rain.first { $0.1 >= 0.5 }
            if maxP < 0.2 { out.rain = .dry(restOfDay: partial) }
            else if let first, first.0 == rain[0].0 { out.rain = .restOfDay(percent: pct) }
            else if let first { out.rain = .from(column: first.0, percent: pct) }
            else { out.rain = .chance(percent: pct) }
            out.rainHour = first?.0.hour
            out.rainMax = maxP
        }
        let gusts = cols.compactMap { c in gustMean(c).map { (c, $0) } }
        if var top = gusts.first {
            for x in gusts.dropFirst() where x.1 > top.1 { top = x }
            if top.1 >= Self.strongGust {
                out.gust = .init(value: top.1, column: top.0, strong: top.1 >= Self.gustThreshold, timeOfDayKey: TodayOutlook.timeOfDayKey(top.0.hour))
            }
        }
        return out
    }
}
