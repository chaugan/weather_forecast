import GlettKit
import SwiftUI

/// "Målt nå rundt Oslo: 7,4° (føles som 5°) · ingen nedbør siste time · vind 3 m/s · luftfuktighet 87 %"
/// (`#heroLocal`, `renderLocal`, js/app.js:1190-1210): the robust mean of the public Netatmo stations nearby, from
/// glett.no's `api/netatmo.php`. A discreet note when there are too few stations; nothing until it is loaded.
///
/// Inputs: `model.measured` (MeasuredNow?, loaded by AppModel after the forecast), `model.place`, `model.windUnit`.
struct MeasuredNowLine: View {
    let measured: MeasuredNow?
    /// The place's name; only the part before the first comma is shown, as the web's `name.split(',')[0]`.
    let placeName: String
    let windUnit: WindUnit

    init(model: AppModel) {
        self.init(measured: model.measured, placeName: model.place?.name ?? "", windUnit: model.windUnit)
    }

    init(measured: MeasuredNow?, placeName: String, windUnit: WindUnit) {
        self.measured = measured; self.placeName = placeName; self.windUnit = windUnit
    }

    var body: some View {
        if let m = measured {
            Group {
                if m.ok, let t = m.temp {
                    Text(line(m, t))
                        .font(.subheadline)
                        .foregroundStyle(.glett.text)
                        .accessibilityHint(Text(verbatim: L10n.t("local.src", ["n": String(t.n), "km": JS.fmt(m.radius_km)])))
                } else {
                    Text(verbatim: L10n.t("local.few", ["n": String(m.stations)]))
                        .font(.footnote)
                        .foregroundStyle(.glett.muted)
                }
            }
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.glett.line, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        }
    }

    /// js/app.js:1194-1203: the label, the temperature (bold) with "føles som" when it differs by a degree or more, then
    /// rain, wind and humidity where enough stations measure them.
    private func line(_ m: MeasuredNow, _ t: MeasuredNow.Robust) -> AttributedString {
        var label = AttributedString(L10n.t("local.title", ["name": shortName]) + " ")
        label.inlinePresentationIntent = .stronglyEmphasized
        label.foregroundColor = .glett.accent2

        var temp = AttributedString("\(Self.loc1(t.v))°")
        temp.inlinePresentationIntent = .stronglyEmphasized

        var out = label + temp
        if let fl = m.feelsLike, abs(fl - t.v) >= 1 {
            var feels = AttributedString(" (\(L10n.t("hero.feels", ["v": JS.fmt(fl)])))")
            feels.foregroundColor = .glett.muted
            out += feels
        }
        var parts: [String] = []
        if let r = m.rainState {
            switch r {
            case .mm: parts.append(L10n.t("local.rain.mm", ["mm": Self.loc1(m.rain?.mm_1h ?? 0)]))
            case .some: parts.append(L10n.t("local.rain.some"))
            case .none: parts.append(L10n.t("local.rain.none"))
            }
        }
        if let w = m.wind, w.n >= 5 {
            parts.append(L10n.t("local.wind", ["v": Format.wind(w.kmh, windUnit), "u": Format.windUnit(windUnit)]))
        }
        if let h = m.hum { parts.append(L10n.t("local.hum", ["h": JS.fmt(h.v)])) }
        for p in parts { out += AttributedString(" · \(p)") }
        return out
    }

    private var shortName: String {
        String(placeName.split(separator: ",", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
    }

    /// `loc1(v)`: one decimal in the app's language ("7,4" / "7.4").
    static func loc1(_ v: Double) -> String {
        v.formatted(.number.precision(.fractionLength(1)).rounded(rule: .toNearestOrAwayFromZero).locale(L10n.locale))
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    let json = #"{"ok": true, "stations": 41, "radius_km": 6, "temp": {"v": 7.4, "n": 38}, "hum": {"v": 87, "n": 30},"#
        + #" "rain": {"n": 12, "mm_1h": 0, "wet_share": 0.05}, "wind": {"n": 6, "kmh": 14.4, "gust_kmh": 25}}"#
    let few = #"{"ok": false, "stations": 2}"#
    VStack(spacing: 12) {
        MeasuredNowLine(measured: try? JSONDecoder().decode(MeasuredNow.self, from: Data(json.utf8)), placeName: "Oslo, Norge", windUnit: .ms)
        MeasuredNowLine(measured: try? JSONDecoder().decode(MeasuredNow.self, from: Data(few.utf8)), placeName: "Finse", windUnit: .ms)
    }
    .padding()
    .frame(width: 380)
}
