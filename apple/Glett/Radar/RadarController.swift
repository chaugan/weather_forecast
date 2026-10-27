import Foundation
import GlettKit
import MapKit
import Observation

/// One radar frame (js/app.js:2532): an observed MET slot, a step of MET's radar nowcast (`fc`), or a RainViewer frame.
struct RadarFrame: Identifiable, Hashable, Sendable {
    /// Unix seconds.
    var t: Double
    /// MET: the slot name ("20261025T143500Z"), or "nc:<issue>:<t>" for a nowcast step. RainViewer: the tile path.
    var key: String
    /// A nowcast step (ahead of the newest observed frame).
    var fc = false
    /// The nowcast issue (`rmSlotName`) the step belongs to.
    var issueKey: String?
    var met: Bool
    /// A tile has loaded.
    var ok = false
    /// Every tile failed before one loaded: the slot is not published (yet).
    var bad = false

    var id: String { key }
    var date: Date { Date(timeIntervalSince1970: t) }
}

/// The radar map's frames and playback (`rmRefresh`, `rmLayerFor`, `rmWindow`, `rmSeek`, `rmPlay`; js/app.js:2512-2636).
/// One layer on the map draws the shown frame (`RadarRenderer`); nothing is interpolated or extrapolated. The shown
/// frame's tiles load first, then the next frames'; a frame whose tiles all fail is dropped, and a nowcast issue that
/// is not published yet falls back to the previous one.
@MainActor @Observable
final class RadarController {
    let lat: Double
    let lon: Double
    /// MET's composite (the Nordic area), else RainViewer.
    let met: Bool

    private(set) var frames: [RadarFrame] = []
    /// The shown frame, -1 before any.
    private(set) var index = -1
    private(set) var isPlaying = false
    /// The radar source does not answer (`rm.down`, js/app.js:2606): no frames, the map says so over the base map, and
    /// `probe()` checks once a minute whether it is back.
    private(set) var down = false
    /// The app is in the foreground (the probe rests otherwise, as the web's does on a hidden page).
    var active = true
    private(set) var lastRefresh: Date?

    /// 12 observed frames with room, else 7 (`RM.n()`); set by the view from its width.
    var wide = false
    /// No autoplay with Reduce Motion (`lmReduced`, js/app.js:1884).
    var reduceMotion = false
    /// The radar's opacity (`RM.alpha()`); set by the view from the colour scheme.
    var alpha = RadarConfig.alpha(dark: false) {
        didSet { if alpha != oldValue { renderer?.alpha = alpha; renderer?.setNeedsDisplay() } }
    }
    /// The radar side is shown (not the wind's): hidden, it stops playing and draws nothing.
    var shown = true {
        didSet {
            guard shown != oldValue else { return }
            // the layer draws nothing while hidden (MapKit kept drawing it at a changed opacity)
            renderer?.display(shown ? current.map(source) : nil)
            if !shown { stop() }
        }
    }

    @ObservationIgnored private weak var mapView: MKMapView?
    /// The radar's one overlay and what draws it.
    @ObservationIgnored let layer = RadarLayer()
    @ObservationIgnored private var renderer: RadarRenderer?
    @ObservationIgnored private lazy var store = RadarTileStore { [weak self] key, ok in self?.tile(key, ok) }
    @ObservationIgnored private var showTask: Task<Void, Never>?
    @ObservationIgnored private var ncBad: Set<String> = []
    @ObservationIgnored private var playTask: Task<Void, Never>?
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var token = 0
    @ObservationIgnored private var autoplayPending = false
    @ObservationIgnored private var rvHost = RadarConfig.rvHost
    /// An observed (not nowcast) frame has loaded a tile (`rm.obsOk`).
    @ObservationIgnored private var obsOk = false
    /// A check is running (`rm.checking`); one at a time.
    @ObservationIgnored private var checking = false

    init(lat: Double, lon: Double) {
        self.lat = lat
        self.lon = lon
        met = RadarConfig.inNordic(lat: lat, lon: lon)
    }

    /// The map the radar goes on (set once by `RadarMap`).
    func attach(_ map: MKMapView) {
        mapView = map
        map.addOverlay(layer, level: .aboveLabels)
    }

