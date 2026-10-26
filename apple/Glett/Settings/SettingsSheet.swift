import SwiftUI

/// Settings as a sheet over Været (the gear in the toolbar): its own stack, so the models and "Hva er Glett?" open
/// inside it.
struct SettingsSheet: View {
    let model: AppModel

    var body: some View {
        NavigationStack {
            SettingsView(model: model).glettSheetRoot()
        }
        .glettSheet()
    }
}

#Preview {
    Color.clear
        .sheet(isPresented: .constant(true)) { SettingsSheet(model: .preview()) }
        .glettLanguage()
        .modelContainer(PlaceStore.previewContainer())
}
