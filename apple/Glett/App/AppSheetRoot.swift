import SwiftUI

/// The sheet `model.navigation.sheet` asks for: Settings, the models or "Hva er Glett?", each with its own stack.
struct AppSheetRoot: View {
    let sheet: AppSheet
    let model: AppModel

    var body: some View {
        switch sheet {
        case .settings: SettingsSheet(model: model)
        case .models: ModelsSheet(model: model)
        case .about: AboutSheet()
        }
    }
}

#Preview {
    AppSheetRoot(sheet: .settings, model: .preview())
        .modelContainer(PlaceStore.previewContainer())
        .glettLanguage()
}
