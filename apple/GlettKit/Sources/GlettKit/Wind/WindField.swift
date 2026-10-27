import Foundation

/// The wind map's run (`api/wind.php?meta=1`): MET Nordic's newest finished run and its hours (unix seconds).
public struct WindMeta: Sendable, Codable, Hashable {
    public var run: String
    /// The run's reference time ("varselet laget kl.").
    public var ref: Double
    public var times: [Double]

    public init(run: String, ref: Double, times: [Double]) { self.run = run; self.ref = ref; self.times = times }

    /// This hour to 48 hours on, and the index nearest `want` (now when nil), as js/windmap.js `hours`.
    public func hours(want: Double?, now: Date = Date()) -> (times: [Double], index: Int) {
        let hour = (now.timeIntervalSince1970 / 3600).rounded(.down) * 3600
        var ts = times.filter { $0 >= hour && $0 <= hour + 48 * 3600 }
        if ts.isEmpty, let last = times.last { ts = [last] }
        let target = want ?? hour
        let best = ts.indices.min { abs(ts[$0] - target) < abs(ts[$1] - target) } ?? 0
        return (ts, best)
    }
}

/// The box of the map asked for (js/windmap.js `viewFor`): the view plus a margin, a point every ~10 pt, never finer
/// than the grid (3 km, or MET's own 1 km once the points would be closer than 2.5 km).
public struct WindView: Sendable, Hashable {
    public var s: Double, w: Double, n: Double, e: Double
    public var nx: Int, ny: Int
    public var fine: Bool

    /// - Parameters: the visible box in degrees and the view's size in points.
    public init(south: Double, west: Double, north: Double, east: Double, width: Double, height: Double) {
        let padLat = (north - south) * 0.25, padLon = (east - west) * 0.25
        let s = max(40.5, south - padLat), n = min(79.5, north + padLat)
        let w = max(-29.5, west - padLon), e = min(59.5, east + padLon)
        let kmX = (e - w) * 111.3 * cos((s + n) / 2 * .pi / 180), kmY = (n - s) * 111.3
        let fine = kmX / (width * 1.5 / 10) < 2.5, km = fine ? 1.0 : 3.0
        func r(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }
        self.s = r(s); self.w = r(w); self.n = r(n); self.e = r(e)
        nx = max(6, min(140, Int(min(width * 1.5 / 10, kmX / km).rounded())))
        ny = max(6, min(140, Int(min(height * 1.5 / 10, kmY / km).rounded())))
        self.fine = fine
    }

    /// The box holds the visible one (no new request needed).
    public func contains(south: Double, west: Double, north: Double, east: Double) -> Bool {
        south >= s && north <= n && west >= w && east <= e
    }
}

/// One forecast hour for a box (`api/wind.php?run=&t=…`): u towards the east and v towards the north in m/s on a
/// regular lat/lon grid, rows south to north; NaN where MET has nothing.
public struct WindFrame: Sendable {
    public var run: String
    public var t: Double
    public var s: Double, w: Double, n: Double, e: Double
    public var nx: Int, ny: Int
    public var u: [Float], v: [Float]

    public init(run: String, t: Double, s: Double, w: Double, n: Double, e: Double, nx: Int, ny: Int, u: [Float], v: [Float]) {
        self.run = run; self.t = t; self.s = s; self.w = w; self.n = n; self.e = e; self.nx = nx; self.ny = ny; self.u = u; self.v = v
    }

    /// Bilinear between the grid points; nil outside the box or where a corner has no data (js/windmap.js `sample`).
    public func sample(lat: Double, lon: Double) -> (u: Double, v: Double)? {
        guard nx > 1, ny > 1 else { return nil }
        let x = (lon - w) / (e - w) * Double(nx - 1), y = (lat - s) / (n - s) * Double(ny - 1)
        guard x >= 0, y >= 0, x <= Double(nx - 1), y <= Double(ny - 1) else { return nil }
        let i = min(nx - 2, Int(x)), j = min(ny - 2, Int(y)), a = x - Double(i), b = y - Double(j), q = j * nx + i
        func at(_ arr: [Float]) -> Double {
            Double(arr[q]) * (1 - a) * (1 - b) + Double(arr[q + 1]) * a * (1 - b) + Double(arr[q + nx]) * (1 - a) * b + Double(arr[q + nx + 1]) * a * b
        }
        let uu = at(u), vv = at(v)
        return uu.isNaN || vv.isNaN ? nil : (uu, vv)
    }
}

/// Where the wind map is (MET Nordic's area) and how its wind reads.
public enum WindGrid {
    /// MET Nordic's Lambert conformal grid (lat_0 = lat_1 = lat_2 = 63, lon_0 = 15, sphere), 1 km, 1796 × 2321:
    /// the place is inside it with a 5 km margin (js/windmap.js `covers`).
    public static func covers(lat: Double, lon: Double) -> Bool {
        let p1 = 63 * Double.pi / 180, n = sin(p1)
        let f = cos(p1) * pow(tan(.pi / 4 + p1 / 2), n) / n
        let rho0 = 6_371_000 * f / pow(tan(.pi / 4 + p1 / 2), n)
        let rho = 6_371_000 * f / pow(tan(.pi / 4 + lat * .pi / 360), n), th = n * (lon - 15) * .pi / 180
        let i = (rho * sin(th) + 897_442.2) / 1000, j = (rho0 - rho * cos(th) + 1_104_322.0) / 1000
        return i > 5 && j > 5 && i < 1790 && j < 2315
    }

    /// The direction the wind comes from (degrees, 0 = north) for u and v.
    public static func from(u: Double, v: Double) -> Double {
        (atan2(-u, -v) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
    }

    /// "n", "ne", … for `dir.<x>`.
    public static func compass8(_ deg: Double) -> String {
        ["n", "ne", "e", "se", "s", "sw", "w", "nw"][Int((deg / 45).rounded()) % 8]
    }
}
