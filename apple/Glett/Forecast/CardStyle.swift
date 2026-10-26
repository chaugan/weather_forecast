import SwiftUI

/// The web's `.card` / `.hero` panel (css/style.css:515): panel colour, a thin line, rounded 16.
struct CardStyle: ViewModifier {
    var padding: CGFloat = 16

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.glett.panel, in: .rect(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.glett.line))
    }
}

extension View {
    /// Wraps the view in a Glett card.
    func glettCard(padding: CGFloat = 16) -> some View { modifier(CardStyle(padding: padding)) }
}
