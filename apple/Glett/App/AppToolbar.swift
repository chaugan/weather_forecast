import SwiftUI

/// The toolbar of the forecast (the web's top bar, index.html:19-55): places, then a menu with the models, the
/// settings, the radar and "Hva er Glett?".
struct AppToolbar: ToolbarContent {
    let model: AppModel
    /// Compact width shows the places button (regular width has the places in the sidebar).
    var showsPlaces = true

    var body: some ToolbarContent {
        if showsPlaces {
            ToolbarItem(placement: .topBarLeading) {
                Button { model.showPlaces = true } label: {
                    Label { Text(verbatim: L10n.t("nav.places")) } icon: { Image(systemName: "map") }
                }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button { model.path.append(.models) } label: {
                    Label { Text(verbatim: L10n.t("tb.models")) } icon: { Image(systemName: "square.stack.3d.up") }
                }
                Button { model.path.append(.radar) } label: {
                    Label { Text(verbatim: L10n.t("rm.open")) } icon: { Image(systemName: "dot.radiowaves.left.and.right") }
                }
                Button { model.path.append(.settings) } label: {
                    Label { Text(verbatim: L10n.t("tb.settings")) } icon: { Image(systemName: "gearshape") }
                }
                Button { model.path.append(.about) } label: {
                    Label { Text(verbatim: L10n.t("about.btn")) } icon: { Image(systemName: "questionmark.circle") }
                }
                Divider()
                Button { model.reload(force: true) } label: {
                    Label { Text(verbatim: L10n.t("tb.refresh.title")) } icon: { Image(systemName: "arrow.clockwise") }
                }
                .disabled(model.place == nil)
            } label: {
                Label { Text(verbatim: L10n.t("menu.title")) } icon: { Image(systemName: "ellipsis") }
            }
        }
    }
}
