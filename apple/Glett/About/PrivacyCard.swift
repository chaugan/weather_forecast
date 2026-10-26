import SwiftUI

/// What the device sends to whom (brief §11): no account, no tracking, nothing about the user stored on a server; the
/// coordinates go to Open-Meteo, MET Norway and glett.no, the location only on "Min posisjon".
struct PrivacyCard: View {
    private struct Item: Identifiable {
        let id: String
        let icon: String
    }

    private let items = [
        Item(id: "app.privacy.om", icon: "cloud.sun"),
        Item(id: "app.privacy.met", icon: "dot.radiowaves.left.and.right"),
        Item(id: "app.privacy.glett", icon: "server.rack"),
        Item(id: "app.privacy.apple", icon: "location"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label { Text(app: "app.privacy").font(.headline) } icon: {
                Image(systemName: "hand.raised.fill").foregroundStyle(.glett.accent)
            }
            Text(app: "app.privacy.lead").font(.callout)
            ForEach(items) { item in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: item.icon)
                        .font(.footnote)
                        .foregroundStyle(.glett.muted)
                        .frame(width: 20)
                    Text(app: item.id).font(.footnote)
                }
            }
            Link(destination: AboutContent.privacyURL) {
                Label { Text(app: "app.privacy.more") } icon: { Image(systemName: "arrow.up.right") }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.glett.accent)
            }
            .padding(.top, 2)
        }
        .foregroundStyle(.glett.text)
        .glettCard()
    }
}

#Preview {
    PrivacyCard().padding()
}
