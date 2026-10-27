import Foundation
import GlettKit

/// Number, time and day formatting as the web prints them (js/app.js `fmt`, `wv`/`wu`, `dayName`, `dayLabel`).
enum Format {
    /// "7°" (`${fmt(v)}°`).
    static func temp(_ v: Double?) -> String { "\(JS.fmt(v))°" }

    /// The wind in the chosen unit, no decimals (`fmt(wv(kmh))`, js/app.js:81).
    static func wind(_ kmh: Double?, _ unit: WindUnit) -> String { JS.fmt(unit.value(kmh)) }

    /// `wu()` (js/app.js:82): "m/s" or "km/t".
    static func windUnit(_ unit: WindUnit) -> String { L10n.t(unit.key) }

    /// A share 0…1 as the web's `Math.round(p * 100)`.
    static func percent(_ share: Double?) -> Int? { share.map { Int(JS.round($0 * 100)) } }

    /// "42 %" with a no-break space, as the web's `${p}&nbsp;%`; "–" for none.
    static func percentText(_ share: Double?) -> String { percent(share).map { "\($0)\u{00A0}%" } ?? "–" }

    /// "mm" with one decimal below 10 (js/app.js:913 `fmt(mm, mm < 10 ? 1 : 0)`).
    static func mm(_ v: Double?) -> String {
        guard let v else { return "–" }
        return "\(JS.fmt(v, v < 10 ? 1 : 0))\u{00A0}mm"
    }

    /// "14:05" in the app's language, device time zone (`fmtTime`, js/app.js:930).
    static func time(_ d: Date) -> String {
        d.formatted(Date.FormatStyle(locale: L10n.locale).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    }

    /// When a forecast was fetched: "14:05" today, "fre. 23. okt. 14:05" on another day (device time zone).
    static func fetched(_ d: Date, now: Date = Date()) -> String {
        if Calendar.current.isDate(d, inSameDayAs: now) { return time(d) }
        let day = d.formatted(Date.FormatStyle(locale: L10n.locale).weekday(.abbreviated).day().month(.abbreviated))
        return "\(day) \(time(d))"
    }

    /// Noon of a forecast date ("YYYY-MM-DD") in the place's zone, as the web's `new Date(date + 'T12:00:00')`.
    static func noon(_ date: String, in f: Forecast) -> Date {
        Date(timeIntervalSince1970: JS.localToUnix(date + "T12:00", offset: f.utcOffsetSeconds))
    }

    /// `dayName(d)` (js/app.js:197): "I dag", "I morgen", else the short weekday ("tor.").
    static func dayName(_ d: Int, in f: Forecast, today: Int) -> String {
        if d == today { return L10n.t("today") }
        if d == today + 1 { return L10n.t("tomorrow") }
        guard d >= 0, d < f.dates.count else { return "" }
        var style = Date.FormatStyle(locale: L10n.locale).weekday(.abbreviated)
        style.timeZone = f.timeZone
        return noon(f.dates[d], in: f).formatted(style)
    }

    /// The short date of a forecast day ("26. okt." / "26 Oct").
    static func shortDate(_ d: Int, in f: Forecast) -> String {
        guard d >= 0, d < f.dates.count else { return "" }
        var style = Date.FormatStyle(locale: L10n.locale).day().month(.abbreviated)
        style.timeZone = f.timeZone
        return noon(f.dates[d], in: f).formatted(style)
    }

    /// `dayLabel(d)` (js/app.js:198): "I morgen 26. okt.".
    static func dayLabel(_ d: Int, in f: Forecast, today: Int) -> String {
        "\(dayName(d, in: f, today: today)) \(shortDate(d, in: f))"
    }

    /// A model's display name (`mn.<id>`, else the English name).
    static func modelName(_ p: Provider) -> String { L10n.has(p.nameKey) ? L10n.t(p.nameKey) : p.name }

    /// The category name (`cat.<x>`).
    static func category(_ c: WeatherCategory) -> String { L10n.t(c.key) }
}
