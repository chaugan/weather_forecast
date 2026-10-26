import GlettKit
import SwiftUI

/// No place yet (`#empty`, `empty.html`): the hint, the search, "Min posisjon" and the cities.
struct EmptyForecastView: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n.attributed("empty.html")).font(.body).foregroundStyle(.glett.text)
            Button { model.showPlaces = true } label: {
                Label { Text(verbatim: L10n.t("pb.search")) } icon: { Image(systemName: "magnifyingglass") }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.bordered)
            .tint(.glett.accent)
            MyLocationButton(model: model)
                .buttonStyle(.bordered)
                .tint(.glett.accent)
            Text(verbatim: L10n.t("pb.cities")).font(.headline).foregroundStyle(.glett.text)
            FlowLayout {
                ForEach(Place.cities) { city in
                    Button(city.name) { model.select(city) }
                        .buttonStyle(.bordered)
                        .tint(.glett.accent)
                }
            }
        }
        .glettCard()
    }
}

#Preview {
    EmptyForecastView(model: .previewEmpty()).padding().background(.glett.bg)
}
