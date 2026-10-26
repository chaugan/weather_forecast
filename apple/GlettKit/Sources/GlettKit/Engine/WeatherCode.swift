import Foundation

/// Weather codes: the code derived when a model has none.
public enum WeatherCode {
    /// `deriveCode(p, i)` of js/app.js:85-94: from precipitation, temperature, CAPE and cloud cover.
    public static func derive(_ h: Hourly, _ i: Int) -> Double? {
        func at(_ v: HourlyVariable) -> Double? { let a = h[v]; return i < a.count ? a[i] : nil }
        let pr = at(.precipitation), tt = at(.temperature2m), c = at(.cloudCover), cape = at(.cape)
        if let pr, pr >= 0.1 {
            if let cape, cape >= 1500, pr >= 1 { return 95 }
            if let tt, tt <= 0.5 { return 73 }
            return pr >= 4 ? 65 : pr >= 0.3 ? 61 : 51
        }
        guard let c else { return nil }
        return c < 20 ? 0 : c < 45 ? 1 : c < 75 ? 2 : 3
    }
}

/// "Feels like" from temperature, wind and humidity.
public enum FeelsLike {
    /// `feelsLike(tC, windKmh, rh)` of js/app.js:73-77 (Steadman without the radiation term); humidity defaults to 60 %.
    public static func steadman(_ tC: Double?, windKmh: Double?, rh: Double?) -> Double? {
        guard let tC else { return nil }
        let wk = windKmh ?? 0
        let ws = (wk == 0 || wk.isNaN ? 0 : wk) / 3.6
        let e = ((rh ?? 60) / 100) * 6.105 * Foundation.exp((17.27 * tC) / (237.7 + tC))
        return tC + 0.33 * e - 0.7 * ws - 4.0
    }
}
