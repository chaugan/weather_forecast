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
    /// The wind reading's size, to place it beside the pin.
    @State private var bubble = CGSize(width: 140, height: 44)
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    /// The web's "wide" for `RM.n()` (`min-width: 700px`).
    nonisolated static let wideWidth: CGFloat = 700
    /// The panel's widest (regular width: the map stays the picture).
    static let panelMaxWidth: CGFloat = 560
    /// Frames are topped up when the last refresh is older than this (js/app.js:2470, 240 s).
    static let refreshAfter: TimeInterval = 240

    /// The map runs up under the top bar to the screen's edge; `band`: a frosted band fading out under the bar.
    let toEdge: Bool
    let band: Bool

    init(place: Place, nowcast: NowcastSeries?, now: Date, topo: Bool, windUnit: WindUnit = .default, wind: Bool = false,
         toEdge: Bool = false, band: Bool = false) {
        self.toEdge = toEdge
        self.band = band
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
                .overlay { windReading }
                .ignoresSafeArea(edges: toEdge ? .all : [.horizontal, .bottom])
            if band { topBand }
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

    /// Frosted glass behind the status bar and the top bar, fading out just under them.
    private var topBand: some View {
        GeometryReader { geo in
            let h = geo.safeAreaInsets.top + 34
            VStack {
                Rectangle()
                    .fill(.ultraThinMaterial)
                    .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.55),
                                                 .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
                    .frame(height: h)
                Spacer(minLength: 0)
            }
            .ignoresSafeArea(edges: .top)
        }
        .allowsHitTesting(false)
    }

    /// The wind at a tapped spot (`wm-pop`): a small pin where the finger was and the reading just above it (under it
    /// near the top edge), kept on screen near the sides.
    @ViewBuilder
    private var windReading: some View {
        if windOn, let r = wind.reading {
            GeometryReader { geo in
                let pinH: CGFloat = 26, gap: CGFloat = 4
                let fitsAbove = r.point.y - pinH - gap - bubble.height > 8
                let y = fitsAbove ? r.point.y - pinH - gap - bubble.height / 2 : r.point.y + gap + bubble.height / 2 + 6
                let x = min(max(r.point.x, bubble.width / 2 + 8), max(bubble.width / 2 + 8, geo.size.width - bubble.width / 2 - 8))
                ZStack {
                    TapPin()
                        .frame(width: 20, height: pinH)
                        .position(x: r.point.x, y: r.point.y - pinH / 2)   // the tip on the spot
                    Text(verbatim: r.text)
                        .font(.footnote.weight(.semibold))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.glett.text)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.glett.panel, in: .rect(cornerRadius: 10))
                        .shadow(color: .black.opacity(0.2), radius: 4, y: 2)
                        .fixedSize()
                        .onGeometryChange(for: CGSize.self) { $0.size } action: { bubble = $0 }
                        .position(x: x, y: y)
                }
            }
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

/// The wind reading's pin: a drop with a white edge all round and a white dot, its tip at the bottom centre.
private struct TapPin: View {
    var body: some View {
        ZStack(alignment: .top) {
            PinShape().fill(Color.glett.accent)
            PinShape().stroke(.white, lineWidth: 2)
            Circle().fill(.white).frame(width: 6, height: 6).padding(.top, 7)
        }
        .shadow(color: .black.opacity(0.35), radius: 2, y: 1)
        .accessibilityHidden(true)
    }
}

/// A map pin's outline in its frame: a round head across the full width, its sides running straight to a point at the
/// bottom centre (they leave the head where they touch it, so there is no corner).
private struct PinShape: Shape {
    func path(in rect: CGRect) -> Path {
        let r = rect.width / 2, cx = rect.midX, cy = rect.minY + r, tip = CGPoint(x: rect.midX, y: rect.maxY)
        let theta = acos(min(1, r / (tip.y - cy)))   // the touch points, either side of straight down
        let down = Double.pi / 2                      // y grows downward: +π/2 points at the tip
        var p = Path()
        p.move(to: tip)
        // over the top, from the right touch point to the left one, the long way round
        let from = down - theta, to = down + theta - 2 * .pi
        for k in 0...48 {
            let t = from + (to - from) * Double(k) / 48
            p.addLine(to: CGPoint(x: cx + r * cos(t), y: cy + r * sin(t)))
        }
        p.closeSubpath()
        return p
    }
}
