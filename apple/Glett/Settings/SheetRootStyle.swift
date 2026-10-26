import SwiftUI

/// The root page of one of the app's sheets (Settings, Models, About; apple/docs/DESIGN.md, item 3): a large title and
/// the close button at the top trailing edge. Pages pushed inside the sheet set `.inline` at their link.
private struct SheetRootStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .navigationBarTitleDisplayMode(.large)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { SheetCloseButton() } }
    }
}

extension View {
    /// The sheet's root page: large title, close button.
    func glettSheetRoot() -> some View { modifier(SheetRootStyle()) }

    /// The sheet itself: form size on iPad, Glett's accent.
    func glettSheet() -> some View {
        presentationSizing(.form).tint(.glett.accent)
    }
}
