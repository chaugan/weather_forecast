import GlettKit
import SwiftUI

/// The meteogram's chart rows drawn with one `Canvas` each: the same marks, scales and colours as the Swift Charts
/// versions had, but a canvas is a single static drawing, so scrolling the page does not make it work (Swift Charts
/// did, frame after frame: the owner saw a lower frame rate with the meteogram, 2026-10-27).
struct MeteogramPlot {
    let slice: MeteogramSlice
    let size: CGSize
    let y: ClosedRange<Double>

    func x(_ p: MeteogramPoint) -> CGFloat { x(slice.x(p)) }
    func x(_ v: Double) -> CGFloat { CGFloat(v / slice.domain.upperBound) * size.width }
    func y(_ v: Double) -> CGFloat {
        let span = max(y.upperBound - y.lowerBound, .ulpOfOne)
        return size.height * CGFloat(1 - (v - y.lowerBound) / span)
    }

    /// The points of `value` along the day and its neighbours, skipping steps without one (as the charts did).
    func line(_ value: (MeteogramPoint) -> Double?) -> [CGPoint] {
        slice.continuous.compactMap { p in value(p).map { CGPoint(x: x(p), y: y($0)) } }
    }

    /// The area between two lines, `top` left to right and `bottom` back.
    static func band(_ top: [CGPoint], _ bottom: [CGPoint]) -> Path {
        guard let first = top.first, let last = bottom.last else { return Path() }
        var p = Path()
        p.move(to: first)
        CatmullRom.add(top, to: &p)
        p.addLine(to: last)
        CatmullRom.add(bottom.reversed(), to: &p)
        p.closeSubpath()
        return p
    }

    static func curve(_ pts: [CGPoint]) -> Path {
        var p = Path()
        guard let first = pts.first else { return p }
        p.move(to: first)
        CatmullRom.add(pts, to: &p)
        return p
    }
}

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

/// The temperature row (js/app.js:672-680): grid lines, the spread between the models (lowest to highest) as a band,
/// the weighted mean as a smooth line, and its value every third hour.
struct MeteogramTemperatureCanvas: View {
    let slice: MeteogramSlice
    let data: MeteogramData
    let height: CGFloat
    let width: CGFloat
    @Environment(\.dynamicTypeSize) private var dynamicType

    /// A label every third hour (`i % 3 === 1`, js/app.js:677); every step when steps are 3 h or longer.
    private var labelEvery: Int { max(1, 3 / max(1, slice.points.first?.column.hours ?? 1)) }

    var body: some View {
        let font = Font.scaledSystem(11, weight: .bold, in: dynamicType)
        Canvas { ctx, size in
            let plot = MeteogramPlot(slice: slice, size: size, y: data.temperature)
            ctx.clip(to: Path(CGRect(origin: .zero, size: size)))
            for v in data.temperatureTicks {
                var grid = Path()
                grid.move(to: CGPoint(x: 0, y: plot.y(v)))
                grid.addLine(to: CGPoint(x: size.width, y: plot.y(v)))
                ctx.stroke(grid, with: .color(.glett.line), lineWidth: 1)
            }
            let both = slice.continuous.filter { $0.step.temperatureMin != nil && $0.step.temperatureMax != nil }
            let top = both.map { CGPoint(x: plot.x($0), y: plot.y($0.step.temperatureMax ?? 0)) }
            let bottom = both.map { CGPoint(x: plot.x($0), y: plot.y($0.step.temperatureMin ?? 0)) }
            ctx.fill(MeteogramPlot.band(top, bottom), with: .color(HoursColor.temperature.opacity(0.14)))
            ctx.stroke(MeteogramPlot.curve(plot.line { $0.step.temperature }), with: .color(HoursColor.temperature),
                       style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
            for p in slice.points where (p.index - slice.firstIndex) % labelEvery == labelEvery / 2 {
                guard let t = p.step.temperature else { continue }
                let label = ctx.resolve(Text(verbatim: Format.temp(t)).font(font).foregroundStyle(Color.glett.text))
                ctx.draw(label, at: CGPoint(x: plot.x(p), y: plot.y(t) - 3), anchor: .bottom)
            }
        }
        .frame(width: width, height: height)
        .accessibilityHidden(true)
    }
}

/// The rain row (js/app.js:666-671, 682): the wettest model as a light bar, the weighted mean as a solid bar with its
/// amount from 0.25 mm, and MET's radar for the next hours as a dashed outline (amber where it disagrees with the
/// models).
struct MeteogramRainCanvas: View {
    let slice: MeteogramSlice
    let data: MeteogramData
    let height: CGFloat
    let width: CGFloat
    @Environment(\.dynamicTypeSize) private var dynamicType

    /// Bars leave this much of the column free on each side (`x = i * CW + 8`, width `CW - 16`).
    private static let inset = 0.18

