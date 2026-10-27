import GlettKit
import SwiftUI

/// The radar for one place: the map edge to edge and the panel floating over its foot (wide screens keep the panel
/// at a readable width). Loads the frames on appear, tops them up every few minutes while shown (js/app.js:2468-2470),
/// and pauses in the background.
struct RadarContent: View {
    let place: Place
    let nowcast: NowcastSeries?
    let now: Date
    let topo: Bool
    let windUnit: WindUnit

    @State private var controller: RadarController
    @State private var wind = WindController()
    /// The wind side is shown.
    @State private var windOn: Bool
    @State private var panelHeight: CGFloat = 0
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    /// The web's "wide" for `RM.n()` (`min-width: 700px`).
    nonisolated static let wideWidth: CGFloat = 700
    /// The panel's widest (regular width: the map stays the picture).
    static let panelMaxWidth: CGFloat = 560
    /// Frames are topped up when the last refresh is older than this (js/app.js:2470, 240 s).
    static let refreshAfter: TimeInterval = 240

    init(place: Place, nowcast: NowcastSeries?, now: Date, topo: Bool, windUnit: WindUnit = .default, wind: Bool = false) {
        self.place = place
        self.nowcast = nowcast
        self.now = now
        self.topo = topo
        self.windUnit = windUnit
        _controller = State(initialValue: RadarController(lat: place.lat, lon: place.lon))
        _windOn = State(initialValue: wind && WindGrid.covers(lat: place.lat, lon: place.lon))
    }

    /// MET Nordic's wind is there for the place (`wmCovers`).
    private var windAvailable: Bool { WindGrid.covers(lat: place.lat, lon: place.lon) }

    var body: some View {
        // the pulsing marker and the place's line come from MET's radar nowcast only (js/app.js:2486)
        let here = (nowcast?.model ?? true) ? nil : NowcastHere.evaluate(nowcast, now: now)
        ZStack(alignment: .bottom) {
            RadarMap(controller: controller, wind: wind, windOn: windOn, active: scenePhase == .active, place: place, topo: topo,
                     wet: here?.wetNow ?? false, reduceMotion: reduceMotion, bottomInset: panelHeight)
                .overlay(alignment: .topLeading) { windReading }
                .ignoresSafeArea(edges: [.horizontal, .bottom])
            if controller.down && !windOn {
                RadarDownOverlay(met: controller.met, stripWorks: stripWorks)
                    .padding(.bottom, panelHeight)
                    .ignoresSafeArea(edges: [.horizontal, .bottom])
            }
            RadarPanel(controller: controller, here: here, topo: topo, now: now, windOn: $windOn, windAvailable: windAvailable,
                       wind: wind, reduceMotion: reduceMotion)
                .frame(maxWidth: Self.panelMaxWidth)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { panelHeight = $0 }
        }
        .onGeometryChange(for: Bool.self) { $0.size.width >= Self.wideWidth } action: { controller.wide = $0 }
        .onChange(of: windOn, initial: true) { _, on in
            AppNavigation.shared.radarWind = on   // the title follows
            controller.shown = !on
            wind.windUnit = windUnit
            if on { wind.show() } else { wind.hide() }
        }
        .task {
            controller.alpha = RadarConfig.alpha(dark: colorScheme == .dark)
            controller.reduceMotion = reduceMotion
            await controller.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                if controller.down { await controller.probe() }   // `RM.probeMs`: is the radar back?
                else if let last = controller.lastRefresh, Date().timeIntervalSince(last) > Self.refreshAfter { await controller.refresh() }
            }
        }
        .onChange(of: colorScheme) { _, s in controller.alpha = RadarConfig.alpha(dark: s == .dark) }
        .onChange(of: reduceMotion) { _, r in controller.reduceMotion = r }
        .onChange(of: scenePhase) { _, phase in
            controller.active = phase == .active
            if phase == .active { Task { await controller.refresh() } } else { controller.stop() }
        }
        .onChange(of: controller.down) { _, down in
            if down { AccessibilityNotification.Announcement(RadarDownOverlay.text(met: controller.met, stripWorks: stripWorks)).post() }
        }
        .onDisappear { controller.stop(); wind.hide() }
    }

    /// The wind at a tapped spot (`wm-pop`), just above where the finger was.
    @ViewBuilder
    private var windReading: some View {
        if windOn, let r = wind.reading {
            Text(verbatim: r.text)
                .font(.footnote.weight(.semibold))
                .multilineTextAlignment(.center)
                .foregroundStyle(.glett.text)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.glett.panel, in: .rect(cornerRadius: 10))
                .shadow(color: .black.opacity(0.2), radius: 4, y: 2)
                .fixedSize()
                .alignmentGuide(.leading) { $0.width / 2 - r.point.x }
                .alignmentGuide(.top) { $0.height + 10 - r.point.y }
                .allowsHitTesting(false)
                .transition(.opacity)
        }
    }

    /// The 2-hour strip in the now card shows MET's own radar nowcast (not the model stand-in), so the overlay can point to it.
    private var stripWorks: Bool {
        RadarStrip.make(nowcast, now: now).map { !$0.model } ?? false
    }
}

#Preview {
    let sample = PreviewSamples.oslo
    RadarContent(place: sample.place, nowcast: sample.nowcast, now: sample.now, topo: true)
}
