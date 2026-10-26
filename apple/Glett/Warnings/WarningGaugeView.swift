import GlettKit
import SwiftUI

/// The gauge under a warning (`lmGaugeHtml`, js/app.js:2363-2378; css/style.css:1253-1265): a scale from 0, MET's
/// range as a striped band in the warning's colour, a grey dot per model, and Glett's weighted mean as a blue line.
struct WarningGaugeView: View {
    let gauge: AlertGauge
    /// The warning's level, for the band's colour.
    let level: String

    /// The band's two stripe colours per level (css/style.css:1256-1258).
    static let stripes: [String: (Color, Color)] = [
        "yellow": (Color(hex: 0xF5C518), Color(hex: 0xF8DC6B)),
        "orange": (Color(hex: 0xF97316), Color(hex: 0xFDBA74)),
        "red": (Color(hex: 0xDC2626), Color(hex: 0xF87171)),
    ]
    /// `.aw-gauge .dot` (#94a3b8).
    static let dot = Color(hex: 0x94A3B8)
    /// The gauge's height (`.aw-gauge { height: 62px }`).
    static let height: CGFloat = 62
    /// The labels grow with Dynamic Type only this far: they sit in the gauge's fixed 62 pt.
    static let maxTextScale: CGFloat = 1.2

    @Environment(\.dynamicTypeSize) private var dynamicType

    var body: some View {
        Canvas { ctx, size in draw(&ctx, width: size.width) }
            .frame(height: Self.height)
            .padding(.horizontal, 2)
            .accessibilityElement()
            .accessibilityLabel(Text(verbatim: L10n.t("lm.aw.aria", ["g": AlertGauge.f(gauge.glett), "u": gauge.unit])))
    }

    private func font(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .scaledSystem(size, weight: weight, relativeTo: .caption1, maxScale: Self.maxTextScale, in: dynamicType)
    }

    private func draw(_ ctx: inout GraphicsContext, width w: CGFloat) {
        let g = gauge
        func x(_ v: Double) -> CGFloat { CGFloat(g.position(v)) * w }

        // base line
        ctx.fill(Path(CGRect(x: 0, y: 32, width: w, height: 2)), with: .color(.glett.line))

        // MET's band and its label
        if let lo = g.bandLow, let hi = g.bandHigh {
            let l = x(lo), bw = max(w * 0.016, x(hi) - l)
            let rect = CGRect(x: l, y: 24, width: bw, height: 18)
            let (c1, c2) = Self.stripes[level] ?? Self.stripes["yellow"]!
            var band = ctx
            band.clip(to: Path(roundedRect: rect, cornerRadius: 3))
            band.fill(Path(rect), with: .color(c1))
            var stripe = Path()
            var sx = rect.minX - rect.height
            while sx < rect.maxX + rect.height {   // repeating-linear-gradient(-45deg, c1 0 6px, c2 6px 12px)
                let a = sx + 6 * CGFloat(2).squareRoot(), b = sx + 12 * CGFloat(2).squareRoot()   // 6 px stripes across a 45° slant
                stripe.move(to: CGPoint(x: a, y: rect.minY)); stripe.addLine(to: CGPoint(x: b, y: rect.minY))
                stripe.addLine(to: CGPoint(x: b - rect.height, y: rect.maxY)); stripe.addLine(to: CGPoint(x: a - rect.height, y: rect.maxY))
                stripe.closeSubpath()
                sx = b
            }
            band.fill(stripe, with: .color(c2))
            if let label = g.metLabel {
                let text = Text(verbatim: label).font(font(11.5, .semibold)).foregroundStyle(.glett.text)
                if l / w > 0.55 { ctx.draw(text, at: CGPoint(x: rect.maxX, y: 0), anchor: .topTrailing) }
                else { ctx.draw(text, at: CGPoint(x: l, y: 0), anchor: .topLeading) }
            }
        }

        // a dot per model, lifted to a second row where two would overlap
        var rows: [CGFloat] = [-99, -99]
        for v in g.values.sorted() {
            let p = CGFloat(g.position(v)) * 100
            let r = p - rows[0] >= 2.6 ? 0 : p - rows[1] >= 2.6 ? 1 : 0
            rows[r] = p
            let c = CGPoint(x: x(v), y: r == 1 ? 23 : 33)
            let outer = Path(ellipseIn: CGRect(x: c.x - 5, y: c.y - 5, width: 10, height: 10))
            ctx.fill(outer, with: .color(.glett.panel))
            ctx.fill(Path(ellipseIn: CGRect(x: c.x - 3, y: c.y - 3, width: 6, height: 6)), with: .color(Self.dot))
        }

        // Glett's line and label
        let gx = x(g.glett), glPct = min(93, max(7, g.position(g.glett) * 100))
        ctx.fill(Path(roundedRect: CGRect(x: gx - 2, y: 23, width: 4, height: 20), cornerRadius: 2), with: .color(.glett.accent))
        let gl = CGFloat(glPct / 100) * w
        ctx.draw(Text(verbatim: "Glett \(AlertGauge.f(g.glett))").font(font(11.5, .bold)).foregroundStyle(.glett.accent),
                 at: CGPoint(x: gl, y: 45), anchor: .top)

        // ticks 0, middle, end (with the unit), left out where Glett's label is
        func tick(_ v: Double, _ at: Double, _ anchor: UnitPoint, unit: Bool = false) {
            guard abs(at - glPct) >= 13 else { return }
            let s = JS.fmt(v) + (unit ? " \(g.unit)" : "")
            ctx.draw(Text(verbatim: s).font(font(11)).foregroundStyle(.glett.muted), at: CGPoint(x: CGFloat(at / 100) * w, y: 45), anchor: anchor)
        }
        tick(0, 0, .topLeading)
        tick(g.scaleMid, g.position(g.scaleMid) * 100, .top)
        tick(g.scaleMax, 100, .topTrailing, unit: true)
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    VStack(spacing: 20) {
        WarningGaugeView(gauge: AlertGauge(kind: .gust, unit: "m/s", values: [17, 19, 21, 22, 22.5, 24, 25, 27, 31], glett: 23,
                                           low: 25, high: 30, threshold: 25), level: "orange")
        WarningGaugeView(gauge: AlertGauge(kind: .rain, unit: "mm", values: [22, 30, 35, 41, 48, 60], glett: 38,
                                           low: 40, high: 60, threshold: 40), level: "yellow")
    }
    .padding()
    .frame(width: 360)
}
