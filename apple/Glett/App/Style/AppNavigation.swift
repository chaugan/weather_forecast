import Foundation
import Observation

/// The tabs of the app (apple/docs/DESIGN.md, item 1). Kjørevær, Turvær and Leirplass come later.
enum AppTab: Hashable {
    case weather, places

    /// "Været" (`ui.vaer.s`) / "Steder" (`app.tab.places`).
    var title: String { self == .weather ? L10n.t("ui.vaer.s") : AppText.t("app.tab.places") }

    var systemImage: String { self == .weather ? "cloud.sun" : "list.star" }
}

/// The screens shown as sheets over Været (item 3); the radar is a full-screen cover of its own (item 4).
enum AppSheet: String, Identifiable {
    case settings, models, about

    var id: String { rawValue }
}

/// Where the user is: tab, sheet, radar, the place search's focus. One per process like `AppModel` (GlettApp keeps a
/// single model for every window), reached as `model.navigation`; the shell binds its tab view, sheets and cover to it.
@MainActor @Observable
final class AppNavigation {
    static let shared = AppNavigation()

    var tab: AppTab = .weather
    var sheet: AppSheet?
    var radarShown = false
    /// The Steder tab's search field has the focus (`searchFocused`).
    var searchFocused = false
}

/// The hooks the content and the sheets call; the shell presents what they ask for (DESIGN.md, "Hooks").
extension AppModel {
    var navigation: AppNavigation { .shared }

    /// "Time for time" for a day (a tap or the context menu on a day): picks the day, shows Været and scrolls to the
    /// hours on compact width.
    func showHours(day: Int) {
        selectedDay = day == engine?.todayIndex ? nil : day
        navigation.tab = .weather
        scrollToHours = true
    }

    /// Settings, the models or "Hva er Glett?" as a sheet over Været.
    func present(_ sheet: AppSheet) {
        navigation.sheet = sheet
    }

    /// The rain radar, full screen, zooming out of the radar strip.
    func presentRadar() {
        navigation.radarShown = true
    }

    /// The place search: the Steder tab with its search field focused.
    func searchPlaces() {
        navigation.tab = .places
        navigation.searchFocused = true
    }
}
