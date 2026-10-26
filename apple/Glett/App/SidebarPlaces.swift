import GlettKit
import SwiftData
import SwiftUI

/// The places at the top of the regular-width sidebar: the search and "Min posisjon", then the chips in the web's
/// groups ("Mine steder", "Sist søkt", "Byer"), each under its label and wrapping. The search opens the places sheet.
struct SidebarPlaces: View {
    let model: AppModel
    @Query(sort: [SortDescriptor(\SavedPlace.order), SortDescriptor(\SavedPlace.created)]) private var saved: [SavedPlace]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PlaceSearchButton(model: model)
            MyLocationButton(model: model, compact: true)
                .buttonStyle(.bordered)
                .tint(.glett.accent)
            ForEach(PlaceGroup.make(saved: saved.map(\.place), recent: model.recent)) { g in
                VStack(alignment: .leading, spacing: 6) {
                    PlaceGroupLabel(group: g)
                    FlowLayout(spacing: 6, lineSpacing: 6) {
                        ForEach(g.places, id: \.placeKey) { PlaceChip(place: $0, kind: g.kind, model: model) }
                    }
                }
            }
        }
    }
}

#Preview {
    SidebarPlaces(model: .preview())
        .padding()
        .modelContainer(PlaceStore.previewContainer())
}
