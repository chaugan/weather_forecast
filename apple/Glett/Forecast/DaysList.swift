import GlettKit
import SwiftUI

/// "Dagene fremover" (`#weekCard`, index.html:145-150): a header row and one row per day; a tap picks the day the
/// hour views show (`state.day`).
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
            Text(verbatim: L10n.t("wk.title")).font(.title3.weight(.bold)).foregroundStyle(.glett.text).padding(.bottom, 8)
            header(cols)
            Divider().overlay(Color.glett.line)
            ForEach(days) { d in
                Button {
                    model.selectedDay = d.day == today ? nil : d.day
                    model.scrollToHours = true
                } label: {
                    DayRow(day: d, name: Format.dayName(d.day, in: engine.forecast, today: today),
                           date: Format.shortDate(d.day, in: engine.forecast), windUnit: model.windUnit,
                           selected: d.day == selected, columns: cols)
                }
                .buttonStyle(.plain)
                if d.day != days.last?.day { Divider().overlay(Color.glett.line) }
            }
            Text(verbatim: L10n.t("wk.note")).font(.footnote).foregroundStyle(.glett.muted).padding(.top, 8)
        }
        .glettCard(padding: 14)
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
