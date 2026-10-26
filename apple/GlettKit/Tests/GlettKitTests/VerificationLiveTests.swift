import Testing
import Foundation
@testable import GlettKit

/// Live reliability run for Oslo (Frost + Netatmo, or ERA5 + METAR when Frost is short). Off by default; run with
/// `GLETT_LIVE=1 swift test --filter VerificationLiveTests`.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["GLETT_LIVE"] == "1"))
struct VerificationLiveTests {
    @Test func oslo() async throws {
        let service = WeatherService(cache: ForecastCache(directory: tempDir()), gate: RateGate(), identity: ClientIdentity(version: "0.1.0", build: "1"))
        let oslo = Place.cities[0]
        let v = try await service.verification(for: oslo)
        // every VERIFY_MODELS model (12: BOM has no archive) gets a score at Oslo
        #expect(Set(v.models.keys) == Set(ModelCatalog.verifyModels))
        for (id, m) in v.models {
            #expect(m.score != nil, "\(id) has no score")
            for (k, w) in m.weights {
                if let w { #expect(w >= VerificationEngine.weightMin && w <= VerificationEngine.weightMax, "\(id).\(k) = \(w)") }
            }
        }
        #expect(v.models.values.contains { $0.weight(.temperature2m) != nil })
        let again = try await service.verification(for: oslo)
        #expect(again == v)   // from the vf3 cache

        // plugged into the consensus
        let bundle = try await service.forecast(for: oslo)
        let e = bundle.consensus(settings: ForecastSettings(weighted: true, disabledModels: []), weights: v)
        #expect(e.nowSummary()?.temperature != nil)
        print("LIVE verify Oslo: truth \(v.truth.rawValue) \(v.start)…\(v.end), \(v.hours) h, netatmo \(v.netatmoHours) h, obs weight \(v.obsWeight); "
              + v.ranked().map { "\($0.id) \($0.model.score ?? -1)/\($0.model.score7 ?? -1)" }.joined(separator: ", "))
    }
}
