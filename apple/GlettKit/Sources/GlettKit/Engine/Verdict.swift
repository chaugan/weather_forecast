import Foundation

/// The five-dot verdict of the now card (js/app.js:1083-1086).
public struct Verdict: Sendable, Hashable {
    public enum Level: String, Sendable { case high = "hi", mid, low = "lo"
        /// `hero.verdict.<hi|mid|lo>`.
        public var key: String { "hero.verdict.\(rawValue)" }
    }
    public var category: WeatherCategory
    /// The weighted share of the top category (0…1).
    public var share: Double
    /// ≥ 0.8 high, ≥ 0.5 mid, else low.
    public var level: Level
    /// `max(1, round(share × 5))`.
    public var dots: Int
    /// `round(share × nActive)`: "{k} av {n} modeller" (a weighted share times the count, not a raw count).
    public var agreeing: Int
    /// The number of active models.
    public var total: Int
    /// The lowest and highest model temperature for the step; nil without any.
    public var temperatureMin: Double?
    public var temperatureMax: Double?

    /// The detail line's key, `hero.verdict.detail` with {k} {n} {cat} {min} {max}.
    public static let detailKey = "hero.verdict.detail"
}

/// The now card (`renderHero`, js/app.js:1059-1093) without its HTML.
public struct NowSummary: Sendable {
    public var column: StepColumn
    public var shares: [CategoryShare]?
    public var temperature: Double?
    /// Weighted apparent temperature; the web shows it when it differs by ≥ 1° from `temperature`.
    public var feelsLike: Double?
    public var wind: Double?
    public var gust: Double?
    public var direction: Double?
    public var verdict: Verdict?
    /// `round(top share × active)` for "hero.nmodels" (0 without a top).
    public var agreeing: Int
    public var activeCount: Int
    public var uniqueCount: Int

    public var top: CategoryShare? { shares?.first }
    public var icon: WeatherIcon? { top.map { WeatherIcon(category: $0.category, night: column.night) } }
    /// The web shows "føles som" when |feels − temp| ≥ 1.
    public var showsFeelsLike: Bool {
        guard let f = feelsLike, let t = temperature else { return false }
        return abs(f - t) >= 1
    }
}

extension ConsensusEngine {
    /// The step the now card describes: the current hour, else the first one still ahead, else the first (js/app.js:1070).
    public func nowColumn() -> StepColumn? {
        let cols = columns(step: 1)
        return cols.first { $0.now } ?? cols.first { !$0.past } ?? cols.first
    }

    /// The verdict for a step (js/app.js:1083-1086); nil without any category.
    public func verdict(_ c: StepColumn) -> Verdict? {
        guard let top = weatherShares(c)?.first else { return nil }
        let nAll = providers.count
        let k = Int(JS.round(top.share * Double(nAll)))
        let level: Verdict.Level = top.share >= 0.8 ? .high : top.share >= 0.5 ? .mid : .low
        let tv = values(.mean(.temperature2m), c)
        return Verdict(category: top.category, share: top.share, level: level, dots: max(1, Int(JS.round(top.share * 5))),
                       agreeing: k, total: nAll, temperatureMin: tv.min(), temperatureMax: tv.max())
    }

    /// The now card's numbers (`renderHero`).
    public func nowSummary() -> NowSummary? {
        guard let c = nowColumn() else { return nil }
        let shares = weatherShares(c)
        let top = shares?.first
        return NowSummary(column: c, shares: shares, temperature: temperature(c), feelsLike: feelsLike(c), wind: wind(c), gust: gustMean(c),
                          direction: direction(c), verdict: verdict(c),
                          agreeing: top.map { Int(JS.round($0.share * Double(providers.count))) } ?? 0,
                          activeCount: providers.count, uniqueCount: uniqueCount)
    }
}
