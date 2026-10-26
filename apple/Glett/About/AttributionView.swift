import SwiftUI

/// "Hva er Glett?" with the sources, licences and terms: the web's `about.html` by section, the "not an official
/// forecast" terms, each data source with its licence and link, the full credits of `footer.html` (as text, no HTML),
/// what the device sends to whom, and the app's version.
struct AttributionView: View {
    var body: some View {
        let footer = AboutContent.footerParts()
        ScrollViewReader { proxy in
            List {
                Section {
                    AboutHeader().listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
                ForEach(AboutContent.aboutSections()) { s in
                    Section {
                        Text(SimpleHTML.attributed(s.html)).font(.body).foregroundStyle(.glett.text)
                    } header: {
                        if let t = s.title { Text(verbatim: t) }
                    }
                }
                Section {
                    NotOfficialCard(html: footer.terms).id("terms")
                }
                Section {
                    ForEach(AttributionSource.all) { s in
                        SourceRow(source: s).id(s.id == AttributionSource.all.first?.id ? "sources" : s.id)
                    }
                } header: {
                    Text(app: "app.sources")
                }
                Section {
                    Text(SimpleHTML.attributed(footer.credits)).font(.footnote).foregroundStyle(.glett.text).id("credits")
                } header: {
                    Text(app: "app.credits")
                }
                PrivacySection(anchor: "privacy")
            }
            .listStyle(.insetGrouped)
            .tint(.glett.accent)
            .task {
                if let a = ScreenshotHook.take("-GlettScroll") {
                    try? await Task.sleep(for: .milliseconds(400))
                    proxy.scrollTo(a, anchor: .top)
                }
            }
        }
        .navigationTitle(Text(verbatim: L10n.t("about.btn")))
    }
}

#Preview {
    NavigationStack { AttributionView().glettSheetRoot() }
}

#Preview("Dark") {
    NavigationStack { AttributionView().glettSheetRoot() }.preferredColorScheme(.dark)
}
