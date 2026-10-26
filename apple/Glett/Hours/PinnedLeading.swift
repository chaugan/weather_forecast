import SwiftUI

extension View {
    /// Keeps the view at the leading edge of the horizontal scroll view around it while the rest scrolls on (the web's
    /// sticky first column, css/style.css:75 `.grid .rowh { position: sticky; left: 0 }`). With `span` (the width
    /// of what the view belongs to, measured from the view's own leading edge) it stops at the end of that span, so a
    /// day label stays inside its own day (css/style.css:403). Runs in the render pass: no body update per point.
    func pinnedLeading(_ on: Bool = true, span: CGFloat = .infinity) -> some View {
        visualEffect { content, proxy in
            let minX = proxy.frame(in: .scrollView(axis: .horizontal)).minX
            let room = max(0, span - proxy.size.width)
            return content.offset(x: on ? min(max(0, -minX), room) : 0)
        }
    }
}
