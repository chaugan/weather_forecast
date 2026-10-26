import Foundation
import GlettKit

/// What MET warns against what the models say over the warning's hours (`lmAlertGauge`, js/app.js:2341-2369): the
/// strongest gust (land) or mean wind (sea) in each model, or its precipitation over the period, in the visitor's
/// wind unit or mm. nil for the kinds without a model number to hold against (storm surge, snow, ice, fire …).
struct AlertGauge: Sendable, Hashable {
    enum Kind: String, Sendable { case gust, wind, rain }

    var kind: Kind
    /// "m/s", "km/t" or "mm".
    var unit: String
    /// One value per active model.
    var values: [Double]
    /// Glett: the models' weighted mean.
    var glett: Double
    /// The range in MET's text ("27-33 m/s", "40-60 mm"), converted.
    var low: Double?
    var high: Double?
    /// MET's trigger level, converted.
    var threshold: Double?

    init(kind: Kind, unit: String, values: [Double], glett: Double, low: Double?, high: Double?, threshold: Double?) {
        self.kind = kind; self.unit = unit; self.values = values; self.glett = glett
        self.low = low; self.high = high; self.threshold = threshold
    }

    init?(alert x: MetAlert, engine: ConsensusEngine, windUnit: WindUnit) {
        guard let from = x.fromDate?.timeIntervalSince1970, let to = x.toDate?.timeIntervalSince1970 else { return nil }
        let times = engine.forecast.times
        let idx = times.indices.filter { let u = times[$0].timeIntervalSince1970; return u >= from && u < to }
        guard let a = idx.first, let last = idx.last else { return nil }
        let b = last + 1
        let trig = Self.leadingNumber(x.trigger)

        if x.type == "wind" || x.event == "gale" {
            let gust = x.domain != "marine"   // MET warns land by the gusts, the sea by the mean wind
            let pr = gust
                ? engine.pairs(.wind, start: a) { StepAggregation.aggregate($0, .gust, a, b) }
                : engine.pairs(.wind, start: nil) { p in
                    let h = p.hourly[.windSpeed10m]
                    return JS.nn(Array(h[min(a, h.count)..<min(b, h.count)])).max()
                }
            guard !pr.isEmpty, let g = ConsensusEngine.wmean(pr) else { return nil }
            let conv = { (ms: Double) in windUnit.value(ms * 3.6) ?? ms }
            let r = Self.range(in: x.desc, unit: #"m\/s"#)
            self.init(kind: gust ? .gust : .wind, unit: Format.windUnit(windUnit), values: pr.map { windUnit.value($0.v) ?? $0.v },
                      glett: windUnit.value(g) ?? g, low: r.map { conv($0.0) }, high: r.map { conv($0.1) },
                      threshold: trig != nil && x.trigger.contains("m/s") ? conv(trig!) : nil)
            return
        }
        if x.type == "rain" || x.event == "rain" {
            let pr = engine.pairs(.precip, start: a) { StepAggregation.aggregate($0, .precip, a, b) }
            guard !pr.isEmpty, let g = ConsensusEngine.wmean(pr) else { return nil }
            let r = Self.range(in: x.desc, unit: "mm")
            self.init(kind: .rain, unit: "mm", values: pr.map(\.v), glett: g, low: r?.0, high: r?.1,
                      threshold: trig != nil && x.trigger.contains("mm") ? trig : nil)
            return
        }
        return nil
    }

    /// `parseFloat(String(v).replace(',', '.'))`: the number at the start of the text.
    static func leadingNumber(_ s: String) -> Double? {
        let t = s.replacingOccurrences(of: ",", with: ".").trimmingCharacters(in: .whitespaces)
        guard let m = t.range(of: #"^[+-]?(\d+\.?\d*|\.\d+)"#, options: .regularExpression) else { return nil }
        return Double(t[m])
    }

    /// `range(unit)` of js/app.js:2348-2353: "27-33 m/s" as (27, 33); else the smallest and largest single value given
    /// in that unit ("15 m/s, periodevis 17 m/s").
    static func range(in desc: String, unit: String) -> (Double, Double)? {
        let num = #"(\d+(?:[.,]\d+)?)"#
        func value(_ s: Substring) -> Double? { Double(s.replacingOccurrences(of: ",", with: ".")) }
        if let re = try? Regex(num + #"\s*[-–]\s*"# + num + #"\s*"# + unit),
           let m = try? re.firstMatch(in: desc),
           let lo = m.output[1].substring.flatMap(value), let hi = m.output[2].substring.flatMap(value) {
            return (lo, hi)
        }
        guard let re = try? Regex(num + #"\s*"# + unit) else { return nil }
        let all = desc.matches(of: re).compactMap { $0.output[1].substring.flatMap(value) }
        guard let lo = all.min(), let hi = all.max() else { return nil }
        return (lo, hi)
    }

    // MARK: The drawing's scale (`lmGaugeHtml`, js/app.js:2363-2378)

    /// The band: MET's range, or its trigger level alone.
    var bandLow: Double? { low ?? threshold }
    var bandHigh: Double? { high ?? threshold }

    /// The scale's step: 5 up to 40, 10 up to 100, else 50.
    var step: Double {
        let top = scaleTop
        return top <= 40 ? 5 : top <= 100 ? 10 : 50
    }
    private var scaleTop: Double { max(values.max() ?? 0, glett, bandHigh ?? 0, threshold ?? 0) * 1.12 }
    /// The scale's end, a whole step above everything shown.
    var scaleMax: Double { max(step, (scaleTop / step).rounded(.up) * step) }
    /// The middle tick.
    var scaleMid: Double { JS.round(scaleMax / 2 / step) * step }
    /// A value's place on the scale, 0…1.
    func position(_ v: Double) -> Double { JS.clamp(v / scaleMax) }

    /// "MET varsler 27–33" (`lm.aw.met`), nil without a band.
    var metLabel: String? {
        guard let lo = bandLow, let hi = bandHigh else { return nil }
        return L10n.t("lm.aw.met", ["r": lo == hi ? Self.f(lo) : "\(Self.f(lo))–\(Self.f(hi))"])
    }

    // MARK: The sentence under it (`lmGaugeVerdict`, js/app.js:2379-2386)

    enum Relation: String { case noBand, below, above, `in` }

    var relation: Relation {
        guard let lo = bandLow, let hi = bandHigh else { return .noBand }
        return glett < lo ? .below : glett > hi ? .above : .in
    }

    /// The bold lead ("Modellene støtter varselet:") and the rest ("kast 18–27 m/s, 9 av 13 over 20 m/s.").
    var verdict: (lead: String?, text: String) {
        let mn = values.min() ?? 0, mx = values.max() ?? 0
        var s = L10n.t("lm.aw.\(kind.rawValue)", ["r": "\(Self.f(mn))–\(Self.f(mx)) \(unit)"])
        if let thr = threshold {
            s += L10n.t("lm.aw.k", ["k": String(values.filter { $0 >= thr }.count), "n": String(values.count), "thr": Self.f(thr), "u": unit])
        }
        if relation == .noBand { return (nil, s.prefix(1).uppercased() + s.dropFirst() + ".") }
        return (L10n.t("lm.aw.\(relation.rawValue)"), s + ".")
    }

    /// `fmt(Math.round(v))`.
    static func f(_ v: Double) -> String { JS.fmt(JS.round(v)) }
}
