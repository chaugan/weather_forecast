import SwiftUI

/// The wind arrow of js/icons.js:105 (`WI.arrow(deg)`): the path "M12 3l6 15-6-4-6 4z" turned by `deg + 180`, so it
/// points where the wind blows. `degrees` is where the wind comes from (meteorological), nil draws nothing.
struct WindArrow: View {
    let degrees: Double?
    var size: CGFloat = 14

    var body: some View {
        if let degrees {
            ArrowShape()
                .fill(.glett.text)
                .frame(width: size, height: size)
                .rotationEffect(.degrees((degrees + 180).rounded()))
                .accessibilityHidden(true)
        }
    }

    private struct ArrowShape: Shape {
        func path(in r: CGRect) -> Path {
            let s = min(r.width, r.height) / 24
            var p = Path()
            p.move(to: CGPoint(x: r.minX + 12 * s, y: r.minY + 3 * s))
            p.addLine(to: CGPoint(x: r.minX + 18 * s, y: r.minY + 18 * s))
            p.addLine(to: CGPoint(x: r.minX + 12 * s, y: r.minY + 14 * s))
            p.addLine(to: CGPoint(x: r.minX + 6 * s, y: r.minY + 18 * s))
            p.closeSubpath()
            return p
        }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    HStack(spacing: 12) {
        ForEach([0.0, 45, 90, 180, 270], id: \.self) { WindArrow(degrees: $0, size: 22) }
    }
    .padding()
}
