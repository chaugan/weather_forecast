import GlettKit
import SwiftUI

/// The warnings box on the forecast (the `s.alert` line of `renderSummary`, js/app.js:966-972, as a list): MET's
/// triangle in each warning's colour, the title, and level · period · how long until it starts or ends.
struct WarningsSummary: View {
    /// Most serious first (`MetAlert` order from `AlertsResponse.here`).
    let alerts: [MetAlert]
    let now: Date

    var body: some View {
        let tint = alerts.first.flatMap { WarningTriangle.fill[$0.level] } ?? WarningTriangle.unknownFill
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(verbatim: L10n.t("s.alert"))
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.glett.accent2)
                Spacer(minLength: 8)
                if alerts.count > 1 {
                    Text(verbatim: String(alerts.count)).font(.subheadline.weight(.semibold)).foregroundStyle(.glett.accent2)
                }
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.glett.accent2)
            }
            .accessibilityHidden(true)
            ForEach(alerts) { row($0) }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.12), in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(tint.opacity(0.65), lineWidth: 1))
        .contentShape(.rect(cornerRadius: 14))
    }

    private func row(_ a: MetAlert) -> some View {
        HStack(alignment: .center, spacing: 10) {
            WarningTriangle(a, width: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: a.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.glett.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text(verbatim: [AlertText.levelLine(a), AlertText.span(a), AlertText.state(a, now: now) ?? ""]
                    .filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.footnote)
                    .foregroundStyle(.glett.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: "\(L10n.t("s.alert")): \(a.name), \(AlertText.level(a)), \(AlertText.span(a))"))
    }
}

#Preview {
    WarningsSummary(alerts: WarningSamples.alerts, now: PreviewSamples.fixtureNow).padding()
}
