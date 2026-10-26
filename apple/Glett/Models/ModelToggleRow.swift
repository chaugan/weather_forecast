import GlettKit
import SwiftUI

/// One model in the list (`renderModels` row, js/app.js:1030-1038): the name, the region line, the reliability badge
/// and the switch; a duplicate is greyed with "Samme data som …" and has no switch.
struct ModelToggleRow: View {
    let provider: Provider
    /// The provider it copies (`dupOf`), by display name.
    var duplicateOf: String?
    let score: Int?
    @Binding var isOn: Bool

    var body: some View {
        if let duplicateOf {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: Format.modelName(provider)).font(.body.weight(.semibold))
                Text(verbatim: L10n.t("m.dup", ["n": duplicateOf])).font(.caption)
            }
            .foregroundStyle(.glett.muted)
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
        } else {
            Toggle(isOn: $isOn) {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: Format.modelName(provider))
                            .font(.body.weight(.semibold))
                            .foregroundStyle(isOn ? .glett.text : .glett.muted)
                        if let region = ReliabilityFormat.region(provider.id) {
                            Text(verbatim: region).font(.caption).foregroundStyle(.glett.muted)
                        }
                    }
                    Spacer(minLength: 4)
                    if let score { ScoreBadge(score: score).opacity(isOn ? 1 : 0.5) }
                }
            }
            .tint(.glett.accent)
            .padding(.vertical, 2)
        }
    }
}

#Preview {
    @Previewable @State var on = true
    let f = PreviewSamples.engine.forecast
    List {
        ModelToggleRow(provider: f.providers[0], score: 84, isOn: $on)
        ModelToggleRow(provider: f.providers[1], score: 63, isOn: .constant(false))
        ModelToggleRow(provider: f.providers[2], duplicateOf: "ECMWF IFS", score: nil, isOn: .constant(true))
    }
}
