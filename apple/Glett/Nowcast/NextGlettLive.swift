import ActivityKit
import Foundation
import GlettKit

/// Starts, follows and ends the Live Activity "Neste glett" (`NextGlettAttributes`). One at a time, for the place
/// shown when it was started. The app updates it whenever it fetches a new nowcast for that place (there is no push
/// server), and ends it when the nowcast no longer has a change in it; past its moment it shows as out of date.
@MainActor
enum NextGlettLive {
    /// Live Activities are on for the app (Settings → Glett).
    static var available: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    nonisolated static func running(for place: Place) -> Activity<NextGlettAttributes>? {
        Activity<NextGlettAttributes>.activities.first { $0.attributes.place == place.shortName && $0.activityState == .active }
    }

    /// Starts following the nowcast for `place`, in place of any other.
    static func start(place: Place, geo: Bool = false, nowcast: NowcastSeries?, now: Date = Date()) {
        guard let state = NextGlettAttributes.ContentState(nowcast, now: now) else { return }
        start(place: place.shortName, link: PlaceLink.url(place, geo: geo), state: state)
    }

    static func start(place: String, link: URL?, state: NextGlettAttributes.ContentState) {
        // the ones running now go; the end runs later, so the new one must not be among them
        stop(Set(Activity<NextGlettAttributes>.activities.map(\.id)))
        _ = try? Activity.request(attributes: NextGlettAttributes(place: place, link: link), content: content(state))
    }

    static func stop() { stop(Set(Activity<NextGlettAttributes>.activities.map(\.id))) }

    private static func stop(_ ids: Set<String>) {
        guard !ids.isEmpty else { return }
        // the activities are looked up inside the task: an `Activity` is not Sendable
        Task {
            for a in Activity<NextGlettAttributes>.activities where ids.contains(a.id) { await a.end(nil, dismissalPolicy: .immediate) }
        }
    }

    /// A new nowcast for `place`: the running activity follows it, or ends a minute later when nothing changes in it.
    static func update(place: Place, nowcast: NowcastSeries?, now: Date = Date()) {
        guard running(for: place) != nil else { return }
        let state = NextGlettAttributes.ContentState(nowcast, now: now)
        Task {
            guard let a = running(for: place) else { return }
            if let state { await a.update(content(state)) } else { await a.end(nil, dismissalPolicy: .after(now.addingTimeInterval(60))) }
        }
    }

    /// Out of date 5 minutes after the moment it counts down to.
    private static func content(_ state: NextGlettAttributes.ContentState) -> ActivityContent<NextGlettAttributes.ContentState> {
        ActivityContent(state: state, staleDate: state.at.addingTimeInterval(300), relevanceScore: 50)
    }

    #if DEBUG
    /// `-GlettLiveDemo`: rain in 14 minutes, for screenshots.
    static func demo(place: String, now: Date = Date()) {
        let rates: [Double] = [0, 0, 0, 0.3, 0.8, 1.6, 2.4, 1.2, 0.4, 0.4, 0.4, 0.4, 0, 0, 0, 0, 0, 0]
        start(place: place, link: nil, state: .init(wetNow: false, at: now.addingTimeInterval(14 * 60), blip: false, model: false,
                                         rates: rates, start: now, stepSeconds: 300))
    }
    #endif
}
