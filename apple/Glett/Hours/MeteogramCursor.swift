import SwiftUI

/// The time cursor of the meteogram (`.mghl`, css/style.css:941): the picked step's column, tinted with dashed edges.
/// It hides while it would lie in a reserved region of the window (brief §8; see `ReservedRegions`).
struct MeteogramCursor: View {
    let width: CGFloat
    let height: CGFloat
    let regions: ReservedRegions

    var body: some View {
        Rectangle()
            .fill(Color.glett.accent.opacity(0.10))
            .overlay {
                HStack {
                    edge
                    Spacer(minLength: 0)
                    edge
                }
            }
            .frame(width: width, height: height)
            .avoiding(regions)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private var edge: some View {
        Line().stroke(Color.glett.accent, style: StrokeStyle(lineWidth: 1, dash: [3, 3])).frame(width: 1)
    }

    private struct Line: Shape {
        func path(in r: CGRect) -> Path { Path { p in p.move(to: CGPoint(x: r.midX, y: r.minY)); p.addLine(to: CGPoint(x: r.midX, y: r.maxY)) } }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    MeteogramCursor(width: 44, height: 200, regions: ReservedRegions()).padding()
}

#Preview("Under the fold (hidden)", traits: .sizeThatFitsLayout) {
    // a reserved region over the whole preview, as a fold would be: the cursor must not draw
    MeteogramCursor(width: 44, height: 200, regions: ReservedRegions(rects: [CGRect(x: -10_000, y: -10_000, width: 20_000, height: 20_000)])).padding()
}
