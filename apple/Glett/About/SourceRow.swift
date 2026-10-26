import SwiftUI

/// One data source: its name, what the app gets from it, the licence, and a link to its site.
struct SourceRow: View {
    let source: AttributionSource

    var body: some View {
        Link(destination: source.url) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(verbatim: source.displayName).font(.subheadline.weight(.semibold)).foregroundStyle(.glett.text)
                        if let l = source.licence {
                            Text(verbatim: l)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.glett.muted)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .overlay(Capsule().strokeBorder(.glett.line))
                        }
                    }
                    Text(app: source.roleKey).font(.caption).foregroundStyle(.glett.muted).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(.glett.accent)
            }
            .padding(.vertical, 4)
            .contentShape(.rect)
        }
        .accessibilityHint(Text(verbatim: source.url.host() ?? ""))
    }
}

#Preview {
    List { ForEach(AttributionSource.all.prefix(3)) { SourceRow(source: $0) } }
}
