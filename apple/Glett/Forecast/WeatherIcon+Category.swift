import GlettKit
import SwiftUI

// GlettKit's icon enum is shadowed by the app's `WeatherIcon` view (and `GlettKit.WeatherIcon` resolves to the
// `GlettKit` enum, not the module), so categories map to icons through the representative code here.
extension WeatherIcon {
    /// The icon the web draws for a category (`WI.svg(WI.CAT_CODE[cat], night)`), labelled with the category name.
    init(category: WeatherCategory, night: Bool, size: CGFloat = 36) {
        self.init(name: Self.name(code: category.representativeCode, night: night), size: size)
    }
}
