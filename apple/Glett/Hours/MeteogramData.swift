import GlettKit
import SwiftUI

/// One step of the meteogram (`dayStats(d)`, js/app.js:647-656, at the chosen step): the consensus, cloud cover and
/// the radar amount where MET's radar covers the step.
struct MeteogramPoint: Identifiable {
    let index: Int
    let step: StepConsensus
    /// Weighted mean cloud cover, %.
    let cloud: Double?
    /// Radar millimetres in the step (`radarForCol`, js/app.js:231), nil outside radar time or with model data.
    let radar: Double?
    /// Radar disagrees with the models here (`radarBadge(c) !== ''`, js/app.js:670): outlined in amber.
    let radarDisagrees: Bool

    var id: Int { index }
    var column: StepColumn { step.column }
}

/// The week's points and the shared scales, so every day of the meteogram draws on the same axes.
struct MeteogramData {
    let points: [MeteogramPoint]
    /// Index ranges of `points` per day, in order.
    let days: [(day: Int, range: Range<Int>)]
    let temperature: ClosedRange<Double>
    let rainTop: Double
    /// Top of the wind axis in the chosen unit.
    let windTop: Double
    let unit: WindUnit

    /// The temperature axis (js/app.js:663): one degree of room around the values, at least 6 degrees.
    static let minTemperatureSpan = 6.0
    /// The wind axis reaches at least 10 m/s (36 km/h) so a calm week does not look stormy.
    static let minWindTopKmh = 36.0

    init(table: HourTable, nowcast: NowcastSeries?, unit: WindUnit) {
        let e = table.engine
        self.unit = unit
        points = table.columns.enumerated().map { i, c in
            let s = e.step(c)
            let r = RadarBadge.radar(for: c, nowcast: nowcast)
            return MeteogramPoint(index: i, step: s, cloud: e.mean(.cloudCover, c), radar: r?.mm,
                                  radarDisagrees: RadarBadge.badge(for: c, nowcast: nowcast, rainChance: s.rainChance) != nil)
        }
        var days: [(Int, Range<Int>)] = []
        for (i, p) in points.enumerated() {
            if let last = days.last, last.0 == p.column.day { days[days.count - 1].1 = last.1.lowerBound..<(i + 1) } else { days.append((p.column.day, i..<(i + 1))) }
        }
        self.days = days.map { (day: $0.0, range: $0.1) }

        // The web scales each day by the models' lowest and highest value (js/app.js:662-663). Over a week one outlier
        // model would flatten every day, so the week's axis follows the mean ± the models' spread; a rarer outlier
        // clips the band at the edge instead.
        let temps = points.flatMap { p -> [Double] in
            guard let t = p.step.temperature else { return [] }
            let sd = p.step.temperatureSpread ?? 0
            return [t - sd, t + sd]
        }
        var lo = ((temps.min() ?? 0) - 1).rounded(.down), hi = ((temps.max() ?? 10) + 1).rounded(.up)
        if hi - lo < Self.minTemperatureSpan { hi = lo + Self.minTemperatureSpan }
        temperature = lo...hi
        // js/app.js:667 `rMax = max(1, wettest model, radar)`
        rainTop = max(1, points.compactMap(\.step.precipitationMax).max() ?? 0, points.compactMap(\.radar).max() ?? 0)
        let gustTop = points.compactMap { $0.step.gust ?? $0.step.wind }.max() ?? 0
        windTop = unit.value(max(Self.minWindTopKmh, gustTop * 1.1)) ?? 10
    }

    /// The three temperature grid lines (js/app.js:678): bottom, middle, top.
    var temperatureTicks: [Double] {
        [temperature.lowerBound, ((temperature.lowerBound + temperature.upperBound) / 2).rounded(), temperature.upperBound]
    }

    /// The point index of the current step, if it is in the forecast.
    var nowIndex: Int? { points.firstIndex { $0.column.now } }
}

/// Heights of the meteogram's rows and the column width, shared by the day charts and the pinned axis.
struct MeteogramLayout {
    var column: CGFloat
    var header: CGFloat = 26
    var hours: CGFloat = 18
    var icon: CGFloat = 30
    var agree: CGFloat = 16
    var strip: CGFloat = 10
    var temperature: CGFloat = 150
    var rain: CGFloat = 64
    var wind: CGFloat = 58
    var arrows: CGFloat = 34
    var cloud: CGFloat = 38

    /// Column width at least these by step; wider when a day fits the view (`CW`, js/app.js:635, 723).
    static let minColumn: [Int: CGFloat] = [1: 44, 3: 50, 6: 60, 12: 84]

    static func column(step: Int, viewport: CGFloat) -> CGFloat {
        let minW = minColumn[step] ?? 44
        guard viewport > 0 else { return minW }
        return max(minW, (viewport / CGFloat(24 / max(1, step))).rounded(.down))
    }

    /// The rows under the day header, top to bottom (night shading and the cursor cover these).
    var body: CGFloat { hours + icon + agree + strip + temperature + rain + wind + arrows + cloud }
}

/// One day of the meteogram: its points, plus the neighbours either side so lines run on across the day border
/// (drawn outside the day's x domain and clipped).
struct MeteogramSlice {
    let day: Int
    let points: [MeteogramPoint]
    let before: MeteogramPoint?
    let after: MeteogramPoint?

    init(data: MeteogramData, day: Int, range: Range<Int>) {
        self.day = day
        points = Array(data.points[range])
        before = range.lowerBound > 0 ? data.points[range.lowerBound - 1] : nil
        after = range.upperBound < data.points.count ? data.points[range.upperBound] : nil
    }

    var count: Int { points.count }
    var firstIndex: Int { points.first?.index ?? 0 }

    /// x of a point on the day's axis `0...count`: the middle of its column.
    func x(_ p: MeteogramPoint) -> Double { Double(p.index - firstIndex) + 0.5 }

    /// The day's points with the neighbours, for lines and bands.
    var continuous: [MeteogramPoint] { [before].compactMap { $0 } + points + [after].compactMap { $0 } }

    var domain: ClosedRange<Double> { 0...Double(max(1, count)) }
}
