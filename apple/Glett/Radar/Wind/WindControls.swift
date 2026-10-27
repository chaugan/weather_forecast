import GlettKit
import SwiftUI

/// The wind side's controls (js/windmap.js `ui`): play, the hour once with its day, the slider with the days marked
/// under it, the speed legend, one line (how to read the map, or what went wrong) and the run behind "Om kartet".
struct WindControls: View {
    let wind: WindController
    let reduceMotion: Bool
    /// The panel is folded: the time controls only.
    var small = false
    @State private var showsAbout = false

    var body: some View {
        let w = wind
        VStack(alignment: .leading, spacing: 10) {
            if small {
                // folded: one row, play at the slider's left and the time at its right, the legend under it (owner)
                HStack(alignment: .top, spacing: 10) {
                    smallPlay
                    if w.times.count > 1 { timeline } else { Spacer(minLength: 0) }
                    smallTime
                }
                legend
            } else {
            HStack(alignment: .center, spacing: 12) {
                playButton()
                timeLabel
                Spacer(minLength: 0)
            }
            if w.times.count > 1 {
                timeline
            }
            legend
            line
            if showsAbout, let run = w.meta?.ref {
                Text(verbatim: L10n.t("wm.cap", ["run": w.clock(run)]))
                    .font(.caption)
                    .foregroundStyle(.glett.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
            }
        }
    }

    private var timeline: some View {
        let w = wind
        return RadarTimeline(count: w.times.count, index: w.index, lastObserved: w.times.count - 1,
                             valueText: w.times.indices.contains(w.index) ? w.label(w.times[w.index]) : "",
                             marksAt: dayMarks, name: L10n.t("wm.slider")) { i in Task { await w.seek(i, byUser: true) } }
    }

    /// The folded row's time: the hour and its day.
    @ViewBuilder
    private var smallTime: some View {
        let w = wind
        if w.times.indices.contains(w.index) {
            let t = w.times[w.index]
            VStack(alignment: .trailing, spacing: 0) {
                Text(verbatim: w.clock(t)).font(.subheadline.weight(.bold)).monospacedDigit().foregroundStyle(.glett.text)
                Text(verbatim: w.day(t)).font(.caption2).foregroundStyle(.glett.muted).lineLimit(1)
            }
            .fixedSize()
            .accessibilityElement(children: .combine)
        } else {
            ProgressView().controlSize(.small)
        }
    }

    /// The folded row's play: a plain accent circle of 32 pt, its centre on the slider's line (the glass style pads
    /// its button out to the full size).
    private var smallPlay: some View {
        let w = wind
        return Button {
            if w.isPlaying { w.stop() } else { w.play() }
        } label: {
            Image(systemName: w.isPlaying ? "pause.fill" : "play.fill")
                .font(.footnote.weight(.bold))
                .foregroundStyle(Color.glett.onAccent)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 32, height: 32)
                .background(Color.glett.accent, in: .circle)
        }
        .buttonStyle(.plain)
        .disabled(w.times.count < 2)
        .accessibilityLabel(Text(verbatim: L10n.t(w.isPlaying ? "lm.radar.pause" : "lm.radar.play")))
    }

    private func playButton(size: CGFloat = 44) -> some View {
        let w = wind
        return Button {
            if w.isPlaying { w.stop() } else { w.play() }
        } label: {
            Image(systemName: w.isPlaying ? "pause.fill" : "play.fill")
                .font(size < 44 ? .subheadline : .title3)
                .frame(width: size, height: size)
                .contentTransition(.symbolEffect(.replace))
                .foregroundStyle(Color.glett.onAccent)
        }
        .glassProminentButton()
        .buttonBorderShape(.circle)
        .tint(.glett.accent)
        .disabled(w.times.count < 2)
        .accessibilityLabel(Text(verbatim: L10n.t(w.isPlaying ? "lm.radar.pause" : "lm.radar.play")))
    }

    @ViewBuilder
    private var timeLabel: some View {
        let w = wind
        if w.times.indices.contains(w.index) {
            let t = w.times[w.index]
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: w.clock(t)).font(.title2.weight(.bold)).monospacedDigit().foregroundStyle(.glett.text)
                    Text(verbatim: w.day(t)).font(.footnote.weight(.medium)).foregroundStyle(.glett.muted)
                }
                if w.loading { ProgressView().controlSize(.small) }
            }
            .accessibilityElement(children: .combine)
        } else if w.error == nil {
            HStack(spacing: 8) {
                ProgressView()
                Text(verbatim: L10n.t("wm.loading")).font(.subheadline).foregroundStyle(.glett.muted)
            }
        }
    }

    /// A mark where each new day starts, named.
    private var dayMarks: [(index: Int, text: String)] {
        wind.times.indices.dropFirst().filter { wind.clock(wind.times[$0]) == "00:00" }.map { ($0, wind.day(wind.times[$0])) }
    }

    /// The colours from calm to 30 m/s, marked at 0, 10, 20 and 30 in the chosen unit.
    private var legend: some View {
        let stops: [Double] = [0, 5, 10, 15, 20, 25, 30], marks: [Double] = [0, 10, 20, 30]
        return VStack(spacing: 3) {
            LinearGradient(colors: stops.map { Color(uiColor: WindColors.color($0)) }, startPoint: .leading, endPoint: .trailing)
                .frame(height: 8)
                .clipShape(Capsule())
            HStack {
                ForEach(Array(marks.enumerated()), id: \.offset) { i, m in
                    if i > 0 { Spacer(minLength: 0) }
                    HStack(spacing: 3) {
                        Text(verbatim: wind.speedText(m))
                        if i == marks.count - 1 { Text(verbatim: Format.windUnit(wind.windUnit)).fontWeight(.semibold) }
                    }
                }
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.glett.text)
        }
        .accessibilityHidden(true)
    }

    private var line: some View {
        let w = wind
        let msg = w.error == "down" ? L10n.t("wm.err.down") : w.error != nil ? L10n.t("wm.err.net") : nil
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: msg ?? L10n.t(reduceMotion ? "wm.hint.still" : "wm.hint"))
                .font(.caption)
                .foregroundStyle(msg == nil ? Color.glett.text : Color.glett.bad)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if msg == nil, w.meta != nil {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { showsAbout.toggle() }
                } label: {
                    Text(verbatim: L10n.t("rm.about")).font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .tint(.glett.accent)
            }
        }
    }
}
