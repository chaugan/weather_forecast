import GlettKit
import SwiftUI

/// The most likely weather of a step as lines (`.wlist`, js/app.js:303-305): the top categories with their share, the
/// first bold with "enige", and the segmented bar under them. The list shows two lines, as the web does on phones
/// (css/style.css:478).
struct ShareLines: View {
    let shares: [CategoryShare]
    var night = false
    var lines = 2
    var showsIcons = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(shares.prefix(lines).enumerated()), id: \.element.category) { i, s in
                line(s, top: i == 0)
            }
            AgreementBar(shares: shares, height: 5).padding(.top, 2)
        }
    }

    private func line(_ s: CategoryShare, top: Bool) -> some View {
        HStack(spacing: 4) {
            if showsIcons { WeatherIcon(category: s.category, night: night, size: 16) }
            Text(verbatim: Format.category(s.category))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            ViewThatFits(in: .horizontal) {
                if top {
                    Text(verbatim: "\(Format.percentText(s.share)) \(L10n.t("g.agree_short"))").fixedSize()
                }
                Text(verbatim: Format.percentText(s.share)).fixedSize()
            }
            .fontWeight(.bold)
            .monospacedDigit()
        }
        .font(top ? .footnote.weight(.bold) : .caption.weight(.medium))
        .foregroundStyle(top ? Color.glett.text : Color.glett.muted)
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    ShareLines(shares: [.init(category: .rain, share: 0.62), .init(category: .cloudy, share: 0.31), .init(category: .snow, share: 0.07)])
        .frame(width: 170)
        .padding()
}
