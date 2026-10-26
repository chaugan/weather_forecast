import SwiftUI

/// The close button of the app's sheets and the radar cover, placed with `ToolbarItem(placement: .topBarTrailing)`:
/// the system's round ✕ (`role: .close`) on iOS 26, "Lukk" (`h.close`) on iOS 18. Both say "Lukk" to VoiceOver in the
/// app's language.
struct SheetCloseButton: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        if #available(iOS 26, *) {
            Button(role: .close) { dismiss() } label: {
                Label { Text(verbatim: L10n.t("h.close")) } icon: { Image(systemName: "xmark") }
            }
        } else {
            Button { dismiss() } label: { Text(verbatim: L10n.t("h.close")) }
        }
    }
}

#Preview {
    NavigationStack {
        Color.clear
            .navigationTitle(Text(verbatim: "Innstillinger"))
            .toolbar { ToolbarItem(placement: .topBarTrailing) { SheetCloseButton() } }
    }
}