    /// The renderer for `layer` (the map's delegate asks once).
    func makeRenderer() -> RadarRenderer {
        let r = RadarRenderer(layer: layer, store: store)
        r.alpha = alpha
        renderer = r
        r.display(shown ? current.map(source) : nil)
        return r
    }

    /// The map moved or zoomed: other tiles are on screen.
    func mapMoved() { plan() }

    /// The newest observed frame (`rmLastObs`), -1 when there is none.
    var lastObserved: Int { frames.lastIndex { !$0.fc } ?? -1 }

    var current: RadarFrame? { frames.indices.contains(index) ? frames[index] : nil }

    /// Minutes since the newest observed frame.
    func age(now: Date) -> Double? {
        let l = lastObserved
        return l >= 0 ? (now.timeIntervalSince1970 - frames[l].t) / 60 : nil
    }

    // MARK: Frames

    /// `rmRefresh`: build or top up the frame list. MET slots every 5 minutes back from a few minutes ago plus the newest
    /// nowcast issue's steps after them; RainViewer's published frames elsewhere.
    func refresh(now: Date = Date()) async {
        guard !refreshing, !down else { return }
        refreshing = true
        defer { refreshing = false }
        token += 1
        let tok = token
        let n = RadarConfig.frameCount(wide: wide)
        var wanted: [RadarFrame] = []
        if met {
            let slot = (now.timeIntervalSince1970 / 300).rounded(.down) * 300 - RadarConfig.lagMinutes * 60
            for i in (0..<(n + 2)).reversed() {
                let t = slot - Double(i) * 300
                wanted.append(RadarFrame(t: t, key: RadarConfig.slotName(t), met: true))
            }
            var issue = slot
            while ncBad.contains(RadarConfig.slotName(issue)) && slot - issue < 6 * 300 { issue -= 300 }
            let issueKey = RadarConfig.slotName(issue)
            if !ncBad.contains(issueKey) {
                for k in 1...RadarConfig.ncSteps {
                    let tt = issue + Double(k) * 300
                    if tt > slot { wanted.append(RadarFrame(t: tt, key: "nc:\(issueKey):\(Int(tt))", fc: true, issueKey: issueKey, met: true)) }
                }
            }
        } else {
            let meta = await RainViewerFrames.shared.frames(now: now)
            guard tok == token else { return }
            guard let meta, meta.host == RadarConfig.rvHost else { goDown(); return }   // the frame list itself is missing
            rvHost = meta.host
            wanted = meta.frames.suffix(n).map { RadarFrame(t: $0.t, key: $0.path, met: false) }
        }
        lastRefresh = now

        var have: [String: RadarFrame] = [:]
        for f in frames { have[f.key] = f }
        var next: [RadarFrame] = []
        for w in wanted {
            if let f = have[w.key] { if !f.bad { next.append(f) } } else { next.append(w) }
        }
        let first = have.isEmpty
        let wasLast = index < 0 || index == lastObserved, kept = index, shown = current?.key
        frames = next
        // the shown frame keeps showing where it now is in the list
        index = shown.flatMap { k in frames.firstIndex { $0.key == k } } ?? -1
        let nowLast = lastObserved
        let target = wasLast ? (nowLast >= 0 ? nowLast : frames.count - 1) : min(max(0, index >= 0 ? index : kept), frames.count - 1)
        if index >= 0, target != index, !isPlaying { showWhenWhole(target) } else { seek(target) }
        if first && !reduceMotion { autoplay(tok) }
    }

    /// A new newest frame after a refresh shows once its tiles are in (or after `tileWait`), so the map does not go
    /// empty while they load; unless the user or the playback has moved on.
    private func showWhenWhole(_ i: Int) {
        guard frames.indices.contains(i), let from = current?.key else { return }
        let key = frames[i].key
        plan(first: i)
        showTask?.cancel()
        showTask = Task { [weak self] in
            let start = ContinuousClock.now
            while let self, !Task.isCancelled, let k = self.frames.firstIndex(where: { $0.key == key }), !self.isWhole(k),
                  !self.frames[k].bad, ContinuousClock.now - start < RadarConfig.tileWait {
                try? await Task.sleep(for: .milliseconds(100))
            }
            guard let self, !Task.isCancelled, !self.isPlaying, self.current?.key == from,
                  let k = self.frames.firstIndex(where: { $0.key == key }) else { return }
            self.seek(k)
        }
    }

