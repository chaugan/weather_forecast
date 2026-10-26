import SwiftUI

/// The places as a sheet over Været (the search chip): search, "Min posisjon", "Mine steder", the cities.
struct PlacesSheet: View {
    let model: AppModel

    var body: some View {
        NavigationStack {
            PlacesView(model: model).glettSheetRoot()
        }
        .glettSheet()
    }
}

#Preview {
    Color.clear
        .sheet(isPresented: .constant(true)) { PlacesSheet(model: .preview()) }
        .glettLanguage()
        .modelContainer(PlaceStore.previewContainer())
}
