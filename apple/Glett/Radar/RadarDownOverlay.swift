import SwiftUI

/// The rain map's outage note (`.rm-down`, js/app.js:2644-2651, css/style.css): over the whole map, the base map dimmed
/// beneath it, centred text that takes no touches. The words are the web's, so web and app say the same.
struct RadarDownOverlay: View {
    /// MET's composite (the Nordic area), else RainViewer.
    let met: Bool
    /// The now card's strip shows MET's radar nowcast, which still works.
    let stripWorks: Bool

    var body: some View {
        VStack(spacing: 6) {
            Text(verbatim: L10n.t("rm.down"))
                .font(.headline)
                .foregroundStyle(.glett.text)
            Text(verbatim: Self.body(met: met, stripWorks: stripWorks))
                .font(.subheadline)
                .foregroundStyle(.glett.muted)
                .frame(maxWidth: 34 * 13.5)
        }
        .multilineTextAlignment(.center)
        .lineSpacing(2)
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.glett.panel.opacity(0.84))
        .allowsHitTesting(false)
        .accessibilityElement(children: .combine)
    }

    /// `rm.down.met`/`rm.down.rv`, `rm.down.retry`, and `rm.down.strip` naming the strip by its title.
    static func body(met: Bool, stripWorks: Bool) -> String {
        var s = L10n.t(met ? "rm.down.met" : "rm.down.rv") + " " + L10n.t("rm.down.retry")
        if stripWorks { s += " " + L10n.t("rm.down.strip", ["name": L10n.t("radar.title")]) }
        return s
    }

    /// What VoiceOver announces when the radar goes down (the web's `role="status"`).
    static func text(met: Bool, stripWorks: Bool) -> String {
        L10n.t("rm.down") + ". " + body(met: met, stripWorks: stripWorks)
    }
}

#Preview {
    ZStack {
        Color.green.opacity(0.3)
        RadarDownOverlay(met: true, stripWorks: true)
    }
}
