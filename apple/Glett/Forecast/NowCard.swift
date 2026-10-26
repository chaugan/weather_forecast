import GlettKit
import SwiftUI

/// The now card (`renderHero`, js/app.js:1059-1093): icon, temperature, "føles som", the most likely weather with
/// "{k} av {n} modeller", wind with gusts; then the verdict, the probability row, measured now, today's lines, the
/// nowcast line and the way to the radar.
struct NowCard: View {
    let model: AppModel
    let engine: ConsensusEngine

    var body: some View {
        let now = engine.nowSummary()
        VStack(alignment: .leading, spacing: 12) {
            if let now {
                header(now)
                if let v = now.verdict { VerdictView(verdict: v) }
                ProbabilityRow(step: engine.step(now.column), windUnit: model.windUnit)
            }
            MeasuredNowLine(model: model)
            OutlookLines(outlook: engine.todayOutlook(), windUnit: model.windUnit) { model.scrollToHours = true }
            NowcastLine(model: model)
            Button {
                model.path.append(.radar)
            } label: {
                Label { Text(verbatim: L10n.t("rm.open")) } icon: { Image(systemName: "dot.radiowaves.left.and.right") }
                    .font(.subheadline.weight(.medium))
            }
            .buttonStyle(.bordered)
            .tint(.glett.accent)
        }
        .glettCard(padding: 14)
    }

    private func header(_ now: NowSummary) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 14) {
                icon(now)
                temperature(now)
                description(now)
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 14) { icon(now); temperature(now) }
                description(now)
            }
        }
    }

    @ViewBuilder
    private func icon(_ now: NowSummary) -> some View {
        if let icon = now.icon { WeatherIcon(name: icon.rawValue, size: 72) }
    }

    private func temperature(_ now: NowSummary) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: Format.temp(now.temperature))
                .scaledFont(44, weight: .heavy, relativeTo: .largeTitle, maxScale: 1.6, monospacedDigit: true)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            if now.showsFeelsLike {
                Text(verbatim: L10n.t("hero.feels", ["v": JS.fmt(now.feelsLike)]))
                    .font(.subheadline)
                    .foregroundStyle(.glett.muted)
            }
        }
        .foregroundStyle(.glett.text)
        .fixedSize()
    }

    private func description(_ now: NowSummary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let top = now.top {
                Text(verbatim: "\(Format.category(top.category)) \(now.column.now ? L10n.t("hero.now") : now.column.label)")
                    .font(.headline)
                Text(verbatim: L10n.t("hero.nmodels", ["k": String(now.agreeing), "n": String(now.activeCount)]))
                    .font(.footnote)
                    .foregroundStyle(.glett.muted)
            }
            if now.wind != nil {
                HStack(spacing: 4) {
                    WindArrow(degrees: now.direction)
                    Text(verbatim: windText(now)).font(.subheadline.weight(.medium))
                }
            }
        }
        .foregroundStyle(.glett.text)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// "4 (9) m/s": mean wind, gust in brackets.
    private func windText(_ now: NowSummary) -> String {
        let u = model.windUnit
        let gust = now.gust.map { " (\(Format.wind($0, u)))" } ?? ""
        return "\(Format.wind(now.wind, u))\(gust) \(Format.windUnit(u))"
    }
}

#Preview {
    let model = AppModel.preview()
    ScrollView {
        if let e = model.engine { NowCard(model: model, engine: e).padding() }
    }
    .background(.glett.bg)
}
