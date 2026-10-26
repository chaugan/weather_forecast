import SwiftUI

/// A Glett card: the panel colour on the page colour, a thin line, rounded 16 (css/style.css:515). `.glettCard()`
/// (Forecast/CardStyle.swift) forwards here, so every card in the app looks the same.
struct GlettCardModifier: ViewModifier {
    var padding: CGFloat = GlettMetrics.cardPadding

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.glett.panel, in: .rect(cornerRadius: GlettMetrics.cardRadius))
            .overlay(RoundedRectangle(cornerRadius: GlettMetrics.cardRadius).strokeBorder(.glett.line))
    }
}

extension View {
    /// The scrolling column of a page: side margins and the gap between cards are set by the caller's VStack
    /// (`spacing: GlettMetrics.cardSpacing`).
    func glettPage() -> some View {
        padding(.horizontal, GlettMetrics.pagePadding).padding(.vertical, 8)
    }

    /// The page colour behind the cards, edge to edge.
    func glettPageBackground() -> some View {
        background(Color.glett.bg.ignoresSafeArea())
    }
}

#Preview {
    ScrollView {
        VStack(alignment: .leading, spacing: GlettMetrics.cardSpacing) {
            VStack(alignment: .leading, spacing: 12) {
                GlettSectionHeader(title: "Time for time", subtitle: "fra nå")
                Text(verbatim: "Modellene er uenige").font(.subheadline.weight(.bold))
            }
            .modifier(GlettCardModifier(padding: 14))
            Text(verbatim: "Dagene fremover").font(.headline).modifier(GlettCardModifier())
        }
        .glettPage()
    }
    .glettPageBackground()
}
