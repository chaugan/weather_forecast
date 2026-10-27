import GlettKit
import SwiftUI

/// The segmented bar (`segBar`, js/app.js:247; css/style.css:568): how the models split by weather type, one segment
/// per category in its colour, widths by weighted share. One canvas: a capsule-clipped stack of views made SwiftUI
/// redraw every bar on every frame of a scroll, and the meteogram has one per step (owner, 2026-10-27).
struct AgreementBar: View {
    let shares: [CategoryShare]
    var height: CGFloat = 6

    var body: some View {
        Canvas { ctx, size in
            let r = CGRect(origin: .zero, size: size)
            ctx.clip(to: Capsule().path(in: r))
            ctx.fill(Path(r), with: .color(.glett.line))
            var x: CGFloat = 0
            for s in shares {
                let w = max(0, size.width * s.share)
                ctx.fill(Path(CGRect(x: x, y: 0, width: w, height: size.height)), with: .color(s.category.color))
                x += w
            }
        }
        .frame(height: height)
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
