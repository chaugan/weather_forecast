import GlettKit
import SwiftUI

/// One measurement of a model's check (a cell of the reliability table, js/app.js:526-551): the error against the
/// first truth (MET stations or ERA5) with its bias, the error against the second (Netatmo or METAR, in blue), and the
/// "best" marker.
struct MeasureRow: View {
    let measure: VerificationMeasure
    let result: ModelVerification
    let truth: VerificationResult.Truth
    let unit: WindUnit
    var isBest = false

    var body: some View {
        let (l1, l2) = ReliabilityFormat.sources(truth)
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: ReliabilityFormat.title(measure)).font(.subheadline.weight(.semibold))
                    if isBest {
                        Text(verbatim: L10n.t("r.best"))
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.glett.good)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.glett.good.opacity(0.12), in: .capsule)
                    }
                }
                Text(verbatim: ReliabilityFormat.detail(measure, unit: unit)).font(.caption).foregroundStyle(.glett.muted)
            }
            Spacer(minLength: 8)
            if let first = firstValue {
                VStack(alignment: .trailing, spacing: 2) {
                    source(l1, first, color: .glett.text)
                    if let b = biasText { Text(verbatim: b).font(.caption).foregroundStyle(.glett.muted) }
                    if let second = secondValue { source(l2, second, color: .glett.rain) }
                }
            } else {
                Text(verbatim: "–").foregroundStyle(.glett.muted)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private func source(_ label: String, _ value: String, color: Color) -> some View {
        HStack(spacing: 5) {
            Text(verbatim: label).font(.caption.weight(.medium)).foregroundStyle(.glett.muted)
            Text(verbatim: value).font(.subheadline.weight(.bold).monospacedDigit()).foregroundStyle(color)
        }
    }

    private var firstValue: String? {
        switch measure {
        case .precip: ReliabilityFormat.share(result.csi)
        case .code: ReliabilityFormat.share(result.codeAcc)
        default: ReliabilityFormat.error(result.mae[measure.rawValue], measure, unit: unit)
        }
    }

    private var secondValue: String? {
        switch measure {
        case .precip: ReliabilityFormat.share(result.obs?.csi)
        case .code: ReliabilityFormat.share(result.obs?.codeAcc)
        default: ReliabilityFormat.error(result.obs?.mae[measure.rawValue], measure, unit: unit)
        }
    }

    private var biasText: String? {
        measure.tolerance == nil ? nil : ReliabilityFormat.bias(result.bias[measure.rawValue], measure, unit: unit)
    }
}

#Preview {
    let v = ReliabilitySamples.oslo!
    let m = v.models["ecmwf_ifs025"]!
    List {
        ForEach(VerificationMeasure.allCases, id: \.self) { k in
            MeasureRow(measure: k, result: m, truth: v.truth, unit: .ms, isBest: k == .temperature2m)
        }
    }
}
