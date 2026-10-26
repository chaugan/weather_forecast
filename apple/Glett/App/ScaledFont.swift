import SwiftUI
import UIKit

extension Font {
    /// The system font at `size` points scaled with Dynamic Type like `style` (brief §1), but never past `maxScale`
    /// times `size`: chart labels and the hero number sit in fixed geometry, so they grow only as far as it allows.
    static func scaledSystem(_ size: CGFloat, weight: Font.Weight = .regular, relativeTo style: UIFont.TextStyle = .caption2,
                             maxScale: CGFloat = 1.3, monospacedDigit: Bool = false, in dynamicType: DynamicTypeSize) -> Font {
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicType))
        let scaled = UIFontMetrics(forTextStyle: style).scaledValue(for: size, compatibleWith: traits)
        let f = Font.system(size: min(scaled, size * maxScale), weight: weight)
        return monospacedDigit ? f.monospacedDigit() : f
    }
}

/// `.scaledFont(10, …)`: `Font.scaledSystem` with the view's own Dynamic Type size.
private struct ScaledFont: ViewModifier {
    let size: CGFloat
    let weight: Font.Weight
    let style: UIFont.TextStyle
    let maxScale: CGFloat
    let monospacedDigit: Bool
    @Environment(\.dynamicTypeSize) private var dynamicType

    func body(content: Content) -> some View {
        content.font(.scaledSystem(size, weight: weight, relativeTo: style, maxScale: maxScale, monospacedDigit: monospacedDigit, in: dynamicType))
    }
}

extension View {
    /// A fixed-size system font that still follows Dynamic Type, capped at `maxScale` (see `Font.scaledSystem`).
    func scaledFont(_ size: CGFloat, weight: Font.Weight = .regular, relativeTo style: UIFont.TextStyle = .caption2,
                    maxScale: CGFloat = 1.3, monospacedDigit: Bool = false) -> some View {
        modifier(ScaledFont(size: size, weight: weight, style: style, maxScale: maxScale, monospacedDigit: monospacedDigit))
    }
}
