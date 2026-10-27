import GlettKit
import SwiftData
import SwiftUI

/// The place bar on Været (`.placebar`, index.html:62-74): the search and "Min posisjon" side by side (`.pb-row`),
/// then the chips in their groups, "Mine steder" first (`#chips`, `renderChips`, js/app.js:1357). The chips scroll
/// sideways and bring the shown place into view, as `scrollRowTo` does. The search is typed in place (`PlaceSearchField`).
struct PlaceChips: View {
    let model: AppModel
    @Query(sort: [SortDescriptor(\SavedPlace.order), SortDescriptor(\SavedPlace.created)]) private var saved: [SavedPlace]

    var body: some View {
        let groups = PlaceGroup.make(saved: saved.map(\.place), recent: model.recent)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                PlaceSearchField(model: model)
                // the search has the whole row while it is in use
                if !model.navigation.searchFocused {
                    MyLocationButton(model: model, compact: true)
                        .buttonStyle(.bordered)
                        .tint(.glett.accent)
                        .fixedSize()
                        .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.2), value: model.navigation.searchFocused)
            .zIndex(1)   // the inline search's hits drop down over the chips
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 14) {
                        ForEach(groups) { g in
                            HStack(spacing: 6) {
                                PlaceGroupLabel(group: g)
                                ForEach(g.places, id: \.placeKey) { p in
                                    PlaceChip(place: p, kind: g.kind, model: model).id(p.placeKey)
                                }
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
                .scrollClipDisabled()
                .onAppear { show(model.place, proxy) }
                .onChange(of: model.place?.placeKey) { _, _ in withAnimation { show(model.place, proxy) } }
            }
        }
    }

    private func show(_ p: Place?, _ proxy: ScrollViewProxy) {
        if let k = p?.placeKey { proxy.scrollTo(k, anchor: .center) }
    }
}

#Preview {
    PlaceChips(model: .preview()).padding().background(.glett.bg).modelContainer(PlaceStore.previewContainer())
}
