import GlettKit
import SwiftUI

/// MET warnings in force at the place, on the forecast: `WarningsSummary`, and on a tap `WarningsSheet` with MET's
/// text, its links and the models held against it (js/app.js:966-972, 2393-2416). Shows nothing when there are none.
///
/// Inputs: `model.alerts` ([MetAlert], most serious first; loaded by AppModel after the forecast).
struct WarningsBanner: View {
    let model: AppModel
    @State private var showsSheet = false

    var body: some View {
        if !model.alerts.isEmpty {
            Button { showsSheet = true } label: { WarningsSummary(alerts: model.alerts, now: model.now) }
                .buttonStyle(.plain)
                .accessibilityHint(Text(verbatim: L10n.t("s.alert.go")))
                .sheet(isPresented: $showsSheet) {
                    WarningsSheet(alerts: model.alerts, engine: model.engine, windUnit: model.windUnit, now: model.now, placeName: model.place?.name)
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                }
        }
    }
}

#Preview {
    WarningsBanner(model: .preview(alerts: WarningSamples.alerts)).padding()
}
