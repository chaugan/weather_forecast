import SwiftUI

/// The thin bar under a model's name (`.bar i`, width = score %).
struct ScoreBar: View {
    let score: Int?

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.glett.line)
                Capsule().fill(ReliabilityFormat.color(score))
                    .frame(width: g.size.width * CGFloat(min(100, max(0, score ?? 0))) / 100)
            }
        }
        .frame(height: 5)
        .accessibilityHidden(true)
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    VStack { ScoreBar(score: 88); ScoreBar(score: 65); ScoreBar(score: 30) }.frame(width: 200).padding()
}
