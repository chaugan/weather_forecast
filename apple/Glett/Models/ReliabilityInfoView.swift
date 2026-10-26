import GlettKit
import SwiftUI

/// "Slik leser du tabellen": the web's notes under the reliability table (`relNote` and `legend`, js/app.js:549-556)
/// — how to read it, what was measured where, the period, and the limitations.
struct ReliabilityInfoView: View {
    let result: VerificationResult
    let placeName: String

    var body: some View {
        List {
            Section {
                Text(SimpleHTML.attributed(L10n.t(result.truth == .frost ? "r.howto.frost" : "r.howto")))
            }
            ForEach(Array(legend.enumerated()), id: \.offset) { _, part in
                Section { Text(SimpleHTML.attributed(part)) }
            }
        }
        .listStyle(.insetGrouped)
        .font(.body)
        .foregroundStyle(.glett.text)
        .tint(.glett.accent)
        .navigationTitle(Text(verbatim: L10n.t("lg.title")))
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The legend's parts as the web joins them with `<br>`.
    private var legend: [String] {
        let loc = placeName
        if result.truth == .frost {
            let s = result.frost?.stations ?? [:]
            let nm = { (k: String) in s[k].map { "\($0.name ?? $0.id) (\($0.km.map { JS.fmt($0, 1) } ?? "–") km)" } ?? "–" }
            let nt = result.netatmoHours > 0
                ? L10n.t("r.netatmo.used", ["n": String(result.netatmoHours), "w": String(Int(JS.round(result.obsWeight * 100)))])
                : L10n.t("r.netatmo.none")
            return L10n.t("r.legend.frost", ["start": result.start, "end": result.end, "hours": String(result.hours), "loc": loc,
                                             "t": nm("t"), "w": nm("w"), "c": nm("c"), "p": nm("p"), "r": nm("r"), "nt": nt, "d": "7"])
                .components(separatedBy: "<br>")
        }
        let st = result.station.map {
            L10n.t("r.station", ["id": $0.id, "name": $0.name ?? $0.id, "km": $0.km.map { JS.fmt($0, 0) } ?? "–", "n": String($0.reports),
                                 "start": $0.start, "end": $0.end])
        } ?? L10n.t("r.nostation", ["km": "60"])
        return [st,
                L10n.t("r.legend", ["start": result.start, "end": result.end, "hours": String(result.hours), "loc": loc,
                                    "w": String(Int(JS.round(result.obsWeight * 100)))]),
                L10n.t("r.limits")]
    }
}

#Preview {
    NavigationStack { ReliabilityInfoView(result: ReliabilitySamples.oslo!, placeName: "Oslo") }
}
