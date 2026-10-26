import Foundation

/// The few JavaScript number and string rules the web code relies on, so the port gives the same numbers, keys and URLs.
/// Every function names the JS it stands in for.
public enum JS {
    /// `Math.round(x)`: the nearest integer, halves towards +∞ (Swift's `.rounded()` sends -2.5 to -3, JS to -2).
    @inlinable public static func round(_ x: Double) -> Double {
        guard x.isFinite else { return x }
        let f = x.rounded(.down)
        return x - f >= 0.5 ? f + 1 : f   // x - floor(x) is exact for every double
    }

    /// `round(v, d)` of js/data.js:43: `Math.round(v * 10 ** d) / 10 ** d`.
    @inlinable public static func round(_ x: Double, _ digits: Int) -> Double {
        let p = pow10(digits)
        return round(x * p) / p
    }

    @usableFromInline static func pow10(_ d: Int) -> Double {
        var p = 1.0
        for _ in 0..<max(0, d) { p *= 10 }
        return p
    }

    /// `Math.min(b, Math.max(a, x))`, `clamp` of js/app.js:5.
    @inlinable public static func clamp(_ x: Double, _ a: Double = 0, _ b: Double = 1) -> Double { min(b, max(a, x)) }

    /// `Number.prototype.toFixed(d)`: rounds the exact binary value, halves away from zero.
    public static func toFixed(_ x: Double, _ digits: Int) -> String {
        guard x.isFinite else { return x.isNaN ? "NaN" : (x > 0 ? "Infinity" : "-Infinity") }
        if abs(x) >= 1e21 { return string(x) }
        let negative = x < 0
        // %.120f prints the exact decimal expansion (Darwin's printf is exact) of any double this code meets
        let exact = String(format: "%.120f", abs(x))
        let parts = exact.split(separator: ".", omittingEmptySubsequences: false)
        var intDigits = Array(parts[0].utf8).map { Int($0) - 48 }
        let frac = parts.count > 1 ? Array(parts[1].utf8).map { Int($0) - 48 } : []
        var kept = Array(frac.prefix(digits))
        while kept.count < digits { kept.append(0) }
        let next = digits < frac.count ? frac[digits] : 0
        if next >= 5 {   // the exact rest is >= one half: up (JS picks the larger n on a tie)
            var i = kept.count - 1
            var carry = true
            while carry && i >= 0 { kept[i] += 1; if kept[i] == 10 { kept[i] = 0; i -= 1 } else { carry = false } }
            if carry {
                var j = intDigits.count - 1
                while carry && j >= 0 { intDigits[j] += 1; if intDigits[j] == 10 { intDigits[j] = 0; j -= 1 } else { carry = false } }
                if carry { intDigits.insert(1, at: 0) }
            }
        }
        var s = intDigits.map(String.init).joined()
        if digits > 0 { s += "." + kept.map(String.init).joined() }
        return negative ? "-" + s : s
    }

    /// `fmt(v, d)` of js/app.js:8: `toFixed(d)` with "-0" shown as "0", and "–" for no value. Use it wherever the web
    /// prints a number with `fmt` (temperatures, wind), so the app shows the same digits.
    public static func fmt(_ v: Double?, _ d: Int = 0) -> String {
        guard let v else { return "–" }
        let s = toFixed(v, d)
        return s == "-0" ? "0" : s
    }

    /// `+x.toFixed(d)`: the number again.
    public static func fixed(_ x: Double, _ digits: Int) -> Double { Double(toFixed(x, digits)) ?? x }

