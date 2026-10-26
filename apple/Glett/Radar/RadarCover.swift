import SwiftUI

/// The rain radar full screen (`model.presentRadar()`): zooms out of the now card's radar strip and back into it when
/// closed. Without a strip on screen it slides up.
struct RadarCover: View {
    let model: AppModel

    var body: some View {
        NavigationStack {
            RadarMapView(model: model)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { SheetCloseButton() } }
        }
        .tint(.glett.accent)
        .radarZoomDestination()
    }
}

#Preview {
    RadarCover(model: .preview())
}
