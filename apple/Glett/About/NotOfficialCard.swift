import SwiftUI

/// The terms from `footer.html`'s second line in a callout: the probabilities are model agreement and not an official
/// forecast (brief §10).
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
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.glett.mid.opacity(0.08), in: .rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.glett.mid.opacity(0.4)))
    }
}

#Preview {
    NotOfficialCard(html: AboutContent.footerParts().terms).padding()
}
