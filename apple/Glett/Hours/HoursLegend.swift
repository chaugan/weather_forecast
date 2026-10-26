import GlettKit
import SwiftUI

/// "Slik leser du tabellen" (`#legend`, js/app.js:734, 839, 873): what the rows mean, the number of models, the
/// weighting and the short-range boost for MET Nordic and Yr.
struct HoursLegend: View {
    let view: HourView
    let modelCount: Int
    let unit: WindUnit
    /// `weightsOn()`: weighting is on and reliability weights are loaded.
    let weighted: Bool
    /// The AI row is on screen (`lg.compare`).
    let showsCompare: Bool

    @State private var open = false

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            Text(verbatim: text)
                .font(.footnote)
                .foregroundStyle(.glett.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)
        } label: {
            Text(verbatim: L10n.t("lg.title")).font(.subheadline.weight(.semibold)).foregroundStyle(.glett.text)
        }
        .tint(.glett.muted)
    }

    private var text: String {
        let u = ["u": Format.windUnit(unit)]
        var s = view == .meteogram
            ? L10n.t("mg.legend")
            : L10n.t("lg.weather") + L10n.t("lg.weather.wind", u)
        s += L10n.t("lg.providers", ["n": "\(modelCount)"])
        if weighted { s += L10n.stripped("lg.weighted") }
        s += L10n.t("lg.shortmet")
        if showsCompare && view != .meteogram { s += L10n.t("lg.compare") }
        return s
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    HoursLegend(view: .timeDown, modelCount: 13, unit: .ms, weighted: true, showsCompare: true).frame(width: 340).padding()
}
