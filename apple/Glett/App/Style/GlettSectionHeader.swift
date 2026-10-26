import SwiftUI

/// The title row of a card ("Dagene fremover", "Time for time · fra nå" with the step menu): headline, an optional
/// muted subtitle on the same baseline, an optional control at the trailing edge.
struct GlettSectionHeader<Trailing: View>: View {
    let title: String
    var subtitle: String?
    let trailing: Trailing

    init(title: String, subtitle: String? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: title)
                .font(.headline)
                .foregroundStyle(.glett.text)
                .accessibilityAddTraits(.isHeader)
            if let subtitle {
                Text(verbatim: subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.glett.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            trailing
        }
    }
}

extension GlettSectionHeader where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil) {
        self.init(title: title, subtitle: subtitle) { EmptyView() }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    VStack(spacing: 20) {
        GlettSectionHeader(title: "Dagene fremover")
        GlettSectionHeader(title: "Time for time", subtitle: "fra nå") {
            Button("1 time") {}.tint(.glett.accent)
        }
    }
    .padding()
}
