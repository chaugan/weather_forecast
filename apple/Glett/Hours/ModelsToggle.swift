import SwiftUI

/// "Vis alle {n} modellene" / "Skjul modellene" under the table (`#modelsToggle`, js/app.js:309-311, 875).
struct ModelsToggle: View {
    @Binding var open: Bool
    let count: Int

    var body: some View {
        Button {
            withAnimation(.snappy) { open.toggle() }
        } label: {
            Label {
                Text(verbatim: open ? L10n.t("g.models_hide") : L10n.t("g.models_show", ["n": "\(count)"]))
            } icon: {
                Image(systemName: open ? "chevron.up" : "chevron.down")
            }
            .font(.subheadline.weight(.semibold))
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .tint(.glett.accent)
        .frame(maxWidth: .infinity)
        .accessibilityValue(Text(verbatim: open ? L10n.t("g.models_hide") : ""))
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    @Previewable @State var open = false
    ModelsToggle(open: $open, count: 13).padding()
}
