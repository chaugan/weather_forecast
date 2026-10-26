import SwiftUI

/// The toolbar of Været: one gear button that opens Settings (the models and "Hva er Glett?" are reached from there).
struct AppToolbar: ToolbarContent {
    let model: AppModel

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button { model.present(.settings) } label: {
                Label { Text(verbatim: L10n.t("tb.settings")) } icon: { Image(systemName: "gearshape") }
            }
        }
    }
}
