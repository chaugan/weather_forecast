import SwiftUI

/// iOS 26 looks (Liquid Glass, navigation subtitles) with plain fallbacks, so the app also runs on iOS 18.
extension View {
    @ViewBuilder func glassPanel(cornerRadius: CGFloat) -> some View {
        if #available(iOS 26, *) {
            glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
        } else {
            background(.regularMaterial, in: .rect(cornerRadius: cornerRadius))
        }
    }

    @ViewBuilder func glassProminentButton() -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glassProminent)
        } else {
            buttonStyle(.borderedProminent)
        }
    }

    /// A round button on glass, as the top bar's own buttons (iOS 26); bordered before.
    @ViewBuilder func glassButton() -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glass)
        } else {
            buttonStyle(.bordered)
        }
    }

    /// The soft fade under the top bar (iOS 26), also on iPad, where the default is a hard band with an edge: with two
    /// columns scrolled one at a time, that band ended in a line across half the screen (owner, 2026-10-26).
    @ViewBuilder func softTopEdge() -> some View {
        if #available(iOS 26, *) {
            scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            self
        }
    }

    @ViewBuilder func navigationSubtitleIfAvailable(_ text: Text) -> some View {
        if #available(iOS 26, *) {
            navigationSubtitle(text)
        } else {
            self
        }
    }
}
