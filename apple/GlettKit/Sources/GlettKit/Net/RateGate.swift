import Foundation

/// Open-Meteo's free limits kept by the device: a port of `OMGate` (js/omgate.js). Every Open-Meteo request is weighed
/// as Open-Meteo counts it and held while the last 60 s hold more than 500 of weight; a 429 says which limit was hit:
/// a minute is waited out and the request sent again (twice at most), an hour or a day is an error that later requests
/// share. With a `suiteName` the log is shared through that UserDefaults suite (the App Group), as the web shares it
/// between tabs through localStorage.
public actor RateGate {
    /// `MINUTE` (js/omgate.js:13): under 600 for the other things on the same connection.
    public static let minuteBudget = 500.0
    /// `WIN` (js/omgate.js:14), seconds.
    public static let window = 60.0
    /// The localStorage key of the web (`glett.om`), used as the UserDefaults key.
    public static let storageKey = "glett.om"

    /// The process-wide gate. On iOS and watchOS the log lives in the App Group, so the app and its widgets share one
    /// budget; on macOS (`swift test`) it stays in memory, which keeps the tests away from group containers.
    public static let shared: RateGate = {
        #if os(macOS)
        RateGate()
        #else
        RateGate(suiteName: AppGroup.identifier)
        #endif
    }()

    /// A wait the UI may announce (the web's `glett:omwait` event, `om.wait` {s}); `until == nil` when it is over.
    public struct Wait: Sendable { public var until: Date?; public var why: GlettError.Limit? }

    private struct State: Codable { var log: [[Double]] = []; var until: Double = 0; var why: String = "" }
    private var mem = State()
    private let suiteName: String?
    private let clock: @Sendable () -> Date
    private var onWait: (@Sendable (Wait) -> Void)?

    public init(suiteName: String? = nil, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.suiteName = suiteName
        self.clock = clock
    }

    /// Called whenever the gate starts or stops holding a request back.
    public func setWaitHandler(_ h: (@Sendable (Wait) -> Void)?) { onWait = h }

    // MARK: weight (js/omgate.js:20-30)

    /// `weight(url)`: locations × max(1, days ÷ 14) × max(1, variables × models ÷ 10); geocoding 1; elevation per location.
    public static func weight(_ url: URL) -> Double {
        let c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        func q(_ k: String) -> String? { c?.queryItems?.first { $0.name == k }?.value }
        func count(_ s: String?) -> Int { (s ?? "").split(separator: ",", omittingEmptySubsequences: true).count }
        let host = url.host ?? ""
        if host.contains("geocoding") { return 1 }
        let n = Double(max(1, count(q("latitude"))))
        if url.path.contains("elevation") { return n }
        let vars = ["hourly", "daily", "current", "minutely_15"].reduce(0) { $0 + count(q($1)) }
        let models = max(1, count(q("models")))
        var days = (jsNumber(q("forecast_days")).flatMap { $0 == 0 ? nil : $0 } ?? 7) + (jsNumber(q("past_days")).flatMap { $0 == 0 ? nil : $0 } ?? 0)
        if let a = q("start_date"), let b = q("end_date"), let ua = JS.parseISO(a), let ub = JS.parseISO(b) { days = max(1, (ub - ua) / 86400 + 1) }
        return n * max(1, days / 14) * max(1, Double(vars * models) / 10)
    }

    /// `+s` (empty → 0, not a number → NaN, here nil).
    private static func jsNumber(_ s: String?) -> Double? {
        guard let s else { return nil }
        let t = s.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return 0 }
        return Double(t)
    }

    /// `isOM(url)`: any host under open-meteo.com.
    public static func isOpenMeteo(_ url: URL) -> Bool {
        guard let h = url.host?.lowercased() else { return false }
        return h == "open-meteo.com" || h.hasSuffix(".open-meteo.com")
    }

    // MARK: the log

    private func load() {
        guard let suiteName, let d = UserDefaults(suiteName: suiteName)?.data(forKey: Self.storageKey),
              let s = try? JSONDecoder().decode(State.self, from: d) else { return }
        mem = s
    }
    private func save() {
        guard let suiteName, let d = try? JSONEncoder().encode(mem) else { return }
        UserDefaults(suiteName: suiteName)?.set(d, forKey: Self.storageKey)
    }
    private func prune(_ now: Double) { mem.log = mem.log.filter { $0.count == 2 && now - $0[0] < Self.window * 1000 } }
    private var used: Double { mem.log.reduce(0) { $0 + $1[1] } }

    /// The weight used in the last minute (for diagnostics and tests).
    public func usedWeight() -> Double { load(); prune(clock().timeIntervalSince1970 * 1000); return used }

    private func limitError(_ url: URL, _ why: GlettError.Limit) -> GlettError { .quota(host: url.host ?? "", limit: why) }

    /// `take(url)`: waits for room in the last minute, then writes this request's weight in the log.
    @discardableResult
    public func take(_ url: URL) async throws -> Double {
        let w = Self.weight(url)
        var told = false
        while true {
            try Task.checkCancellation()
            let now = clock().timeIntervalSince1970 * 1000
            load(); prune(now)
            if mem.until > now {
                let why = GlettError.Limit(rawValue: mem.why) ?? .minute
                if why != .minute { throw limitError(url, why) }
                onWait?(Wait(until: Date(timeIntervalSince1970: mem.until / 1000), why: .minute)); told = true
                try await Task.sleep(for: .milliseconds(Int(min(mem.until - now, 1000)) + 50))
                continue
            }
            let u = used
            // a request heavier than the whole minute goes alone: holding it back would never end
            if u == 0 || u + w <= Self.minuteBudget {
                mem.log.append([now, w]); save()
                if told { onWait?(Wait(until: nil, why: nil)) }
                return w
            }
            var s = u, at = now
            for x in mem.log { s -= x[1]; at = x[0] + Self.window * 1000; if s + w <= Self.minuteBudget { break } }
            onWait?(Wait(until: Date(timeIntervalSince1970: at / 1000), why: .minute)); told = true
            try await Task.sleep(for: .milliseconds(Int(min(at - now, 1000)) + 50))
        }
    }

    /// `refused(url, res)`: reads which limit a 429 names and remembers it.
    private func refused(_ data: Data) -> GlettError.Limit {
        let reason = HTTPClient.reason(data)
        func has(_ p: String) -> Bool { reason.range(of: p, options: [.regularExpression, .caseInsensitive]) != nil }
        let why: GlettError.Limit = has("minut") ? .minute : has("hour") ? .hour : has("day|daily") ? .day : .minute
        load()
        let now = clock().timeIntervalSince1970 * 1000
        mem.until = now + (why == .minute ? 61_000 : why == .hour ? 10 * 60_000 : 60 * 60_000)
        mem.why = why.rawValue
        save()
        return why
    }

    /// `gateFetch(url, doFetch)`: through the gate; a minute's 429 is retried up to twice.
    public func fetch(_ url: URL, _ doFetch: @Sendable () async throws -> (Data, HTTPURLResponse)) async throws -> (Data, HTTPURLResponse) {
        var tries = 0
        while true {
            try await take(url)
            let (data, res) = try await doFetch()
            if res.statusCode != 429 { return (data, res) }
            let why = refused(data)
            if why != .minute || tries >= 2 { throw limitError(url, why) }
            tries += 1
        }
    }
}

/// The App Group shared by the app, its widgets and the watch extension (brief §3.1).
public enum AppGroup {
    public static let identifier = "group.no.glett.shared"
}
