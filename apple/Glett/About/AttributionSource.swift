import Foundation

/// A data source the app uses, with its licence and home page (the credits of `footer.html`, js/i18n.js:31, as a list).
/// Names are the providers' own; what each one gives the app comes from the string catalog.
struct AttributionSource: Identifiable, Sendable {
    let id: String
    /// The provider's name, or a catalog key for one that is translated (`nameKey`).
    var name: String?
    var nameKey: String?
    /// `app.src.*`: what the app gets from it.
    let roleKey: String
    let licence: String?
    let url: URL

    var displayName: String { nameKey.map { AppText.t($0) } ?? name ?? id }

    /// CC BY 4.0, the licence of Open-Meteo, MET Norway, Copernicus and Kartverket data.
    static let ccBy = "CC BY 4.0"
    static let ccByURL = URL(string: "https://creativecommons.org/licenses/by/4.0/")!

    static let all: [AttributionSource] = [
        .init(id: "openmeteo", name: "Open-Meteo.com", roleKey: "app.src.openmeteo", licence: ccBy, url: URL(string: "https://open-meteo.com/")!),
        .init(id: "met", nameKey: "app.src.met.name", roleKey: "app.src.met", licence: ccBy, url: URL(string: "https://api.met.no/")!),
        .init(id: "era5", name: "Copernicus ERA5", roleKey: "app.src.era5", licence: ccBy,
              url: URL(string: "https://cds.climate.copernicus.eu/")!),
        .init(id: "metar", name: "NOAA Aviation Weather Center", roleKey: "app.src.metar", licence: nil,
              url: URL(string: "https://aviationweather.gov/")!),
        .init(id: "kartverket", name: "© Kartverket", roleKey: "app.src.kartverket", licence: ccBy, url: URL(string: "https://www.kartverket.no/")!),
        .init(id: "osm", name: "© OpenStreetMap", roleKey: "app.src.osm", licence: "ODbL",
              url: URL(string: "https://www.openstreetmap.org/copyright")!),
        .init(id: "netatmo", name: "Netatmo", roleKey: "app.src.netatmo", licence: nil, url: URL(string: "https://weathermap.netatmo.com/")!),
        .init(id: "wefo", name: "WeFo", roleKey: "app.src.wefo", licence: nil, url: URL(string: "https://github.com/santonoreg/weather_forecast")!),
    ]
}
