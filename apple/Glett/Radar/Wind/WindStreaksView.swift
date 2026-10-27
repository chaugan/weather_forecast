import GlettKit
import MapKit
import UIKit

/// The wind's streaks over the map (js/windmap.js `stepParticles`): a fixed number for the map's area, each living
/// 1-3 s and moving in screen points at a speed that grows with the wind but not with the zoom, so a close view never
/// turns into a storm. Light map: dark streaks where the field is pale (under 9 m/s), white where it is deep; dark
/// map: white throughout. With Reduce Motion: still arrows. Hidden while the map moves, placed anew when it stops.
@MainActor
final class WindStreaksView: UIView {
    private struct Part { var x: Double; var y: Double; var age: Double; var max: Double }

    weak var map: MKMapView?
    /// The view changed size: the owner places the wind anew (the box fetched and the streaks).
    var onResize: (() -> Void)?
    private var lastSize = CGSize.zero
    /// The frames to read and the blend between them.
    var wind: () -> (a: WindFrame?, b: WindFrame?, tau: Double) = { (nil, nil, 0) }
    var reduceMotion = false { didSet { if reduceMotion != oldValue { restart() } } }
    /// Streaks run (the wind side is shown and the app is in front).
    var running = false { didSet { if running != oldValue { restart() } } }

