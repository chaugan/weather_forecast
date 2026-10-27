import Foundation
import SwiftUI
import Synchronization

/// The app's own strings, for the few things the web has no text for (language and theme names, the privacy summary,
/// the reliability detail): table `AppStrings` (Glett/About/AppStrings.xcstrings), keys prefixed `app.`. Same rules
/// as `L10n.t`: the current language, then English, then the key; `{name}` placeholders from `args`. Everything the
/// web already says comes from `L10n` with the js/i18n.js keys.
enum AppText {
    static let table = "AppStrings"

    private static let bundles = Mutex<[L10n.Language: Bundle]>([:])
    private static let missing = "\u{1}missing\u{1}"

    static func t(_ key: String, _ args: [String: String] = [:]) -> String {
        let lang = L10n.language
        var s = lookup(key, lang) ?? (lang == .en ? nil : lookup(key, .en)) ?? L10n.t(key)
        for (name, value) in args { s = s.replacingOccurrences(of: "{\(name)}", with: value) }
        return s
    }

    private static func lookup(_ key: String, _ lang: L10n.Language) -> String? {
        let bundle: Bundle? = bundles.withLock { cache in
            if let b = cache[lang] { return b }
            guard let path = Bundle.main.path(forResource: lang.rawValue, ofType: "lproj"), let b = Bundle(path: path) else { return nil }
            cache[lang] = b
            return b
        }
        guard let bundle else { return nil }
        let s = bundle.localizedString(forKey: key, value: missing, table: table)
        return s == missing ? nil : s
    }
}

extension Text {
    /// `Text(app: "app.key")` = `Text(AppText.t("app.key"))`.
    init(app key: String, _ args: [String: String] = [:]) {
        self.init(verbatim: AppText.t(key, args))
    }
}

/// The app's version as Settings and the about screen show it: CFBundleShortVersionString and the build.
enum AppVersion {
    static var short: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "–" }
    static var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "–" }
    /// "0.1.0 (1)".
    static var text: String { AppText.t("app.version.value", ["v": short, "b": build]) }
}
