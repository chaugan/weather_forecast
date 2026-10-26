import Foundation
import GlettKit

/// Launch arguments for screenshots and UI checks (documented in apple/docs/ARCHITECTURE.md and apple/README.md):
/// `-GlettPlace "59.91,10.75,Oslo"`, `-GlettScreen now|days|hours|models|settings|about|radar|places`,
/// `-GlettLang nb|en`, `-GlettHourView down|across|meteogram`. Unknown values are ignored.
struct LaunchOptions: Sendable {
    /// The screen or section to open once the forecast is there.
    enum Screen: String, Sendable, CaseIterable {
        case now, days, hours, models, settings, about, radar, places
    }

    var place: Place?
    var screen: Screen?
    var language: L10n.Language?
    var hourView: HourView?

    static let current = LaunchOptions(arguments: ProcessInfo.processInfo.arguments)

    init(arguments: [String]) {
        func value(_ name: String) -> String? {
            guard let i = arguments.firstIndex(of: "-\(name)"), i + 1 < arguments.count else { return nil }
            return arguments[i + 1]
        }
        place = value("GlettPlace").flatMap(Self.parsePlace)
        screen = value("GlettScreen").flatMap { Screen(rawValue: $0.lowercased()) }
        language = value("GlettLang").flatMap { L10n.Language(rawValue: $0.lowercased()) }
        hourView = value("GlettHourView").flatMap { v -> HourView? in
            switch v.lowercased() {
            case "down", "v": .timeDown
            case "across", "h": .timeAcross
            case "meteogram", "m": .meteogram
            default: nil
            }
        }
    }

    /// "lat,lon,Name" (the name may contain commas); without a name the coordinates name the place.
    static func parsePlace(_ s: String) -> Place? {
        let parts = s.split(separator: ",", maxSplits: 2, omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count >= 2, let lat = Double(parts[0]), let lon = Double(parts[1]) else { return nil }
        let name = parts.count == 3 && !parts[2].isEmpty ? parts[2] : "\(parts[0]), \(parts[1])"
        return Place.cleaned(id: "launch:\(parts[0]),\(parts[1])", name: name, lat: lat, lon: lon)
    }
}
