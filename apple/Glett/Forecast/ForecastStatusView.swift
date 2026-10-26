import GlettKit
import SwiftUI

/// Loading, errors, the rate gate's wait and the stored-data note (`#loading`, `#error`, index.html:104-106):
/// - nothing to show yet: a spinner with "Henter varsler fra alle modellene…";
/// - a failed fetch with nothing stored: the message and a retry button;
/// - a failed fetch over a stored forecast: the message as a note;
/// - a stored forecast past its lifetime (offline, or the fetch failed): "Lagret varsel fra fre. 14:05" (`app.stored`).
struct ForecastStatusView: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let until = model.rateWaitUntil, until > Date() {
                notice(L10n.t("om.wait", ["s": String(max(1, Int(until.timeIntervalSinceNow.rounded(.up))))]), systemImage: "hourglass", tint: .glett.mid)
            }
            if model.bundle == nil, model.isLoading {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(verbatim: L10n.t("loading")).font(.subheadline).foregroundStyle(.glett.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glettCard(padding: 14)
            } else if let message = model.errorMessage {
                if model.bundle == nil {
                    VStack(alignment: .leading, spacing: 10) {
                        notice(message, systemImage: "exclamationmark.triangle.fill", tint: .glett.bad)
                        Button { model.reload(force: true) } label: { Text(verbatim: L10n.t("tb.refresh")).foregroundStyle(Color.glett.onAccent) }
                            .buttonStyle(.borderedProminent)
                            .tint(.glett.accent)
                    }
                } else {
                    notice(message, systemImage: "wifi.exclamationmark", tint: .glett.mid)
                }
            }
            if model.isShowingStoredData, let b = model.bundle, !model.isLoading {
                notice(AppText.t("app.stored", ["time": Format.fetched(b.forecast.generated, now: model.now)]), systemImage: "clock.arrow.circlepath", tint: .glett.mid)
            }
        }
    }

    private func notice(_ text: String, systemImage: String, tint: Color) -> some View {
        Label {
            Text(verbatim: text).font(.subheadline).foregroundStyle(.glett.text)
        } icon: {
            Image(systemName: systemImage).foregroundStyle(tint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(tint.opacity(0.1), in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(tint.opacity(0.4)))
    }
}

#Preview {
    ForecastStatusView(model: .previewEmpty()).padding()
}
