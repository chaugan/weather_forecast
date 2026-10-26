import SwiftUI

/// The reliability badge next to a model (`.rel` with `scoreCls`, js/app.js:558): the score 0–100 in the colour of its
/// class.
struct ScoreBadge: View {
    let score: Int?
    var large = false

    var body: some View {
        let color = ReliabilityFormat.color(score)
        Text(verbatim: score.map(String.init) ?? "–")
            .font((large ? Font.title2 : .footnote).weight(.bold).monospacedDigit())
            .foregroundStyle(color)
            .padding(.horizontal, large ? 10 : 7)
            .padding(.vertical, large ? 4 : 2)
            .frame(minWidth: large ? 48 : 34)
            .background(color.opacity(0.13), in: .capsule)
            .overlay(Capsule().strokeBorder(color.opacity(0.35)))
            .accessibilityLabel(Text(verbatim: L10n.t("r.badge") + ": " + (score.map(String.init) ?? "–")))
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    HStack { ScoreBadge(score: 86); ScoreBadge(score: 71); ScoreBadge(score: 42); ScoreBadge(score: nil); ScoreBadge(score: 77, large: true) }
        .padding()
}
