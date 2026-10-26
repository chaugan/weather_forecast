import GlettKit
import SwiftData
import SwiftUI

/// One place chip (`.chip`, css/style.css:333-342): the name before its comma, a gold ★ in front of a saved place,
/// recent places in muted text; the shown place filled with the accent and with its own star to save or remove it.
struct PlaceChip: View {
    let place: Place
    let kind: PlaceGroup.Kind
    let model: AppModel
    @Environment(\.modelContext) private var context

    var body: some View {
        let active = model.place?.placeKey == place.placeKey
        HStack(spacing: 0) {
            Button { model.select(place, recent: kind == .recent) } label: {
                HStack(spacing: 5) {
                    if kind == .saved {
                        Text(verbatim: "★").font(.caption).foregroundStyle(active ? Color.glett.onAccent : Color.glett.sun)
                    }
                    Text(verbatim: place.name.split(separator: ",").first.map(String.init) ?? place.name)
                        .fontWeight(active ? .semibold : .medium)
                        .foregroundStyle(active ? Color.glett.onAccent : kind == .recent ? Color.glett.muted : Color.glett.text)
                        .lineLimit(1)
                }
                .padding(.leading, 14)
                .padding(.trailing, active ? 8 : 14)
                .frame(minHeight: 38)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(active ? .isSelected : [])
            if active { star }
        }
        .font(.subheadline)
        .background(active ? Color.glett.accent : Color.glett.panel, in: .capsule)
        .overlay(Capsule().strokeBorder(active ? Color.glett.accent : Color.glett.line))
        .contentShape(.capsule)
    }

    /// `.chip .star`: ☆ saves the shown place in "Mine steder", ★ removes it.
    private var star: some View {
        let s = PlaceStore.saved(place, in: context)
        return Button {
            // as the web (js/app.js:1378): saving also puts the place among the recent ones
            if let s { PlaceStore.remove(s, in: context) } else { _ = PlaceStore.save(place, in: context); model.addRecent(place) }
        } label: {
            Text(verbatim: s != nil ? "★" : "☆")
                .foregroundStyle(Color.glett.onAccent)
                .padding(.leading, 8)
                .padding(.trailing, 12)
                .frame(minHeight: 38)
                .overlay(alignment: .leading) { Rectangle().fill(Color.glett.onAccent.opacity(0.35)).frame(width: 1) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: L10n.t(s != nil ? "pb.unstar" : "pb.star")))
    }
}

/// A group's small upper-case label (`.chiplbl`).
struct PlaceGroupLabel: View {
    let group: PlaceGroup

    var body: some View {
        Text(verbatim: L10n.t(group.titleKey).uppercased(with: L10n.locale))
            .font(.caption2.weight(.bold))
            .tracking(0.5)
            .foregroundStyle(.glett.muted)
            .accessibilityAddTraits(.isHeader)
    }
}

#Preview {
    let m = AppModel.preview()
    HStack {
        PlaceChip(place: m.place!, kind: .saved, model: m)
        PlaceChip(place: Place.cities[1], kind: .city, model: m)
    }
    .padding()
    .modelContainer(PlaceStore.previewContainer())
}
