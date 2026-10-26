import Foundation

/// "Neste glett": the nowcast line of the now card (js/app.js:954-964), as data. The widgets and the Live Activity show this.
public struct NextGlett: Sendable, Hashable {
    public enum Kind: Sendable, Hashable {
        /// Raining now, dry from `at` (`nc.wet.now` {h}).
        case wetUntil(Date)
        /// Rain through the whole series (`nc.wet.all`).
        case wetAll
        /// Dry now, rain from `at` (`nc.dry.now` {h}).
        case dryUntil(Date)
        /// Mostly dry, one short wet step at `at` (`nc.dry.blip` {h}).
        case blip(Date)
        /// Dry through the whole series (`nc.dry.all`).
        case dryAll
    }
    public var kind: Kind
    /// It is wet at the first step (≥ 0.1 mm/h).
    public var wetNow: Bool
    /// The series is Open-Meteo's model fallback, not radar (`nc.model`, source `nc.src.model` instead of `nc.src`).
    public var model: Bool

    /// The sentence's key (`nc.wet.now`, `nc.wet.all`, `nc.dry.now`, `nc.dry.blip`, `nc.dry.all`); the label is `nc.label`.
    public var key: String {
        switch kind {
        case .wetUntil: "nc.wet.now"
        case .wetAll: "nc.wet.all"
        case .dryUntil: "nc.dry.now"
        case .blip: "nc.dry.blip"
        case .dryAll: "nc.dry.all"
        }
    }
    /// The time for `{h}`, when the sentence has one.
    public var time: Date? {
        switch kind {
        case .wetUntil(let d), .dryUntil(let d), .blip(let d): d
        default: nil
        }
    }

    /// The precipitation rate that counts as wet (mm/h).
    public static let wetRate = 0.1

    /// js/app.js:955-963. A change needs two steps in a row on the other side (or the last step), so a lone wet step is a blip.
    public static func evaluate(_ nc: NowcastSeries?, now: Date = Date()) -> NextGlett? {
        guard let nc, !nc.series.isEmpty else { return nil }
        let nowS = now.timeIntervalSince1970
        let s = nc.series.filter { $0.t >= nowS - 300 }
        guard let s0 = s.first else { return nil }
        func wet(_ p: NowcastPoint) -> Bool { p.rate >= wetRate }
        let rainingNow = wet(s0)
        var change = -1
        for i in 1..<max(1, s.count) where wet(s[i]) != rainingNow && (i + 1 >= s.count || wet(s[i + 1]) != rainingNow) { change = i; break }
        let blip = !rainingNow && change <= 0 ? s.first(where: wet) : nil
        let kind: Kind
        if rainingNow { kind = change > 0 ? .wetUntil(s[change].date) : .wetAll }
        else { kind = change > 0 ? .dryUntil(s[change].date) : blip.map { .blip($0.date) } ?? .dryAll }
        return NextGlett(kind: kind, wetNow: rainingNow, model: nc.model)
    }
}

/// MET's 90-minute nowcast for the place in one line (`lmHereLine`, js/app.js:2439-2444): the first change within 19 steps.
public struct NowcastHere: Sendable, Hashable {
    public var wetNow: Bool
    /// The first step on the other side, if any within 90 minutes.
    public var flip: Date?
    /// `lm.radar.here.until|from|on|dry` {h}.
    public var key: String {
        flip != nil ? (wetNow ? "lm.radar.here.until" : "lm.radar.here.from") : (wetNow ? "lm.radar.here.on" : "lm.radar.here.dry")
    }

    public static func evaluate(_ nc: NowcastSeries?, now: Date = Date()) -> NowcastHere? {
        guard let nc, !nc.series.isEmpty else { return nil }
        let nowS = now.timeIntervalSince1970
        let s = Array(nc.series.filter { $0.t >= nowS - 300 }.prefix(19))
        guard let s0 = s.first else { return nil }
        let w = s0.rate >= NextGlett.wetRate
        return NowcastHere(wetNow: w, flip: s.first { ($0.rate >= NextGlett.wetRate) != w }?.date)
    }
}

/// The "Radar neste 2 timer" strip (`renderRadarStrip`, js/app.js:1239-1258) as data.
public struct RadarStrip: Sendable {
    public enum Status: Sendable, Hashable {
        /// `radar.none`.
        case none
        /// `radar.total` {mm}.
        case total(Double)
        /// `radar.blip` {h}.
        case blip(Date)
    }
    /// The bars: 5-minute radar steps (24) or 15-minute model steps (8).
    public var points: [NowcastPoint]
    /// Seconds per bar (300 radar, 900 model).
    public var stepSeconds: Double
    /// The scale's top (mm/h): 0.25, 0.5, 1, 2, 5, 10 or the next 10 above the peak.
    public var top: Double
    public var total: Double
    public var status: Status
    public var model: Bool
    /// "Rain nearby" from the ring, within the strip's window.
    public var nearby: RadarNearby?

