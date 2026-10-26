import GlettKit
import SwiftUI

/// One of a model's consensus weights (`verify.models[id].weights[key]`, js/app.js:204): the parameter, a bar on the
/// 0.5–1.8 scale with 1 marked, and the value; no weight counts as 1.
struct WeightRow: View {
    let key: WeightKey
    let weight: Double?
    /// Weighting is on (`glett.weighted`); off, the row is dimmed.
    var active = true

    /// `normWeights`' clamp (js/data.js), the bar's ends.
    private let range = VerificationEngine.weightMin...VerificationEngine.weightMax

    var body: some View {
        HStack(spacing: 12) {
            Text(verbatim: ReliabilityFormat.title(key))
                .font(.subheadline)
                .frame(minWidth: 84, alignment: .leading)
            GeometryReader { g in
                let x = { (v: Double) in g.size.width * (v - range.lowerBound) / (range.upperBound - range.lowerBound) }
                let w = min(range.upperBound, max(range.lowerBound, weight ?? 1))
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.glett.line).frame(height: 6)
                    Capsule().fill(color(w))
                        .frame(width: abs(x(w) - x(1)), height: 6)
                        .offset(x: min(x(w), x(1)))
                    Rectangle().fill(Color.glett.muted).frame(width: 1.5, height: 12).offset(x: x(1) - 0.75)
                }
                .frame(maxHeight: .infinity)
            }
            .frame(height: 14)
            Text(verbatim: weight.map { "×" + ReliabilityFormat.number($0, 2) } ?? "×1")
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(weight == nil ? .glett.muted : .glett.text)
                .frame(width: 56, alignment: .trailing)
        }
        .opacity(active ? 1 : 0.5)
        .accessibilityElement(children: .combine)
    }

    private func color(_ w: Double) -> Color { w >= 1 ? .glett.good : .glett.mid }
}

#Preview {
    List {
        WeightRow(key: .temperature2m, weight: 1.34)
        WeightRow(key: .precip, weight: 0.72)
        WeightRow(key: .storm, weight: nil)
        WeightRow(key: .wind, weight: 1.8, active: false)
    }
}
