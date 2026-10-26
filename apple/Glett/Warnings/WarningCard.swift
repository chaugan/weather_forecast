import GlettKit
import SwiftUI

/// One warning in the warnings sheet (`lmRenderAlerts`, js/app.js:2398-2414; css/style.css:1242-1269): MET's
/// triangle, the title, level (and "til havs") with the link to MET, the period and how long until it starts or ends,
/// MET's text with its web addresses as links, then the gauge of MET's numbers against the models.
struct WarningCard: View {
    let alert: MetAlert
    /// nil for the kinds without a model number (storm surge, ice, fire …), or without a forecast.
    let gauge: AlertGauge?
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            Text(AlertText.linkified(alert.desc))
                .font(.subheadline)
                .foregroundStyle(.glett.text.opacity(0.86))
                .tint(.glett.accent2)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if let gauge {
                WarningGaugeView(gauge: gauge, level: alert.level)
                verdict(gauge)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            WarningTriangle(alert)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: alert.name)
                    .font(.headline)
                    .foregroundStyle(.glett.text)
                    .fixedSize(horizontal: false, vertical: true)
                levelLine
                    .font(.footnote)
                    .foregroundStyle(.glett.muted)
                    .tint(.glett.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 1) {
                Text(verbatim: AlertText.span(alert))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.glett.text)
                if let state = AlertText.state(alert, now: now) {
                    Text(verbatim: state).font(.footnote).foregroundStyle(.glett.muted)
                }
            }
            .fixedSize()
        }
    }

    /// "gult nivå · til havs · MET", MET linking to the warning on met.no.
    private var levelLine: Text {
        var s = AttributedString("\(AlertText.levelLine(alert)) · ")
        var met = AttributedString("MET")   // the source's name, as on the web
        if let url = AlertText.web(alert) {
            met.link = url
            met.underlineStyle = .single
        }
        s += met
        return Text(s)
    }

    private func verdict(_ g: AlertGauge) -> some View {
        let v = g.verdict
        var s = AttributedString()
        if let lead = v.lead {
            var b = AttributedString(lead + " ")
            b.inlinePresentationIntent = .stronglyEmphasized
            s += b
        }
        s += AttributedString(v.text)
        return Text(s)
            .font(.subheadline)
            .foregroundStyle(.glett.text)
            .fixedSize(horizontal: false, vertical: true)
    }
}

#Preview {
    let engine = PreviewSamples.engine
    ScrollView {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(WarningSamples.alerts) { a in
                WarningCard(alert: a, gauge: AlertGauge(alert: a, engine: engine, windUnit: .ms), now: PreviewSamples.fixtureNow)
                Divider()
            }
        }
        .padding()
    }
    .background(.glett.panel)
}
