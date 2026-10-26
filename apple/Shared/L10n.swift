import Foundation
import GlettKit
import Observation
import SwiftUI
import Synchronization

/// Strings from Localizable.xcstrings, which apple/scripts/i18n-export.mjs generates from js/i18n.js with the same keys.
/// Lookup mirrors `t()` in js/i18n.js:619: the effective language, then English, then the key itself; `{name}` placeholders
/// are replaced from `args`. Safe from any thread: the language lives behind a lock, the views re-render through
/// `LanguageSettings` (see `glettLanguage(_:)`).
enum L10n {
    /// The two languages of js/i18n.js `I18N`.
    enum Language: String, Sendable, CaseIterable {
        case nb, en

        /// js/i18n.js:626 `dateLocale()`.
        var locale: Locale { Locale(identifier: self == .nb ? "nb_NO" : "en_GB") }
    }

    private static let current = Mutex<Language>(LanguageSettings.storedEffectiveLanguage())
    private static let bundles = Mutex<[Language: Bundle]>([:])

    /// The language strings are looked up in now.
    static var language: Language {
        get { current.withLock { $0 } }
        set { current.withLock { $0 = newValue } }
    }

    /// Locale for dates, months and numbers: nb-NO or en-GB, as the web's `dateLocale()`.
    static var locale: Locale { language.locale }

    /// `t(key, {name: value})` from js/i18n.js:619.
    static func t(_ key: String, _ args: [String: String] = [:]) -> String {
        t(key, args, language: language)
    }

    /// The same lookup in a given language (widgets, previews, tests).
    static func t(_ key: String, _ args: [String: String] = [:], language: Language) -> String {
        var s = lookup(key, language) ?? (language == .en ? nil : lookup(key, .en)) ?? key
        for (name, value) in args { s = s.replacingOccurrences(of: "{\(name)}", with: value) }
        return s
    }

    /// js/i18n.js:624 `hasT(key)`.
    static func has(_ key: String) -> Bool {
        lookup(key, language) != nil || lookup(key, .en) != nil
    }

    /// For the few values with HTML (their catalog comment starts with "HTML:"): the text with tags removed,
    /// `<br>`, `</p>`, `</li>` and headings as line breaks, list items with a bullet.
    static func stripped(_ key: String, _ args: [String: String] = [:], language: Language? = nil) -> String {
        String(attributed(key, args, language: language).characters)
    }

    /// The same, as an AttributedString for `Text`: `<b>`/`<strong>` bold, `<i>`/`<em>` italic, headings bold,
    /// `<a href>` links (relative ones resolved against https://glett.no/; `#` links become plain text).
    static func attributed(_ key: String, _ args: [String: String] = [:], language: Language? = nil) -> AttributedString {
        SimpleHTML.attributed(t(key, args, language: language ?? self.language))
    }

    private static let missing = "\u{1}missing\u{1}"

    private static func lookup(_ key: String, _ lang: Language) -> String? {
        guard let bundle = bundle(for: lang) else { return nil }
        let s = bundle.localizedString(forKey: key, value: missing, table: "Localizable")
        return s == missing ? nil : s
    }

    private static func bundle(for lang: Language) -> Bundle? {
        bundles.withLock { cache in
            if let b = cache[lang] { return b }
            guard let path = Bundle.main.path(forResource: lang.rawValue, ofType: "lproj"),
                  let b = Bundle(path: path) else { return nil }
            cache[lang] = b
            return b
        }
    }
}

/// The language setting: `nb`, `en` or follow the device, stored as the web stores it (`glett.lang`, js/i18n.js:616).
@MainActor @Observable
final class LanguageSettings {
    enum Choice: String, CaseIterable, Identifiable, Sendable {
        case system, nb, en
        var id: String { rawValue }
    }

    nonisolated static let defaultsKey = "glett.lang"
    static let shared = LanguageSettings()

    @ObservationIgnored private let defaults: UserDefaults

    /// What the user picked; writing it updates `L10n` and every view that reads `effective`.
    var choice: Choice {
        didSet {
            if choice == .system { defaults.removeObject(forKey: Self.defaultsKey) } else { defaults.set(choice.rawValue, forKey: Self.defaultsKey) }
            effective = Self.resolve(choice)
        }
    }

    /// The language in use.
    private(set) var effective: L10n.Language {
        didSet { L10n.language = effective }
    }

    init(defaults: UserDefaults = LanguageSettings.groupDefaults()) {
        self.defaults = defaults
        let c = Choice(rawValue: defaults.string(forKey: Self.defaultsKey) ?? "") ?? .system
        choice = c
        effective = Self.resolve(c)
        L10n.language = effective
    }

    /// Call when the app becomes active: the device language may have changed while the choice is `system`.
    func refresh() {
        let e = Self.resolve(choice)
        if e != effective { effective = e }
    }

    nonisolated static func resolve(_ choice: Choice) -> L10n.Language {
        switch choice {
        case .nb: .nb
        case .en: .en
        case .system: deviceLanguage()
        }
    }

