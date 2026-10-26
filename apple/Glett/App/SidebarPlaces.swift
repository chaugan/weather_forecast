import GlettKit
import SwiftData
import SwiftUI

/// The places at the top of the regular-width sidebar: the search and "Min posisjon", then the saved places (or the
/// cities when none are saved), the shown one highlighted. The search opens the Steder tab with its search focused.
struct SidebarPlaces: View {
    let model: AppModel
    @Query(sort: [SortDescriptor(\SavedPlace.order), SortDescriptor(\SavedPlace.created)]) private var saved: [SavedPlace]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { model.searchPlaces() } label: {
                Label { Text(verbatim: L10n.t("pb.search")).frame(maxWidth: .infinity, alignment: .leading) } icon: {
                    Image(systemName: "magnifyingglass")
                }
            }
            .buttonStyle(.bordered)
            .tint(.glett.accent)
            MyLocationButton(model: model, compact: true)
                .buttonStyle(.bordered)
                .tint(.glett.accent)
            Text(verbatim: L10n.t(saved.isEmpty ? "pb.cities" : "pb.saved")).font(.caption.weight(.semibold)).foregroundStyle(.glett.muted)
            FlowLayout(spacing: 6, lineSpacing: 6) {
                ForEach(places, id: \.placeKey) { p in
                    let on = model.place?.placeKey == p.placeKey
                    Button { model.select(p) } label: { Text(verbatim: p.name).lineLimit(1) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .tint(on ? Color.glett.accent : Color.glett.muted)
                        .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
    }

    private var places: [Place] { saved.isEmpty ? Place.cities : saved.map(\.place) }
}

#Preview {
    SidebarPlaces(model: .preview())
        .padding()
        .modelContainer(PlaceStore.previewContainer())
        .environment(LanguageSettings.shared)
}
