import GlettKit
import SwiftUI

/// The five dots of the verdict (js/app.js:1085, css/style.css:564-566): `dots` filled in the level's colour.
struct VerdictDots: View {
    let dots: Int
    let level: Verdict.Level
    var size: CGFloat = 9

    var body: some View {
        HStack(spacing: size / 3) {
            ForEach(0..<5, id: \.self) { i in
                Circle()
                    .fill(i < dots ? onColor : Color.glett.line)
                    .frame(width: size, height: size)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(Text(verbatim: "\(dots) / 5"))
    }

    private var onColor: Color {
        switch level {
        case .high: .glett.good
        case .mid: .glett.mid
        case .low: .glett.bad
        }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    VStack(alignment: .leading, spacing: 8) {
        VerdictDots(dots: 5, level: .high)
        VerdictDots(dots: 3, level: .mid)
        VerdictDots(dots: 1, level: .low)
    }
    .padding()
}