    /// `String(x)` for a JS number: integers without ".0", decimals as the shortest round trip, exponent outside 1e-7…1e21.
    public static func string(_ x: Double) -> String {
        if x.isNaN { return "NaN" }
        if x.isInfinite { return x > 0 ? "Infinity" : "-Infinity" }
        if x == 0 { return "0" }
        if x == x.rounded(), abs(x) < 1e21 {
            if abs(x) < 9.0e15 { return String(Int64(x)) }
        }
        // Swift's description is the shortest round-trip digit string too; only the layout differs from JS
        let d = "\(abs(x))"
        var mantissa = Substring(d), exp = 0
        if let e = d.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = d[..<e]; exp = Int(d[d.index(after: e)...]) ?? 0
        }
        let parts = mantissa.split(separator: ".", omittingEmptySubsequences: false)
        var digits = String(parts[0]) + (parts.count > 1 ? String(parts[1]) : "")
        var n = parts[0].count + exp   // value = 0.<digits> × 10^n
        while digits.count > 1 && digits.hasPrefix("0") { digits.removeFirst(); n -= 1 }
        while digits.count > 1 && digits.hasSuffix("0") { digits.removeLast() }
        let k = digits.count
        let out: String
        if k <= n && n <= 21 {
            out = digits + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            let i = digits.index(digits.startIndex, offsetBy: n)
            out = digits[..<i] + "." + digits[i...]
        } else if -6 < n && n <= 0 {
            out = "0." + String(repeating: "0", count: -n) + digits
        } else {
            let e = n - 1
            let m = k == 1 ? digits : String(digits.prefix(1)) + "." + digits.dropFirst()
            out = m + "e" + (e >= 0 ? "+" : "-") + String(abs(e))
        }
        return x < 0 ? "-" + out : out
    }

    private static let uriUnreserved: CharacterSet = {
        var s = CharacterSet()
        s.insert(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return s
    }()

    /// `encodeURIComponent(s)`.
    public static func encodeURIComponent(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: uriUnreserved) ?? s
    }

    /// `qs(o)` of js/data.js:119: `k=v` pairs joined by `&`, both encoded, in the given order.
    public static func qs(_ pairs: [(String, String)]) -> String {
        pairs.map { "\(encodeURIComponent($0.0))=\(encodeURIComponent($0.1))" }.joined(separator: "&")
    }

    /// `Date.UTC(y, m - 1, d, h, min) / 1000 - offset`: `localToUnix` of js/data.js:123 for Open-Meteo's local "YYYY-MM-DDTHH:MM".
    public static func localToUnix(_ s: String, offset: Int) -> Double {
        let u = Array(s.utf8)
        func num(_ a: Int, _ b: Int) -> Int {
            guard a < u.count else { return 0 }
            var v = 0
            for i in a..<min(b, u.count) where u[i] >= 48 && u[i] <= 57 { v = v * 10 + Int(u[i]) - 48 }
            return v
        }
        let days = daysFromCivil(num(0, 4), num(5, 7), num(8, 10))
        let secs = Double(days) * 86400 + Double(num(11, 13)) * 3600 + Double(num(14, 16)) * 60
        return secs - Double(offset)
    }

    /// `new Date(ms).toISOString().slice(0, n)` for unix seconds (n = 10 date, 13 date + hour, 16 + minutes).
    public static func isoUTC(_ unix: Double, _ n: Int = 24) -> String {
        let msTotal = (unix * 1000).rounded(.down)
        var secs = Int64((msTotal / 1000).rounded(.down))
        let ms = Int(msTotal - Double(secs) * 1000)
        var days = secs / 86400
        secs -= days * 86400
        if secs < 0 { secs += 86400; days -= 1 }
        let (y, m, d) = civilFromDays(Int(days))
        let s = String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", y, m, d, Int(secs / 3600), Int(secs % 3600 / 60), Int(secs % 60), ms)
        return String(s.prefix(n))
    }

    /// `Date.parse(iso) / 1000` for MET's and MetAlerts' times ("2026-10-25T18:00:00Z", "+01:00" offsets, fractions).
    public static func parseISO(_ s: String) -> Double? {
        let u = Array(s.utf8)
        guard u.count >= 10 else { return nil }
        func num(_ a: Int, _ len: Int) -> Int? {
            guard a + len <= u.count else { return nil }
            var v = 0
            for i in a..<(a + len) { guard u[i] >= 48 && u[i] <= 57 else { return nil }; v = v * 10 + Int(u[i]) - 48 }
            return v
        }
        guard let y = num(0, 4), let mo = num(5, 2), let d = num(8, 2) else { return nil }
        var h = 0, mi = 0, sec = 0.0, i = 10, offset = 0
        if u.count > 10 {
            guard let hh = num(11, 2) else { return nil }
            h = hh; i = 13
            if i < u.count, u[i] == 58, let m2 = num(14, 2) { mi = m2; i = 16 }
            if i < u.count, u[i] == 58, let s2 = num(17, 2) {
                sec = Double(s2); i = 19
                if i < u.count, u[i] == 46 {
                    var j = i + 1, frac = 0.0, scale = 0.1
                    while j < u.count, u[j] >= 48, u[j] <= 57 { frac += Double(u[j] - 48) * scale; scale /= 10; j += 1 }
                    sec += frac; i = j
                }
            }
            if i < u.count {
                if u[i] == 90 { offset = 0 }
                else if u[i] == 43 || u[i] == 45, let oh = num(i + 1, 2) {
                    let om = (i + 3 < u.count && u[i + 3] == 58) ? (num(i + 4, 2) ?? 0) : (num(i + 3, 2) ?? 0)
                    offset = (oh * 3600 + om * 60) * (u[i] == 45 ? -1 : 1)
                }
            } else {
                offset = 0   // JS reads a date-time without a zone as local time; MET always sends one
            }
        }
        let days = daysFromCivil(y, mo, d)
        return Double(days) * 86400 + Double(h * 3600 + mi * 60) + sec - Double(offset)
    }

    /// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
    public static func daysFromCivil(_ y0: Int, _ m: Int, _ d: Int) -> Int {
        let y = m <= 2 ? y0 - 1 : y0
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }

    public static func civilFromDays(_ z0: Int) -> (Int, Int, Int) {
        let z = z0 + 719468
        let era = (z >= 0 ? z : z - 146096) / 146097
        let doe = z - era * 146097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
        let y = yoe + era * 400
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp + (mp < 10 ? 3 : -9)
        return (m <= 2 ? y + 1 : y, m, d)
    }

    /// `nn(arr)` of js/app.js:6: the values that are neither null nor NaN.
    @inlinable public static func nn(_ a: [Double?]) -> [Double] {
        var out: [Double] = []
        out.reserveCapacity(a.count)
        for x in a { if let x, !x.isNaN { out.append(x) } }
        return out
    }

    /// `mean(a)` of js/app.js:7: left-to-right sum over the count, null when empty.
    @inlinable public static func mean(_ a: [Double]) -> Double? {
        guard !a.isEmpty else { return nil }
        var s = 0.0
        for x in a { s += x }
        return s / Double(a.count)
    }

    /// A stable sort, as V8's `Array.prototype.sort`: equal elements keep their order.
    public static func stableSorted<T>(_ a: [T], by before: (T, T) -> Bool) -> [T] {
        a.enumerated().sorted { x, y in
            if before(x.element, y.element) { return true }
            if before(y.element, x.element) { return false }
            return x.offset < y.offset
        }.map(\.element)
    }
}
