import SwiftUI

/// The zoom from the radar strip into the full-screen radar (iOS 18 `matchedTransitionSource` and
/// `navigationTransition(.zoom)`). The shell owns the `@Namespace` and puts it in the environment above the
/// `fullScreenCover`; the strip marks itself as the source, the cover's content as the destination. Without a
/// namespace (previews, a missing strip) both are no-ops and the cover slides up as usual.
enum RadarZoom {
    static let id = "glett.radar"
}

extension EnvironmentValues {
    @Entry var radarZoomNamespace: Namespace.ID?
}

extension View {
    /// Marks the view the radar zooms out of (the radar strip's box, Nowcast/NowcastLine.swift).
    func radarZoomSource() -> some View { modifier(RadarZoomSource()) }

    /// Marks the full-screen radar as the zoom's destination (the cover's root view).
    func radarZoomDestination() -> some View { modifier(RadarZoomDestination()) }
}

private struct RadarZoomSource: ViewModifier {
    @Environment(\.radarZoomNamespace) private var namespace

    func body(content: Content) -> some View {
        if let namespace {
            content.matchedTransitionSource(id: RadarZoom.id, in: namespace)
        } else {
            content
        }
    }
}

private struct RadarZoomDestination: ViewModifier {
    @Environment(\.radarZoomNamespace) private var namespace

    func body(content: Content) -> some View {
        if let namespace {
            content.navigationTransition(.zoom(sourceID: RadarZoom.id, in: namespace))
        } else {
            content
        }
    }
}
