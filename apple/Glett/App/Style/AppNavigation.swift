import Foundation
import Observation

/// The tabs are the web's tools (owner, 2026-10-26): Været now; Kjørevær, Turvær and Leirplass join as they are
/// built. The places are not a tab: they are the chips on Været, the search sheet and "Mine steder" in Settings. The
/// tab bar shows once there are two tools.
enum AppTab: Hashable, CaseIterable {
    case weather

    /// "Været" (`ui.vaer.s`).
    var title: String { L10n.t("ui.vaer.s") }

    var systemImage: String { "cloud.sun" }
}

/// The screens shown as sheets over Været (item 3); the radar is a full-screen cover of its own (item 4).
enum AppSheet: String, Identifiable {
    /// `places`: the place search, "Min posisjon", "Mine steder" and the cities (the search chip).
    case settings, models, about, places

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
    /// The places sheet's search field has the focus (`searchFocused`).
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

    /// The place search: the places sheet with its search field focused.
    func searchPlaces() {
        navigation.searchFocused = true
        navigation.sheet = .places
    }
}
