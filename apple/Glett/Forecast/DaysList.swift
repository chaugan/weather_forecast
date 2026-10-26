import GlettKit
import SwiftUI

/// "Dagene fremover" (`#weekCard`, index.html:145-150): a header row and one row per day; a tap picks the day the
/// hour views show (`state.day`), a long press offers "Time for time".
struct DaysList: View {
    let model: AppModel
    let engine: ConsensusEngine

    /// Column widths that grow with Dynamic Type (the web's grid `minmax(56px, 1fr) 30px auto auto auto`).
    struct Columns {
        var icon: CGFloat
        var hilo: CGFloat
        var rain: CGFloat
        var gust: CGFloat
    }

    @ScaledMetric(relativeTo: .body) private var hiloWidth: CGFloat = 76
    @ScaledMetric(relativeTo: .footnote) private var rainWidth: CGFloat = 62
    @ScaledMetric(relativeTo: .footnote) private var gustWidth: CGFloat = 50

    var body: some View {
        let cols = Columns(icon: 30, hilo: hiloWidth, rain: rainWidth, gust: gustWidth)
        let days = engine.days()
        let today = engine.todayIndex
        let selected = model.selectedDay ?? today
        VStack(alignment: .leading, spacing: 0) {
            GlettSectionHeader(title: L10n.t("wk.title")).padding(.bottom, 8)
            header(cols)
            Divider().overlay(Color.glett.line)
            ForEach(days) { d in
                Button {
                    model.showHours(day: d.day)
                } label: {
                    DayRow(day: d, name: Format.dayName(d.day, in: engine.forecast, today: today),
                           date: Format.shortDate(d.day, in: engine.forecast), windUnit: model.windUnit,
                           selected: d.day == selected, columns: cols)
                }
                .buttonStyle(.plain)
                .contextMenu { menu(d.day) }
                if d.day != days.last?.day { Divider().overlay(Color.glett.line) }
            }
            Text(verbatim: L10n.t("wk.note")).font(.footnote).foregroundStyle(.glett.muted).padding(.top, 8)
        }
        .glettCard(padding: 14)
        .glettHaptic(.selection, trigger: model.selectedDay)
    }

    /// The long press on a day: "Time for time" for it. "Del" (`GlettLink`) waits until glett.no opens a shared place.
    private func menu(_ day: Int) -> some View {
        Button { model.showHours(day: day) } label: {
            Label { Text(verbatim: L10n.t("hrs.title")) } icon: { Image(systemName: "clock") }
        }
    }

    private func header(_ c: Columns) -> some View {
        HStack(spacing: 10) {
            Text(verbatim: L10n.t("wk.day")).frame(maxWidth: .infinity, alignment: .leading)
            Color.clear.frame(width: c.icon, height: 1)
            Text(verbatim: L10n.t("wk.hilo")).frame(width: c.hilo, alignment: .trailing)
            Text(verbatim: L10n.t("wk.rain")).frame(width: c.rain, alignment: .trailing)
            // the web hides the unit here too (css/style.css:741 `.week .wk-h .hu`); the settings show it
            Text(verbatim: L10n.t("wk.gust")).frame(width: c.gust, alignment: .trailing)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(.glett.muted)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .padding(.bottom, 6)
        .accessibilityHidden(true)
    }
}

#Preview {
    let model = AppModel.preview()
    ScrollView {
        if let e = model.engine { DaysList(model: model, engine: e).padding() }
    }
    .background(.glett.bg)
}
