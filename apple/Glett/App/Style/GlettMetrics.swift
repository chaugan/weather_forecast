import SwiftUI

/// Spacing and corner radius of the Glett cards: the web's `.card` / `.hero` (css/style.css:515), as before the native
/// redesign (the owner's plan does not change the cards).
enum GlettMetrics {
    /// Side margin of a page.
    static let pagePadding: CGFloat = 16
    /// The gap between cards on a page.
    static let cardSpacing: CGFloat = 14
    /// Inside a card.
    static let cardPadding: CGFloat = 16
    static let cardRadius: CGFloat = 16
}
