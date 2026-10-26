import Foundation
import Testing
@testable import GlettKit

/// The nowcast against the web's JS (Fixtures/expected/nowcast.json): the recorded answers replayed through
/// `NowcastClient` (MET radar + ring, and London's 422 → Open-Meteo fallback), and the "Neste glett" line
/// (renderSummary, js/app.js:955-962) and the 90-minute line (`lmHereLine`, js/app.js:2439-2444) at every recorded time.
@Suite("Golden nowcast") struct GoldenNowcastTests {
    static let file: GNowcastFile? = try? Golden.decode(GNowcastFile.self, "nowcast", "expected")
    static let recorded: [String] = file?.recorded.map(\.place.slug) ?? []
    static let synthetic: [String] = file?.synthetic.map(\.name) ?? []

    @Test func fileHasTheCases() throws {
        let f = try #require(Self.file, "expected/nowcast.json does not decode")
        #expect(Self.recorded == ["bergen", "london"])
        #expect(f.synthetic.count == 10)
    }

    /// `fetchNowcast` replayed: the same series, ring (order, directions), km, model flag and fetched time.
    @Test(arguments: recorded) func replay(_ slug: String) async throws {
        let rec = try #require(Self.file?.recorded.first { $0.place.slug == slug })
        let m = try #require(Golden.manifest?.nowcast.first { $0.slug == slug })
        let stub = try GoldenReplay.transport(m.requests)
        let http = HTTPClient(transport: stub, gate: nil, identity: .current)
        let cache = ForecastCache(directory: tempDir())
        let client = NowcastClient(met: METClient(http: http, cache: cache), openMeteo: OpenMeteoClient(http: http), cache: cache)
        let nc = try #require(await client.nowcast(lat: m.lat, lon: m.lon, now: Date(timeIntervalSince1970: rec.now)))

        #expect(Set(stub.requests.compactMap { $0.url?.absoluteString }) == Set(rec.sources.map(\.url)))
        var d = GoldenDiff("nowcast \(slug)")
        compare(&d, "nowcast", nc, rec.nowcast)
        d.eq("model", nc.model, rec.model)
        d.eq("model (manifest)", nc.model, m.model)
        d.report()
    }

    @Test(arguments: recorded) func recordedSentences(_ slug: String) throws {
        let rec = try #require(Self.file?.recorded.first { $0.place.slug == slug })
        var d = GoldenDiff("nowcast \(slug) sentences")
        for e in rec.evaluations { check(&d, rec.nowcast, e) }
        d.report()
    }

    @Test(arguments: synthetic) func syntheticSentences(_ name: String) throws {
        let c = try #require(Self.file?.synthetic.first { $0.name == name })
        var d = GoldenDiff("nowcast \(name)")
        for e in c.evaluations { check(&d, c.nowcast, e) }
        d.report()
    }

    private func compare(_ d: inout GoldenDiff, _ p: String, _ got: NowcastSeries, _ want: NowcastSeries) {
        func series(_ q: String, _ a: [NowcastPoint], _ b: [NowcastPoint]) {
            d.eq("\(q).count", a.count, b.count)
            for (i, (x, y)) in zip(a, b).enumerated() { d.num("\(q)[\(i)].t", x.t, y.t); d.num("\(q)[\(i)].rate", x.rate, y.rate) }
        }
        series("\(p).series", got.series, want.series)
        d.eq("\(p).ring.dirs", got.ring.map(\.dir), want.ring.map(\.dir))
        for (r, w) in zip(got.ring, want.ring) { series("\(p).ring.\(w.dir)", r.series, w.series) }
        d.num("\(p).km", got.km, want.km)
        d.num("\(p).fetched", got.fetched, want.fetched)
    }

    private func check(_ d: inout GoldenDiff, _ nc: NowcastSeries, _ e: GEval) {
        let now = Date(timeIntervalSince1970: e.now), p = "@\(Int(e.now))"

        let g = NextGlett.evaluate(nc, now: now)
        d.eq("\(p).summary?", g != nil, e.summary != nil)
        if let g, let s = e.summary {
            d.eq("\(p).summary.rainingNow", g.wetNow, s.rainingNow)
            d.eq("\(p).summary.key", g.key, s.t.first?.key)
            d.eq("\(p).summary.t.count", 1, s.t.count)
            // The web formats s[change].t or blip.t into {h}; the other sentences take no params.
            let want = s.change > 0 ? s.changeT : s.t.first?.key == "nc.dry.blip" ? s.blipT : nil
            d.num("\(p).summary.h", g.time?.timeIntervalSince1970, want)
            d.num("\(p).summary.params.h", g.time?.timeIntervalSince1970, s.t.first?.h)
            d.eq("\(p).summary.hasParams", g.time != nil, s.t.first?.hasParams)
            d.eq("\(p).summary.model", g.model, nc.model)
        }

        let h = NowcastHere.evaluate(nc, now: now)
        d.eq("\(p).here?", h != nil, e.here != nil)
        if let h, let w = e.here {
            d.eq("\(p).here.wetNow", h.wetNow, w.wetNow)
            d.eq("\(p).here.key", h.key, w.t.first?.key)
            d.num("\(p).here.h", h.flip?.timeIntervalSince1970, w.t.first?.h)
        }
    }
}
