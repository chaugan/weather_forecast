import SwiftUI

/// Centripetal Catmull–Rom through the points (α = 0.5, d3's `curveCatmullRom`), the curve Swift Charts draws for
/// `.catmullRom`: smooth, and without the loops and overshoot of the uniform kind.
enum CatmullRom {
    static let alpha = 0.5

    /// Adds the curve from `pts[0]` (the path's current point) through the rest.
    static func add(_ pts: [CGPoint], to path: inout Path) {
        guard pts.count > 1 else { return }
        if pts.count == 2 { path.addLine(to: pts[1]); return }
        for i in 0..<(pts.count - 1) {
            let p0 = pts[max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[min(pts.count - 1, i + 2)]
            let l01 = pow(dist(p0, p1), alpha), l12 = pow(dist(p1, p2), alpha), l23 = pow(dist(p2, p3), alpha)
            var c1 = p1, c2 = p2
            if l01 > 1e-6 {
                let a = 2 * l01 * l01 + 3 * l01 * l12 + l12 * l12, n = 3 * l01 * (l01 + l12)
                c1 = CGPoint(x: (p1.x * a - p0.x * l12 * l12 + p2.x * l01 * l01) / n,
                             y: (p1.y * a - p0.y * l12 * l12 + p2.y * l01 * l01) / n)
            }
            if l23 > 1e-6 {
                let b = 2 * l23 * l23 + 3 * l23 * l12 + l12 * l12, m = 3 * l23 * (l23 + l12)
                c2 = CGPoint(x: (p2.x * b + p1.x * l23 * l23 - p3.x * l12 * l12) / m,
                             y: (p2.y * b + p1.y * l23 * l23 - p3.y * l12 * l12) / m)
            }
            path.addCurve(to: p2, control1: c1, control2: c2)
        }
    }

    private static func dist(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(b.x - a.x, b.y - a.y) }
}
