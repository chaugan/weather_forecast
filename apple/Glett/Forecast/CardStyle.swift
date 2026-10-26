import SwiftUI

extension View {
    /// Wraps the view in a Glett card (`GlettCardModifier`, App/Style): the web's `.card` / `.hero` panel
    /// (css/style.css:515): panel colour, a thin line, rounded 16.
    func glettCard(padding: CGFloat = GlettMetrics.cardPadding) -> some View { modifier(GlettCardModifier(padding: padding)) }
}
