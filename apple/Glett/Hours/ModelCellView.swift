import GlettKit
import SwiftUI

/// One model's step in the weather tab (`weatherCell`, js/app.js:286-290): its icon, temperature and wind. `inLane`
/// for the time-across lanes, whose fixed geometry caps the wind's size; the time-down table follows Dynamic Type.
struct ModelCellView: View {
    let cell: HourTable.ModelCell
    let night: Bool
    let unit: WindUnit
    var axis: Axis = .vertical
    var inLane = false

    var body: some View {
        if let code = cell.code {
            let layout = axis == .vertical ? AnyLayout(VStackLayout(spacing: 1)) : AnyLayout(HStackLayout(spacing: 4))
            layout {
                WeatherIcon(code: code, night: night, size: 24)
                VStack(spacing: 0) {
                    Text(verbatim: Format.temp(cell.temperature)).font(.caption.weight(.semibold))
                    wind.foregroundStyle(.glett.muted)
                }
            }
            .monospacedDigit()
            .foregroundStyle(.glett.text)
        } else {
            Text(verbatim: "–").foregroundStyle(.glett.muted)
        }
    }

    @ViewBuilder private var wind: some View {
        let w = WindValue(wind: cell.wind, direction: cell.direction, unit: unit, arrowSize: 10)
        if inLane { w.scaledFont(11, relativeTo: .caption2) } else { w.font(.caption) }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    HStack(spacing: 16) {
        ModelCellView(cell: .init(code: 61, temperature: 6.4, wind: 14, direction: 200), night: false, unit: .ms)
        ModelCellView(cell: .init(code: 2, temperature: 3.1, wind: 7, direction: 20), night: true, unit: .ms, axis: .horizontal)
    }
    .padding()
}
