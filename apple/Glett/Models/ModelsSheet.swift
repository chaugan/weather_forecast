import SwiftUI

/// The models and their reliability as a sheet over Været ("Vis alle modellene"); a model's detail opens inside it.
struct ModelsSheet: View {
    let model: AppModel

    var body: some View {
        NavigationStack {
            ModelsListView(model: model).glettSheetRoot()
        }
        .glettSheet()
    }
}

#Preview {
    Color.clear
        .sheet(isPresented: .constant(true)) { ModelsSheet(model: .preview()) }
}
