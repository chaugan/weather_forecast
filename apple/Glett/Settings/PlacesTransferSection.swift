import GlettKit
import SwiftData
import SwiftUI

/// Export and import of the saved places in the web's file format (`glett-locations.json`, js/data.js:618-622), so
/// places move between the app and glett.no: the same as the places sheet's buttons, as a shortcut in the settings.
struct PlacesTransferSection: View {
    let model: AppModel
    @Environment(\.modelContext) private var context
    @Query(sort: [SortDescriptor(\SavedPlace.order), SortDescriptor(\SavedPlace.created)]) private var saved: [SavedPlace]
    @State private var importing = false
    /// The last import's outcome: the text and whether it went well.
    @State private var message: (text: String, ok: Bool)?

    var body: some View {
        Section {
            // "Mine steder": add, remove, reorder (moved here from a tab, owner 2026-10-26: the tab bar is for tools)
            NavigationLink {
                PlacesView(model: model).navigationBarTitleDisplayMode(.inline)
            } label: {
                LabeledContent {
                    Text(verbatim: String(saved.count)).monospacedDigit()
                } label: {
                    Label { Text(verbatim: L10n.t("pb.saved")) } icon: { Image(systemName: "star") }
                }
            }
            ShareLink(item: PlacesExport(data: PlaceStore.exportJSON(saved)), preview: SharePreview(PlacesExport.filename)) {
                LabeledContent {
                    Text(app: "app.places.count", ["n": String(saved.count)]).monospacedDigit()
                } label: {
                    Label { Text(verbatim: L10n.t("pl.export")) } icon: { Image(systemName: "square.and.arrow.up") }
                }
            }
            .disabled(saved.isEmpty)
            .id("places")
            Button { importing = true } label: {
                Label { Text(verbatim: L10n.t("pl.import")) } icon: { Image(systemName: "square.and.arrow.down") }
            }
        } header: {
            Text(verbatim: L10n.t("nav.places"))
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                if let message {
                    Label { Text(verbatim: message.text) } icon: {
                        Image(systemName: message.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    }
                    .foregroundStyle(message.ok ? .glett.good : .glett.bad)
                }
                Text(app: "app.places.hint")
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json, .plainText]) { result in
            importFile(result)
        }
    }

    private func importFile(_ result: Result<URL, any Error>) {
        guard case .success(let url) = result else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let n = try PlaceStore.importJSON(try Data(contentsOf: url), into: context)
            message = (L10n.t("ok.imported", ["n": String(n)]), true)
        } catch {
            message = (L10n.t("err.import"), false)
        }
    }
}

#Preview {
    NavigationStack { Form { PlacesTransferSection(model: .preview()) } }.modelContainer(PlaceStore.previewContainer())
}
