import GlettKit
import SwiftUI

/// The precipitation radar (`#radarMap`, index.html:126-135; js/app.js:2424-2636), in the full-screen `RadarCover`: MET's
/// radar over Kartverket's map in the Nordic area (RainViewer over Apple's map elsewhere), the last hour as frames
/// and MET's nowcast after "nå", played by opacity with a time slider, the place's marker and the credits.
///
/// Inputs: `model.place`, `model.nowcast`, `model.now`, the map setting (`glett.map`).
struct RadarMapView: View {
    let model: AppModel

    var body: some View {
        let title = L10n.t(model.navigation.radarWind ? "rm.mode.wind" : "rm.mode.rain"), sub = model.place?.shortName ?? ""
        Group {
            if let p = model.place {
                RadarContent(place: p, nowcast: model.nowcast, now: model.now, topo: Self.usesTopo(p, defaults: model.defaults),
                             windUnit: model.windUnit, wind: model.navigation.radarWind)
                    .id(p.placeKey)   // another place: a new map, frames and marker (js/app.js:2477-2484)
            } else {
                Color.glett.bg.ignoresSafeArea()
            }
        }
        .navigationTitle(Text(verbatim: title))
        // the map to the screen's edge with the title and the close button on glass over it (owner, 2026-10-27): no bar,
        // as iOS 26 blurs what lies under one with a hard edge, even with its background hidden
        .toolbar(.hidden, for: .navigationBar)
        .overlay(alignment: .top) { MapTopControls(title: title, subtitle: sub) }
    }

    /// js/app.js:2479: Kartverket's topo map in Norway (`inNorwayLL`) unless the map setting is OpenStreetMap.
    static func usesTopo(_ p: Place, defaults: UserDefaults) -> Bool {
        Place.inNorway(lat: p.lat, lon: p.lon) && defaults.string(forKey: SettingsKey.mapBase) != "osm"
    }
}

#Preview {
    NavigationStack { RadarMapView(model: .preview()) }
}

/// The map's title and place on glass, a pill in the middle of the top.
private struct TitlePill: View {
    let title: String
    let subtitle: String

    var body: some View {
        let text = VStack(spacing: 0) {
            Text(verbatim: title).font(.headline)
            if !subtitle.isEmpty { Text(verbatim: subtitle).font(.caption).foregroundStyle(.secondary) }
        }
        .lineLimit(1)
        .padding(.horizontal, 18)
        .padding(.vertical, 5)
        if #available(iOS 26, *) {
            text.glassEffect(.regular, in: .capsule)
        } else {
            text.background(.regularMaterial, in: .capsule)
        }
    }
}

/// The top of the map: the title in a glass pill in the middle and the close button on glass at the right, where the
/// bar had them.
private struct MapTopControls: View {
    let title: String
    let subtitle: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            TitlePill(title: title, subtitle: subtitle)
            HStack {
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.body.weight(.semibold))
                        .frame(width: 36, height: 36)
                }
                .glassButton()
                .buttonBorderShape(.circle)
                .tint(.glett.accent)
                .accessibilityLabel(Text(verbatim: L10n.t("h.close")))
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
    }
}