    /// js/i18n.js:610 `detectLang()`: the first Norwegian (nb/nn/no) or English preference wins, otherwise English.
    nonisolated static func deviceLanguage(_ preferred: [String] = Locale.preferredLanguages) -> L10n.Language {
        for raw in preferred {
            let code = raw.lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? ""
            if ["nb", "nn", "no"].contains(code) { return .nb }
            if code == "en" { return .en }
        }
        return .en
    }

    nonisolated static func storedEffectiveLanguage(_ defaults: UserDefaults = groupDefaults()) -> L10n.Language {
        resolve(Choice(rawValue: defaults.string(forKey: defaultsKey) ?? "") ?? .system)
    }

    /// The App Group suite, where the other settings live (brief §3.5), so widgets and the watch see the choice too.
    /// A choice stored by an earlier build in the app's standard defaults is moved there.
    nonisolated static func groupDefaults() -> UserDefaults {
        guard let group = UserDefaults(suiteName: AppGroup.identifier) else { return .standard }
        let standard = UserDefaults.standard
        if group.object(forKey: defaultsKey) == nil, let old = standard.string(forKey: defaultsKey) {
            group.set(old, forKey: defaultsKey)
            standard.removeObject(forKey: defaultsKey)
        }
        return group
    }
}

extension Text {
    /// `Text(l10n: "key")` = `Text(L10n.t("key"))`, never re-localised by SwiftUI.
    init(l10n key: String, _ args: [String: String] = [:]) {
        self.init(verbatim: L10n.t(key, args))
    }
}

extension View {
    /// Put on the root view: rebuilds the tree when the language changes and sets the matching locale for dates.
    func glettLanguage(_ settings: LanguageSettings = .shared) -> some View {
        modifier(GlettLanguageModifier(settings: settings))
    }
}

private struct GlettLanguageModifier: ViewModifier {
    let settings: LanguageSettings
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .id(settings.effective)
            .environment(\.locale, settings.effective.locale)
            .environment(settings)
            .onChange(of: scenePhase) { _, phase in if phase == .active { settings.refresh() } }
    }
}

/// A tiny HTML reader for the catalog's few HTML values (tags used: h2 h3 p b ul li a br span).
enum SimpleHTML {
    static let base = URL(string: "https://glett.no/")!

    static func attributed(_ html: String) -> AttributedString {
        var out = AttributedString()
        var bold = 0, italic = 0
        var link: URL?
        var i = html.startIndex

        func append(_ text: String) {
            guard !text.isEmpty else { return }
            var a = AttributedString(decodeEntities(text))
            var intent: InlinePresentationIntent = []
            if bold > 0 { intent.insert(.stronglyEmphasized) }
            if italic > 0 { intent.insert(.emphasized) }
            if !intent.isEmpty { a.inlinePresentationIntent = intent }
            if let link { a.link = link }
            out += a
        }
        func newline(_ count: Int = 1) {
            // never more than `count` line breaks in a row, none at the start
            let chars = out.characters
            guard !chars.isEmpty else { return }
            var trailing = 0
            for c in chars.reversed() { if c == "\n" { trailing += 1 } else { break } }
            if trailing < count { out += AttributedString(String(repeating: "\n", count: count - trailing)) }
        }

        while i < html.endIndex {
            guard html[i] == "<" else {
                let next = html[i...].firstIndex(of: "<") ?? html.endIndex
                append(String(html[i..<next]))
                i = next
                continue
            }
            guard let close = html[i...].firstIndex(of: ">") else { append(String(html[i...])); break }
            let tag = html[html.index(after: i)..<close]
            i = html.index(after: close)
            let closing = tag.hasPrefix("/")
            let name = tag.drop(while: { $0 == "/" }).prefix(while: { $0.isLetter || $0.isNumber }).lowercased()
            switch (name, closing) {
            case ("b", false), ("strong", false), ("h2", false), ("h3", false):
                if name.hasPrefix("h") { newline(2) }
                bold += 1
            case ("b", true), ("strong", true): bold = max(0, bold - 1)
            case ("h2", true), ("h3", true): bold = max(0, bold - 1); newline()
            case ("i", false), ("em", false): italic += 1
            case ("i", true), ("em", true): italic = max(0, italic - 1)
            case ("br", _): out += AttributedString("\n")
            case ("p", false): newline(2)
            case ("p", true), ("ul", true): newline()
            case ("li", false): newline(); append("• ")
            case ("a", false): link = href(in: String(tag))
            case ("a", true): link = nil
            default: break
            }
        }
        // trim trailing line breaks
        while let last = out.characters.last, last == "\n" { out.characters.removeLast() }
        return out
    }

    private static func href(in tag: String) -> URL? {
        guard let r = tag.range(of: #"href\s*=\s*"([^"]*)""#, options: .regularExpression) else { return nil }
        let raw = tag[r].split(separator: "\"", omittingEmptySubsequences: false).dropFirst().first.map(String.init) ?? ""
        if raw.isEmpty || raw.hasPrefix("#") { return nil }
        return URL(string: raw, relativeTo: base)?.absoluteURL
    }

    private static func decodeEntities(_ s: String) -> String {
        guard s.contains("&") else { return s }
        return s.replacingOccurrences(of: "&nbsp;", with: "\u{00A0}")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&amp;", with: "&")
    }
}
