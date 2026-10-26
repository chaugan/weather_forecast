import SwiftUI

/// "Hva er Glett?" as a sheet over Været (the footer's link).
struct AboutSheet: View {
    var body: some View {
        NavigationStack {
            // inline title: the header under it already says "Glett" in large type
            AttributionView().navigationBarTitleDisplayMode(.inline).glettSheetRoot()
        }
        .glettSheet()
    }
}

#Preview {
    Color.clear
        .sheet(isPresented: .constant(true)) { AboutSheet() }
}
