import AppIntents
import GlettKit
import WidgetKit

/// A place a widget can show: the place last viewed in the app, "Min posisjon", or one of the saved places
/// (long-press the widget → Edit). Each widget has its own.
struct WidgetPlace: AppEntity {
    static let lastID = "last"
    static let geoID = "geo"

    /// `lastID`, `geoID`, or the saved place's id ("saved:<uid>").
    let id: String
    let name: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation { TypeDisplayRepresentation(name: "Sted") }
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
    static var defaultQuery: WidgetPlaceQuery { WidgetPlaceQuery() }

    static var last: WidgetPlace { WidgetPlace(id: lastID, name: AppText.t("app.w.place.last")) }
    static var geo: WidgetPlace { WidgetPlace(id: geoID, name: L10n.t("pb.geo")) }

    /// The place to forecast; a saved place that has been deleted since falls back to the last viewed one.
    func resolve() async -> Place {
        switch id {
        case Self.geoID: return await WidgetData.currentPlace()
        case Self.lastID: return WidgetData.lastPlace()
        default: return WidgetData.savedPlaces().first { $0.id == id } ?? WidgetData.lastPlace()
        }
    }
}

struct WidgetPlaceQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [WidgetPlace] {
        try await suggestedEntities().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [WidgetPlace] {
        [WidgetPlace.last, WidgetPlace.geo] + WidgetData.savedPlaces().map { WidgetPlace(id: $0.id, name: $0.name) }
    }

    func defaultResult() async -> WidgetPlace? { .last }
}

/// The widgets' one setting: the place.
struct PlaceIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource { "Sted" }
    static var description: IntentDescription { IntentDescription("Stedet widgeten viser.") }

    @Parameter(title: "Sted")
    var place: WidgetPlace?
}
