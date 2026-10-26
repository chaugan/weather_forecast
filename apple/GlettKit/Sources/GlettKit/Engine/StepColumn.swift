import Foundation

/// One column of the hour table: hours `a..<b` of the forecast (`columns()`, js/app.js:174-195).
public struct StepColumn: Sendable, Hashable, Identifiable {
    public var a: Int
    public var b: Int
    /// Index into `Forecast.dates`.
    public var day: Int
    /// The first step of its day.
    public var first: Bool
    /// "HH:MM" for 1 h steps, "HH–HH" for longer ones (local time, as the web labels them).
    public var label: String
    /// The local hour the step starts at.
    public var hour: Int
    /// The step is over.
    public var past: Bool
    /// The step holds the current hour.
    public var now: Bool
    /// The middle hour of the step is night (draw night icons).
    public var night: Bool
    /// The step's start as an instant (`colUnix`, js/app.js:230).
    public var start: Date

    public var id: Int { a }
    public var hours: Int { b - a }
}

extension Forecast {
    /// `columns(step, day)` of js/app.js:174-195: the whole week, or one day; `now` decides past/now.
    /// Like the web, a day is taken as 24 entries of the hourly axis.
    public func columns(step: Int = 1, day: Int? = nil, now: Date = Date()) -> [StepColumn] {
        let step = max(1, step)
        let nowStr = JS.isoUTC(now.timeIntervalSince1970 + Double(utcOffsetSeconds), 13)
        var cols: [StepColumn] = []
        let n = time.count
        for d in dates.indices {
            if let day, d != day { continue }
            let base = d * 24
            var s = 0
            while s < 24 {
                let a = base + s, b = min(base + s + step, n)
                if a >= n { break }
                let last = String(time[b - 1].prefix(13))
                let hourA = Int(time[a].dropFirst(11).prefix(2)) ?? 0
                let label = step > 1
                    ? "\(time[a].dropFirst(11).prefix(2))–\(String(format: "%02d", (hourA + step) % 24))"
                    : String(time[a].dropFirst(11).prefix(5))
                let mid = min(a + step / 2, b - 1)
                let startHour = String(time[a].prefix(13))
                let startUnix = JS.localToUnix(String(time[a].prefix(13)) + ":00", offset: utcOffsetSeconds)
                cols.append(StepColumn(a: a, b: b, day: d, first: s == 0, label: label, hour: hourA,
                                       past: last < nowStr, now: startHour <= nowStr && nowStr <= last,
                                       night: mid < isDay.count && isDay[mid] == 0, start: Date(timeIntervalSince1970: startUnix)))
                s += step
            }
        }
        return cols
    }

    /// `nowIdx()` of js/app.js:209: the index of the current local hour, -1 when outside the axis.
    public func nowIndex(now: Date = Date()) -> Int {
        let s = JS.isoUTC(now.timeIntervalSince1970 + Double(utcOffsetSeconds), 13)
        return time.firstIndex { $0.hasPrefix(s) } ?? -1
    }

    /// `todayIndex()` of js/app.js:196: today's index in `dates` (0 when today is not in the forecast).
    public func todayIndex(now: Date = Date()) -> Int {
        let s = JS.isoUTC(now.timeIntervalSince1970 + Double(utcOffsetSeconds), 10)
        return dates.firstIndex(of: s) ?? 0
    }
}
