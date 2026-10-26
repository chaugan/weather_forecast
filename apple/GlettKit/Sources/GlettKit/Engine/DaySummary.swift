import Foundation

/// One day card of the 7-day list (`renderDays`, js/app.js:890-921).
public struct DaySummary: Sendable, Identifiable {
    /// Index into `Forecast.dates`.
    public var day: Int
    /// "YYYY-MM-DD", local.
    public var date: String
    /// The most likely weather of the day (each model's `dayCategory` over 06–22, weighted).
    public var category: WeatherCategory?
    /// Weighted mean of each model's highest and lowest temperature of the whole day.
    public var high: Double?
    public var low: Double?
    /// Weighted share of models with ≥ 1 mm from the current hour on (today) or the whole day. The web shows `round(× 100)`.
    public var rainChance: Double?
    /// Weighted mean of the models' precipitation sums, same hours.
    public var precipitation: Double?
    /// Weighted share of models with their own thunder code (≥ 95), same hours; the web shows it from 20 %.
    public var thunderChance: Double?
    /// Weighted mean of the models' highest gusts (km/h), same hours.
    public var gust: Double?
    /// True when today's rain, thunder and gust count only from the current hour on (`wk.rest`).
    public var restOfDay: Bool

    public var id: Int { day }
    /// The web calls the day dry below 0.5 mm.
    public var isDry: Bool { (precipitation ?? 0) < 0.5 }
    public var icon: WeatherIcon? { category.map { WeatherIcon(category: $0, night: false) } }
}

extension ConsensusEngine {
    /// `dayCategory(codes)` of js/app.js:880-888: thunder from 2 hours, snow from 2, rain (with drizzle) from 3, else the most common.
    public static func dayCategory(_ codes: [Double?]) -> WeatherCategory? {
        let cats = JS.nn(codes).compactMap { WeatherCategory(code: $0) }
        var order: [WeatherCategory] = [], c: [WeatherCategory: Int] = [:]
        for k in cats { if c[k] == nil { order.append(k) }; c[k, default: 0] += 1 }
        if (c[.thunder] ?? 0) >= 2 { return .thunder }
        if (c[.snow] ?? 0) >= 2 { return .snow }
        if (c[.rain] ?? 0) + (c[.drizzle] ?? 0) >= 3 { return .rain }
        return JS.stableSorted(order) { c[$0]! > c[$1]! }.first
    }

    /// The day cards (js/app.js:890-921). These read the hourly series directly, so no short-range boost applies.
    public func days() -> [DaySummary] {
        let f = forecast, n = f.time.count, ni = nowIndex
        func slice(_ a: [Double?], _ lo: Int, _ hi: Int) -> [Double?] {
            let l = max(0, min(lo, a.count)), h = max(l, min(hi, a.count)); return Array(a[l..<h])
        }
        return f.dates.indices.map { d in
            let a = d * 24, b = min(a + 24, n)
            let r0 = ni > a && ni < b ? ni : a
            let weather: [WeightedValue<WeatherCategory>] = pairs(.weather, start: nil) { Self.dayCategory(slice($0.hourly.code, a + 6, a + 22)) }
            var order: [WeatherCategory] = [], cnt: [WeatherCategory: Double] = [:]
            for x in weather { if cnt[x.v] == nil { order.append(x.v) }; cnt[x.v] = (cnt[x.v] ?? 0) + x.w }
            let top = JS.stableSorted(order) { cnt[$0]! > cnt[$1]! }.first
            func ext(_ pick: ([Double]) -> Double?) -> Double? {
                Self.wmean(pairs(.temperature2m, start: nil) { p in let v = JS.nn(slice(p.hourly[.temperature2m], a, b)); return v.isEmpty ? nil : pick(v) })
            }
            let sums = { (p: Provider) -> Double? in
                let v = JS.nn(slice(p.hourly[.precipitation], r0, b)); guard !v.isEmpty else { return nil }
                var s = 0.0; for x in v { s += x }; return s
            }
            let rp = Self.wshare(pairs(.precip, start: nil, sums)) { $0 >= 1 }
            let sp = Self.wshare(pairs(.storm, start: nil) { p in
                let v = JS.nn(slice(p.hourly[.weatherCode], r0, b)); return v.isEmpty ? nil : (v.contains { $0 >= 95 } ? 1 : 0)
            }) { $0 == 1 }
            let mm = Self.wmean(pairs(.precip, start: nil, sums))
            let gust = Self.wmean(pairs(.wind, start: nil) { p in JS.nn(slice(p.hourly[.windGusts10m], r0, b)).max() })
            return DaySummary(day: d, date: f.dates[d], category: top, high: ext { $0.max() }, low: ext { $0.min() }, rainChance: rp,
                              precipitation: mm, thunderChance: sp, gust: gust, restOfDay: r0 > a)
        }
    }
}
