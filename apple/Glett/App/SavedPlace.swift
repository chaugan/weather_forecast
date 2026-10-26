import Foundation
import GlettKit
import SwiftData

/// A saved place ("Mine steder"). The fields mirror the web's saved location (`{id, name, lat, lon}`, js/data.js:600-611)
/// plus the list order and the creation time, so the web's JSON export imports and exports one to one (brief §3.5).
@Model
final class SavedPlace {
    /// Stable id for deep links (`glett://place/<uid>`) and widgets; not the SwiftData identifier, which changes on sync.
    var uid: String = UUID().uuidString
    var name: String = ""
    var lat: Double = 0
    var lon: Double = 0
    /// Position in the list, ascending.
    var order: Int = 0
    var created: Date = Date()

    init(uid: String = UUID().uuidString, name: String, lat: Double, lon: Double, order: Int, created: Date = Date()) {
        self.uid = uid
        self.name = name
        self.lat = lat
        self.lon = lon
        self.order = order
        self.created = created
    }

    /// The place to forecast.
    var place: Place { Place(id: "saved:\(uid)", name: name, lat: lat, lon: lon) }

    /// `placeKey` (js/app.js:23): how the web matches saved places, to 0.001°.
    var placeKey: String { place.placeKey }
}
