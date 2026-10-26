import GlettKit
import SwiftData
import SwiftUI

/// The place heading (`.placehead`, index.html:110-113): the name (◎ and a "Min posisjon" tag for the device's
/// position), the star that saves it, and "lat, lon · el moh. · a/n modeller · oppdatert hh:mm".
struct PlaceHeader: View {
    let model: AppModel
    @Environment(\.modelContext) private var context
    @Query(sort: \SavedPlace.order) private var saved: [SavedPlace]

    var body: some View {
        if let place = model.place {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if model.placeIsGeo {
                        Image(systemName: "location.fill").font(.title3).foregroundStyle(.glett.accent).accessibilityHidden(true)
                    }
                    Text(verbatim: place.name)
                        .font(.title.weight(.heavy))
                        .foregroundStyle(.glett.text)
                        .lineLimit(2)
                    if model.placeIsGeo, place.name != L10n.t("pb.geo.name") {
                        Text(verbatim: L10n.t("pb.geo.name"))
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 9).padding(.vertical, 2)
                            .background(.glett.accent, in: .capsule)
                            .foregroundStyle(.white)
                    }
                    Spacer(minLength: 4)
                    starButton(place)
                }
                if let meta = metaLine { Text(verbatim: meta).font(.caption).foregroundStyle(.glett.muted) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func isSaved(_ p: Place) -> SavedPlace? {
        let k = p.placeKey
        return saved.first { $0.placeKey == k }
    }

    private func starButton(_ place: Place) -> some View {
        let s = isSaved(place)
        return Button {
            if let s { PlaceStore.remove(s, in: context) } else { PlaceStore.save(place, in: context) }
        } label: {
            Image(systemName: s != nil ? "star.fill" : "star")
                .font(.title2)
                .foregroundStyle(s != nil ? Color.glett.sun : Color.glett.muted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: L10n.t(s != nil ? "pb.unstar" : "pb.star")))
        .accessibilityAddTraits(s != nil ? .isSelected : [])
    }

    /// `hero.meta` · `hero.models` (js/app.js:1069, 1093).
    private var metaLine: String? {
        guard let b = model.bundle else { return nil }
        let f = b.forecast
        var parts = [L10n.t("hero.meta", ["lat": JS.toFixed(f.lat, 3), "lon": JS.toFixed(f.lon, 3), "el": JS.fmt(f.elevation ?? 0)])]
        if let c = model.modelCounts {
            parts.append(L10n.t("hero.models", ["a": String(c.active), "n": String(c.unique), "time": Format.fetched(f.generated, now: model.now)]))
        }
        return parts.joined(separator: " · ")
    }
}

#Preview {
    PlaceHeader(model: .preview()).padding().modelContainer(PlaceStore.previewContainer())
}
