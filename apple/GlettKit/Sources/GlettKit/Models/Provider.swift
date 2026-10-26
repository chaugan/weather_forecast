import Foundation

/// One forecast source: an Open-Meteo model or MET Norway / Yr (`{id, hourly}` in js/data.js:199 and :172).
public struct Provider: Sendable, Codable, Equatable, Identifiable {
    public var id: String
    /// English display name from `MODEL_NAMES` (js/app.js:59-63); the UI localises with the key `mn.<id>`.
    public var name: String
    public var hourly: Hourly
    /// The id of an earlier provider with exactly the same series (js/app.js:101-105): shown greyed, counted once.
    public var dupOf: String?

    public init(id: String, name: String? = nil, hourly: Hourly, dupOf: String? = nil) {
        self.id = id
        self.name = name ?? ModelCatalog.name(id)
        self.hourly = hourly
        self.dupOf = dupOf
    }

    private enum CodingKeys: String, CodingKey { case id, name, hourly, dupOf }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        self.init(id: id, name: try c.decodeIfPresent(String.self, forKey: .name), hourly: try c.decode(Hourly.self, forKey: .hourly),
                  dupOf: try c.decodeIfPresent(String.self, forKey: .dupOf))
    }

    /// The localisation key of the model name (`mn.<id>`, js/app.js:64).
    public var nameKey: String { "mn.\(id)" }
}

/// The models Glett asks for and their names.
public enum ModelCatalog {
    /// `MODELS` (js/data.js:29-30): the 13 Open-Meteo models, in request order.
    public static let openMeteoModels = ["ecmwf_aifs025_single", "ecmwf_ifs025", "gfs_seamless", "icon_seamless", "gem_seamless", "meteofrance_seamless",
                                         "ukmo_seamless", "jma_seamless", "cma_grapes_global", "bom_access_global", "knmi_seamless", "dmi_seamless", "metno_seamless"]
    /// `VERIFY_MODELS` (js/data.js:33-34): the models scored for reliability (BOM has no archive).
    public static let verifyModels = ["ecmwf_aifs025_single", "ecmwf_ifs025", "gfs_seamless", "icon_seamless", "gem_seamless", "meteofrance_seamless",
                                      "ukmo_seamless", "jma_seamless", "cma_grapes_global", "knmi_seamless", "dmi_seamless", "metno_seamless"]
    /// MET Norway / Yr, converted onto the same axis (js/data.js:172).
    public static let yrID = "yr"
    /// `MODEL_NAMES` (js/app.js:59-63), the English fallback names.
    public static let names: [String: String] = [
        "ecmwf_aifs025_single": "ECMWF AIFS (AI)", "ecmwf_ifs025": "ECMWF IFS", "gfs_seamless": "NOAA GFS", "icon_seamless": "DWD ICON",
        "gem_seamless": "Environment Canada GEM", "meteofrance_seamless": "Météo-France", "ukmo_seamless": "UK Met Office", "jma_seamless": "JMA (Japan)",
        "cma_grapes_global": "CMA GRAPES (China)", "bom_access_global": "BOM ACCESS (Australia)", "knmi_seamless": "KNMI (Netherlands)",
        "dmi_seamless": "DMI (Denmark)", "metno_seamless": "MET Norway (Nordic)", "yr": "MET Norway / Yr",
    ]
    /// `ALL_MODEL_IDS` (js/app.js:1023): every model the list may show, also those without coverage for a place.
    public static let allIDs = openMeteoModels + [yrID]
    /// `HEADLINE_MODEL_IDS` (js/app.js:275): the single-model AI forecast shown on its own row.
    public static let headlineIDs = ["ecmwf_aifs025_single"]

    public static func name(_ id: String) -> String { names[id] ?? id }
}
