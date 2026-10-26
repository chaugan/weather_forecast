import GlettKit
import SwiftUI

/// "Fargene i stolpene:" with the weather types that occur this week (`renderSegKey`, js/app.js:815-821;
/// css/style.css:1036-1039).
struct SegmentKey: View {
    let categories: [WeatherCategory]

    var body: some View {
        if !categories.isEmpty {
            FlowLayout(spacing: 12, lineSpacing: 4) {
                Text(verbatim: L10n.t("seg.key")).foregroundStyle(.glett.muted)
                ForEach(categories, id: \.self) { c in
                    HStack(spacing: 5) {
                        RoundedRectangle(cornerRadius: 2).fill(c.color).frame(width: 14, height: 8)
                        Text(verbatim: Format.category(c)).foregroundStyle(.glett.text)
                    }
                }
            }
            .font(.caption)
            .accessibilityElement(children: .combine)
        }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    SegmentKey(categories: [.clear, .partly, .cloudy, .rain]).frame(width: 340).padding()
}
