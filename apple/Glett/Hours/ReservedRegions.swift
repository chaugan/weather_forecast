import SwiftUI

/// The parts of the window the meteogram's time cursor and readout must keep clear of (brief §8: the iPhone Duo fold
/// and the camera), in global coordinates.
///
/// TODO(iPhone Duo): the iOS 27.0 SDK has no `GeometryProxy.reservedRegions(kind:options:layoutDirectionBehavior:)`
/// (grepped SwiftUI/SwiftUICore .swiftinterface on 2026-10-25; brief §8 expects it with `.division` and `.occlusion`
/// in the 27.1 SDK). When it is there, read its rects from a window-level geometry (RootView), not from the meteogram's
/// card, whose insets are always 0, and pass them down. Until then `rects` is empty in practice, so nothing is hidden;
/// MeteogramCursor's second preview shows the hiding with a fake region.
struct ReservedRegions: Equatable, Sendable {
    var rects: [CGRect] = []

    init(rects: [CGRect] = []) { self.rects = rects }

    /// What lies outside the safe area of `proxy`'s view (zero-size strips inside a normal layout).
    init(_ proxy: GeometryProxy) {
        let f = proxy.frame(in: .global), i = proxy.safeAreaInsets
        var r: [CGRect] = []
        if i.leading > 0 { r.append(CGRect(x: f.minX - i.leading, y: f.minY, width: i.leading, height: f.height)) }
        if i.trailing > 0 { r.append(CGRect(x: f.maxX, y: f.minY, width: i.trailing, height: f.height)) }
        rects = r
    }

    /// The rect touches no reserved region.
    func isClear(_ rect: CGRect) -> Bool { !rects.contains { $0.intersects(rect) } }
}

extension View {
    /// Hides the view while any part of it would lie in a reserved region (the cursor scrolled under the fold).
    func avoiding(_ regions: ReservedRegions) -> some View {
        visualEffect { content, proxy in
            content.opacity(regions.isClear(proxy.frame(in: .global)) ? 1 : 0)
        }
    }
}
