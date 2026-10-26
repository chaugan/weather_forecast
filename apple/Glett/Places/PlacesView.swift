import GlettKit
import SwiftData
import SwiftUI
import UniformTypeIdentifiers

/// "Mine steder" (`#view-places` and the place bar, index.html:58-72, 202-232): search as you type (Open-Meteo, as
/// the forecast page's search), "Min posisjon", the saved places (delete, reorder), the cities, and the web's JSON
/// import/export. Picking a place shows it and closes the sheet.
struct PlacesView: View {
    let model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @Query(sort: [SortDescriptor(\SavedPlace.order), SortDescriptor(\SavedPlace.created)]) private var saved: [SavedPlace]

    @State private var query = ""
    @State private var hits: [PlaceHit] = []
    @State private var searching = false
    @State private var searchError: String?
    @State private var message: (text: String, ok: Bool)?
    @State private var importing = false

    /// `SEARCH_DEBOUNCE` of the web's place search (GlettKit API.md: 350 ms, 2 characters).
    static let debounce: Duration = .milliseconds(350)
    static let minQuery = 2

    var body: some View {
        NavigationStack {
            List {
                if query.trimmingCharacters(in: .whitespaces).count >= Self.minQuery {
                    searchResults
                } else {
                    places
                }
            }
            .navigationTitle(Text(verbatim: L10n.t("nav.places")))
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: Text(verbatim: L10n.t("pb.search")))
            .autocorrectionDisabled()
            .task(id: query) { await search(query) }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Text(verbatim: L10n.t("h.close")) }
                }
                ToolbarItem(placement: .primaryAction) {
                    if !saved.isEmpty { EditButton() }
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json, .plainText]) { result in
                importFile(result)
            }
        }
    }

    // MARK: Search

    @ViewBuilder
    private var searchResults: some View {
        Section {
            if searching && hits.isEmpty {
                HStack { ProgressView(); Spacer() }
            } else if let searchError {
                Text(verbatim: searchError).foregroundStyle(.glett.bad)
            } else if hits.isEmpty {
                Text(verbatim: L10n.t("search.none")).foregroundStyle(.glett.muted)
            }
            ForEach(hits) { hit in
                Button { pick(hit.place()) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: hit.placeName).foregroundStyle(.glett.text)
                        Text(verbatim: hit.sub ?? hit.name).font(.caption).foregroundStyle(.glett.muted)
                    }
                }
            }
        }
    }

    private func search(_ q: String) async {
        let q = q.trimmingCharacters(in: .whitespaces)
        guard q.count >= Self.minQuery else { hits = []; searchError = nil; return }
        do { try await Task.sleep(for: Self.debounce) } catch { return }
        searching = true
        defer { searching = false }
        do {
            let r = try await model.service.search(q, lang: model.lang)
            guard !Task.isCancelled else { return }
            hits = r
            searchError = nil
        } catch let e as GlettError {
            guard !Task.isCancelled else { return }
            hits = []
            searchError = e.verbatim ?? L10n.t(e.l10nKey, e.l10nArgs)
        } catch {
            return
        }
    }

    // MARK: Places

    @ViewBuilder
    private var places: some View {
        Section {
            MyLocationButton(model: model) { dismiss() }
            if let message {
                Text(verbatim: message.text).font(.footnote).foregroundStyle(message.ok ? Color.glett.good : Color.glett.bad)
            }
        }
        Section {
            if saved.isEmpty {
                Text(verbatim: L10n.t("saved.none")).foregroundStyle(.glett.muted)
            }
            ForEach(saved) { s in
                Button { pick(s.place) } label: { placeRow(s.place) }
            }
            .onDelete { idx in
                for i in idx { PlaceStore.remove(saved[i], in: context) }
            }
            .onMove { from, to in
                var list = saved
                list.move(fromOffsets: from, toOffset: to)
                PlaceStore.reorder(list, in: context)
            }
        } header: {
            Text(verbatim: L10n.t("pl.saved"))
        }
        Section {
            ForEach(Place.cities) { c in
                Button { pick(c) } label: { placeRow(c) }
            }
        } header: {
            Text(verbatim: L10n.t("pb.cities"))
        }
        Section {
            Button { importing = true } label: {
                Label { Text(verbatim: L10n.t("pl.import")) } icon: { Image(systemName: "square.and.arrow.down") }
            }
            ShareLink(item: PlacesExport(data: PlaceStore.exportJSON(saved)), preview: SharePreview(PlacesExport.filename)) {
                Label { Text(verbatim: L10n.t("pl.export")) } icon: { Image(systemName: "square.and.arrow.up") }
            }
            .disabled(saved.isEmpty)
        }
    }

    private func placeRow(_ p: Place) -> some View {
        let on = model.place?.placeKey == p.placeKey
        return HStack {
            Text(verbatim: p.name).foregroundStyle(.glett.text)
            Spacer()
            if on { Image(systemName: "checkmark").foregroundStyle(.glett.accent) }
        }
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func pick(_ p: Place, geo: Bool = false) {
        model.select(p, geo: geo)
        dismiss()
    }

    // MARK: Import

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
    PlacesView(model: .preview()).modelContainer(PlaceStore.previewContainer())
}
