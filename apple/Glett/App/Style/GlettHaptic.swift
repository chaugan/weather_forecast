import SwiftUI

/// The app's two haptics (apple/docs/DESIGN.md, item 6): a selection tick when a day, step, view, place, tab or
/// meteogram step is picked, and a light tap when a pull to refresh has finished.
enum GlettHaptic {
    case selection
    case refresh

    var feedback: SensoryFeedback {
        switch self {
        case .selection: .selection
        case .refresh: .impact(weight: .light)
        }
    }
}

extension View {
    /// `sensoryFeedback` with one of the app's haptics, played when `trigger` changes.
    func glettHaptic<T: Equatable>(_ haptic: GlettHaptic, trigger: T) -> some View {
        sensoryFeedback(haptic.feedback, trigger: trigger)
    }
}
