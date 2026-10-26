import GlettKit
import SwiftUI

/// The verdict line of the now card (`heroVerdict`, js/app.js:1083-1088): five dots, "Modellene er enige" and
/// "{k} av {n} modeller for {cat} · temperatur {min}–{max}°".
struct VerdictView: View {
    let verdict: Verdict

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VerdictDots(dots: verdict.dots, level: verdict.level).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                Text(verbatim: L10n.t(verdict.level.key)).font(.subheadline.weight(.bold))
                Spacer(minLength: 8)
                detail
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 10) {
                    VerdictDots(dots: verdict.dots, level: verdict.level)
                    Text(verbatim: L10n.t(verdict.level.key)).font(.subheadline.weight(.bold))
                }
                detail
            }
        }
        .foregroundStyle(.glett.text)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.glett.summary, in: .rect(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }

    private var detail: some View {
        Text(verbatim: L10n.t(Verdict.detailKey, [
            "k": String(verdict.agreeing), "n": String(verdict.total),
            "cat": Format.category(verdict.category).lowercased(with: L10n.locale),
            "min": JS.fmt(verdict.temperatureMin), "max": JS.fmt(verdict.temperatureMax),
        ]))
        .font(.footnote)
        .foregroundStyle(.glett.muted)
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    if let c = PreviewSamples.engine.nowColumn(), let v = PreviewSamples.engine.verdict(c) {
        VerdictView(verdict: v).padding()
    }
}
