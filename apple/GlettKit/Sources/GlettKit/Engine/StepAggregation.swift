import Foundation

/// What `agg(p, param, a, b)` computes over one step (js/app.js:121-134).
public enum AggregateParam: Sendable, Hashable {
    /// Precipitation sum.
    case precip
    /// Highest gust.
    case gust
    /// Highest CAPE.
    case cape
    /// Highest weather code (the derived `code` series).
    case code
    /// Wind direction: speed-weighted circular mean.
    case dir
    /// The plain mean of any hourly variable.
    case mean(HourlyVariable)
}

/// The step aggregation of the hour table (1/3/6/12 h), ported from js/app.js:115-134.
public enum StepAggregation {
    /// The step sizes of the web's step selector (index.html `stepSelect`).
    public static let steps = [1, 3, 6, 12]

    /// `agg(p, param, a, b)`: one provider over hours a..<b; nil when the provider has no value there.
    public static func aggregate(_ p: Provider, _ param: AggregateParam, _ a: Int, _ b: Int) -> Double? {
        let h = p.hourly
        func slice(_ arr: [Double?]) -> [Double] {
            let lo = max(0, min(a, arr.count)), hi = max(lo, min(b, arr.count))
            return JS.nn(Array(arr[lo..<hi]))
        }
        switch param {
        case .precip:
            let v = slice(h[.precipitation]); guard !v.isEmpty else { return nil }
            var s = 0.0; for x in v { s += x }; return s
        case .gust:
            let v = slice(h[.windGusts10m]); return v.max()
        case .cape:
            let v = slice(h[.cape]); return v.max()
        case .code:
            let v = slice(h.code); return v.max()
        case .dir:
            let dirs = h[.windDirection10m], speeds = h[.windSpeed10m]
            var d: [Double] = [], w: [Double] = []
            for i in max(0, a)..<max(max(0, a), min(b, dirs.count)) {
                guard let x = dirs[i] else { continue }
                d.append(x)
                let s = i < speeds.count ? speeds[i] : nil
                w.append(truthyOr1(s))
            }
            return d.isEmpty ? nil : circularMean(d, weights: w)
        case .mean(let v):
            return JS.mean(slice(h[v]))
        }
    }

    /// `circMean(dirs, weights)` of js/app.js:116-120: a weighted vector mean in degrees, 0..<360.
    public static func circularMean(_ dirs: [Double], weights: [Double]) -> Double {
        var x = 0.0, y = 0.0
        for (i, d) in dirs.enumerated() {
            let w = truthyOr1(i < weights.count ? weights[i] : nil)
            x += Foundation.cos(d * Double.pi / 180) * w
            y += Foundation.sin(d * Double.pi / 180) * w
        }
        return (Foundation.atan2(y, x) * 180 / Double.pi + 360).truncatingRemainder(dividingBy: 360)
    }

    /// JS `x || 1`: null, 0 and NaN become 1.
    @inlinable static func truthyOr1(_ x: Double?) -> Double {
        guard let x, x != 0, !x.isNaN else { return 1 }
        return x
    }
}
