import SwiftUI

/// Glett's weather icons drawn natively from js/icons.js: the same 64 × 64 geometry, the same gradients
/// (icons.js:108-115) and part styles (css/style.css:104-111, 1178-1197), and the same movement as the web's `.wi.anim`
/// (css/style.css:378-395, 1182-1188): rays turn, clouds drift, drops fall, snow sways, fog drifts, the bolt flickers,
/// the moon floats. Night icons draw the real moon phase for `date` (icons.js:12-29).
struct WeatherGlyph: View {
    /// One of `WeatherIcon.names`.
    let name: String
    /// Moves (the web animates large icons in view only; css/style.css:378).
    let animated: Bool
    /// The moment the night icon's moon is drawn for.
    let date: Date

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Only icons on screen move (the web's IntersectionObserver, js/app.js:493-505).
    @State private var visible = true

    var body: some View {
        let parts = Self.parts(name, date: date)
        let dark = colorScheme == .dark
        Group {
            if animated && !reduceMotion {
                TimelineView(.animation(minimumInterval: 1 / 30, paused: !visible)) { tl in
                    Canvas { ctx, size in
                        Self.draw(parts, in: &ctx, size: size, dark: dark, t: tl.date.timeIntervalSinceReferenceDate)
                    }
                }
                .onScrollVisibilityChange(threshold: 0.01) { visible = $0 }
            } else {
                Canvas { ctx, size in Self.draw(parts, in: &ctx, size: size, dark: dark, t: nil) }
            }
        }
    }

    /// How far a part may reach past the 64 × 64 box (`.wi { overflow: visible }`, css/style.css:104): the back cloud
    /// of `cloudy` starts left of it, the rays and the drop-shadow reach out. The canvas is this much larger than the
    /// icon's frame and draws the box in its middle.
    static let overflow: CGFloat = 1.3

    // MARK: Parts (icons.js:41-62)

    enum Part {
        /// `sun(cx, cy, r)`: the disc and its rays.
        case sun(cx: Double, cy: Double, r: Double)
        /// `moon(t)` for the moon phase `p`.
        case moon(CGAffineTransform, phase: Double)
        /// `cloud(t)` (`.cloudg`), or the back cloud of `cloudy` (`.cloudg2`, opacity .82).
        case cloud(CGAffineTransform, back: Bool)
        /// `.drops`: each `.dropg` at (x, y) scaled k; its index picks the web's animation delay.
        case drops([(x: Double, y: Double, k: Double)])
        /// `.snowc` circles.
        case flakes([(x: Double, y: Double)])
        case bolt
        case fog
    }

    private static func tr(_ x: Double, _ y: Double, _ k: Double = 1) -> CGAffineTransform {
        CGAffineTransform(translationX: x, y: y).scaledBy(x: k, y: k)
    }

    private static let up = tr(0, -6)
    private static let small = tr(8, 4, 0.88)
    private static let showerCloud = tr(8, -2, 0.88)
    private static let showerDrops: [(x: Double, y: Double, k: Double)] = [(28, 49, 0.9), (38, 51, 0.9), (48, 49, 0.9)]

    static func parts(_ name: String, date: Date) -> [Part] {
        let p = moonPhase(date)
        switch name {
        case "clear-day": return [.sun(cx: 32, cy: 32, r: 12)]
        case "clear-night": return [.moon(.identity, phase: p)]
        case "partly-day": return [.sun(cx: 25, cy: 24, r: 9), .cloud(small, back: false)]
        case "partly-night": return [.moon(tr(-4, -5, 0.72), phase: p), .cloud(small, back: false)]
        case "fog": return [.cloud(tr(0, -8, 0.95), back: false), .fog]
        case "drizzle": return [.cloud(up, back: false), .drops([(26, 52, 0.6), (36, 54, 0.6), (46, 52, 0.6)])]
        case "rain": return [.cloud(up, back: false), .drops([(26, 51, 1), (36, 54, 1), (46, 51, 1)])]
        case "heavy-rain": return [.cloud(up, back: false), .drops([(22, 51, 1), (30, 54, 1), (38, 51, 1), (46, 54, 1)])]
        case "showers-day": return [.sun(cx: 22, cy: 20, r: 8), .cloud(showerCloud, back: false), .drops(showerDrops)]
        case "showers-night": return [.moon(tr(-4, -7, 0.66), phase: p), .cloud(showerCloud, back: false), .drops(showerDrops)]
        case "sleet": return [.cloud(up, back: false), .drops([(26, 52, 0.9), (46, 52, 0.9)]), .flakes([(36, 58)])]
        case "snow": return [.cloud(up, back: false), .flakes([(24, 56), (34, 60), (44, 56)])]
        case "thunder": return [.cloud(up, back: false), .bolt]
        default: return [.cloud(tr(-9, -9, 0.72), back: true), .cloud(tr(2, 3), back: false)]   // cloudy
        }
    }

    /// icons.js:14-15 `moonPhase(ms)`: 0 new, 0.5 full, from the mean synodic month since the new moon of 6 Jan 2000.
    static func moonPhase(_ date: Date) -> Double {
        let synodic = 29.530588853, newMoon2000 = 947_182_440.0   // Date.UTC(2000, 0, 6, 18, 14) / 1000
        let d = ((date.timeIntervalSince1970 - newMoon2000) / 86_400).truncatingRemainder(dividingBy: synodic)
        return (d < 0 ? d + synodic : d) / synodic
    }

    // MARK: Shapes

    static let cloudPath = SVGPath.path("M19 50h27a10 10 0 0 0 2-19.8A15 15 0 0 0 19.5 33 8.7 8.7 0 0 0 19 50z")
    static let dropPath = SVGPath.path("M0 0c2.6 3.6 3.8 5.8 3.8 7.6a3.8 3.8 0 0 1-7.6 0C-3.8 5.8-2.6 3.6 0 0z")
    static let boltPath = SVGPath.path("M35 42l-9 14h7l-3 9 12-15h-7z")

    /// icons.js:3-10: eight rays from r + 4 to r + 9, coordinates rounded to one decimal as the web writes them.
    static func rays(cx: Double, cy: Double, r: Double) -> Path {
        var p = Path()
        func d1(_ v: Double) -> Double { (v * 10).rounded() / 10 }
        for i in 0..<8 {
            let a = Double(i) * .pi / 4, c = cos(a), n = sin(a)
            p.move(to: CGPoint(x: d1(cx + c * (r + 4)), y: d1(cy + n * (r + 4))))
            p.addLine(to: CGPoint(x: d1(cx + c * (r + 9)), y: d1(cy + n * (r + 9))))
        }
        return p
    }

    /// icons.js:17-29: the lit part as limb + terminator, nil at new moon (only the dark disc shows).
    static func moonLit(phase p: Double) -> Path? {
        if p < 0.015 || p > 0.985 { return nil }
        let cx = 31.0, cy = 31.0, r = 17.0, k = cos(2 * .pi * p), rx = String(format: "%.2f", r * abs(k))
        let waxing = p < 0.5, crescent = k > 0
        let limb = waxing ? "A\(r) \(r) 0 0 1 \(cx) \(cy + r)" : "A\(r) \(r) 0 0 0 \(cx) \(cy + r)"
        let term = "A\(rx) \(r) 0 0 \(waxing ? (crescent ? 0 : 1) : (crescent ? 1 : 0)) \(cx) \(cy - r)"
        return SVGPath.path("M\(cx) \(cy - r)\(limb)\(term)z")
    }

    static let craters: [(x: Double, y: Double, r: Double)] =
        [(-5, -6, 3.4), (5, 3, 2.6), (-4, 7, 2.1), (6, -7, 1.7), (1, -1, 1.3), (-9, 1, 1.2), (9, 9, 1.1)]

    // MARK: Paint (icons.js:108-115, css/style.css)

    private static func rgb(_ hex: UInt32, _ a: Double = 1) -> Color {
        Color(.sRGB, red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: a)
    }

    private static let sunStops = Gradient(stops: [.init(color: rgb(0xFFF3A6), location: 0), .init(color: rgb(0xFFC21A), location: 0.45),
                                                   .init(color: rgb(0xF08A00), location: 1)])
    private static let moonStops = Gradient(stops: [.init(color: rgb(0xFFFBE8), location: 0), .init(color: rgb(0xF6E2A0), location: 0.55),
                                                    .init(color: rgb(0xDCB95E), location: 1)])
    private static let dropStops = Gradient(colors: [rgb(0x8FD0FF), rgb(0x1D6FE0)])
    private static let snowStops = Gradient(colors: [rgb(0xFFFFFF), rgb(0x8ECDF5)])
    private static let boltStops = Gradient(colors: [rgb(0xFFE66B), rgb(0xF57C00)])
    /// `--cloud-top` / `--cloud-bot` (css/style.css:5, 14).
    private static func cloudStops(dark: Bool) -> Gradient {
        dark ? Gradient(colors: [rgb(0xE4EBF7), rgb(0x6B7B96)]) : Gradient(colors: [rgb(0xEEF3FB), rgb(0x8FA2C0)])
    }
    private static let outline = rgb(0x506487, 0.45)   // rgba(80, 100, 135, .45)

    /// SVG `objectBoundingBox` radial gradient (cx, cy, r as fractions of the shape's box).
    private static func radial(_ g: Gradient, _ box: CGRect, cx: Double, cy: Double, r: Double) -> GraphicsContext.Shading {
        .radialGradient(g, center: CGPoint(x: box.minX + cx * box.width, y: box.minY + cy * box.height),
                        startRadius: 0, endRadius: r * max(box.width, box.height))
    }

    /// SVG `objectBoundingBox` linear gradient from (x1, y1) to (x2, y2).
    private static func linear(_ g: Gradient, _ box: CGRect, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> GraphicsContext.Shading {
        .linearGradient(g, startPoint: CGPoint(x: box.minX + x1 * box.width, y: box.minY + y1 * box.height),
                        endPoint: CGPoint(x: box.minX + x2 * box.width, y: box.minY + y2 * box.height))
    }

    // MARK: Drawing

    /// Draws the parts in SVG order; `t` (seconds) moves them, nil draws them at rest as the web's non-animated icons.
    static func draw(_ parts: [Part], in ctx: inout GraphicsContext, size: CGSize, dark: Bool, t: Double?) {
        let s = min(size.width, size.height) / (64 * overflow)
        ctx.translateBy(x: (size.width - 64 * s) / 2, y: (size.height - 64 * s) / 2)
        ctx.scaleBy(x: s, y: s)
        for part in parts {
            switch part {
            case let .sun(cx, cy, r):
                let disc = Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))
                ctx.fill(disc, with: radial(sunStops, disc.boundingRect, cx: 0.35, cy: 0.3, r: 0.8))
                var g = ctx
                if let t {   // `rays`: one turn in 48 s
                    g.translateBy(x: cx, y: cy)
                    g.rotate(by: .degrees(360 * (t / 48).truncatingRemainder(dividingBy: 1)))
                    g.translateBy(x: -cx, y: -cy)
                }
                g.stroke(rays(cx: cx, cy: cy, r: r), with: .color(rgb(0xFFB800)), style: StrokeStyle(lineWidth: 3.5, lineCap: .round))

            case let .moon(m, p):
                var g = ctx
                let c = CGPoint(x: 31, y: 31).applying(m)
                if let t {   // `moonfloat`: 8 s, up 2 and a 6° rock
                    let f = Motion.alternate(t, 8, Motion.easeInOut)
                    g.translateBy(x: c.x, y: c.y + lerp(0.8, -1.2, f))
                    g.rotate(by: .degrees(lerp(-3, 3, f)))
                    g.translateBy(x: -c.x, y: -c.y)
                }
                g.concatenate(m)
                let disc = Path(ellipseIn: CGRect(x: 14, y: 14, width: 34, height: 34))
                var d = g
                d.opacity = dark ? 0.28 : 0.16
                d.fill(disc, with: .color(rgb(0xB99A4E)))
                d.stroke(disc, with: .color(rgb(0x967328, 0.3)), lineWidth: 1)
                if let lit = moonLit(phase: p) {
                    g.fill(lit, with: radial(moonStops, lit.boundingRect, cx: 0.35, cy: 0.3, r: 0.85))
                    var cr = g
                    cr.clip(to: lit)
                    cr.opacity = 0.3
                    for k in craters {
                        cr.fill(Path(ellipseIn: CGRect(x: 31 + k.x - k.r, y: 31 + k.y - k.r, width: 2 * k.r, height: 2 * k.r)),
                                with: .color(rgb(0xC9A24C)))
                    }
                    g.stroke(lit, with: .color(rgb(0x967328, 0.45)), lineWidth: 1)
                }

            case let .cloud(m, back):
                var g = ctx
                if let t {   // `cloudA` 6 s / `cloudB` 7.5 s, back and forth
                    let f = Motion.alternate(t, back ? 7.5 : 6, Motion.easeInOut)
                    g.translateBy(x: back ? lerp(1.8, -1.8, f) : lerp(-1.2, 1.6, f), y: back ? lerp(0, 0.6, f) : lerp(0, -0.8, f))
                }
                if back { g.opacity = 0.82 }
                let path = cloudPath.applying(m)
                g.fill(path, with: linear(cloudStops(dark: dark), path.boundingRect, 0, 0, 0, 1))
                g.stroke(path, with: .color(outline), lineWidth: m.a)

            case let .drops(list):
                for (i, d) in list.enumerated() {
                    var g = ctx
                    if let t {   // `fall` 1.3 s, ease-in; the 2nd, 3rd and 4th start .45, .9 and .2 s into it
                        let delay = [0, 0.45, 0.9, 0.2][min(i, 3)]
                        let f = ((t + delay) / 1.3).truncatingRemainder(dividingBy: 1)
                        g.translateBy(x: 0, y: lerp(-1, 4, Motion.easeIn(f)))
                        g.opacity = f < 0.3 ? lerp(0.2, 1, Motion.easeIn(f / 0.3)) : lerp(1, 0, Motion.easeIn((f - 0.3) / 0.7))
                    }
                    let path = dropPath.applying(tr(d.x, d.y, d.k))
                    g.fill(path, with: linear(dropStops, path.boundingRect, 0, 0, 1, 1))
                }

            case let .flakes(list):
                var g = ctx
                if let t {   // `sway` 3.2 s, back and forth
                    let f = Motion.alternate(t, 3.2, Motion.easeInOut)
                    g.translateBy(x: lerp(-1, 1, f), y: lerp(0, 2, f))
                }
                for c in list {
                    let dot = Path(ellipseIn: CGRect(x: c.x - 2.6, y: c.y - 2.6, width: 5.2, height: 5.2))
                    g.fill(dot, with: radial(snowStops, dot.boundingRect, cx: 0.35, cy: 0.3, r: 0.8))
                }

            case .bolt:
                var g = ctx
                if let t { g.opacity = Motion.flicker(t) }
                g.fill(boltPath, with: linear(boltStops, boltPath.boundingRect, 0, 0, 1, 1))
                g.stroke(boltPath, with: .color(rgb(0xFFD54A)), style: StrokeStyle(lineWidth: 0.8, lineJoin: .round))

            case .fog:
                var g = ctx
                if let t { g.translateBy(x: lerp(-2, 2, Motion.alternate(t, 5, Motion.easeInOut)), y: 0) }   // `drift` 5 s
                for r in [CGRect(x: 12, y: 52, width: 38, height: 4.5), CGRect(x: 20, y: 59, width: 32, height: 4.5)] {
                    let bar = Path(roundedRect: r, cornerRadius: 2.2)
                    g.fill(bar, with: linear(cloudStops(dark: dark), r, 0, 0, 0, 1))
                }
            }
        }
    }

