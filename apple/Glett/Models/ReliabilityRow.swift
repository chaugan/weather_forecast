import GlettKit
import SwiftUI

/// One row of the reliability ranking (a row of `renderReliability`'s table, js/app.js:541-547): the name, "(av)" when
/// switched off, the score bar with the 28-day score and the last-7-days score.
struct ReliabilityRow: View {
    let id: String
    let result: ModelVerification
    let disabled: Bool
    /// The number of "best" marks the model holds (best per measurement).
    var bestCount = 0

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(verbatim: ReliabilityFormat.name(id)).font(.subheadline.weight(.semibold))
                    if disabled { Text(verbatim: L10n.t("r.disabled")).font(.caption).foregroundStyle(.glett.muted) }
                    if bestCount > 0 {
                        Text(verbatim: L10n.t("r.best") + (bestCount > 1 ? " ×\(bestCount)" : ""))
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.glett.good)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.glett.good.opacity(0.12), in: .capsule)
                    }
                }
                ScoreBar(score: result.score)
            }
            ScoreBadge(score: result.score).frame(width: ReliabilityHeader.scoreWidth)
            Text(verbatim: result.score7.map(String.init) ?? "–")
                .font(.footnote.weight(.semibold).monospacedDigit())
                .foregroundStyle(ReliabilityFormat.color(result.score7))
                .frame(width: ReliabilityHeader.score7Width)
        }
        .opacity(disabled ? 0.55 : 1)
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    let v = ReliabilitySamples.oslo!
    List {
        ForEach(v.ranked(), id: \.id) { r in
            ReliabilityRow(id: r.id, result: r.model, disabled: r.id == "jma_seamless", bestCount: r.id == v.ranked().first?.id ? 3 : 0)
        }
    }
}
