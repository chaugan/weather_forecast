import SwiftUI

/// The Været tab: picks the layout by the horizontal size class (brief §8: never by idiom or screen).
struct WeatherTab: View {
    let model: AppModel
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        if sizeClass == .regular {
            RegularRootView(model: model)
        } else {
            CompactRootView(model: model)
        }
    }
}

#Preview {
    WeatherTab(model: .preview())
        .modelContainer(PlaceStore.previewContainer())
        .glettLanguage()
}
