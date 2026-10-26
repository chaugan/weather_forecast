import SwiftUI

/// Picks the layout by the horizontal size class (brief §8: never by idiom or screen), and owns what both share: the
/// places sheet, the first load, the minute clock and the return to the foreground.
struct RootView: View {
    @Bindable var model: AppModel
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if sizeClass == .regular {
                RegularRootView(model: model)
            } else {
                CompactRootView(model: model)
            }
        }
        .tint(.glett.accent)
        .sheet(isPresented: $model.showPlaces) { PlacesView(model: model) }
        .task { await model.start() }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                model.tick()
            }
        }
        .onChange(of: scenePhase) { _, phase in if phase == .active { model.becameActive() } }
    }
}

#Preview {
    RootView(model: .preview())
        .modelContainer(PlaceStore.previewContainer())
        .glettLanguage()
}
