import SwiftData
import SwiftUI

/// The app's tools (Været; a tab bar once Kjørevær and the others join) and what every screen shares: the sheets (Settings, the models, "Hva er Glett?"),
/// the full-screen radar that zooms out of the radar strip, the first load, the minute clock and the return to the
/// foreground. Bound to `model.navigation` (App/Style/AppNavigation.swift).
struct RootView: View {
    let model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.modelContext) private var context
    @Namespace private var radarZoom

    var body: some View {
        @Bindable var nav = model.navigation
        Group {
            if AppTab.allCases.count > 1 {
                TabView(selection: $nav.tab) {
                    ForEach(AppTab.allCases, id: \.self) { tab in
                        Tab(tab.title, systemImage: tab.systemImage, value: tab) { content(tab) }
                    }
                }
            } else {
                content(.weather)
            }
        }
        .tint(.glett.accent)
        .glettHaptic(.selection, trigger: nav.tab)
        // a place picked anywhere (chips, the places sheet, Min posisjon) ticks once
        .glettHaptic(.selection, trigger: model.place?.placeKey)
        .sheet(item: $nav.sheet) { AppSheetRoot(sheet: $0, model: model) }
        .fullScreenCover(isPresented: $nav.radarShown) { RadarCover(model: model) }
        .fullScreenCover(isPresented: $nav.searchShown) { PlaceSearchCover(model: model) }
        .environment(\.radarZoomNamespace, radarZoom)
        .task {
            #if DEBUG
            for p in model.launch.save where PlaceStore.saved(p, in: context) == nil { _ = PlaceStore.save(p, in: context) }
            #endif
            await model.start()
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                model.tick()
            }
        }
        #if DEBUG
        .task {
            if UserDefaults.standard.bool(forKey: "GlettLiveDemo"), let p = model.place { NextGlettLive.demo(place: p.name) }
            // `-GlettOpenURL glett://place?…`: as a widget's tap, for tests
            if let s = UserDefaults.standard.string(forKey: "GlettOpenURL"), let u = URL(string: s) {
                try? await Task.sleep(for: .seconds(3))
                model.open(u)
            }
        }
        #endif
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.becameActive() } else if phase == .background { WidgetReload.now() }
        }
    }

    @ViewBuilder
    private func content(_ tab: AppTab) -> some View {
        switch tab {
        case .weather: WeatherTab(model: model)
        }
    }
}

#Preview {
    RootView(model: .preview())
        .modelContainer(PlaceStore.previewContainer())
        .glettLanguage()
}
