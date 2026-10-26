import GlettKit
import SwiftUI

/// "Radar neste 2 timer" (`renderRadarStrip`, js/app.js:1239-1274; css/style.css:631-637, 853-865): one bar per
/// 5 minutes of MET's radar nowcast (or per 15 minutes of the model fallback) on a scale that follows the rain, the
/// status and source, "Nedbør i nærheten" from the ring, and a readout for the bar under the finger.
struct RadarStripView: View {
    let strip: RadarStrip
    @State private var selected: Int?

    /// `.rs-plot .rs-bars { height: 42px }`.
    static let plotHeight: CGFloat = 42

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: L10n.t(strip.model ? "radar.title.model" : "radar.title"))
                .font(.footnote.weight(.bold))
                .foregroundStyle(.glett.text)
            Text(verbatim: "\(status) · \(L10n.t(strip.model ? "radar.src.model" : "radar.src"))")
                .font(.caption)
                .foregroundStyle(.glett.muted)
                .padding(.top, 2)
                .fixedSize(horizontal: false, vertical: true)
            if let near = strip.nearby {
                Label { Text(verbatim: nearby(near)).fixedSize(horizontal: false, vertical: true) } icon: {
                    Image(systemName: "drop.fill").foregroundStyle(.glett.rain)
                }
                .font(.footnote)
                .foregroundStyle(.glett.text)
                .padding(.top, 6)
            }
            plot.padding(.top, 20)
            ticks.padding(.top, 2)
            readout.padding(.top, 4)
        }
        .onChange(of: strip.points.first?.t) { _, _ in selected = nil }
        .glettHaptic(.selection, trigger: selected)
    }

    // MARK: Plot

    private var plot: some View {
        GeometryReader { geo in
            let n = strip.points.count, gap: CGFloat = 2
            let w = max(1, (geo.size.width - gap * CGFloat(n - 1)) / CGFloat(n))
            ZStack(alignment: .topLeading) {
                gridLine(label: "\(Self.loc1(strip.top)) \(L10n.t("radar.unit"))", y: 0, width: geo.size.width)
                gridLine(label: Self.loc1(strip.top / 2), y: Self.plotHeight / 2, width: geo.size.width)
                HStack(alignment: .bottom, spacing: gap) {
                    ForEach(Array(strip.points.enumerated()), id: \.offset) { i, p in
                        UnevenRoundedRectangle(topLeadingRadius: 2, topTrailingRadius: 2)
                            .fill(Self.color(p.rate))
                            .frame(width: w, height: barHeight(p.rate))
                            .overlay {
                                if selected == i {
                                    UnevenRoundedRectangle(topLeadingRadius: 2, topTrailingRadius: 2).stroke(.glett.text, lineWidth: 2)
                                }
                            }
                    }
                }
                .frame(width: geo.size.width, height: Self.plotHeight, alignment: .bottomLeading)
                Rectangle().fill(.glett.line).frame(height: 1).offset(y: Self.plotHeight)
            }
            .contentShape(.rect)
            .gesture(DragGesture(minimumDistance: 0).onChanged { g in
                let i = Int((g.location.x / geo.size.width) * CGFloat(n))
                selected = min(n - 1, max(0, i))
            })
        }
        .frame(height: Self.plotHeight + 1)
        .accessibilityElement()
        .accessibilityLabel(Text(verbatim: L10n.t(strip.model ? "radar.title.model" : "radar.title")))
        .accessibilityValue(Text(verbatim: status))
    }

    private func gridLine(label: String, y: CGFloat, width: CGFloat) -> some View {
        ZStack(alignment: .topTrailing) {
            Path { p in p.move(to: .zero); p.addLine(to: CGPoint(x: width, y: 0)) }
                .stroke(.glett.line, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                .frame(width: width, height: 1)
            Text(verbatim: label)
                .scaledFont(10.5, maxScale: 1.4)
                .foregroundStyle(.glett.muted)
                .padding(.horizontal, 3)
                .background(.glett.panel)
                .offset(y: -14)
        }
        .frame(width: width, alignment: .topLeading)
        .offset(y: y)
    }

    /// js/app.js:1248: `max(rate > 0 ? 3 : 1, round(rate / top × 40))` px, on the 42 px plot.
    private func barHeight(_ rate: Double) -> CGFloat {
        CGFloat(max(rate > 0 ? 3 : 1, JS.round(rate / strip.top * 40)))
    }

    /// The bar colours (css/style.css:634, 859-861): grey dry, light/full rain colour, accent for heavy.
    static func color(_ rate: Double) -> Color {
        switch RadarStrip.intensity(rate) {
        case "heavy": .glett.accent2
        case "mod": .glett.rain
        case "wet": .glett.rain.opacity(0.55)
        default: .glett.line
        }
    }

    // MARK: Ticks and readout

    private var ticks: some View {
        GeometryReader { geo in
            let n = strip.points.count, every = strip.model ? 2 : 6
            ForEach(Array(stride(from: 0, to: n, by: every)), id: \.self) { i in
                Text(verbatim: Format.time(strip.points[i].date))
                    .scaledFont(10.5, maxScale: 1.4)
                    .foregroundStyle(.glett.muted)
                    .fixedSize()
                    .offset(x: geo.size.width * CGFloat(i) / CGFloat(n))
            }
        }
        .frame(height: 14)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var readout: some View {
        if let i = selected, i < strip.points.count {
            let p = strip.points[i]
            let value = p.rate >= 0.05 ? "\(Self.loc1(p.rate)) \(L10n.t("radar.unit")) · " : ""
            Text(Self.reading(time: Format.time(p.date), rest: " · \(value)\(L10n.t(RadarStrip.wordKey(p.rate)))"))
                .font(.footnote)
                .foregroundStyle(.glett.text)
                .frame(minHeight: 18, alignment: .leading)
        } else {
            Text(verbatim: L10n.t("radar.hint"))
                .font(.footnote)
                .foregroundStyle(.glett.muted)
                .frame(minHeight: 18, alignment: .leading)
        }
    }

    // MARK: Texts

    /// "**14:05** · 1,2 mm/t · moderat nedbør".
    static func reading(time: String, rest: String) -> AttributedString {
        var t = AttributedString(time)
        t.inlinePresentationIntent = .stronglyEmphasized
        return t + AttributedString(rest)
    }

    /// `radar.none` / `radar.total` {mm} / `radar.blip` {h}.
    private var status: String {
        switch strip.status {
        case .none: L10n.t("radar.none")
        case .total(let mm): L10n.t("radar.total", ["mm": Self.loc1(mm)])
        case .blip(let d): L10n.t("radar.blip", ["h": Format.time(d)])
        }
    }

    /// `radarNearby` (js/app.js:1276-1285): "Nedbør i nærheten: nord og nordøst, ca. 5 km unna, 14:10–14:40".
    private func nearby(_ n: RadarNearby) -> String {
        let dirs = n.directions.map { L10n.t("dir.\($0)") }
        let dirText = n.all ? L10n.t("radar.near.all")
            : dirs.count > 1 ? "\(dirs.dropLast().joined(separator: ", ")) \(L10n.t("and")) \(dirs.last!)" : (dirs.first ?? "")
        let when = n.single ? L10n.t("radar.near.at", ["h": Format.time(n.from)])
            : L10n.t("radar.near.span", ["a": Format.time(n.from), "b": Format.time(n.to)])
        return L10n.t("radar.near", ["dirs": dirText, "km": JS.string(n.km), "when": when])
    }

    /// `loc1` of js/app.js:1246: up to two decimals below 1, else one, in the app's language.
    static func loc1(_ v: Double) -> String {
        v.formatted(.number.precision(.fractionLength(0...(v < 1 ? 2 : 1))).rounded(rule: .toNearestOrAwayFromZero).locale(L10n.locale))
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    let now = PreviewSamples.fixtureNow
    let rates = [0, 0, 0, 0.2, 0.6, 1.4, 2.2, 4.5, 3.1, 1.2, 0.4, 0.1]
    let pts = (0..<24).map { i in NowcastPoint(t: now.timeIntervalSince1970 + Double(i) * 300, rate: rates[i % 12] * (i < 12 ? 1 : 0.3)) }
    let nc = NowcastSeries(series: pts, ring: [.init(dir: "sw", series: pts), .init(dir: "w", series: pts)], km: 5, fetched: now.timeIntervalSince1970)
    VStack {
        if let s = RadarStrip.make(nc, now: now) { RadarStripView(strip: s) }
    }
    .padding()
    .frame(width: 380)
    .background(.glett.panel)
}
