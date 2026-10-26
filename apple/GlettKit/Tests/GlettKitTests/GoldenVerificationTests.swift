import Foundation
import Testing
@testable import GlettKit

/// The reliability check (`fetchVerify`, js/data.js:295-373) against the web's JS: the recorded answers (Frost for Oslo;
/// ERA5 and METAR for London) replayed through `VerificationService`, and the result (scores, errors, weights) held
/// against expected/verify.json.
@Suite("Golden verification") struct GoldenVerificationTests {
    static let file: GVerifyFile? = try? Golden.decode(GVerifyFile.self, "verify", "expected")
    static let slugs: [String] = file?.places.map(\.place.slug) ?? []

    @Test func bothTruthsRecorded() throws {
        let f = try #require(Self.file, "expected/verify.json does not decode")
        #expect(Set(f.places.map(\.result.truth)) == [.frost, .era5])
        #expect(Golden.manifest?.verify?.map(\.slug) == Self.slugs)
    }

    @Test(arguments: slugs) func result(_ slug: String) async throws {
        let e = try #require(Self.file?.places.first { $0.place.slug == slug })
        let stub = try GoldenReplay.transport(e.sources, base: "")
        let now = Date(timeIntervalSince1970: e.now)
        let svc = VerificationService(http: HTTPClient(transport: stub, gate: nil, identity: ClientIdentity(version: "1", build: "1")),
                                      cache: ForecastCache(directory: tempDir(), clock: { now }), clock: { now })
        let r = try await svc.verification(lat: e.place.lat, lon: e.place.lon)
        // the same requests as the web, byte for byte
        #expect(Set(stub.requests.map { $0.url!.absoluteString }) == Set(e.sources.map(\.url)))

        let w = e.result
        var d = GoldenDiff("\(slug) verification")
        d.eq("truth", r.truth, w.truth)
        d.eq("start", r.start, w.start); d.eq("end", r.end, w.end)
        d.eq("hours", r.hours, w.hours); d.eq("recent_from", r.recentFrom, w.recentFrom)
        d.eq("frost", r.frost, w.frost); d.eq("netatmo_hours", r.netatmoHours, w.netatmoHours)
        d.eq("station", r.station, w.station); d.num("obs_weight", r.obsWeight, w.obsWeight)
        d.eq("models", Set(r.models.keys), Set(w.models.keys))
        for (id, m) in w.models {
            guard let g = r.models[id] else { continue }
            let p = "models.\(id)"
            d.eq("\(p).score", g.score, m.score); d.eq("\(p).score7", g.score7, m.score7)
            Self.map("\(p).skill", g.skill, m.skill, &d)
            Self.map("\(p).mae", g.mae, m.mae, &d)
            Self.map("\(p).bias", g.bias, m.bias, &d)
            d.num("\(p).csi", g.csi, m.csi); d.num("\(p).code_acc", g.codeAcc, m.codeAcc)
            d.eq("\(p).obs?", g.obs != nil, m.obs != nil)
            if let go = g.obs, let mo = m.obs {
                Self.map("\(p).obs.mae", go.mae, mo.mae, &d)
                Self.map("\(p).obs.bias", go.bias, mo.bias, &d)
                d.num("\(p).obs.csi", go.csi, mo.csi); d.num("\(p).obs.code_acc", go.codeAcc, mo.codeAcc)
            }
            d.eq("\(p).weights.keys", Set(g.weights.keys), Set(m.weights.keys))
            for (k, v) in m.weights { d.num("\(p).weights.\(k)", g.weights[k] ?? nil, v) }
        }
        d.report()
    }

    private static func map(_ path: String, _ got: [String: Double], _ want: [String: Double], _ d: inout GoldenDiff) {
        d.eq("\(path).keys", Set(got.keys), Set(want.keys))
        for (k, v) in want { d.num("\(path).\(k)", got[k], v) }
    }
}
