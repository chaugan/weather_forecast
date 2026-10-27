import GlettKit
import SwiftData
import SwiftUI
import UniformTypeIdentifiers

/// "Mine steder" (`#view-places` and the place bar, index.html:58-72, 202-232): search as you type (Open-Meteo, as
/// the forecast page's search), "Min posisjon", the saved places (delete, reorder), the cities, and the web's JSON
/// import/export. Shown from Settings → "Mine steder"; picking a place closes
/// the sheet and shows it on Været.
struct PlacesView: View {
    let model: AppModel
    @Environment(\.modelContext) private var context
    @Query(sort: [SortDescriptor(\SavedPlace.order), SortDescriptor(\SavedPlace.created)]) private var saved: [SavedPlace]

    @State private var search = PlaceSearch()
    @State private var message: (text: String, ok: Bool)?
    @State private var importing = false
    @FocusState private var focused: Bool

    var body: some View {
        List {
            if search.active {
                Section { PlaceSearchRows(search: search) { pick($0, recent: true) } }
            } else {
                places
            }
        }
        .navigationTitle(Text(verbatim: L10n.t("nav.places")))
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: $search.query, placement: .navigationBarDrawer(displayMode: .always), prompt: Text(verbatim: L10n.t("pb.search")))
        .searchFocused($focused)
        .autocorrectionDisabled()
        .task(id: search.query) { await search.run(model) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if !saved.isEmpty { EditButton() }
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json, .plainText]) { result in
            importFile(result)
        }
    }

    // MARK: Places

    @ViewBuilder
    private var places: some View {
        Section {
            MyLocationButton(model: model) { showWeather() }
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
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { PlaceStore.remove(s, in: context) } label: {
                            Label { Text(verbatim: L10n.t("saved.delete")) } icon: { Image(systemName: "trash") }
                        }
                    }
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

    /// A search hit goes under "Sist søkt" (js/app.js:1410); a saved place or a city does not.
    private func pick(_ p: Place, geo: Bool = false, recent: Bool = false) {
        model.select(p, geo: geo, recent: recent)
        showWeather()
    }

    /// Back to Været with the search cleared, as a fresh visit to Steder starts with the places.
    private func showWeather() {
        search.query = ""
        focused = false
        model.navigation.tab = .weather
        model.navigation.sheet = nil
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
