import GlettKit

/// The chips' groups as the web lists them (`renderChips`, js/app.js:1357-1363): "Mine steder", then "Sist søkt"
/// (recent places that are neither saved nor a city), then the cities not saved. Empty groups are left out.
struct PlaceGroup: Identifiable {
    enum Kind { case saved, recent, city }

    let kind: Kind
    let places: [Place]

    var id: Kind { kind }

    /// `pb.saved`, `pb.recent`, `pb.cities`.
    var titleKey: String {
        switch kind {
        case .saved: "pb.saved"
        case .recent: "pb.recent"
        case .city: "pb.cities"
        }
    }

    static func make(saved: [Place], recent: [Place]) -> [PlaceGroup] {
        let savedKeys = Set(saved.map(\.placeKey))
        let cityKeys = Set(Place.cities.map(\.placeKey))
        return [
            PlaceGroup(kind: .saved, places: saved),
            PlaceGroup(kind: .recent, places: recent.filter { !savedKeys.contains($0.placeKey) && !cityKeys.contains($0.placeKey) }),
            PlaceGroup(kind: .city, places: Place.cities.filter { !savedKeys.contains($0.placeKey) }),
        ].filter { !$0.places.isEmpty }
    }
}
