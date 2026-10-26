import SwiftUI

/// The column heads above the ranking: "Modell", "Poeng", "Siste 7 dager" (`r.model`, `r.score`, `r.score7`).
struct ReliabilityHeader: View {
    static let scoreWidth: CGFloat = 46
    static let score7Width: CGFloat = 52

    var body: some View {
        HStack(alignment: .bottom, spacing: 12) {
            Text(verbatim: L10n.t("r.model"))
            Spacer()
            Text(verbatim: L10n.t("r.score")).frame(width: Self.scoreWidth)
            Text(verbatim: L10n.stripped("r.score7"))
                .multilineTextAlignment(.center)
                .frame(width: Self.score7Width)
        }
        // the rows below are links: leave room for their chevron so the columns line up
        .padding(.trailing, 22)
        .font(.caption.weight(.semibold))
        .textCase(nil)
        .foregroundStyle(.glett.muted)
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    ReliabilityHeader().padding()
}
