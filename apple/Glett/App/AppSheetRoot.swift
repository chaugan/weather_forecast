import SwiftUI

/// The sheet `model.navigation.sheet` asks for: Settings, the models, "Hva er Glett?" or the places, each with its own
/// stack.
struct AppSheetRoot: View {
    let sheet: AppSheet
    let model: AppModel

    var body: some View {
        switch sheet {
        case .settings: SettingsSheet(model: model)
        case .models: ModelsSheet(model: model)
        case .about: AboutSheet()
        case .places: PlacesSheet(model: model)
        }
    }
}

#Preview {
    AppSheetRoot(sheet: .settings, model: .preview())
        .modelContainer(PlaceStore.previewContainer())
        .glettLanguage()
}
