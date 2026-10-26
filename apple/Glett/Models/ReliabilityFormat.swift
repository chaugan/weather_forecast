import Foundation
import GlettKit
import SwiftUI

/// Labels and numbers of the reliability table (`renderReliability`, js/app.js:508-556), shared by the model list and
/// the model detail.
enum ReliabilityFormat {
    /// `nameById(id)` (js/app.js): `mn.<id>`, else `MODEL_NAMES`, else the id.
    static func name(_ id: String) -> String {
        L10n.has("mn.\(id)") ? L10n.t("mn.\(id)") : ModelCatalog.names[id] ?? id
    }

    /// The region line under a model (`mi.<id>`, js/app.js:1037), nil when the catalog has none.
    static func region(_ id: String) -> String? {
        L10n.has("mi.\(id)") ? L10n.t("mi.\(id)") : nil
    }

    /// The colour of `scoreCls(v)` (js/app.js:506): good from 80, mid from 60, else bad.
    static func color(_ score: Int?) -> Color {
        switch VerificationResult.scoreLevel(score) {
        case "hi": .glett.good
        case "mid": .glett.mid
        default: .glett.bad
        }
    }

    /// The row title of a measurement: the parameter's tab name (`p.<key>`).
    static func title(_ m: VerificationMeasure) -> String {
        switch m {
        case .temperature2m: L10n.t("p.temperature_2m")
        case .windSpeed10m: L10n.t("p.wind")
        case .cloudCover: L10n.t("p.cloud_cover")
        case .relativeHumidity2m: L10n.t("p.relative_humidity_2m")
        case .pressureMSL: L10n.t("p.pressure_msl")
        case .precip: L10n.t("p.precip")
        case .code: L10n.t("p.weather")
        }
    }

    /// The table's column head (`r.temp` … `r.code`): for errors its second line ("feil °C"), for the hit rates the
    /// whole head on one line ("Treff nedbør").
    static func detail(_ m: VerificationMeasure, unit: WindUnit) -> String {
        let key: String = switch m {
        case .temperature2m: "r.temp"
        case .windSpeed10m: "r.wind"
        case .cloudCover: "r.cloud"
        case .relativeHumidity2m: "r.hum"
        case .pressureMSL: "r.press"
        case .precip: "r.rain"
        case .code: "r.code"
        }
        let lines = L10n.stripped(key, ["u": Format.windUnit(unit)]).split(separator: "\n").map(String.init)
        if m.tolerance != nil, lines.count > 1 { return lines.dropFirst().joined(separator: " ") }
        return lines.joined(separator: " ")
    }

    /// Decimals per measurement, as the table prints them (js/app.js:550-551).
    static func decimals(_ m: VerificationMeasure) -> Int {
        switch m {
        case .cloudCover, .relativeHumidity2m: 0
        case .pressureMSL: 2
        default: 1
        }
    }

    /// A number in the app's language ("1,2" / "1.2"): the web's `toFixed(d)` (halves away from zero, js/app.js:530-531)
    /// with the language's decimal separator.
    static func number(_ v: Double, _ decimals: Int) -> String {
        JS.toFixed(v, decimals).replacingOccurrences(of: ".", with: L10n.locale.decimalSeparator ?? ".")
    }

    /// An error in the display unit (wind is stored in km/h, js/app.js:529).
    static func error(_ v: Double?, _ m: VerificationMeasure, unit: WindUnit) -> String? {
        guard let v else { return nil }
        let f = m == .windSpeed10m && unit == .ms ? 1 / 3.6 : 1
        return number(v * f, decimals(m))
    }

    /// `r.bias` with the sign the web gives it (`+` for a positive bias).
    static func bias(_ v: Double?, _ m: VerificationMeasure, unit: WindUnit) -> String? {
        guard let v, let s = error(v, m, unit: unit) else { return nil }
        return L10n.t("r.bias", ["v": (v > 0 ? "+" : "") + s])
    }

    /// A hit rate 0…1 as "72 %".
    static func share(_ v: Double?) -> String? { v.map { Format.percentText($0) } }

    /// The two sources of a cell: MET/ERA5 first, Netatmo/METAR second (js/app.js:512).
    static func sources(_ truth: VerificationResult.Truth) -> (first: String, second: String) {
        truth == .frost ? (L10n.t("r.src.met"), "Netatmo") : ("ERA5", "METAR")
    }

    /// The weight keys in the web's order (js/app.js:203), with the parameter tab names as labels.
    static let weightKeys: [WeightKey] = [.weather, .temperature2m, .precip, .wind, .storm, .cloudCover, .relativeHumidity2m, .pressureMSL]

    static func title(_ k: WeightKey) -> String { L10n.t("p.\(k.rawValue)") }
}
