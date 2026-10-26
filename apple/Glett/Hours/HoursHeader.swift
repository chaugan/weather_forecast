import GlettKit
import SwiftUI

/// The head of the hour card (`.hours-h` and the step select, index.html:156-170): "Time for time · fra nå", the step
/// (1/3/6/12 h) and the three views. Both choices are stored as settings (`glett.step`, `glett.orient2`).
struct HoursHeader: View {
    @Bindable var model: AppModel
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: L10n.t("hrs.title"))
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.glett.text)
                    .accessibilityAddTraits(.isHeader)
                Text(verbatim: subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.glett.muted)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Picker(selection: $model.step) {
                    ForEach(StepAggregation.steps, id: \.self) { s in Text(verbatim: L10n.t("step.\(s)")).tag(s) }
                } label: {
                    Text(verbatim: L10n.t("tb.step"))
                }
                .pickerStyle(.menu)
                .tint(.glett.accent)
                .fixedSize()
                .accessibilityLabel(Text(verbatim: L10n.t("tb.step")))
            }
            Picker(selection: $model.hourView) {
                Text(verbatim: L10n.t("orient.v")).tag(HourView.timeDown)
                Text(verbatim: L10n.t("orient.h")).tag(HourView.timeAcross)
                Text(verbatim: L10n.t("orient.m")).tag(HourView.meteogram)
            } label: {
                Text(verbatim: L10n.t("hrs.title"))
            }
            .pickerStyle(.segmented)
        }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    HoursHeader(model: .preview(), subtitle: "fra nå").frame(width: 360).padding()
}
