import ActivityKit
import GlettKit
import SwiftUI
import WidgetKit

/// The Live Activity "Neste glett" (brief §6): rain starting or stopping within the nowcast, counted down on the Lock
/// Screen and in the Dynamic Island. The countdown runs by itself (`Text(timerInterval:)`), so it needs no updates;
/// the app updates it when it fetches a new nowcast and ends it when nothing changes any more.
struct NextGlettAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// Raining now (the countdown is to dry weather), else dry (to rain).
        var wetNow: Bool
        /// When it changes.
        var at: Date
        /// A short shower rather than rain that sets in (`NextGlett.Kind.blip`).
        var blip: Bool
        /// Open-Meteo's model rather than MET's radar.
        var model: Bool
        /// The precipitation rate (mm/h) for each step from `start`, as the radar strip draws it.
        var rates: [Double]
        var start: Date
        var stepSeconds: Double
    }

    /// The place's name.
    var place: String
}

extension NextGlettAttributes.ContentState {
    /// The state for a nowcast at `now`, when rain starts or stops within it.
    init?(_ nc: NowcastSeries?, now: Date) {
        guard let next = NextGlett.evaluate(nc, now: now), let at = next.time, let strip = RadarStrip.make(nc, now: now),
              let first = strip.points.first else { return nil }
        if case .blip = next.kind { blip = true } else { blip = false }
        wetNow = next.wetNow
        self.at = at
        model = next.model
        rates = strip.points.map(\.rate)
        start = first.date
        stepSeconds = strip.stepSeconds
    }

    /// "Regn om" / "Opphold om".
    var countdownLabel: String { AppText.t(wetNow ? "app.la.dryIn" : "app.la.rainIn") }

    /// "Regn fra ca. 14:20" (the widgets' short "neste glett").
    var sentence: String {
        let h = Format.time(at)
        return wetNow ? AppText.t("app.w.wet.now", ["h": h]) : AppText.t(blip ? "app.w.dry.blip" : "app.w.dry.now", ["h": h])
    }

    var symbol: String { wetNow ? "sun.max.fill" : "drop.fill" }
    var tint: Color { wetNow ? .glett.sun : .glett.rain }
}

/// The countdown to `at`, stopping at 0:00 (the system keeps it running between updates).
struct GlettCountdown: View {
    let at: Date

    var body: some View {
        let now = Date()
        Text(timerInterval: min(now, at)...at, countsDown: true, showsHours: false)
            .monospacedDigit()
    }
}

/// The nowcast as bars, the change marked: the radar strip in small.
struct ActivityBars: View {
    let state: NextGlettAttributes.ContentState
    /// On glass: the dry steps and the baseline in the vibrant secondary style.
    var glass = false

    var body: some View {
        GeometryReader { geo in
            let n = max(1, state.rates.count)
            let w = geo.size.width / CGFloat(n)
            let top = max(2.0, state.rates.max() ?? 0)
            ZStack(alignment: .bottomLeading) {
                Rectangle().fill(glass ? AnyShapeStyle(.tertiary) : AnyShapeStyle(Color.glett.line)).frame(height: 1)
                ForEach(Array(state.rates.enumerated()), id: \.offset) { i, r in
                    let h = r >= NextGlett.wetRate ? max(3, geo.size.height * CGFloat(min(1, sqrt(r / top)))) : 1
                    RoundedRectangle(cornerRadius: 1)
                        .fill(r >= NextGlett.wetRate ? AnyShapeStyle(Color.glett.rain) : glass ? AnyShapeStyle(.tertiary) : AnyShapeStyle(Color.glett.line))
                        .frame(width: max(1, w - 2), height: h)
                        .offset(x: CGFloat(i) * w)
                }
                let x = CGFloat(state.at.timeIntervalSince(state.start) / state.stepSeconds) * w
                Rectangle().fill(state.tint).frame(width: 2, height: geo.size.height).offset(x: min(max(0, x), geo.size.width - 2))
            }
        }
        .accessibilityHidden(true)
    }
}

/// The Lock Screen face (and the banner on devices without the Dynamic Island). On iOS 26 and later it sits on the
/// system's glass (`glass`): no panel of its own, the text in the vibrant primary and secondary styles that read on
/// any wallpaper (owner, 2026-10-27); before that on Glett's panel colour.
struct NextGlettLockView: View {
    let place: String
    let state: NextGlettAttributes.ContentState
    var stale = false
    var glass = false

    private var main: AnyShapeStyle { glass ? AnyShapeStyle(.primary) : AnyShapeStyle(Color.glett.text) }
    private var muted: AnyShapeStyle { glass ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.glett.muted) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: state.symbol).foregroundStyle(state.tint)
                Text(verbatim: place).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 4)
                Text(verbatim: "Glett").font(.caption.weight(.semibold)).foregroundStyle(muted)
            }
            if stale {
                Text(verbatim: AppText.t("app.la.stale")).font(.headline)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: state.countdownLabel).font(.title3.weight(.semibold))
                    GlettCountdown(at: state.at).font(.system(size: 34, weight: .heavy))
                    Spacer(minLength: 0)
                }
                Text(verbatim: state.sentence + (state.model ? " " + L10n.t("nc.model") : ""))
                    .font(.footnote)
                    .foregroundStyle(muted)
            }
            ActivityBars(state: state, glass: glass).frame(height: 26)
        }
        .foregroundStyle(main)
        .padding(16)
    }
}
