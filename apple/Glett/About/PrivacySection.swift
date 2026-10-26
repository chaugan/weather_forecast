import SwiftUI

/// What the device sends to whom (brief §11): no account, no tracking, nothing about the user stored on a server; the
/// coordinates go to Open-Meteo, MET Norway and glett.no, the location only on "Min posisjon". The last section of
/// the about list, with the app's version in its footer.
struct PrivacySection: View {
    /// The `-GlettScroll` anchor on the first row.
    var anchor: String?

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
        Section {
            Text(app: "app.privacy.lead").font(.body).foregroundStyle(.glett.text).id(anchor)
            ForEach(items) { item in
                Label { Text(app: item.id).font(.footnote).foregroundStyle(.glett.text) } icon: {
                    Image(systemName: item.icon).foregroundStyle(.glett.muted)
                }
            }
            Link(destination: AboutContent.privacyURL) {
                Label { Text(app: "app.privacy.more") } icon: { Image(systemName: "arrow.up.right") }
            }
        } header: {
            Label { Text(app: "app.privacy") } icon: { Image(systemName: "hand.raised.fill") }
        } footer: {
            Text(verbatim: AppText.t("app.brand") + " · " + AppText.t("app.version") + " " + AppVersion.text)
        }
    }
}

#Preview {
    List { PrivacySection() }
}
