import SwiftUI

/// A day's label in the hour views ("I morgen 26. okt.", `dayLabel(d)`), filled with the accent for the day picked
/// in the week list (css/style.css:404 `.dh.cur span`).
struct DayPill: View {
    let text: String
    var current = false

    var body: some View {
        Text(verbatim: text)
            .font(.footnote.weight(.bold))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .foregroundStyle(current ? Color.white : Color.glett.muted)
            .background(current ? Color.glett.accent : Color.clear, in: Capsule())
            .accessibilityAddTraits(.isHeader)
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    HStack {
        DayPill(text: "I dag 25. okt.", current: true)
        DayPill(text: "I morgen 26. okt.")
    }
    .padding()
}
