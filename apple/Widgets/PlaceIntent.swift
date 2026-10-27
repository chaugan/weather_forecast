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

/// A widget configuration with a place; the dog-walk widget's also has the walker.
protocol PlaceConfiguration: WidgetConfigurationIntent {
    var place: WidgetPlace? { get }
    var walker: DogWalker { get }
    var timeline: Bool { get }
}

extension PlaceConfiguration {
    var walker: DogWalker { .woman }
    var timeline: Bool { true }
}

extension PlaceIntent: PlaceConfiguration {}

extension DogWalker: AppEnum {
    static var typeDisplayRepresentation: TypeDisplayRepresentation { TypeDisplayRepresentation(name: "Turgåer") }
    static var caseDisplayRepresentations: [DogWalker: DisplayRepresentation] {
        [.woman: DisplayRepresentation(title: "Kvinne"), .man: DisplayRepresentation(title: "Mann")]
    }
}

/// The dog-walk widget's settings: the place, who walks the dog, and whether the next 90 minutes show (off: the
/// picture alone with the place and temperature, owner).
struct DogWalkIntent: PlaceConfiguration {
    static var title: LocalizedStringResource { "Hundetur" }
    static var description: IntentDescription { IntentDescription("Stedet og hvem som går tur med hunden.") }

    @Parameter(title: "Sted")
    var place: WidgetPlace?

    @Parameter(title: "Turgåer", default: .woman)
    var walker: DogWalker

    @Parameter(title: "Vis neste 90 minutter", default: true)
    var timeline: Bool
}