    /// First load: play once the newest observed frame is whole, or after 3 s (js/app.js:2553-2556). A refresh in between
    /// (a nowcast issue that is not out yet) does not cancel it; the user's own choice of frame does.
    private func autoplay(_ tok: Int) {
        autoplayPending = true
        Task { [weak self] in
            let start = ContinuousClock.now
            while let self, self.autoplayPending, !self.isPlaying {
                guard self.shown else { try? await Task.sleep(for: .milliseconds(300)); continue }   // the wind side is open
                let l = self.lastObserved
                if (l >= 0 && self.isWhole(l)) || ContinuousClock.now - start > .seconds(3) {
                    self.autoplayPending = false
                    self.play(loops: RadarConfig.loops)
                    return
                }
                try? await Task.sleep(for: .milliseconds(150))
            }
        }
    }

    private func clear() {
        stop()
        showTask?.cancel()
        frames = []
        index = -1
        store.cancelAll()
        renderer?.display(nil)
    }

    // MARK: Tiles

    /// Where frame f's tiles come from: MET's composite or nowcast as WMS, or RainViewer's tiles.
    private func source(_ f: RadarFrame) -> RadarSource {
        let met = Dictionary(RadarConfig.metParams, uniquingKeysWith: { a, _ in a })
        if f.met, f.fc, let issue = f.issueKey {
            return RadarSource(key: f.key, kind: .wms(base: RadarConfig.ncBase + RadarConfig.ncFile(issue),
                                                      params: met.merging(["time": JS.isoUTC(f.t)]) { _, b in b }),
                               maxZoom: RadarConfig.metMaxZoom, levelsUp: 2)
        } else if f.met {
            return RadarSource(key: f.key, kind: .wms(base: RadarConfig.metBase + RadarConfig.metFile(f.key), params: met),
                               maxZoom: RadarConfig.metMaxZoom, levelsUp: 2)
        }
        return RadarSource(key: f.key, kind: .xyz(RadarConfig.rvTile(rvHost, f.key)), maxZoom: RadarConfig.rvMaxZoom, levelsUp: 0)
    }

    /// The tiles of `s` the map shows now.
    private func visibleTiles(_ s: RadarSource) -> [RadarTile] {
        guard let map = mapView, map.bounds.width > 0 else { return [] }
        let r = map.wholeMapRect
        guard r.size.width > 0 else { return [] }
        return RadarTiles.tiles(covering: r, z: RadarTiles.zoom(s, zoomScale: MKZoomScale(map.bounds.width / r.size.width)))
    }

    /// `rmWindow`, for every frame: the tiles on screen of frame `first` (the shown one by default) load first, then
    /// the frames after it in playing order. MET's server is HTTP/1.1; asked for all at once, the shown frame would
    /// wait behind the others.
    private func plan(first: Int? = nil) {
        let n = frames.count
        guard n > 0, mapView != nil else { return }
        let start = min(n - 1, max(0, first ?? (index >= 0 ? index : lastObserved)))
        let order = [start] + (index >= 0 && index != start ? [index] : []) + (1..<n).map { (start + $0) % n }
        var seen = Set<Int>(), wanted: [(RadarSource, RadarTile)] = []
        for i in order where seen.insert(i).inserted && !frames[i].bad {
            let s = source(frames[i])
            wanted += visibleTiles(s).map { (s, $0) }
        }
        store.plan(wanted)
    }

    /// Frame i's tiles on screen are all in (or refused): it shows whole rather than as a patchwork.
    private func isWhole(_ i: Int) -> Bool {
        guard frames.indices.contains(i) else { return false }
        let s = source(frames[i]), tiles = visibleTiles(s)
        return !tiles.isEmpty && tiles.allSatisfy { store.isDone(s, $0) }
    }

