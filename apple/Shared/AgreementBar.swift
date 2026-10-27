import GlettKit
import SwiftUI

/// The segmented bar (`segBar`, js/app.js:247; css/style.css:568): how the models split by weather type, one segment
/// per category in its colour, widths by weighted share.
struct AgreementBar: View {
    let shares: [CategoryShare]
    var height: CGFloat = 6

    var body: some View {
        GeometryReader { geo in
            HStack(spacing: 0) {
                ForEach(shares, id: \.category) { s in
                    Rectangle()
                        .fill(s.category.color)
                        .frame(width: max(0, geo.size.width * s.share))
                }
            }
        }
        .frame(height: height)
        .background(.glett.line)
        .clipShape(Capsule())
        .accessibilityElement()
        .accessibilityLabel(Text(verbatim: L10n.t("seg.tip")))
        .accessibilityValue(Text(verbatim: shares.map { "\(Format.category($0.category)) \(Format.percent($0.share) ?? 0)%" }.joined(separator: ", ")))
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    AgreementBar(shares: [.init(category: .rain, share: 0.6), .init(category: .cloudy, share: 0.3), .init(category: .snow, share: 0.1)])
        .frame(width: 240)
        .padding()
}
