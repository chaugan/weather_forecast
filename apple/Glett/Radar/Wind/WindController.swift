import Foundation
import GlettKit
import Observation

/// The wind map, the "Vind" side of the radar map (js/windmap.js): MET Nordic's 10 m wind for the next 48 hours from
/// glett.no (`api/wind.php`), one hour at a time for the box on screen. Playing glides between the hours (u and v
/// blended); the slider snaps to whole hours. `WindOverlayView` draws it.
@MainActor @Observable
final class WindController {
    private(set) var meta: WindMeta?
    /// This hour to +48 h.
    private(set) var times: [Double] = []
    private(set) var index = 0
    /// 0…1 on the way to the next hour while playing.
    private(set) var tau = 0.0
    private(set) var isPlaying = false
    /// The hour on screen is loading.
    private(set) var loading = false
    /// "down" (MET or glett.no not answering) or "net", else nil.
    private(set) var error: String?
    /// The drawing changed (a new hour, a new box): the overlay redraws the colours.
    private(set) var revision = 0
    /// The wind read at a tapped spot, with where it was tapped (points in the map).
    private(set) var reading: (text: String, point: CGPoint)?

    var windUnit: WindUnit = .default
    @ObservationIgnored private let service: WeatherService
    @ObservationIgnored private var view: WindView?
    @ObservationIgnored private var frames: [String: WindFrame] = [:]
    @ObservationIgnored private var order: [String] = []
    @ObservationIgnored private var inflight: [String: Task<WindFrame?, Never>] = [:]
    @ObservationIgnored private var failedAt: [String: Date] = [:]
    @ObservationIgnored private var metaAt: Date?
    @ObservationIgnored private var playTask: Task<Void, Never>?
    @ObservationIgnored private var token = 0

    /// An hour takes this long while playing.
    static let hourSeconds = 1.1

    init(service: WeatherService = .shared) { self.service = service }

    // MARK: Showing

    /// Opens at the hour nearest `at` (now when nil); the hour loads once the map has told its view (`viewChanged`).
    func show(at: Double? = nil) {
        error = nil
        Task {
            guard await loadMeta(), let m = meta else { return }
            let (ts, i) = m.hours(want: at)
            times = ts
            index = i
            if view != nil { await seek(i) }
        }
    }

    /// The wind side closed: nothing plays.
    func hide() {
        stop()
        reading = nil
    }

    private func loadMeta() async -> Bool {
        if meta != nil, let at = metaAt, Date().timeIntervalSince(at) < 600 { return true }
        do {
            let m = try await service.glett.windMeta()
            if meta?.run != m.run { frames = [:]; order = [] }
            meta = m
            metaAt = Date()
            return true
        } catch {
            self.error = Self.kind(error)
            return false
        }
    }

    /// The map stopped moving: a new box when the visible part left the one fetched.
    func viewChanged(_ box: WindView, south: Double, west: Double, north: Double, east: Double) {
        reading = nil
        if let v = view, v.contains(south: south, west: west, north: north, east: east), v.fine == box.fine { revision += 1; return }
        view = box
        if !times.isEmpty { Task { await seek(index) } }
    }

    /// Shows hour i; a user's choice stops the playback.
    func seek(_ i: Int, byUser: Bool = false) async {
        guard !times.isEmpty else { return }
        if byUser { stop() }
        let i = min(times.count - 1, max(0, i))
        if i != index { reading = nil }
        index = i
        tau = 0
        token += 1
        let my = token
        if frame(i) == nil {
            loading = true
            let f = await load(i)
            guard my == token else { return }
            loading = false
            if f == nil { error = error ?? "net"; revision += 1; return }
        }
        error = nil
        revision += 1
        prefetch()
    }

    // MARK: Playing

    func play() {
        guard times.count > 1 else { return }
        if index >= times.count - 1 { index = 0; tau = 0 }
        isPlaying = true
        reading = nil
        playTask?.cancel()
        playTask = Task { [weak self] in
            var last = ContinuousClock.now
            while let self, !Task.isCancelled, self.isPlaying {
                try? await Task.sleep(for: .milliseconds(100))
                let now = ContinuousClock.now
                let dt = Double((now - last).components.attoseconds) / 1e18 + Double((now - last).components.seconds)
                last = now
                guard self.index + 1 < self.times.count else { self.stop(); return }
                if self.frame(self.index + 1) == nil {
                    if await self.load(self.index + 1) == nil { self.stop(); return }
                    last = ContinuousClock.now
                    continue
                }
                self.tau += dt / Self.hourSeconds
                if self.tau >= 1 {
                    self.tau = 0
                    self.index += 1
                    self.prefetch()
                    if self.index >= self.times.count - 1 { self.stop() }
                }
                self.revision += 1
            }
        }
    }