    /// A tile's outcome: the frame is there, or (when nothing of it loaded) it is dropped (`tileload`/`tileerror`).
    private func tile(_ key: String, _ ok: Bool) {
        renderer?.loaded(key)
        guard let i = frames.firstIndex(where: { $0.key == key }) else { return }
        if ok {
            if !frames[i].ok { frames[i].ok = true }
            if !frames[i].fc { obsOk = true }
            return
        }
        guard !frames[i].ok, !frames[i].bad else { return }
        frames[i].bad = true
        if frames[i].fc, let issue = frames[i].issueKey { dropIssue(issue); return }
        if !obsOk { check() }   // no past image has loaded yet: late, or down?
        drop(at: i)
    }

    /// `rmDropIssue`: a nowcast issue that is not published yet; its steps go and the refresh takes the previous issue.
    private func dropIssue(_ issue: String) {
        guard !ncBad.contains(issue) else { return }
        ncBad.insert(issue)
        let shown = current?.key
        frames.removeAll { $0.fc && $0.issueKey == issue }
        index = shown.flatMap { k in frames.firstIndex { $0.key == k } } ?? -1
        if index < 0 { seek(lastObserved >= 0 ? lastObserved : frames.count - 1) } else { plan() }
        Task { await refresh() }
    }

    /// `rmDrop`: a slot whose tiles all fail (not published yet, or missing) leaves the sequence.
    private func drop(at i: Int) {
        let shown = current?.key
        frames.remove(at: i)
        index = shown.flatMap { k in frames.firstIndex { $0.key == k } } ?? -1
        if index < 0 { seek(lastObserved >= 0 ? lastObserved : frames.count - 1) } else { plan() }
    }

    // MARK: Outage

    /// `rmCheck`: an observed frame failed before any observed tile loaded. One small image from a slot that is surely
    /// published tells lateness (carry on) from an outage. Nowcast steps loading do not count: the map is about the radar seen.
    private func check() {
        guard !checking, !down else { return }
        checking = true
        Task {
            let ok = await tryOne()
            checking = false
            if ok { obsOk = true } else if !obsOk { goDown() }
        }
    }

    /// `rmProbe`: while down, the same check; the view calls it once a minute while the map is shown and the app active.
    func probe() async {
        guard down, active, !checking else { return }
        checking = true
        let ok = await tryOne()
        checking = false
        if ok && down { goUp() }
    }

    /// `rmDown`: playback stops, every frame goes from the map, no more frame requests.
    private func goDown() {
        guard !down else { return }
        down = true
        token += 1
        clear()
    }

    /// `rmUp`: the source answers again; the frames load as on first open.
    private func goUp() {
        down = false
        obsOk = false
        ncBad = []
        Task { await refresh() }
    }

    /// `rmTry` (js/app.js:2620): MET's composite for the slot 20 minutes back, 64 px over the place ± 20 km; outside the
    /// Nordic area RainViewer's newest listed frame, one 512 px tile at z 6. A missing frame list counts as a failure.
    private func tryOne(now: Date = Date()) async -> Bool {
        let url: URL
        if met {
            let slot = (now.timeIntervalSince1970 / 300).rounded(.down) * 300 - 20 * 60
            let h = RadarTiles.halfWorld, r = 20_000.0
            let x = lon * h / 180, y = log(tan(.pi / 4 + lat * .pi / 360)) * h / .pi
            var c = URLComponents(string: RadarConfig.metBase + RadarConfig.metFile(RadarConfig.slotName(slot)))!
            c.queryItems = RadarConfig.metParams.map { URLQueryItem(name: $0.0, value: $0.1) } + [
                URLQueryItem(name: "crs", value: "EPSG:3857"),
                URLQueryItem(name: "width", value: "64"), URLQueryItem(name: "height", value: "64"),
                URLQueryItem(name: "bbox", value: [x - r, y - r, x + r, y + r].map { String(format: "%.6f", $0) }.joined(separator: ",")),
            ]
            url = c.url!
        } else {
            guard let meta = await RainViewerFrames.shared.frames(now: now), meta.host == RadarConfig.rvHost,
                  let newest = meta.frames.last else { return false }
            // Leaflet's latLngToPoint at z 6 (256 px world) divided into 512 px tiles
            let z = 6, n = Double(1 << z) * 256 / 512, s = sin(lat * .pi / 180)
            let tx = Int(((lon + 180) / 360 * n).rounded(.down))
            let ty = Int(((0.5 - log((1 + s) / (1 - s)) / (4 * .pi)) * n).rounded(.down))
            url = URL(string: RadarConfig.rvTile(meta.host, newest.path).replacingOccurrences(of: "{z}", with: String(z))
                .replacingOccurrences(of: "{x}", with: String(tx)).replacingOccurrences(of: "{y}", with: String(ty)))!
        }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (_, response) = try? await RadarConfig.session.data(for: req), let http = response as? HTTPURLResponse else { return false }
        return http.statusCode == 200 && (http.mimeType?.hasPrefix("image/") ?? false)
    }

