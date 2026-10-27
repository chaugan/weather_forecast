import GlettKit
import SwiftData
import SwiftUI

/// The place bar on Været (`.placebar`, index.html:62-74): the search and "Min posisjon" side by side (`.pb-row`),
/// then the chips in their groups, "Mine steder" first (`#chips`, `renderChips`, js/app.js:1357). The chips scroll
/// sideways and bring the shown place into view, as `scrollRowTo` does. The search opens the places sheet.
struct PlaceChips: View {
    let model: AppModel
    @Query(sort: [SortDescriptor(\SavedPlace.order), SortDescriptor(\SavedPlace.created)]) private var saved: [SavedPlace]

    var body: some View {
        let groups = PlaceGroup.make(saved: saved.map(\.place), recent: model.recent)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                let inline = PlaceSearchStyle.current == .inline
                if inline { PlaceSearchField(model: model) } else { PlaceSearchButton(model: model) }
                // the inline search has the whole row while it is in use
                if !(inline && model.navigation.searchFocused) {
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

/// The search as the web's field looks (`.pb-search`): a wide rounded field with the magnifier and the prompt; it
/// opens the places sheet with the search focused.
struct PlaceSearchButton: View {
    let model: AppModel

    var body: some View {
        Button { model.searchPlaces() } label: {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.glett.muted)
                Text(verbatim: L10n.t("pb.search")).foregroundStyle(.glett.muted).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 40)
            .background(Color.glett.panel, in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.glett.line))
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    PlaceChips(model: .preview()).padding().background(.glett.bg).modelContainer(PlaceStore.previewContainer())
}
