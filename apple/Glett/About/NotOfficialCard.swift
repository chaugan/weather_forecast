import SwiftUI

/// The terms from `footer.html`'s second line, as a row of the about list tinted like the web's callout: the
/// probabilities are model agreement and not an official forecast (brief §10).
struct NotOfficialCard: View {
    let html: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label { Text(app: "app.notofficial").font(.headline) } icon: {
                Image(systemName: "exclamationmark.shield.fill").foregroundStyle(.glett.mid)
            }
            Text(SimpleHTML.attributed(html)).font(.footnote)
        }
        .foregroundStyle(.glett.text)
        .padding(.vertical, 4)
        .listRowBackground(
            Color.glett.mid.opacity(0.08).background(Color(uiColor: .secondarySystemGroupedBackground))
        )
    }
}

#Preview {
    List { NotOfficialCard(html: AboutContent.footerParts().terms) }
}
