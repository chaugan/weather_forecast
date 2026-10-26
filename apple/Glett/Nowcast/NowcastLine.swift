import GlettKit
import SwiftUI

/// "Neste glett" and the radar strip in the now card (js/app.js:953-964 and 1239-1274): whether rain starts or stops
/// within 90 minutes, from MET's radar nowcast (or Open-Meteo's 15-minute model where the radar does not reach), then
/// the precipitation rate for the next two hours as bars. Shows nothing without a nowcast.
///
/// Inputs: `model.nowcast` (NowcastSeries?, loaded by AppModel after the forecast), `model.now`.
struct NowcastLine: View {
    let nowcast: NowcastSeries?
    let now: Date

    init(model: AppModel) {
        self.init(nowcast: model.nowcast, now: model.now)
    }

    init(nowcast: NowcastSeries?, now: Date) {
        self.nowcast = nowcast; self.now = now
    }

    var body: some View {
        let next = NextGlett.evaluate(nowcast, now: now)
        let strip = RadarStrip.make(nowcast, now: now)
        if next != nil || strip != nil {
            VStack(alignment: .leading, spacing: 12) {
                if let next { line(next) }
                if let strip {
                    RadarStripView(strip: strip)
                        .padding(12)
                        .background(.glett.bg.opacity(0.6), in: .rect(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.glett.line))
                }
            }
        }
    }

    /// The summary item `.sum.nowcast` (css/style.css:359-360, 727, 1328): the weather icon for wet or dry, the bold
    /// label, the sentence, and "(modell)" when it is the model fallback.
    private func line(_ n: NextGlett) -> some View {
        HStack(alignment: .center, spacing: 8) {
            WeatherIcon(code: n.wetNow ? 63 : 1, size: 24)
            Text(sentence(n))
                .font(.footnote.weight(.medium))
                .foregroundStyle(.glett.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.glett.bolt.opacity(0.07), in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.glett.bolt.opacity(0.45)))
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text(verbatim: L10n.t(n.model ? "nc.src.model" : "nc.src")))
    }

    private func sentence(_ n: NextGlett) -> AttributedString {
        var label = AttributedString(L10n.t("nc.label") + ": ")
        label.inlinePresentationIntent = .stronglyEmphasized
        label.foregroundColor = .glett.accent2
        var out = label + AttributedString(L10n.t(n.key, ["h": n.time.map(Format.time) ?? ""]))
        if n.model {
            var m = AttributedString(" " + L10n.t("nc.model"))
            m.foregroundColor = .glett.muted
            out += m
        }
        return out
    }
}

#Preview {
    let model = AppModel.preview()
    ScrollView {
        NowcastLine(model: model).padding()
    }
    .background(.glett.panel)
}
