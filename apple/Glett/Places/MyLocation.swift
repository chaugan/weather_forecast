import GlettKit
import SwiftUI

/// "Min posisjon" (`pb.geo`): the device's position as the place, named by MapKit (or glett.no) once known.
extension AppModel {
    /// Selects the current position; false when there is no position (permission refused, no fix in time).
    @discardableResult
    func selectMyLocation() async -> Bool {
        guard let loc = try? await LocationProvider.currentLocation(),
              let p = Place.cleaned(id: "geo", name: L10n.t("pb.geo.name"), lat: loc.coordinate.latitude, lon: loc.coordinate.longitude)
        else { return false }
        let lang = self.lang
        select(p, geo: true)
        if let name = await LocationProvider.name(for: loc, service: service, lang: lang), place?.placeKey == p.placeKey {
            rename(name)
        }
        return true
    }
}

/// The "Min posisjon" button with its busy state and the failure line.
struct MyLocationButton: View {
    let model: AppModel
    /// Called once the place is set (the sheet closes then).
    var onSelected: () -> Void = {}
    @State private var locating = false
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                Task {
                    locating = true
                    failed = false
                    let ok = await model.selectMyLocation()
                    locating = false
                    if ok { onSelected() } else { failed = true }
                }
            } label: {
                HStack {
                    Label { Text(verbatim: L10n.t(locating ? "pb.geo.loading" : "pb.geo")) } icon: { Image(systemName: "location") }
                    if locating { Spacer(); ProgressView() }
                }
            }
            .disabled(locating)
            if failed {
                Text(verbatim: AppText.t("app.geo.fail")).font(.footnote).foregroundStyle(Color.glett.bad)
            }
        }
    }
}
