import SwiftUI

/// The app's tabs (Været, Steder) and what every screen shares: the sheets (Settings, the models, "Hva er Glett?"),
/// the full-screen radar that zooms out of the radar strip, the first load, the minute clock and the return to the
/// foreground. Bound to `model.navigation` (App/Style/AppNavigation.swift).
struct RootView: View {
    let model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @Namespace private var radarZoom

    var body: some View {
        @Bindable var nav = model.navigation
        TabView(selection: $nav.tab) {
            Tab(AppTab.weather.title, systemImage: AppTab.weather.systemImage, value: AppTab.weather) {
                WeatherTab(model: model)
            }
            Tab(AppTab.places.title, systemImage: AppTab.places.systemImage, value: AppTab.places) {
                PlacesView(model: model)
            }
        }
        .tint(.glett.accent)
        .glettHaptic(.selection, trigger: nav.tab)
        // a place picked anywhere (chips, Steder, Min posisjon) ticks once
        .glettHaptic(.selection, trigger: model.place?.placeKey)
        .sheet(item: $nav.sheet) { AppSheetRoot(sheet: $0, model: model) }
        .fullScreenCover(isPresented: $nav.radarShown) { RadarCover(model: model) }
        .environment(\.radarZoomNamespace, radarZoom)
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
