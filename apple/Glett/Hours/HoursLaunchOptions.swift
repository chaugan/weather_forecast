import Foundation

/// Launch arguments of the hour views, for screenshots and UI checks (next to the app's `LaunchOptions`):
/// `-GlettHoursModels open|closed` sets "Vis alle modellene" and `-GlettStep 1|3|6|12` the step. Both are applied once
/// at launch and stored like a choice made on screen.
struct HoursLaunchOptions: Sendable {
    var modelsOpen: Bool?
    var step: Int?

    static let current = HoursLaunchOptions(arguments: ProcessInfo.processInfo.arguments)

    init(arguments: [String]) {
        func value(_ name: String) -> String? {
            guard let i = arguments.firstIndex(of: "-\(name)"), i + 1 < arguments.count else { return nil }
            return arguments[i + 1].lowercased()
        }
        modelsOpen = value("GlettHoursModels").flatMap { ["open": true, "closed": false][$0] }
        step = value("GlettStep").flatMap(Int.init).flatMap { [1, 3, 6, 12].contains($0) ? $0 : nil }
    }
}
