import GlettKit
import SwiftUI

/// "Mest sannsynlig vær" in the time-down list (js/app.js:300-306; css/style.css:475-478): the big icon of the most
/// likely weather, the top two categories with their share and the segmented bar.
struct TimeDownProbabilityCell: View {
    let step: StepConsensus

    var body: some View {
        if let shares = step.shares, let top = shares.first {
            HStack(spacing: 6) {
                WeatherIcon(category: top.category, night: step.column.night, size: 34)
                ShareLines(shares: shares, night: step.column.night)
            }
            .padding(.horizontal, 6)
        } else {
            Text(verbatim: "–").foregroundStyle(.glett.muted)
        }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    let e = PreviewSamples.engine
    TimeDownProbabilityCell(step: e.step(e.columns(step: 1)[e.nowIndex])).frame(width: 200).padding()
}
