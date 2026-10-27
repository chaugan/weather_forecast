import GlettKit
import SwiftUI

/// The controls and words under the radar map (`#rmSlider`, `#rmCap`; js/app.js:2486-2506): play/pause, the shown
/// frame's time and age, the time slider, the colour legend, one line about the source (the whole story behind
/// "Om kartet"), the map credits, and MET's 90-minute line for the place.
struct RadarPanel: View {
    let controller: RadarController
    /// `lmHereLine` (js/app.js:2438-2444); nil outside the radar.
    let here: NowcastHere?
    /// Kartverket's map is the base (its credit is shown).
    let topo: Bool
    let now: Date
    /// The wind side (`rmMode`, js/app.js:2752-2769): shown, there at this place (MET Nordic), and its controller.
    @Binding var windOn: Bool
    var windAvailable = false
    var wind: WindController?
    var reduceMotion = false
    @State private var showsAbout = false
    /// Folded to the switch, play, the time and the slider, for the map and the scrubbing alone (owner, 2026-10-27);
    /// kept between visits.
    @AppStorage("glett.mapPanel.small") private var small = false

    var body: some View {
        let c = controller
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if windAvailable {
                    Picker(selection: $windOn) {
                        Text(verbatim: L10n.t("rm.mode.rain")).tag(false)
                        Text(verbatim: L10n.t("rm.mode.wind")).tag(true)
                    } label: {
                        EmptyView()
                    }
                    .pickerStyle(.segmented)
                } else {
                    Spacer(minLength: 0)
                }
                foldButton
            }
            if windOn, let wind {
                WindControls(wind: wind, reduceMotion: reduceMotion, small: small)
            } else {
            // while the radar is down the overlay on the map says so: no time, slider, legend or source line (js/app.js:2511-2521)
            if c.down {
                if let here { hereChip(here) }
            } else {
            // the place's line beside the time when it fits on one line, else under it
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 12) {
                    playButton
                    timeLabel
                    Spacer(minLength: 4)
                    if let here { hereChip(here).fixedSize() }
                }
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .center, spacing: 12) {
                        playButton
                        timeLabel
                        Spacer(minLength: 0)
                    }
                    if let here, !small { hereChip(here) }
                }
            }
            if c.frames.count > 1 {
                RadarTimeline(count: c.frames.count, index: c.index, lastObserved: c.lastObserved,
                              valueText: c.accessibilityLabel(c.index)) { c.seek($0, byUser: true) }
            }
            if !small {
            legend
            sourceLine
            }
            if showsAbout, !small, let about {
                Text(verbatim: about)
                    .font(.caption)
                    .foregroundStyle(.glett.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
            }
            }
            if !small { credits }
        }
        .padding(14)
        .animation(.easeInOut(duration: 0.2), value: small)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel(cornerRadius: 24)
    }

    // MARK: Parts

    /// Folds the panel down to the time controls, or opens it again.
    private var foldButton: some View {
        Button {
            small.toggle()
        } label: {
            Image(systemName: small ? "chevron.up" : "chevron.down")
                .font(.subheadline.weight(.semibold))
                .frame(width: 32, height: 32)
        }
        .glassButton()
        .buttonBorderShape(.circle)
        .tint(.glett.text)
        .accessibilityLabel(Text(verbatim: AppText.t(small ? "app.map.unfold" : "app.map.fold")))
    }

    private var playButton: some View {
        let c = controller
        return Button {
            if c.isPlaying { c.stop() } else { c.play() }
        } label: {
            Image(systemName: c.isPlaying ? "pause.fill" : "play.fill")
                .font(.title3)
                .frame(width: 44, height: 44)
                .contentTransition(.symbolEffect(.replace))
                .foregroundStyle(Color.glett.onAccent)
        }
        .glassProminentButton()
        .buttonBorderShape(.circle)
        .tint(.glett.accent)
        .disabled(c.frames.count < 2)
        .accessibilityLabel(Text(verbatim: L10n.t(c.isPlaying ? "lm.radar.pause" : "lm.radar.play")))
    }

    @ViewBuilder
    private var timeLabel: some View {
        let c = controller
        if let f = c.current {
            let stale = (c.age(now: now) ?? 0) > RadarConfig.staleMinutes
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: Format.time(f.date))
                    .font(.title2.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(stale ? Color.glett.mid : f.fc ? Color.glett.accent2 : Color.glett.text)
                Text(verbatim: c.relativeLabel(c.index))
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.glett.muted)
            }
            .accessibilityElement(children: .combine)
        } else if !c.down {
            HStack(spacing: 8) {
                ProgressView()
                Text(verbatim: L10n.t("rm.loading")).font(.subheadline).foregroundStyle(.glett.muted)
            }
        }
    }

    private func hereChip(_ h: NowcastHere) -> some View {
        Label {
            Text(verbatim: L10n.t(h.key, ["h": h.flip.map(Format.time) ?? ""]))
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: h.wetNow ? "cloud.rain.fill" : "sun.max.fill")
                .foregroundStyle(h.wetNow ? Color.glett.rain : Color.glett.sun)
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.glett.text)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.glett.panel.opacity(0.7), in: .capsule)
    }

    private var legend: some View {
        FlowLayout(spacing: 12, lineSpacing: 4) {
            ForEach(RadarConfig.legend(met: controller.met), id: \.key) { item in
                HStack(spacing: 5) {
                    Circle()
                        .fill(Color(hex: item.color))
                        .overlay(Circle().strokeBorder(.black.opacity(0.25)))
                        .frame(width: 12, height: 12)
                    Text(verbatim: L10n.t(item.key)).font(.caption).foregroundStyle(.glett.text)
                }
            }
        }
    }

    /// One line (js/app.js:2497-2500): the source and frequency, that the part after "nå" is the radar's nowcast, and
    /// how old the newest frame is when it is more than 20 minutes.
    @ViewBuilder
    private var sourceLine: some View {
        let c = controller
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(line)
                .font(.caption)
                .foregroundStyle(.glett.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if about != nil {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { showsAbout.toggle() }
                } label: {
                    Text(verbatim: L10n.t("rm.about")).font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .tint(.glett.accent)
                .accessibilityValue(Text(verbatim: showsAbout ? "1" : "0"))
            }
        }
        .animation(nil, value: c.index)
    }

    private var line: AttributedString {
        let c = controller
        guard !c.frames.isEmpty else { return AttributedString() }
        var s = AttributedString(L10n.t(c.met ? "rm.line.met" : "rm.line.rv"))
        if c.frames.contains(where: \.fc) { s += AttributedString(" " + L10n.t("rm.line.fc")) }
        if let age = c.age(now: now), age > RadarConfig.staleMinutes {
            var b = AttributedString(" " + L10n.t("rm.stale", ["m": String(Int(JS.round(age)))]))
            b.inlinePresentationIntent = .stronglyEmphasized
            s += b
        }
        return s
    }

    /// "Om kartet" (js/app.js:2501): resolution, delay, coverage, and the nowcast's reach.
    private var about: String? {
        let c = controller
        let l = c.lastObserved
        guard !c.down, let first = c.frames.first, let newest = c.frames.last else { return nil }
        let last = l >= 0 ? c.frames[l] : newest
        var s = L10n.t(c.met ? "rm.cap.met" : "rm.cap.rv", ["h": Format.time(last.date), "mins": String(Int(JS.round((last.t - first.t) / 60)))])
        if let fc = c.frames.last(where: \.fc) {
            s += " " + L10n.t("rm.cap.fc", ["m": String(Int(JS.round((fc.t - last.t) / 60)))])
        }
        return s
    }

    /// The map's credits, as the web's attribution (the footer lists every source as well).
    private var credits: some View {
        var parts = [(String, URL)]()
        if topo { parts.append(RadarConfig.kartverketCredit) }
        parts.append(controller.met || windOn ? RadarConfig.metCredit : RadarConfig.rainViewerCredit)
        var s = AttributedString()
        for (i, p) in parts.enumerated() {
            if i > 0 { s += AttributedString(" · ") }
            var a = AttributedString(p.0)
            a.link = p.1
            s += a
        }
        return Text(s)
            .font(.caption)
            .foregroundStyle(.glett.muted)
            .tint(.glett.muted)
            .accessibilityLabel(Text(verbatim: "\(L10n.t("map.credits")): \(parts.map(\.0).joined(separator: ", "))"))
    }
}
