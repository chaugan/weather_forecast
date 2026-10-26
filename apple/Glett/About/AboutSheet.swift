import SwiftUI

/// "Hva er Glett?" as a sheet over Været (the footer's link).
struct AboutSheet: View {
    var body: some View {
        NavigationStack {
            AttributionView().glettSheetRoot()
        }
        .glettSheet()
    }
}

#Preview {
    Color.clear
        .sheet(isPresented: .constant(true)) { AboutSheet() }
}