    var body: some View {
        let font = Font.scaledSystem(9.5, weight: .bold, in: dynamicType)
        Canvas { ctx, size in
            let plot = MeteogramPlot(slice: slice, size: size, y: 0...data.rainTop * 1.18)
            ctx.clip(to: Path(CGRect(origin: .zero, size: size)))
            let base = plot.y(0)
            var zero = Path()
            zero.move(to: CGPoint(x: 0, y: base))
            zero.addLine(to: CGPoint(x: size.width, y: base))
            ctx.stroke(zero, with: .color(.glett.line), lineWidth: 1)
            func bar(_ x0: Double, _ l: Double, _ r: Double, _ mm: Double) -> CGRect {
                let left = plot.x(x0 + l), top = plot.y(mm)
                return CGRect(x: left, y: top, width: plot.x(x0 + r) - left, height: base - top)
            }
            for p in slice.points {
                let x0 = Double(p.index - slice.firstIndex)
                if let mx = p.step.precipitationMax, mx > 0 {
                    ctx.fill(Path(bar(x0, Self.inset, 1 - Self.inset, mx)), with: .color(Color.glett.rain.opacity(0.22)))
                }
                if let m = p.step.precipitation, m >= 0.05 {
                    let r = bar(x0, Self.inset, 1 - Self.inset, m)
                    ctx.fill(Path(r), with: .color(.glett.rain))
                    if m >= 0.25 {
                        let label = ctx.resolve(Text(verbatim: JS.fmt(m, 1)).font(font).foregroundStyle(Color.glett.rain))
                        ctx.draw(label, at: CGPoint(x: r.midX, y: r.minY - 1), anchor: .bottom)
                    }
                }
                // the radar outlines (`rect.rradar`, css/style.css:642-644)
                if let mm = p.radar {
                    var r = bar(x0, 0.12, 0.88, max(mm, 0.04))
                    r.size.height = max(1, r.height)
                    ctx.stroke(Path(r), with: .color(p.radarDisagrees ? .glett.mid : .glett.rain),
                               style: StrokeStyle(lineWidth: 1.2, dash: [3, 2]))
                }
            }
        }
        .frame(width: width, height: height)
        .accessibilityHidden(true)
    }
}

/// The wind row: the weighted mean wind as a line, the strongest gusts (the models' mean of their highest gust,
/// `gustMean`) as a dashed line over a light area, in the chosen unit.
struct MeteogramWindCanvas: View {
    let slice: MeteogramSlice
    let data: MeteogramData
    let height: CGFloat
    let width: CGFloat

    var body: some View {
        let u = data.unit
        Canvas { ctx, size in
            let plot = MeteogramPlot(slice: slice, size: size, y: 0...data.windTop)
            ctx.clip(to: Path(CGRect(origin: .zero, size: size)))
            let base = plot.y(0)
            var zero = Path()
            zero.move(to: CGPoint(x: 0, y: base))
            zero.addLine(to: CGPoint(x: size.width, y: base))
            ctx.stroke(zero, with: .color(.glett.line), lineWidth: 1)
            let gust = plot.line { u.value($0.step.gust) }
            if let first = gust.first, let last = gust.last {
                var area = MeteogramPlot.curve(gust)
                area.addLine(to: CGPoint(x: last.x, y: base))
                area.addLine(to: CGPoint(x: first.x, y: base))
                area.closeSubpath()
                ctx.fill(area, with: .color(HoursColor.wind.opacity(0.12)))
            }
            ctx.stroke(MeteogramPlot.curve(gust), with: .color(HoursColor.wind.opacity(0.75)), style: StrokeStyle(lineWidth: 1.2, dash: [4, 3]))
            ctx.stroke(MeteogramPlot.curve(plot.line { u.value($0.step.wind) }), with: .color(HoursColor.wind),
                       style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        }
        .frame(width: width, height: height)
        .accessibilityHidden(true)
    }
}

/// The cloud row: the weighted mean cloud cover, 0–100 %, as a soft area under a thin line.
struct MeteogramCloudCanvas: View {
    let slice: MeteogramSlice
    let height: CGFloat
    let width: CGFloat

    var body: some View {
        Canvas { ctx, size in
            let plot = MeteogramPlot(slice: slice, size: size, y: 0...100)
            ctx.clip(to: Path(CGRect(origin: .zero, size: size)))
            let pts = plot.line(\.cloud)
            guard let first = pts.first, let last = pts.last else { return }
            var area = MeteogramPlot.curve(pts)
            area.addLine(to: CGPoint(x: last.x, y: size.height))
            area.addLine(to: CGPoint(x: first.x, y: size.height))
            area.closeSubpath()
            ctx.fill(area, with: .linearGradient(Gradient(colors: [.glett.cloudTop, Color.glett.cloudBot.opacity(0.6)]),
                                                 startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)))
            ctx.stroke(MeteogramPlot.curve(pts), with: .color(Color.glett.muted.opacity(0.7)), lineWidth: 1)
        }
        .frame(width: width, height: height)
        .accessibilityHidden(true)
    }
}
