import SwiftUI

/// The screen for a pushed route.
struct RouteDestination: View {
    let route: AppRoute
    let model: AppModel

    var body: some View {
        switch route {
        case .models: ModelsListView(model: model)
        case .settings: SettingsView(model: model)
        case .about: AttributionView()
        case .radar: RadarMapView(model: model)
        }
    }
}
