import SwiftUI

/// The top of the about screen: the icon, "Glett", "Et glimt av været" and the version.
struct AboutHeader: View {
    var body: some View {
        HStack(spacing: 14) {
            WeatherIcon(name: "partly-day", size: 60)
                .padding(6)
                .background(Color.glett.summary, in: .rect(cornerRadius: 18))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: L10n.t("title")).font(.largeTitle.weight(.bold))
                Text(verbatim: L10n.t("brand.sub")).font(.subheadline).foregroundStyle(.glett.muted)
                Text(verbatim: AppText.t("app.version") + " " + AppVersion.text)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.glett.muted)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(.glett.text)
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    AboutHeader().padding()
}
