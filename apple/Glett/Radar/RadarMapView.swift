import GlettKit
import SwiftUI

/// The precipitation radar (`#radarMap`, index.html:126-135; js/app.js:2424-2636), pushed as `AppRoute.radar`: MET's
/// radar over Kartverket's map in the Nordic area (RainViewer over Apple's map elsewhere), the last hour as frames
/// and MET's nowcast after "nå", played by opacity with a time slider, the place's marker and the credits.
///
/// Inputs: `model.place`, `model.nowcast`, `model.now`, the map setting (`glett.map`).
struct RadarMapView: View {
    let model: AppModel

    var body: some View {
        Group {
            if let p = model.place {
                RadarContent(place: p, nowcast: model.nowcast, now: model.now, topo: Self.usesTopo(p, defaults: model.defaults))
                    .id(p.placeKey)   // another place: a new map, frames and marker (js/app.js:2477-2484)
            } else {
                Color.glett.bg.ignoresSafeArea()
            }
        }
        .navigationTitle(Text(verbatim: L10n.t("rm.mode.rain")))
        .navigationSubtitleIfAvailable(Text(verbatim: model.place.map { $0.name.split(separator: ",").first.map(String.init) ?? $0.name } ?? ""))
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackgroundVisibility(.visible, for: .navigationBar)
    }

    /// js/app.js:2479: Kartverket's topo map in Norway (`inNorwayLL`) unless the map setting is OpenStreetMap.
    static func usesTopo(_ p: Place, defaults: UserDefaults) -> Bool {
        Place.inNorway(lat: p.lat, lon: p.lon) && defaults.string(forKey: SettingsKey.mapBase) != "osm"
    }
}

#Preview {
    NavigationStack { RadarMapView(model: .preview()) }
}
