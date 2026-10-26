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
/// Frames are tile overlays stacked on the map and switched by opacity; nothing is interpolated or extrapolated. Only
/// the frames near the shown one exist as overlays; a frame whose tiles all fail is dropped, and a nowcast issue that
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
    /// The frame list could not be had (`rm.err`).
    private(set) var failed = false
    private(set) var lastRefresh: Date?

    /// 12 observed frames with room, else 7 (`RM.n()`); set by the view from its width.
    var wide = false
    /// No autoplay with Reduce Motion (`lmReduced`, js/app.js:1884).
    var reduceMotion = false
    /// The radar's opacity (`RM.alpha()`); set by the view from the colour scheme.
    var alpha = RadarConfig.alpha(dark: false) {
        didSet { if alpha != oldValue { frames.indices.forEach(applyAlpha) } }
    }

    /// The opacity of the frames kept ready around the shown one: not zero, so MapKit loads and keeps their tiles.
    static let preloadAlpha = 0.01

    @ObservationIgnored private weak var mapView: MKMapView?
    @ObservationIgnored private var overlays: [String: RadarTileOverlay] = [:]
    @ObservationIgnored private var ncBad: Set<String> = []
    @ObservationIgnored private var playTask: Task<Void, Never>?
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var token = 0
    @ObservationIgnored private var autoplayPending = false
    @ObservationIgnored private var rvHost = RadarConfig.rvHost

    init(lat: Double, lon: Double) {
        self.lat = lat
        self.lon = lon
        met = RadarConfig.inNordic(lat: lat, lon: lon)
    }

    /// The map the overlays go on (set once by `RadarMap`).
    func attach(_ map: MKMapView) {
        mapView = map
        if index >= 0 { window(index) }
    }

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
        guard !refreshing else { return }
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
            guard let meta, meta.host == RadarConfig.rvHost else {
                failed = true
                clear()
                return
            }
            rvHost = meta.host
            wanted = meta.frames.suffix(n).map { RadarFrame(t: $0.t, key: $0.path, met: false) }
        }
        failed = false
        lastRefresh = now

        var have: [String: RadarFrame] = [:]
        for f in frames { have[f.key] = f }
        var next: [RadarFrame] = []
        for w in wanted {
            if let f = have[w.key] { if !f.bad { next.append(f) } } else { next.append(w) }
        }
        let keep = Set(next.map(\.key))
        for (k, o) in overlays where !keep.contains(k) { mapView?.removeOverlay(o); overlays[k] = nil }
        let first = have.isEmpty
        let wasLast = index < 0 || index == lastObserved, kept = index
        frames = next
        index = -1
        let nowLast = lastObserved
        seek(wasLast ? (nowLast >= 0 ? nowLast : frames.count - 1) : min(max(0, kept), frames.count - 1))
        if first && !reduceMotion { autoplay(tok) }
    }

    /// First load: play once the newest observed frame is in, or after 3 s (js/app.js:2553-2556). A refresh in between
    /// (a nowcast issue that is not out yet) does not cancel it; the user's own choice of frame does.
    private func autoplay(_ tok: Int) {
        autoplayPending = true
        Task { [weak self] in
            let start = ContinuousClock.now
            while let self, self.autoplayPending, !self.isPlaying {
                let l = self.lastObserved
                if (l >= 0 && self.frames[l].ok) || ContinuousClock.now - start > .seconds(3) {
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
        overlays.values.forEach { mapView?.removeOverlay($0) }
        overlays = [:]
        frames = []
        index = -1
    }

    // MARK: Layers

    /// `rmWindow(i)`: overlays for the frames within `RadarConfig.window` of the shown one; far ones are removed.
    private func window(_ i: Int) {
        for (k, f) in frames.enumerated() {
            if abs(k - i) <= RadarConfig.window { layer(for: f) }
            else if abs(k - i) > RadarConfig.window + 2, let o = overlays[f.key] { mapView?.removeOverlay(o); overlays[f.key] = nil }
        }
    }

    /// `rmLayerFor(f)`: the frame's overlay, created once.
    private func layer(for f: RadarFrame) {
        guard overlays[f.key] == nil, !f.bad, let map = mapView else { return }
        let report: @Sendable (String, Bool) -> Void = { [weak self] key, ok in
            Task { @MainActor in self?.tile(key, ok) }
        }
        let o: RadarTileOverlay
        if f.met, f.fc, let issue = f.issueKey {
            o = WMSTileOverlay(frameKey: f.key, base: RadarConfig.ncBase + RadarConfig.ncFile(issue),
                               params: RadarConfig.metParams + [("time", JS.isoUTC(f.t))], maxZoom: RadarConfig.metMaxZoom, onTile: report)
        } else if f.met {
            o = WMSTileOverlay(frameKey: f.key, base: RadarConfig.metBase + RadarConfig.metFile(f.key),
                               params: RadarConfig.metParams, maxZoom: RadarConfig.metMaxZoom, onTile: report)
        } else {
            o = RadarTileOverlay(frameKey: f.key, urlTemplate: RadarConfig.rvTile(rvHost, f.key), maxZoom: RadarConfig.rvMaxZoom, onTile: report)
        }
        overlays[f.key] = o
        map.addOverlay(o, level: .aboveLabels)
    }

    /// The opacity a frame's renderer starts with (the map's delegate asks when it makes the renderer).
    func alpha(for overlay: any MKOverlay) -> Double {
        guard let o = overlay as? RadarTileOverlay, let i = frames.firstIndex(where: { $0.key == o.frameKey }) else { return 0 }
        return i == index ? alpha : Self.preloadAlpha
    }

    private func applyAlpha(_ i: Int) {
        guard frames.indices.contains(i), let o = overlays[frames[i].key],
              let r = mapView?.renderer(for: o) else { return }
        r.alpha = alpha(for: o)
    }

    /// A tile's outcome: the frame is there, or (when nothing of it loaded) it is dropped (`tileload`/`tileerror`).
    private func tile(_ key: String, _ ok: Bool) {
        guard let i = frames.firstIndex(where: { $0.key == key }) else { return }
        if ok {
            if !frames[i].ok { frames[i].ok = true }
            return
        }
        guard !frames[i].ok, !frames[i].bad else { return }
        frames[i].bad = true
        if frames[i].fc, let issue = frames[i].issueKey { dropIssue(issue) } else { drop(at: i) }
    }

    /// `rmDropIssue`: a nowcast issue that is not published yet; its steps go and the refresh takes the previous issue.
    private func dropIssue(_ issue: String) {
        guard !ncBad.contains(issue) else { return }
        ncBad.insert(issue)
        let shown = current?.key
        for f in frames where f.fc && f.issueKey == issue {
            if let o = overlays[f.key] { mapView?.removeOverlay(o); overlays[f.key] = nil }
        }
        frames.removeAll { $0.fc && $0.issueKey == issue }
        index = shown.flatMap { k in frames.firstIndex { $0.key == k } } ?? -1
        if index < 0 { seek(lastObserved >= 0 ? lastObserved : frames.count - 1) }
        Task { await refresh() }
    }

    /// `rmDrop`: a slot whose tiles all fail (not published yet, or missing) leaves the sequence.
    private func drop(at i: Int) {
        let shown = current?.key
        if let o = overlays[frames[i].key] { mapView?.removeOverlay(o); overlays[frames[i].key] = nil }
        frames.remove(at: i)
        index = shown.flatMap { k in frames.firstIndex { $0.key == k } } ?? -1
        if index < 0 { seek(lastObserved >= 0 ? lastObserved : frames.count - 1) }
    }

    // MARK: Time

    /// `rmSeek(i, byUser)`: show frame i; a user's choice stops the playback.
    func seek(_ i: Int, byUser: Bool = false) {
        let n = frames.count
        guard n > 0 else { return }
        let i = min(n - 1, max(0, i))
        window(i)
        if i != index {
            let old = index
            index = i
            applyAlpha(old)
            applyAlpha(i)
        }
        if byUser { autoplayPending = false; stop() }
    }

    /// `rmPlay(loops)`: step through the frames, waiting up to 2.5 s for the next frame's tiles, holding on the newest
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
                self.layer(for: self.frames[i])
                let start = ContinuousClock.now
                while !Task.isCancelled, i < self.frames.count, !self.frames[i].ok, !self.frames[i].bad,
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
