import GlettKit
import SwiftUI

/// The summary pill in the top bar while the place heading is scrolled away (`#miniNow`, js/app.js:1090, 1843-1853;
/// css/style.css:1082-1097): the moving weather icon, the place before its comma, the temperature and the weather.
/// A tap goes back to the top (`mini.top`).
struct MiniNow: View {
    let place: Place
    let now: NowSummary
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon = now.icon { WeatherIcon(name: icon.rawValue, size: 24, animated: true) }
                Text(verbatim: place.name.split(separator: ",").first.map(String.init) ?? place.name)
                    .fontWeight(.semibold)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(verbatim: Format.temp(now.temperature)).fontWeight(.bold).monospacedDigit()
                if let top = now.top {
                    Text(verbatim: Format.category(top.category)).foregroundStyle(.glett.muted).lineLimit(1)
                }
            }
            .font(.subheadline)
            .foregroundStyle(.glett.text)
            .padding(.leading, 6)
            .padding(.trailing, 12)
            .padding(.vertical, 3)
            .background(Color.glett.panel, in: .capsule)
            .overlay(Capsule().strokeBorder(Color.glett.line))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: L10n.t("mini.top")))
        .accessibilityValue(Text(verbatim: [place.name, Format.temp(now.temperature), now.top.map { Format.category($0.category) } ?? ""].joined(separator: ", ")))
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
}

#Preview {
    let m = AppModel.preview()
    if let now = m.engine?.nowSummary(), let p = m.place { MiniNow(place: p, now: now) {}.padding() }
}