    /// Bar intensity (js/app.js:1249): "heavy" ≥ 4, "mod" ≥ 1, "wet" ≥ 0.1 mm/h, else nil.
    public static func intensity(_ rate: Double) -> String? { rate >= 4 ? "heavy" : rate >= 1 ? "mod" : rate >= 0.1 ? "wet" : nil }
    /// `radarWord(r)` (js/app.js:1238): `radar.w.none|light|moderate|heavy`.
    public static func wordKey(_ rate: Double) -> String {
        rate < 0.1 ? "radar.w.none" : rate < 1 ? "radar.w.light" : rate < 4 ? "radar.w.moderate" : "radar.w.heavy"
    }

    /// nil when there is too little ahead to draw (fewer than 6 radar or 4 model steps).
    public static func make(_ nc: NowcastSeries?, now: Date = Date()) -> RadarStrip? {
        guard let nc, !nc.series.isEmpty else { return nil }
        let model = nc.model, stepS: Double = model ? 900 : 300
        let nowS = now.timeIntervalSince1970
        let pts = Array(nc.series.filter { $0.t >= nowS - stepS }.prefix(model ? 8 : 24))
        guard pts.count >= (model ? 4 : 6) else { return nil }
        let peak = pts.map(\.rate).max()!
        let top = [0.25, 0.5, 1, 2, 5, 10].first { peak <= $0 } ?? (peak / 10).rounded(.up) * 10
        let total = pts.reduce(0) { $0 + $1.rate * stepS / 3600 }
        let wetPts = pts.filter { $0.rate >= 0.1 }
        let status: Status = wetPts.isEmpty ? .none : total >= 0.1 ? .total(total) : .blip(wetPts[0].date)
        return RadarStrip(points: pts, stepSeconds: stepS, top: top, total: total, status: status, model: model,
                          nearby: RadarNearby.evaluate(nc, from: pts[0].t, to: pts[pts.count - 1].t))
    }
}

/// "Nedbør i nærheten" (`radarNearby`, js/app.js:1276-1285): wet ring points 5 km out within a window.
public struct RadarNearby: Sendable, Hashable {
    /// The wet directions in ring order ("n", "ne", …; `dir.<x>`).
    public var directions: [String]
    /// Six or more directions: `radar.near.all` instead of the list.
    public var all: Bool
    public var from: Date
    public var to: Date
    /// Under 10 minutes apart: `radar.near.at` {h}, else `radar.near.span` {a} {b}.
    public var single: Bool
    public var km: Double

    public static func evaluate(_ nc: NowcastSeries, from t0: Double, to t1: Double) -> RadarNearby? {
        let hits = nc.ring.map { r in (r.dir, r.series.filter { $0.t >= t0 && $0.t <= t1 && $0.rate >= 0.1 }) }.filter { !$0.1.isEmpty }
        guard !hits.isEmpty else { return nil }
        let ts = hits.flatMap { $0.1.map(\.t) }
        let a = ts.min()!, b = ts.max()!
        return RadarNearby(directions: hits.map(\.0), all: hits.count >= 6, from: Date(timeIntervalSince1970: a), to: Date(timeIntervalSince1970: b),
                           single: b - a < 600, km: nc.km == 0 ? 5 : nc.km)
    }
}

/// The radar badge of an hour column when radar and models disagree (`radarForCol` / `radarBadge`, js/app.js:231-244).
public enum RadarBadge: Sendable, Hashable {
    /// Radar sees rain the models miss: `radar.badge.rain` {mm}.
    case rain(mm: Double)
    /// Radar dry where the models say rain: `radar.badge.dry`.
    case dry

    /// Radar millimetres and coverage for a step; nil with model data or under 20 minutes of radar in the step.
    public static func radar(for c: StepColumn, nowcast nc: NowcastSeries?) -> (mm: Double, cover: Double)? {
        guard let nc, !nc.model, !nc.series.isEmpty else { return nil }
        let t0 = c.start.timeIntervalSince1970, t1 = t0 + Double(c.b - c.a) * 3600
        let pts = nc.series.filter { $0.t >= t0 && $0.t < t1 }
        guard pts.count >= 4 else { return nil }
        return (pts.reduce(0) { $0 + $1.rate * 5 / 60 }, Double(pts.count) * 5 / 60 / Double(c.b - c.a))
    }

    public static func badge(for c: StepColumn, nowcast: NowcastSeries?, rainChance chance: Double?) -> RadarBadge? {
        guard let r = radar(for: c, nowcast: nowcast) else { return nil }
        if r.mm >= 0.2 && (chance == nil || chance! < 0.35) { return .rain(mm: r.mm) }
        if r.mm < 0.05, let chance, chance >= 0.6, r.cover >= 0.75 { return .dry }
        return nil
    }
}
