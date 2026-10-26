import GlettKit
import SwiftUI

/// Models that are an exact copy of another one here (outside their own area), greyed with "Samme data som …"
/// (`m.dup`, js/app.js:1030-1031). They are counted once and get no row of their own.
struct DuplicateModelsNote: View {
    let duplicates: [(provider: Provider, original: String)]

    var body: some View {
        if !duplicates.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(duplicates, id: \.provider.id) { d in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: Format.modelName(d.provider)).font(.caption.weight(.semibold))
                        Text(verbatim: L10n.t("m.dup", ["n": d.original])).font(.caption2)
                    }
                    .foregroundStyle(.glett.muted)
                    .opacity(0.8)
                    .accessibilityElement(children: .combine)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(Color.glett.summary, in: .rect(cornerRadius: 10))
        }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    DuplicateModelsNote(duplicates: [(Provider(id: "dmi_seamless", hourly: Hourly(values: [:], count: 0)), "ECMWF IFS")])
        .frame(width: 340)
        .padding()
}
