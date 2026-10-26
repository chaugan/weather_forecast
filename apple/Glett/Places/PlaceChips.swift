import GlettKit
import SwiftData
import SwiftUI

/// The chips under the search (`#chips`, `renderChips`, js/app.js:1357): the saved places, then the cities not saved;
/// the shown place is highlighted. Scrolls sideways.
struct PlaceChips: View {
    let model: AppModel
    @Query(sort: [SortDescriptor(\SavedPlace.order), SortDescriptor(\SavedPlace.created)]) private var saved: [SavedPlace]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Button { model.showPlaces = true } label: {
                    Label { Text(verbatim: L10n.t("pb.search")) } icon: { Image(systemName: "magnifyingglass") }
                }
                .buttonStyle(.bordered)
                .tint(.glett.accent)
                ForEach(places, id: \.placeKey) { p in
                    let on = model.place?.placeKey == p.placeKey
                    Button { model.select(p) } label: {
                        Text(verbatim: p.name).lineLimit(1)
                    }
                    .buttonStyle(.bordered)
                    .tint(on ? Color.glett.accent : Color.glett.muted)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            .padding(.vertical, 2)
        }
        .scrollClipDisabled()
    }

    private var places: [Place] {
        let s = saved.map(\.place)
        let keys = Set(s.map(\.placeKey))
        return s + Place.cities.filter { !keys.contains($0.placeKey) }
    }
}

#Preview {
    PlaceChips(model: .preview()).padding().modelContainer(PlaceStore.previewContainer())
}