    private static func lerp(_ a: Double, _ b: Double, _ f: Double) -> Double { a + (b - a) * f }
}

/// CSS animation timing for the icons.
enum Motion {
    /// `cubic-bezier(x1, y1, x2, y2)` at progress x.
    static func bezier(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ x: Double) -> Double {
        if x <= 0 { return 0 }
        if x >= 1 { return 1 }
        func at(_ a: Double, _ b: Double, _ s: Double) -> Double { 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s }
        var lo = 0.0, hi = 1.0, s = x
        for _ in 0..<24 {   // bisection: monotone in s for these curves
            let v = at(x1, x2, s)
            if abs(v - x) < 1e-6 { break }
            if v < x { lo = s } else { hi = s }
            s = (lo + hi) / 2
        }
        return at(y1, y2, s)
    }

    static func easeInOut(_ x: Double) -> Double { bezier(0.42, 0, 0.58, 1, x) }
    static func easeIn(_ x: Double) -> Double { bezier(0.42, 0, 1, 1, x) }

    /// `infinite alternate`: 0 → 1 → 0 over two periods, eased each way.
    static func alternate(_ t: Double, _ period: Double, _ ease: (Double) -> Double) -> Double {
        let n = t / period, f = n.truncatingRemainder(dividingBy: 1)
        return ease(Int(n) % 2 == 0 ? f : 1 - f)
    }

    /// `flicker` 3.5 s (css/style.css:394): opacity 1 until 88 %, then .35, 1, .5, 1; ease-in-out between keyframes.
    static func flicker(_ t: Double) -> Double {
        let f = (t / 3.5).truncatingRemainder(dividingBy: 1)
        let keys: [(Double, Double)] = [(0, 1), (0.88, 1), (0.90, 0.35), (0.92, 1), (0.95, 0.5), (1, 1)]
        for i in 1..<keys.count where f <= keys[i].0 {
            let (a, va) = keys[i - 1], (b, vb) = keys[i]
            return va + (vb - va) * easeInOut((f - a) / (b - a))
        }
        return 1
    }
}

#Preview("Moving") {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 80))], spacing: 16) {
        ForEach(WeatherIcon.names, id: \.self) { WeatherGlyph(name: $0, animated: true, date: Date()).frame(width: 72, height: 72) }
    }
    .padding()
}