    private var parts: [Part] = []
    private var ctx: CGContext?
    private var scale: CGFloat = 2
    private var link: CADisplayLink?
    private var lonAt: (Double) -> Double = { _ in 0 }
    private var latAt: (Double) -> Double = { _ in 0 }
    private var placed = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        layer.contentsGravity = .resize
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.size != lastSize, bounds.width > 0 else { return }
        lastSize = bounds.size
        if running { onResize?() }
    }

    /// The map stopped moving (or changed size): the screen's lat/lon anew, the streaks seeded anew.
    func place() {
        guard let map, bounds.width > 0, bounds.height > 0 else { return }
        let a = map.convert(.zero, toCoordinateFrom: self), b = map.convert(CGPoint(x: bounds.width, y: bounds.height), toCoordinateFrom: self)
        let w = Double(bounds.width), h = Double(bounds.height)
        func merc(_ lat: Double) -> Double { log(tan(.pi / 4 + lat * .pi / 360)) }
        let m0 = merc(a.latitude), m1 = merc(b.latitude), l0 = a.longitude, l1 = b.longitude
        lonAt = { l0 + (l1 - l0) * $0 / w }
        latAt = { (2 * atan(exp(m0 + (m1 - m0) * $0 / h)) - .pi / 2) * 180 / .pi }
        scale = min(2, window?.screen.scale ?? 2)
        let pw = Int(w * scale), ph = Int(h * scale)
        if ctx?.width != pw || ctx?.height != ph {
            ctx = CGContext(data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            ctx?.translateBy(x: 0, y: CGFloat(ph))
            ctx?.scaleBy(x: scale, y: -scale)   // points, y down as UIKit
        }
        placed = true
        seed()
        if reduceMotion { drawArrows() }
        isHidden = !running
    }

    /// The map started moving: the streaks would slide off their places.
    func hide() { isHidden = true; placed = false }

    /// A new hour or blend: the arrows anew (the streaks pick it up by themselves).
    func windChanged() { if reduceMotion && placed { drawArrows() } }

    private func restart() {
        link?.invalidate()
        link = nil
        clear()
        guard running else { isHidden = true; return }
        if placed { isHidden = false }
        if reduceMotion { if placed { drawArrows() }; return }
        let l = CADisplayLink(target: self, selector: #selector(step))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 20, maximum: 30, preferred: 30)
        l.add(to: .main, forMode: .common)
        link = l
    }

    /// Fewer streaks the closer the view (all of them up to zoom 6, a third at street level).
    private var count: Int {
        let area = Double(bounds.width * bounds.height)
        let zoom = map.map { log2(360 / max(1e-6, $0.region.span.longitudeDelta) * Double($0.bounds.width) / 256) } ?? 7
        return Int((max(150, min(900, area / 600)) * max(0.35, min(1, 1.4 - 0.07 * zoom))).rounded())
    }

    private func spawn() -> Part {
        Part(x: .random(in: 0..<Double(bounds.width)), y: .random(in: 0..<Double(bounds.height)), age: 0, max: 50 + .random(in: 0..<110))
    }

    private func seed() {
        parts = (0..<count).map { _ in spawn() }
        clear()
    }

    private func clear() {
        guard let ctx else { return }
        ctx.saveGState(); ctx.resetClip()
        ctx.clear(CGRect(x: 0, y: 0, width: bounds.width, height: bounds.height))
        ctx.restoreGState()
        layer.contents = nil
    }

    private var dark: Bool { traitCollection.userInterfaceStyle == .dark }

    @objc private func step() {
        guard placed, !isHidden, let ctx else { return }
        let w = wind(), dk = dark
        // the trails fade (the web's 0.075 per frame at 60 fps, here at 30)
        ctx.setBlendMode(.destinationOut)
        ctx.setFillColor(UIColor(white: 0, alpha: 0.145).cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: bounds.width, height: bounds.height))
        ctx.setBlendMode(.normal)
        let lite = CGMutablePath(), deep = CGMutablePath()
        for i in parts.indices {
            parts[i].age += 2   // 30 fps: two of the web's frames
            if parts[i].age > parts[i].max { parts[i] = spawn(); continue }
            let p = parts[i]
            guard let uv = WindController.wind(w.a, w.b, tau: w.tau, lat: latAt(p.y), lon: lonAt(p.x)) else { parts[i] = spawn(); continue }
            let sp = hypot(uv.u, uv.v), px = 2 * 0.32 * pow(sp, 0.8)   // points per frame: 1 m/s 0.6, 10 m/s 4, 25 m/s 8
            var dx = sp > 0 ? uv.u / sp * px : 0, dy = sp > 0 ? -uv.v / sp * px : 0
            let len = hypot(dx, dy)
            if len < 0.7, len > 0 { dx *= 0.7 / len; dy *= 0.7 / len }
            let path = dk || sp >= 9 ? deep : lite
            path.move(to: CGPoint(x: p.x, y: p.y))
            parts[i].x += dx; parts[i].y += dy
            path.addLine(to: CGPoint(x: parts[i].x, y: parts[i].y))
            if parts[i].x < 0 || parts[i].y < 0 || parts[i].x > Double(bounds.width) || parts[i].y > Double(bounds.height) { parts[i] = spawn() }
        }
        ctx.setLineCap(.round)
        ctx.setLineWidth(1.3)
        ctx.addPath(lite); ctx.setStrokeColor(UIColor(red: 22 / 255, green: 32 / 255, blue: 58 / 255, alpha: 0.62).cgColor); ctx.strokePath()
        ctx.addPath(deep); ctx.setStrokeColor(UIColor(white: 1, alpha: 0.92).cgColor); ctx.strokePath()
        layer.contents = ctx.makeImage()
    }

    /// Reduce Motion: an arrow every ~46 pt, pointing where the wind goes.
    private func drawArrows() {
        guard let ctx else { return }
        clear()
        let w = wind(), gap = 46.0, path = CGMutablePath()
        var y = gap / 2
        while y < Double(bounds.height) {
            var x = gap / 2
            while x < Double(bounds.width) {
                if let uv = WindController.wind(w.a, w.b, tau: w.tau, lat: latAt(y), lon: lonAt(x)) {
                    let sp = hypot(uv.u, uv.v)
                    if sp >= 0.3 {
                        let ux = uv.u / sp, uy = -uv.v / sp, l = 7 + min(10, sp * 0.6), hx = x + ux * l, hy = y + uy * l
                        path.move(to: CGPoint(x: x - ux * l, y: y - uy * l)); path.addLine(to: CGPoint(x: hx, y: hy))
                        path.move(to: CGPoint(x: hx - ux * 6 - uy * 4, y: hy - uy * 6 + ux * 4)); path.addLine(to: CGPoint(x: hx, y: hy))
                        path.addLine(to: CGPoint(x: hx - ux * 6 + uy * 4, y: hy - uy * 6 - ux * 4))
                    }
                }
                x += gap
            }
            y += gap
        }
        ctx.setLineCap(.round); ctx.setLineJoin(.round)
        ctx.addPath(path); ctx.setStrokeColor(UIColor(red: 15 / 255, green: 23 / 255, blue: 42 / 255, alpha: 0.45).cgColor); ctx.setLineWidth(3.4); ctx.strokePath()
        ctx.addPath(path); ctx.setStrokeColor(UIColor(white: 1, alpha: 0.95).cgColor); ctx.setLineWidth(1.6); ctx.strokePath()
        layer.contents = ctx.makeImage()
    }
}
