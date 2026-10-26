import GlettKit
import SwiftUI

/// The "Mest sannsynlig vær" row for one step (the hour table's `tr.prob`, js/app.js:300-390, condensed for the now
/// card): the top categories with their shares and the segmented bar, then the chances of rain, strong wind, gusts and
/// thunder.
struct ProbabilityRow: View {
    let step: StepConsensus
    let windUnit: WindUnit

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) { title; Spacer(); hint }
                VStack(alignment: .leading, spacing: 0) { title; hint }
            }
            if let shares = step.shares, !shares.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(shares.prefix(3).enumerated()), id: \.element.category) { i, s in
                        HStack(spacing: 8) {
                            WeatherIcon(category: s.category, night: step.column.night, size: i == 0 ? 26 : 20)
                            Text(verbatim: Format.category(s.category))
                                .font(i == 0 ? .subheadline.weight(.semibold) : .footnote)
                            Spacer(minLength: 4)
                            Text(verbatim: i == 0 ? "\(Format.percentText(s.share)) \(L10n.t("g.agree_short"))" : Format.percentText(s.share))
                                .font(i == 0 ? .subheadline.weight(.bold) : .footnote)
                                .monospacedDigit()
                        }
                        .foregroundStyle(i == 0 ? Color.glett.text : Color.glett.muted)
                    }
                }
                AgreementBar(shares: shares)
            }
            chances
        }
        .padding(12)
        .background(.glett.prob, in: .rect(cornerRadius: 10))
    }

    private var title: some View {
        Text(verbatim: L10n.t("g.prob_weather")).font(.subheadline.weight(.bold)).foregroundStyle(.glett.accent2).lineLimit(1)
    }

    private var hint: some View {
        Text(verbatim: L10n.t("g.prob_weather.hint")).font(.caption).foregroundStyle(.glett.muted).lineLimit(1)
    }

    private var chances: some View {
        VStack(alignment: .leading, spacing: 4) {
            chance(L10n.t("g.prob_rain"), step.rainChance, wet: (step.rainChance ?? 0) >= 0.5)
            chance(L10n.t("g.prob_wind", ["v": Format.wind(ConsensusEngine.windThreshold, windUnit), "u": Format.windUnit(windUnit)]),
                   step.windChance, wet: (step.windChance ?? 0) >= 0.5)
            if let g = step.gustShare {
                Text(verbatim: L10n.t("g.gusts", ["g": Format.wind(ConsensusEngine.gustThreshold, windUnit), "v": String(Format.percent(g) ?? 0)]))
                    .font(.footnote)
                    .foregroundStyle(g >= 0.5 ? Color.glett.bad : Color.glett.muted)
            }
            chance(L10n.t("g.prob_storm"), step.thunderChance, wet: (step.thunderChance ?? 0) >= 0.3)
        }
    }

    private func chance(_ label: String, _ share: Double?, wet: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: label).foregroundStyle(.glett.muted)
            Spacer(minLength: 8)
            Text(verbatim: Format.percentText(share)).fontWeight(.bold).monospacedDigit()
                .foregroundStyle(wet ? Color.glett.accent : Color.glett.text)
        }
        .font(.footnote)
        .accessibilityElement(children: .combine)
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    let e = PreviewSamples.engine
    if let c = e.nowColumn() {
        ProbabilityRow(step: e.step(c), windUnit: .ms).padding().frame(width: 380)
    }
}
