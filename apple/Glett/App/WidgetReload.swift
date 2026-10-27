import WidgetKit

/// Tells the widgets to read again: after the app has fetched (the forecast cache in the App Group is fresh, so they
/// need no request of their own), after a setting that changes their numbers, and when the app goes to the background
/// (places saved, renamed or removed). Reloads asked for while the app is in front do not count against the widgets'
/// daily budget.
@MainActor
enum WidgetReload {
    private static var pending: Task<Void, Never>?

    /// In a moment, once for a burst of changes.
    static func soon() {
        pending?.cancel()
        pending = Task {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    /// Now (the app is leaving the foreground).
    static func now() {
        pending?.cancel()
        WidgetCenter.shared.reloadAllTimelines()
    }
}
