import Foundation
import GlettKit

/// The texts around one MET warning, as the web writes them in the warnings list (js/app.js:2316-2338, 2408-2414).
enum AlertText {
    /// "gult nivå" (`${t('lm.level.' + x.level)} ${t('lm.level.word')}`).
    static func level(_ x: MetAlert) -> String {
        "\(L10n.t("lm.level.\(x.level)")) \(L10n.t("lm.level.word"))"
    }

    /// The line under the title: "gult nivå · til havs" (the MET link follows it in the view).
    static func levelLine(_ x: MetAlert) -> String {
        x.domain == "marine" ? "\(level(x)) · \(L10n.t("lm.alert.marine"))" : level(x)
    }

    /// `lmAlertSpan` (js/app.js:2325-2330): "søn. 03–10" within a day, "søn. 22 – man. 06" across days; minutes only
    /// when not on the hour. In the device's time zone, as the browser's.
    static func span(_ x: MetAlert, calendar: Calendar = .current) -> String {
        guard let a = x.fromDate, let b = x.toDate else { return "" }
        let wd = Date.FormatStyle(locale: L10n.locale).weekday(.abbreviated)
        func hm(_ d: Date) -> String {
            calendar.component(.minute, from: d) != 0 ? Format.time(d) : String(format: "%02d", calendar.component(.hour, from: d))
        }
        return calendar.isDate(a, inSameDayAs: b)
            ? "\(a.formatted(wd)) \(hm(a))–\(hm(b))"
            : "\(a.formatted(wd)) \(hm(a)) – \(b.formatted(wd)) \(hm(b))"
    }

    /// `lmAlertState` (js/app.js:2331-2337): "starter om 3 t", "pågår, 5 t igjen", or nil when it is over.
    static func state(_ x: MetAlert, now: Date) -> String? {
        let n = now.timeIntervalSince1970
        func dur(_ s: Double) -> String {
            let m = Int(JS.round(s / 60))
            return m < 60 ? L10n.t("lm.aw.min", ["n": String(m)])
                : m < 48 * 60 ? L10n.t("lm.aw.h", ["n": String(Int(JS.round(Double(m) / 60)))])
                : L10n.t("lm.aw.d", ["n": String(Int(JS.round(Double(m) / 1440)))])
        }
        if let a = x.fromDate?.timeIntervalSince1970, a > n { return L10n.t("lm.aw.starts", ["d": dur(a - n)]) }
        if let b = x.toDate?.timeIntervalSince1970, b > n { return L10n.t("lm.aw.left", ["d": dur(b - n)]) }
        return nil
    }

    /// `linkify` (js/app.js:2319-2324): MET's text with its web addresses as links ("https://…", or a bare
    /// "sehavniva.no" / "www.yr.no/…"); a full stop or comma after an address belongs to the sentence.
    static func linkified(_ text: String) -> AttributedString {
        var out = AttributedString()
        let ns = text as NSString
        var last = 0
        for m in linkPattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            var raw = ns.substring(with: m.range)
            var tail = ""
            while let c = raw.last, ".,;:!?)".contains(c) { tail = String(c) + tail; raw.removeLast() }
            let href = raw.lowercased().hasPrefix("http") ? raw : "https://\(raw)"
            out += AttributedString(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
            var link = AttributedString(raw)
            if let url = URL(string: href) { link.link = url }
            out += link
            out += AttributedString(tail)
            last = m.range.location + m.range.length
        }
        out += AttributedString(ns.substring(from: last))
        return out
    }

    /// The address pattern of `linkify` (js/app.js:2320).
    static let linkPattern: NSRegularExpression = {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(
            pattern: #"\b(?:https?://[^\s<]+|(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:no|com|org|net|se|fi|dk|eu|int)(?:/[^\s<]*)?)"#,
            options: [.caseInsensitive])
    }()

    /// The summary line on the forecast (js/app.js:968-971): "Kraftige vindkast og høy vannstand" — the distinct
    /// names, the later ones in lower case, joined with commas and "og".
    static func names(_ alerts: [MetAlert]) -> String {
        var seen = Set<String>(), names: [String] = []
        for a in alerts where seen.insert(a.name).inserted { names.append(a.name) }
        let list = names.enumerated().map { i, n in i == 0 ? n : n.prefix(1).lowercased() + n.dropFirst() }
        guard list.count > 1 else { return list.first ?? "" }
        return "\(list.dropLast().joined(separator: ", ")) \(L10n.t("s.alert.and")) \(list.last!)"
    }

    /// The MET link of a warning (`x.web`, trimmed), nil when there is none.
    static func web(_ x: MetAlert) -> URL? {
        let s = x.web.trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? nil : URL(string: s)
    }
}
