import GlettKit
import OSLog
import SwiftUI

/// "Meteogram" (`renderMeteogram`, js/app.js:718-736), as one continuous week at the chosen step instead of the web's
/// two days of hours. Builds the week's numbers once per consensus; the panel below keeps the picked step, so a tap
/// does not recompute them.
struct MeteogramView: View {
    let table: HourTable
    let day: Int
    let unit: WindUnit
    let nowcast: NowcastSeries?
    let now: Date

    var body: some View {
        MeteogramPanel(data: Self.build(table, nowcast: nowcast, unit: unit), table: table, day: day, now: now)
    }

    private static let log = Logger(subsystem: "no.glett.app", category: "hours")

    private static func build(_ table: HourTable, nowcast: NowcastSeries?, unit: WindUnit) -> MeteogramData {
        let t0 = ContinuousClock.now
        let data = MeteogramData(table: table, nowcast: nowcast, unit: unit)
        let ms = (ContinuousClock.now - t0) / .milliseconds(1)
        log.debug("meteogram data: \(data.points.count) steps × \(table.engine.providers.count) models in \(ms, format: .fixed(precision: 1)) ms")
        return data
    }
}

#Preview {
    let t = HourTable(engine: PreviewSamples.engine, step: 1)
    ScrollView {
        MeteogramView(table: t, day: t.today, unit: .ms, nowcast: nil, now: PreviewSamples.fixtureNow).padding()
    }
    .background(.glett.bg)
}
