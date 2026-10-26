import Foundation
import GlettKit
import SwiftData

/// Saved places in SwiftData: the container (App Group when the entitlement is there, else the app's own store) and
/// the few operations the views share (save, unsave, import, export). Widgets and the watch read the same store later.
enum PlaceStore {
    /// Most places a list holds, as the web's import (js/data.js:625).
    static let maxPlaces = 500

    /// The store in the App Group container `group.no.glett.shared` if the app has that entitlement, otherwise the
    /// default location. Never crashes: an unusable store falls back to memory (places then last for the session).
    static func makeContainer() -> ModelContainer {
        let schema = Schema([SavedPlace.self])
        var configs: [ModelConfiguration] = []
        if let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: AppGroup.identifier) {
            let dir = group.appending(path: "Library/Application Support", directoryHint: .isDirectory)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            configs.append(ModelConfiguration("Glett", schema: schema, url: dir.appending(path: "Glett.store")))
        }
        configs.append(ModelConfiguration("Glett", schema: schema, groupContainer: .none))
        for config in configs {
            if let c = try? ModelContainer(for: schema, configurations: [config]) { return c }
        }
        // swiftlint:disable:next force_try
        return try! ModelContainer(for: schema, configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)])
    }

    /// An in-memory container with a few places, for previews.
    @MainActor static func previewContainer() -> ModelContainer {
        let schema = Schema([SavedPlace.self])
        // swiftlint:disable:next force_try
        let c = try! ModelContainer(for: schema, configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)])
        for (i, p) in Place.cities.prefix(3).enumerated() {
            c.mainContext.insert(SavedPlace(name: p.name, lat: p.lat, lon: p.lon, order: i))
        }
        return c
    }

    static func all(_ ctx: ModelContext) -> [SavedPlace] {
        (try? ctx.fetch(FetchDescriptor<SavedPlace>(sortBy: [SortDescriptor(\.order), SortDescriptor(\.created)]))) ?? []
    }

    /// The saved place at the same 0.001° point (`isSaved`, js/app.js).
    static func saved(_ place: Place, in ctx: ModelContext) -> SavedPlace? {
        let key = place.placeKey
        return all(ctx).first { $0.placeKey == key }
    }

    /// Saves a place (cleaned as the web does) unless it is already saved; returns the saved row.
    @discardableResult
    static func save(_ place: Place, in ctx: ModelContext) -> SavedPlace? {
        if let s = saved(place, in: ctx) { return s }
        guard let p = Place.cleaned(name: place.name, lat: place.lat, lon: place.lon) else { return nil }
        let order = (all(ctx).map(\.order).max() ?? -1) + 1
        let s = SavedPlace(name: p.name, lat: p.lat, lon: p.lon, order: order)
        ctx.insert(s)
        try? ctx.save()
        return s
    }

    static func remove(_ s: SavedPlace, in ctx: ModelContext) {
        ctx.delete(s)
        try? ctx.save()
    }

    /// Writes the order after a move in the list.
    static func reorder(_ list: [SavedPlace], in ctx: ModelContext) {
        for (i, s) in list.enumerated() where s.order != i { s.order = i }
        try? ctx.save()
    }

    /// Imports a web export (or a bare array); places already saved are skipped. Returns how many were added.
    static func importJSON(_ data: Data, into ctx: ModelContext) throws -> Int {
        let (places, _) = try PlacesFile.parse(data)
        var keys = Set(all(ctx).map(\.placeKey))
        var order = (all(ctx).map(\.order).max() ?? -1) + 1
        var n = 0
        for p in places where !keys.contains(p.placeKey) && keys.count < maxPlaces {
            ctx.insert(SavedPlace(name: p.name, lat: p.lat, lon: p.lon, order: order))
            keys.insert(p.placeKey)
            order += 1
            n += 1
        }
        try? ctx.save()
        return n
    }

    /// The web's export format (`exportJson`, js/data.js:618-622).
    static func exportJSON(_ list: [SavedPlace]) -> Data {
        let file = PlacesFile(locations: list.map { .init(name: $0.name, lat: $0.lat, lon: $0.lon) })
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? enc.encode(file)) ?? Data("[]".utf8)
    }
}
