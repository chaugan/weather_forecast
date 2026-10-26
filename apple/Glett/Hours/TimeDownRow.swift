import GlettKit
import SwiftUI

/// One step of the time-down list (`tr.hr`, js/app.js:592): the time, the most likely weather, the summary and, when
/// open, every model. Night rows are shaded (css/style.css:913), the current step is marked with the accent
/// (css/style.css:473-474).
struct TimeDownRow: View {
    let table: HourTable
    let column: StepColumn
    let models: [HourTable.Model]
    let metrics: TimeDownMetrics
    let unit: WindUnit
    let scrolls: Bool

    var body: some View {
        let step = table.engine.step(column)
        HStack(spacing: 0) {
            Text(verbatim: column.label)
                .font(.footnote.weight(column.now ? .bold : .regular).monospacedDigit())
                .foregroundStyle(column.now ? Color.glett.accent : Color.glett.text)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .padding(.leading, 6)
                .frame(width: metrics.time, alignment: .leading)
                .frame(maxHeight: .infinity)
                .background(rowBackground(.glett.panel))
                .overlay(alignment: .leading) {
                    if column.now { Rectangle().fill(Color.glett.accent).frame(width: 4) }
                }
                .pinnedLeading(scrolls)
                .zIndex(1)
            TimeDownProbabilityCell(step: step)
                .frame(width: scrolls ? metrics.probability : nil, alignment: .leading)
                .frame(maxWidth: scrolls ? nil : .infinity, maxHeight: .infinity, alignment: .leading)
                .background(rowBackground(.glett.prob))
            TimeDownSummaryCell(step: step, unit: unit)
                .frame(width: metrics.summary)
                .frame(maxHeight: .infinity)
                .background(rowBackground(.glett.summary))
            ForEach(models) { m in
                ModelCellView(cell: table.cell(m.provider, column), night: column.night, unit: unit)
                    .frame(width: metrics.model)
                    .frame(maxHeight: .infinity)
                    .background(rowBackground(m.isHeadline ? Color.glett.accent.opacity(0.06) : .clear))
            }
        }
        .frame(minHeight: metrics.rowHeight)
        .fixedSize(horizontal: false, vertical: true)
        .overlay { if column.now { Color.glett.accent.opacity(0.07).allowsHitTesting(false) } }
        .overlay(alignment: .bottom) { Rectangle().fill(Color.glett.line).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }

    private func rowBackground(_ base: Color) -> Color { column.night ? HoursColor.night : base }
}
