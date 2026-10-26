import Foundation

/// Launch arguments for screenshots and UI checks of the models, settings and about screens (the shell's
/// `-GlettScreen` opens them): `-GlettScroll <anchor>` scrolls the opened screen to a section once
/// (models: `reliability`; settings: `places`, `about`; about: `terms`, `sources`, `credits`, `privacy`), and
/// `-GlettModel <id>|info` opens one model's reliability (or the notes) from the model list once.
@MainActor
enum ScreenshotHook {
    private static var used: Set<String> = []

    /// The argument's value the first time it is asked for, then nil (so going back does not jump again).
    static func take(_ name: String) -> String? {
        guard !used.contains(name) else { return nil }
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
        used.insert(name)
        return args[i + 1]
    }
}
