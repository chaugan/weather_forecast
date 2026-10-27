import SwiftUI

/// A small SVG path-data reader (M L H V C S A Z, absolute and relative, with implicit repeats) for the few path
/// strings the web draws inline, such as MET's warning symbols (`AW_SYM`, js/app.js:42-50) and the weather icons
/// (js/icons.js). Arcs are elliptical without x-axis rotation, which none of those paths use.
enum SVGPath {
    static func path(_ d: String) -> Path {
        var p = Path()
        var tokens = Tokens(d)
        var cur = CGPoint.zero, start = CGPoint.zero, lastControl: CGPoint?
        var cmd: Character = "M"

        while let next = tokens.peekCommand() ?? (tokens.hasNumber ? cmd : nil) {
            if tokens.peekCommand() != nil { tokens.skipCommand() }
            cmd = next
            let rel = cmd.isLowercase
            func pt(_ x: Double, _ y: Double) -> CGPoint { rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y) }
            switch cmd.uppercased().first! {
            case "M":
                guard let x = tokens.number(), let y = tokens.number() else { return p }
                cur = pt(x, y); start = cur; p.move(to: cur)
                cmd = rel ? "l" : "L"   // further pairs are line-tos
                lastControl = nil
            case "L":
                guard let x = tokens.number(), let y = tokens.number() else { return p }
                cur = pt(x, y); p.addLine(to: cur); lastControl = nil
            case "H":
                guard let x = tokens.number() else { return p }
                cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y); p.addLine(to: cur); lastControl = nil
            case "V":
                guard let y = tokens.number() else { return p }
                cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y); p.addLine(to: cur); lastControl = nil
            case "C":
                guard let x1 = tokens.number(), let y1 = tokens.number(), let x2 = tokens.number(), let y2 = tokens.number(),
                      let x = tokens.number(), let y = tokens.number() else { return p }
                let c1 = pt(x1, y1), c2 = pt(x2, y2), end = pt(x, y)
                p.addCurve(to: end, control1: c1, control2: c2)
                lastControl = c2; cur = end
            case "S":
                guard let x2 = tokens.number(), let y2 = tokens.number(), let x = tokens.number(), let y = tokens.number() else { return p }
                let c1 = lastControl.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                let c2 = pt(x2, y2), end = pt(x, y)
                p.addCurve(to: end, control1: c1, control2: c2)
                lastControl = c2; cur = end
            case "A":
                guard let rx = tokens.number(), let ry = tokens.number(), tokens.number() != nil,
                      let large = tokens.number(), let sweep = tokens.number(), let x = tokens.number(), let y = tokens.number() else { return p }
                let end = pt(x, y)
                arc(&p, from: cur, to: end, rx: rx, ry: ry, large: large != 0, sweep: sweep != 0)
                cur = end; lastControl = nil
            case "Z":
                p.closeSubpath(); cur = start; lastControl = nil
            default:
                return p
            }
        }
        return p
    }

    /// An elliptical arc (no x-axis rotation, which the icons never use) as cubic Béziers: SVG's endpoint to centre
    /// conversion (SVG 1.1 appendix F.6), then at most 90° per segment.
    private static func arc(_ p: inout Path, from a: CGPoint, to b: CGPoint, rx rx0: Double, ry ry0: Double, large: Bool, sweep: Bool) {
        var rx = abs(rx0), ry = abs(ry0)
        if rx < 1e-9 || ry < 1e-9 || a == b { p.addLine(to: b); return }
        let x1p = (a.x - b.x) / 2, y1p = (a.y - b.y) / 2
        let lambda = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry)
        if lambda > 1 { rx *= lambda.squareRoot(); ry *= lambda.squareRoot() }
        let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
        let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        let coef = (large == sweep ? -1.0 : 1.0) * max(0, num / den).squareRoot()
        let cxp = coef * rx * y1p / ry, cyp = -coef * ry * x1p / rx
        let cx = cxp + (a.x + b.x) / 2, cy = cyp + (a.y + b.y) / 2
        func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
            let s = ux * vy - uy * vx >= 0 ? 1.0 : -1.0
            let d = (ux * vx + uy * vy) / ((ux * ux + uy * uy).squareRoot() * (vx * vx + vy * vy).squareRoot())
            return s * acos(min(1, max(-1, d)))
        }
        let ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry, vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry
        let t1 = angle(1, 0, ux, uy)
        var dt = angle(ux, uy, vx, vy)
        if !sweep && dt > 0 { dt -= 2 * .pi } else if sweep && dt < 0 { dt += 2 * .pi }
        let segs = max(1, Int((abs(dt) / (.pi / 2)).rounded(.up)))
        let step = dt / Double(segs), k = 4.0 / 3.0 * tan(step / 4)
        var a1 = t1
        for _ in 0..<segs {
            let a2 = a1 + step
            let (c1, s1, c2, s2) = (cos(a1), sin(a1), cos(a2), sin(a2))
            func pt(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: cx + rx * x, y: cy + ry * y) }
            p.addCurve(to: pt(c2, s2), control1: pt(c1 - k * s1, s1 + k * c1), control2: pt(c2 + k * s2, s2 - k * c2))
            a1 = a2
        }
    }

    /// Commands and numbers in path data ("1.5-1.4", ".2", "2-2" are all split as SVG splits them).
    private struct Tokens {
        let s: [Character]
        var i = 0
        init(_ d: String) { s = Array(d) }

        mutating func skipSeparators() { while i < s.count, s[i] == " " || s[i] == "," || s[i] == "\n" { i += 1 } }

        mutating func peekCommand() -> Character? {
            skipSeparators()
            guard i < s.count, s[i].isLetter, s[i] != "e", s[i] != "E" else { return nil }
            return s[i]
        }
        mutating func skipCommand() { i += 1 }

        var hasNumber: Bool {
            mutating get {
                skipSeparators()
                guard i < s.count else { return false }
                return s[i].isNumber || s[i] == "-" || s[i] == "+" || s[i] == "."
            }
        }

        mutating func number() -> Double? {
            skipSeparators()
            var j = i, out = ""
            if j < s.count, s[j] == "-" || s[j] == "+" { out.append(s[j]); j += 1 }
            var dot = false
            while j < s.count {
                let c = s[j]
                if c.isNumber { out.append(c) } else if c == ".", !dot { dot = true; out.append(c) } else { break }
                j += 1
            }
            if j < s.count, s[j] == "e" || s[j] == "E" {
                out.append("e"); j += 1
                if j < s.count, s[j] == "-" || s[j] == "+" { out.append(s[j]); j += 1 }
                while j < s.count, s[j].isNumber { out.append(s[j]); j += 1 }
            }
            guard let v = Double(out) else { return nil }
            i = j
            return v
        }
    }
}
