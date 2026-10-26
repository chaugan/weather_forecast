import SwiftUI

/// "Hva er Glett?" with the sources, licences and terms: the web's `about.html` as cards, the "not an official
/// forecast" terms, each data source with its licence and link, the full credits of `footer.html` (as text, no HTML),
/// what the device sends to whom, and the app's version.
struct AttributionView: View {
    var body: some View {
        let footer = AboutContent.footerParts()
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    AboutHeader()
                    ForEach(AboutContent.aboutSections()) { s in
                        VStack(alignment: .leading, spacing: 8) {
                            if let t = s.title { Text(verbatim: t).font(.headline) }
                            Text(SimpleHTML.attributed(s.html)).font(s.title == nil ? .body : .callout)
                        }
                        .foregroundStyle(.glett.text)
                        .glettCard()
                    }
                    NotOfficialCard(html: footer.terms).id("terms")
                    VStack(alignment: .leading, spacing: 0) {
                        Text(app: "app.sources").font(.headline).padding(.bottom, 4)
                        ForEach(AttributionSource.all) { s in
                            SourceRow(source: s)
                            if s.id != AttributionSource.all.last?.id { Divider() }
                        }
                    }
                    .glettCard()
                    .id("sources")
                    VStack(alignment: .leading, spacing: 8) {
                        Text(app: "app.credits").font(.headline)
                        Text(SimpleHTML.attributed(footer.credits)).font(.footnote)
                    }
                    .foregroundStyle(.glett.text)
                    .glettCard()
                    .id("credits")
                    PrivacyCard().id("privacy")
                    Text(verbatim: AppText.t("app.brand") + " · " + AppText.t("app.version") + " " + AppVersion.text)
                        .font(.caption)
                        .foregroundStyle(.glett.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, 8)
                }
                .tint(.glett.accent)
                .padding(16)
                .frame(maxWidth: 720, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .task {
                if let a = ScreenshotHook.take("-GlettScroll") {
                    try? await Task.sleep(for: .milliseconds(400))
                    proxy.scrollTo(a, anchor: .top)
                }
            }
        }
        .background(.glett.bg)
        .navigationTitle(Text(verbatim: L10n.t("about.btn")))
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    NavigationStack { AttributionView() }
}

#Preview("Dark") {
    NavigationStack { AttributionView() }.preferredColorScheme(.dark)
}
