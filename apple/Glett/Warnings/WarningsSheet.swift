import GlettKit
import SwiftUI

/// The warnings in force at the place, in full (the web's warnings list under the local map, `lmRenderAlerts`,
/// js/app.js:2393-2416): one `WarningCard` each, most serious first, and the legend of the gauges.
struct WarningsSheet: View {
    let alerts: [MetAlert]
    /// For the gauges; nil before the forecast is in.
    let engine: ConsensusEngine?
    let windUnit: WindUnit
    let now: Date
    let placeName: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if alerts.isEmpty {
                        Text(verbatim: L10n.t("lm.alerts.none")).foregroundStyle(.glett.muted)
                    }
                    let gauges = alerts.map { a in engine.flatMap { AlertGauge(alert: a, engine: $0, windUnit: windUnit) } }
                    ForEach(Array(alerts.enumerated()), id: \.element.id) { i, a in
                        if i > 0 { Divider().overlay(Color.glett.line).padding(.vertical, 14) }
                        WarningCard(alert: a, gauge: gauges[i], now: now)
                    }
                    if gauges.contains(where: { $0 != nil }) {
                        Text(verbatim: L10n.t("lm.aw.legend"))
                            .font(.caption)
                            .foregroundStyle(.glett.muted)
                            .padding(.top, 14)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(16)
                .frame(maxWidth: 640, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background(.glett.panel)
            .navigationTitle(Text(verbatim: placeName.map { "\(L10n.t("s.alert")) · \($0)" } ?? L10n.t("s.alert")))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { dismiss() } label: { Text(verbatim: L10n.t("ui.close")) }
                }
            }
        }
    }
}

#Preview {
    Color.clear.sheet(isPresented: .constant(true)) {
        WarningsSheet(alerts: WarningSamples.alerts, engine: PreviewSamples.engine, windUnit: .ms, now: PreviewSamples.fixtureNow, placeName: "Oslo")
    }
}
