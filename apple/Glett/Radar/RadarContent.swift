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

    @State private var controller: RadarController
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

    init(place: Place, nowcast: NowcastSeries?, now: Date, topo: Bool) {
        self.place = place
        self.nowcast = nowcast
        self.now = now
        self.topo = topo
        _controller = State(initialValue: RadarController(lat: place.lat, lon: place.lon))
    }

    var body: some View {
        // the pulsing marker and the place's line come from MET's radar nowcast only (js/app.js:2486)
        let here = (nowcast?.model ?? true) ? nil : NowcastHere.evaluate(nowcast, now: now)
        ZStack(alignment: .bottom) {
            RadarMap(controller: controller, place: place, topo: topo, wet: here?.wetNow ?? false, reduceMotion: reduceMotion,
                     bottomInset: panelHeight)
                .ignoresSafeArea(edges: [.horizontal, .bottom])
            RadarPanel(controller: controller, here: here, topo: topo, now: now)
                .frame(maxWidth: Self.panelMaxWidth)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { panelHeight = $0 }
        }
        .onGeometryChange(for: Bool.self) { $0.size.width >= Self.wideWidth } action: { controller.wide = $0 }
        .task {
            controller.alpha = RadarConfig.alpha(dark: colorScheme == .dark)
            controller.reduceMotion = reduceMotion
            await controller.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                if let last = controller.lastRefresh, Date().timeIntervalSince(last) > Self.refreshAfter { await controller.refresh() }
            }
        }
        .onChange(of: colorScheme) { _, s in controller.alpha = RadarConfig.alpha(dark: s == .dark) }
        .onChange(of: reduceMotion) { _, r in controller.reduceMotion = r }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await controller.refresh() } } else { controller.stop() }
        }
        .onDisappear { controller.stop() }
    }
}

#Preview {
    let sample = PreviewSamples.oslo
    RadarContent(place: sample.place, nowcast: sample.nowcast, now: sample.now, topo: true)
}
