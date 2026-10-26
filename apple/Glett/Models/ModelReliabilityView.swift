import GlettKit
import SwiftUI

/// One model's reliability: the 28-day and 7-day scores, the error per measurement against both truths (a row of
/// the web's reliability table, js/app.js:541-547) and the weights it gets in the consensus.
struct ModelReliabilityView: View {
    let id: String
    let result: VerificationResult
    let model: AppModel

    var body: some View {
        let m = result.models[id]
        let best = result.best(disabled: model.disabledModels)
        List {
            if let m {
                Section {
                    summary(m)
                }
                Section {
                    ForEach(VerificationMeasure.allCases, id: \.self) { k in
                        MeasureRow(measure: k, result: m, truth: result.truth, unit: model.windUnit, isBest: best[k] == id)
                    }
                } header: {
                    Text(app: "app.rel.errors")
                } footer: {
                    Text(app: "app.rel.errors.hint")
                }
                Section {
                    ForEach(ReliabilityFormat.weightKeys, id: \.self) { k in
                        WeightRow(key: k, weight: m.weight(k), active: model.weighted)
                    }
                } header: {
                    Text(app: "app.rel.weights")
                } footer: {
                    Text(app: model.weighted ? "app.rel.weights.hint" : "app.rel.weights.off")
                }
            } else {
                Text(app: "app.rel.notscored").foregroundStyle(.glett.muted)
            }
        }
        .navigationTitle(Text(verbatim: ReliabilityFormat.name(id)))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func summary(_ m: ModelVerification) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: ReliabilityFormat.name(id)).font(.title3.weight(.bold))
                    if let r = ReliabilityFormat.region(id) {
                        Text(verbatim: r).font(.footnote).foregroundStyle(.glett.muted)
                    }
                }
                Spacer(minLength: 8)
                ScoreBadge(score: m.score, large: true)
            }
            ScoreBar(score: m.score)
            HStack(spacing: 18) {
                stat(L10n.t("r.score"), m.score)
                stat(L10n.stripped("r.score7").replacingOccurrences(of: "\n", with: " "), m.score7)
                Spacer()
            }
            Text(verbatim: AppText.t(result.truth == .frost ? "app.rel.truth.frost" : "app.rel.truth.era5") + " · "
                 + AppText.t("app.rel.period", ["start": result.start, "end": result.end, "hours": String(result.hours)]))
                .font(.caption)
                .foregroundStyle(.glett.muted)
        }
        .padding(.vertical, 6)
    }

    private func stat(_ label: String, _ value: Int?) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(verbatim: label).font(.caption).foregroundStyle(.glett.muted)
            Text(verbatim: value.map(String.init) ?? "–")
                .font(.title2.weight(.semibold).monospacedDigit())
                .foregroundStyle(ReliabilityFormat.color(value))
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    NavigationStack {
        ModelReliabilityView(id: "ecmwf_ifs025", result: ReliabilitySamples.oslo!, model: .preview())
    }
}
