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

/// The "Min posisjon" button (`#pbGeo`, beside the search on the web) with its busy state. In a list it says why it
/// failed on a line under it; `compact` (the place row and the sidebar) says it in an alert instead.
struct MyLocationButton: View {
    let model: AppModel
    var compact = false
    /// Called once the place is set (the sheet closes then).
    var onSelected: () -> Void = {}
    @State private var locating = false
    @State private var failed = false

    var body: some View {
        if compact {
            button
                .alert(Text(verbatim: L10n.t("pb.geo")), isPresented: $failed) {
                    // no actions: the system's own localized OK
                } message: {
                    Text(verbatim: AppText.t("app.geo.fail"))
                }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                button
                if failed {
                    Text(verbatim: AppText.t("app.geo.fail")).font(.footnote).foregroundStyle(Color.glett.bad)
                }
            }
        }
    }

    private var button: some View {
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
                if locating { if !compact { Spacer() }; ProgressView().controlSize(.small) }
            }
        }
        .disabled(locating)
    }
}
