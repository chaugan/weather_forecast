import GlettKit
import SwiftUI

/// A model's name in a row or column header, with the AI tag (css/style.css:181 `tr.ai .rowh::after`) and its
/// reliability score when the check has run (`badge(id)`, js/app.js:558; colours by `scoreCls`).
struct ModelRowLabel: View {
    let model: HourTable.Model
    var alignment: HorizontalAlignment = .leading

    var body: some View {
        VStack(alignment: alignment, spacing: 2) {
            Text(verbatim: model.name)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.glett.text)
                .lineLimit(2)
                .multilineTextAlignment(alignment == .leading ? .leading : .center)
                .minimumScaleFactor(0.85)
            HStack(spacing: 4) {
                if model.isHeadline { tag(Text(verbatim: "AI"), .white, .glett.accent) }
                if let s = model.score {
                    tag(Text(verbatim: "\(s)"), level(s), level(s).opacity(0.15))
                        .accessibilityLabel(Text(verbatim: "\(L10n.t("r.badge")) \(s)"))
                }
            }
        }
    }

    private func tag(_ t: Text, _ fg: Color, _ bg: Color) -> some View {
        t.font(.caption2.weight(.bold)).padding(.horizontal, 5).padding(.vertical, 1).foregroundStyle(fg).background(bg, in: Capsule())
    }

    private func level(_ s: Int) -> Color {
        switch VerificationResult.scoreLevel(s) {
        case "hi": .glett.good
        case "mid": .glett.mid
        default: .glett.bad
        }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    let t = HourTable(engine: PreviewSamples.engine, step: 1)
    VStack(alignment: .leading, spacing: 8) {
        ForEach(t.models(weights: nil).prefix(3)) { ModelRowLabel(model: $0) }
    }
    .frame(width: 110)
    .padding()
}