    func stop() {
        isPlaying = false
        playTask?.cancel()
        playTask = nil
        if tau != 0 { tau = 0; revision += 1 }
    }

    // MARK: Reading the wind

    /// The wind at a point now: the hour shown, or on the way to the next one while playing (m/s, u east, v north).
    nonisolated static func wind(_ a: WindFrame?, _ b: WindFrame?, tau: Double, lat: Double, lon: Double) -> (u: Double, v: Double)? {
        guard let x = a?.sample(lat: lat, lon: lon) else { return nil }
        guard tau > 0, let y = b?.sample(lat: lat, lon: lon) else { return x }
        return (x.u + (y.u - x.u) * tau, x.v + (y.v - x.v) * tau)
    }

    /// The frames to draw now.
    var drawing: (a: WindFrame?, b: WindFrame?, tau: Double) { (frame(index), tau > 0 ? frame(index + 1) : nil, tau) }

    /// A tap: "8 m/s fra vest" at that spot and hour, or nothing where there is no wind data.
    func read(lat: Double, lon: Double, at point: CGPoint) {
        let d = drawing
        guard let uv = Self.wind(d.a, d.b, tau: d.tau, lat: lat, lon: lon), index < times.count else { reading = nil; return }
        let speed = hypot(uv.u, uv.v)
        let dir = L10n.t("dir.\(WindGrid.compass8(WindGrid.from(u: uv.u, v: uv.v)))")
        let text = "\(speedText(speed)) \(Format.windUnit(windUnit)) \(L10n.t("wm.from", ["d": dir]))\n\(label(times[index]))"
        reading = (text, point)
    }

    func clearReading() { reading = nil }

    /// A speed in m/s in the chosen unit, as the web's `fmt(wv(…))`.
    func speedText(_ ms: Double) -> String { Format.wind(ms * 3.6, windUnit) }

    // MARK: Labels

    /// "i dag 15:00".
    func label(_ t: Double) -> String { "\(day(t)) \(clock(t))" }
    func clock(_ t: Double) -> String { Format.time(Date(timeIntervalSince1970: t)) }
    /// "i dag", "i morgen", "tor.".
    func day(_ t: Double) -> String {
        let d = Date(timeIntervalSince1970: t), cal = Calendar.current
        if cal.isDateInToday(d) { return L10n.t("today") }
        if cal.isDateInTomorrow(d) { return L10n.t("tomorrow") }
        return d.formatted(Date.FormatStyle(locale: L10n.locale).weekday(.abbreviated))
    }

    // MARK: Data

    private func key(_ t: Double, _ v: WindView) -> String {
        "\(meta?.run ?? "")|\(Int(t))|\(v.s),\(v.w),\(v.n),\(v.e),\(v.nx),\(v.ny)\(v.fine ? ",f" : "")"
    }

    private func frame(_ i: Int) -> WindFrame? {
        guard times.indices.contains(i), let v = view else { return nil }
        return frames[key(times[i], v)]
    }

    @discardableResult
    private func load(_ i: Int) async -> WindFrame? {
        guard times.indices.contains(i), let v = view, let m = meta else { return nil }
        let k = key(times[i], v)
        if let f = frames[k] { return f }
        if let at = failedAt[k], Date().timeIntervalSince(at) < 30 { return nil }   // a failed hour is not asked again for 30 s
        let task = inflight[k] ?? Task { [service] in
            do { return try await service.glett.windFrame(run: m.run, t: times[i], view: v) } catch { return nil }
        }
        inflight[k] = task
        let f = await task.value
        inflight[k] = nil
        if let f {
            frames[k] = f
            order.append(k)
            if order.count > 80 { frames[order.removeFirst()] = nil }
        } else {
            failedAt[k] = Date()
        }
        return f
    }

    /// The hour on screen and the next six (three when zoomed in), one after the other.
    private func prefetch() {
        let start = index, n = view?.fine == true ? 3 : 6
        Task {
            for k in 1...n where start + k < times.count { if await load(start + k) == nil { break } }
        }
    }

    private static func kind(_ e: any Error) -> String {
        // glett.no answers 503 when MET's thredds does not (js/windmap.js: `e.status === 503`)
        if let g = e as? GlettError, case .http(_, 503, _) = g { return "down" }
        return "net"
    }
}