    // MARK: Time

    /// `rmSeek(i, byUser)`: show frame i; a user's choice stops the playback.
    func seek(_ i: Int, byUser: Bool = false) {
        let n = frames.count
        guard n > 0 else { return }
        let i = min(n - 1, max(0, i))
        if i != index {
            index = i
            if shown { renderer?.display(source(frames[i])) }
        }
        plan()
        if byUser { autoplayPending = false; stop() }
    }

    /// `rmPlay(loops)`: step through the frames, waiting up to 2.5 s for all of the next frame's tiles, holding on the newest
    /// observed and the last frame; after `loops` rounds it rests on the newest observed frame.
    func play(loops: Int = .max) {
        stop()
        guard frames.count > 1 else { return }
        isPlaying = true
        playTask = Task { [weak self] in
            guard let first = self else { return }
            var done = 0
            try? await Task.sleep(for: first.index == first.frames.count - 1 ? RadarConfig.hold : RadarConfig.step)
            while let self, !Task.isCancelled {
                let n = self.frames.count
                guard n > 1 else { break }
                let i = (self.index + 1) % n
                let start = ContinuousClock.now
                while !Task.isCancelled, i < self.frames.count, !self.isWhole(i), !self.frames[i].bad,
                      ContinuousClock.now - start < RadarConfig.tileWait {
                    try? await Task.sleep(for: .milliseconds(150))
                }
                guard !Task.isCancelled, self.frames.count > 1 else { break }
                let m = self.frames.count, j = min(i, m - 1)
                self.seek(j)
                let last = self.lastObserved
                if j == m - 1 {
                    done += 1
                    if done >= loops { self.seek(last >= 0 ? last : m - 1); break }
                }
                try? await Task.sleep(for: j == m - 1 || j == last ? RadarConfig.hold : RadarConfig.step)
            }
            if !Task.isCancelled { self?.isPlaying = false; self?.playTask = nil }
        }
    }

    /// `rmStop`.
    func stop() {
        autoplayPending = false
        playTask?.cancel()
        playTask = nil
        isPlaying = false
    }

    // MARK: Labels

    /// Minutes from the newest observed frame to frame i (negative before it).
    func minutesFromLatest(_ i: Int) -> Int {
        guard frames.indices.contains(i) else { return 0 }
        let l = lastObserved, tl = l >= 0 ? frames[l].t : frames[i].t
        return Int(JS.round((frames[i].t - tl) / 60))
    }

    /// The small line under the time (js/app.js:2603): "om 15 min", "siste bilde", "for 10 min siden".
    func relativeLabel(_ i: Int) -> String {
        guard frames.indices.contains(i) else { return "" }
        let m = minutesFromLatest(i)
        return frames[i].fc ? L10n.t("rm.fc", ["m": String(m)])
            : i == lastObserved ? L10n.t("rm.latest") : L10n.t("rm.ago", ["m": String(-m)])
    }

    /// `rmFrameLabel(i)` for VoiceOver: "kl. 14:05 · siste".
    func accessibilityLabel(_ i: Int) -> String {
        guard frames.indices.contains(i) else { return "" }
        let m = minutesFromLatest(i)
        let rel = frames[i].fc ? L10n.t("rm.fc", ["m": String(m)])
            : i == lastObserved ? L10n.t("lm.radar.latest") : L10n.t("lm.radar.ago", ["m": String(-m)])
        return "\(L10n.t("lm.radar.at", ["h": Format.time(frames[i].date)])) · \(rel)"
    }
}
