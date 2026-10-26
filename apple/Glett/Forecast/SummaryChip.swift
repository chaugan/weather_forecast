import SwiftUI

/// One line of the summary strip (`.sum`, css/style.css:352-357): an icon and a short sentence in a bordered pill;
/// `wet` tints it with the rain colour, `dry` gives it a sunny border.
struct SummaryChip<Icon: View>: View {
    enum Tone { case plain, wet, dry }

    let text: String
    var tone: Tone = .plain
    @ViewBuilder var icon: Icon

    var body: some View {
        HStack(spacing: 8) {
            icon
            Text(verbatim: text).font(.footnote.weight(.medium)).foregroundStyle(.glett.text)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(background, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(border))
        .accessibilityElement(children: .combine)
    }

    private var background: Color {
        tone == .wet ? Color.glett.rain.opacity(0.08) : Color.glett.panel
    }

    private var border: Color {
        switch tone {
        case .wet: Color.glett.rain.opacity(0.5)
        case .dry: Color.glett.sun.opacity(0.5)
        case .plain: Color.glett.line
        }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    VStack(alignment: .leading) {
        SummaryChip(text: L10n.t("s.dry.rest"), tone: .dry) { Image(systemName: "drop.fill").foregroundStyle(.glett.rain) }
        SummaryChip(text: L10n.t("s.rain.rest", ["p": "80"]), tone: .wet) { Image(systemName: "drop.fill").foregroundStyle(.glett.rain) }
    }
    .padding()
}
