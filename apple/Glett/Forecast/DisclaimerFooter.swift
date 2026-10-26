import SwiftUI

/// The forecast page's footer (`footer.short`): data by Open-Meteo and MET Norway, map © Kartverket, "ikke et
/// offisielt varsel" — the probabilities are model agreement — and the way to the full sources and terms.
struct DisclaimerFooter: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L10n.attributed("footer.short"))
                .font(.caption)
                .foregroundStyle(.glett.muted)
                .tint(.glett.accent)
            Button { model.path.append(.about) } label: {
                Text(verbatim: L10n.t("footer.more")).font(.caption.weight(.semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.glett.accent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }
}

#Preview {
    DisclaimerFooter(model: .preview()).padding()
}
