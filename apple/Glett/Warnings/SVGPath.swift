import SwiftUI

/// A small SVG path-data reader (M L H V C S A Z, absolute and relative, with implicit repeats) for the few path
/// strings the web draws inline, such as MET's warning symbols (`AW_SYM`, js/app.js:42-50). Arcs are read as circles
/// (rx is used, ry and the rotation are ignored), which is all those paths use.
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
                guard let r = tokens.number(), tokens.number() != nil, tokens.number() != nil,
                      let large = tokens.number(), let sweep = tokens.number(), let x = tokens.number(), let y = tokens.number() else { return p }
                let end = pt(x, y)
                arc(&p, from: cur, to: end, radius: r, large: large != 0, sweep: sweep != 0)
                cur = end; lastControl = nil
            case "Z":
                p.closeSubpath(); cur = start; lastControl = nil
            default:
                return p
            }
        }
        return p
    }

    /// An SVG circular arc as cubic Béziers (SVG 1.1 F.6.5, with rx = ry and no rotation).
    private static func arc(_ p: inout Path, from a: CGPoint, to b: CGPoint, radius r0: Double, large: Bool, sweep: Bool) {
        let x1 = (a.x - b.x) / 2, y1 = (a.y - b.y) / 2
        let d2 = x1 * x1 + y1 * y1
        guard d2 > 0, r0 > 0 else { p.addLine(to: b); return }
        let r = max(r0, d2.squareRoot())
        let coef = (large != sweep ? 1.0 : -1.0) * max(0, (r * r - d2) / d2).squareRoot()
        let cx = coef * y1 + (a.x + b.x) / 2, cy = coef * -x1 + (a.y + b.y) / 2
        let t1 = atan2(a.y - cy, a.x - cx)
        var dt = atan2(b.y - cy, b.x - cx) - t1
        if sweep && dt < 0 { dt += 2 * .pi }
        if !sweep && dt > 0 { dt -= 2 * .pi }
        let n = Int((abs(dt) / (.pi / 2)).rounded(.up)), step = dt / Double(max(1, n))
        let k = 4.0 / 3.0 * tan(step / 4)
        var t = t1
        for _ in 0..<max(1, n) {
            let t2 = t + step
            let p1 = CGPoint(x: cx + r * cos(t), y: cy + r * sin(t)), p2 = CGPoint(x: cx + r * cos(t2), y: cy + r * sin(t2))
            p.addCurve(to: p2,
                       control1: CGPoint(x: p1.x - k * r * sin(t), y: p1.y + k * r * cos(t)),
                       control2: CGPoint(x: p2.x + k * r * sin(t2), y: p2.y - k * r * cos(t2)))
            t = t2
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
