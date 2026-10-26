import GlettKit
import SwiftData
import SwiftUI

/// The place name as a menu (iPad sidebar, owner 2026-10-26): "Min posisjon", the search, "Mine steder" with the shown
/// place ticked, then "Sist søkt" and "Byer" as submenus (the cities inline while nothing is saved). The same groups
/// as the web's chips (`PlaceGroup`), in a quieter form.
struct PlaceMenu<Label: View>: View {
    let model: AppModel
    @ViewBuilder let label: () -> Label
    @Query(sort: [SortDescriptor(\SavedPlace.order), SortDescriptor(\SavedPlace.created)]) private var saved: [SavedPlace]
    @State private var locationFailed = false

    var body: some View {
        let groups = PlaceGroup.make(saved: saved.map(\.place), recent: model.recent)
        Menu {
            Section {
                Button {
                    Task { if await !model.selectMyLocation() { locationFailed = true } }
                } label: {
                    SwiftUI.Label { Text(verbatim: L10n.t("pb.geo")) } icon: { Image(systemName: "location") }
                }
                Button { model.searchPlaces() } label: {
                    SwiftUI.Label { Text(verbatim: L10n.t("pb.search")) } icon: { Image(systemName: "magnifyingglass") }
                }
            }
            ForEach(groups) { g in
                if g.kind == .saved || (g.kind == .city && !groups.contains { $0.kind == .saved }) {
                    Section(L10n.t(g.titleKey)) { items(g) }
                } else {
                    Menu(L10n.t(g.titleKey)) { items(g) }
                }
            }
        } label: {
            label()
        }
        .alert(Text(verbatim: L10n.t("pb.geo")), isPresented: $locationFailed) {
            // the system's own OK
        } message: {
            Text(verbatim: AppText.t("app.geo.fail"))
        }
    }

    @ViewBuilder
    private func items(_ g: PlaceGroup) -> some View {
        ForEach(g.places, id: \.placeKey) { p in
            let on = model.place?.placeKey == p.placeKey
            Button { model.select(p, recent: g.kind == .recent) } label: {
                if on {
                    SwiftUI.Label { Text(verbatim: p.name) } icon: { Image(systemName: "checkmark") }
                } else if g.kind == .saved {
                    SwiftUI.Label { Text(verbatim: p.name) } icon: { Image(systemName: "star.fill") }
                } else {
                    Text(verbatim: p.name)
                }
            }
        }
    }
}

#Preview {
    PlaceMenu(model: .preview()) { Text(verbatim: "Oslo ⌄") }
        .padding()
        .modelContainer(PlaceStore.previewContainer())
}
