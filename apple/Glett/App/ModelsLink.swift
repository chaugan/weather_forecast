import SwiftUI

/// "Vis alle {n} modellene" (`g.models_show`): the individual models are one step away, as on the web.
struct ModelsLink: View {
    let model: AppModel

    var body: some View {
        if let c = model.modelCounts {
            Button { model.path.append(.models) } label: {
                HStack {
                    Text(verbatim: L10n.t("g.models_show", ["n": String(c.unique)]))
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(.glett.muted)
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.glett.accent)
                .glettCard(padding: 14)
            }
            .buttonStyle(.plain)
        }
    }
}

#Preview {
    ModelsLink(model: .preview()).padding().background(.glett.bg)
}
