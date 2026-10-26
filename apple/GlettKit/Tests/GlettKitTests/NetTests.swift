import Testing
import Foundation
@testable import GlettKit

struct NetTests {
    @Test func exactURLs() {
        let la = OpenMeteoClient.cell(59.9139), lo = OpenMeteoClient.cell(10.7522)
        #expect(OpenMeteoClient.forecastURL(lat: la, lon: lo).absoluteString == "https://api.open-meteo.com/v1/forecast?latitude=59.91&longitude=10.75&hourly=temperature_2m%2Capparent_temperature%2Cprecipitation%2Cwind_speed_10m%2Cwind_gusts_10m%2Cwind_direction_10m%2Ccloud_cover%2Crelative_humidity_2m%2Cpressure_msl%2Cweather_code%2Ccape%2Cis_day&models=ecmwf_aifs025_single%2Cecmwf_ifs025%2Cgfs_seamless%2Cicon_seamless%2Cgem_seamless%2Cmeteofrance_seamless%2Cukmo_seamless%2Cjma_seamless%2Ccma_grapes_global%2Cbom_access_global%2Cknmi_seamless%2Cdmi_seamless%2Cmetno_seamless&timezone=auto&forecast_days=7")
        #expect(METClient.compactURL(lat: la, lon: lo).absoluteString == "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=59.9100&lon=10.7500")
        #expect(OpenMeteoClient.minutelyURL(lat: la, lon: lo).absoluteString == "https://api.open-meteo.com/v1/forecast?latitude=59.91&longitude=10.75&minutely_15=precipitation&forecast_minutely_15=10&timezone=auto&models=best_match")
        #expect(OpenMeteoClient.searchURL("Tromsø, N", lang: "nb").absoluteString == "https://geocoding-api.open-meteo.com/v1/search?count=8&language=nb&name=Troms%C3%B8%2C%20N")
        #expect(CacheKey.forecast(lat: la, lon: lo) == "fc:59.91:10.75")
        #expect(CacheKey.forecast(lat: OpenMeteoClient.cell(60.0), lon: OpenMeteoClient.cell(5.0)) == "fc:60:5")
    }

    @Test func ringPoints() {
        // node: the eight ring points around 59.91, 10.75
        let js: [[Double]] = [[59.955, 10.75], [59.942, 10.813], [59.91, 10.84], [59.878, 10.813], [59.865, 10.75], [59.878, 10.687], [59.91, 10.66], [59.942, 10.687]]
        #expect(NowcastClient.ringPoints(lat: 59.91, lon: 10.75).map { [$0.lat, $0.lon] } == js)
    }

    @Test func gateWeights() {
        #expect(abs(RateGate.weight(OpenMeteoClient.forecastURL(lat: 59.91, lon: 10.75)) - 15.6) < 1e-12)
        #expect(RateGate.weight(OpenMeteoClient.searchURL("Oslo", lang: "nb")) == 1)
        #expect(RateGate.weight(OpenMeteoClient.minutelyURL(lat: 59.91, lon: 10.75)) == 1)
        #expect(RateGate.weight(URL(string: "https://api.open-meteo.com/v1/elevation?latitude=1,2,3&longitude=1,2,3")!) == 3)
        let hist = URL(string: "https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=59.9&longitude=10.8&hourly=temperature_2m%2Cprecipitation%2Cwind_speed_10m%2Ccloud_cover%2Crelative_humidity_2m%2Cpressure_msl%2Cweather_code&timezone=UTC&start_date=2026-09-21&end_date=2026-10-24&models=a%2Cb%2Cc%2Cd%2Ce%2Cf%2Cg%2Ch%2Ci%2Cj%2Ck%2Cl")!
        #expect(abs(RateGate.weight(hist) - 34.0 / 14 * (7.0 * 12 / 10)) < 1e-12)
        #expect(RateGate.isOpenMeteo(hist) && !RateGate.isOpenMeteo(URL(string: "https://api.met.no/x")!))
    }

    @Test func gateHoldsTheMinute() async throws {
        let clock = TestClock(Date(timeIntervalSince1970: 1_800_000_000))
        let gate = RateGate(clock: { clock.now })
        let url = OpenMeteoClient.forecastURL(lat: 59.91, lon: 10.75)
        for _ in 0..<32 { try await gate.take(url) }   // 32 × 15.6 = 499.2 fits in 500
        #expect(abs(await gate.usedWeight() - 499.2) < 1e-9)
        clock.advance(61)
        #expect(await gate.usedWeight() == 0)
    }

    @Test func errorMapping() async {
        let stub = StubTransport { req in
            switch req.url!.path {
            case "/429": return (429, Data(), [:])
            case "/quota": return (400, Data(#"{"error":true,"reason":"Daily API request limit exceeded"}"#.utf8), [:])
            case "/reason": return (400, Data(#"{"error":true,"reason":"Parameter 'models' invalid"}"#.utf8), [:])
            case "/plain": return (502, Data("<html>".utf8), [:])
            case "/down": throw URLError(.notConnectedToInternet)
            default: return (200, Data("{}".utf8), [:])
            }
        }
        let http = HTTPClient(transport: stub, gate: nil, identity: ClientIdentity(version: "1.2.3", build: "45"))
        func err(_ p: String) async -> GlettError? {
            do { _ = try await http.data(URL(string: "https://example.org\(p)")!); return nil } catch { return error as? GlettError }
        }
        #expect(await err("/429") == .quota(host: "example.org", limit: .minute))
        #expect(await err("/quota") == .quota(host: "example.org", limit: .minute))
        #expect(await err("/reason") == .http(host: "example.org", status: 400, reason: "Parameter 'models' invalid"))
        #expect(await err("/plain") == .http(host: "example.org", status: 502, reason: nil))
        #expect(await err("/down") == .network(host: "example.org"))
        #expect(await err("/ok") == nil)
        #expect(GlettError.quota(host: "x", limit: .day).l10nKey == "om.day")
    }

    @Test func gateHourLimitIsShared() async {
        let stub = StubTransport { _ in (429, Data(#"{"error":true,"reason":"Hourly API request limit exceeded. Please try again in the next hour."}"#.utf8), [:]) }
        let gate = RateGate()
        let http = HTTPClient(transport: stub, gate: gate, identity: ClientIdentity(version: "1", build: "1"))
        let url = OpenMeteoClient.searchURL("Oslo", lang: "nb")
        await #expect(throws: GlettError.quota(host: "geocoding-api.open-meteo.com", limit: .hour)) { _ = try await http.data(url) }
        await #expect(throws: GlettError.quota(host: "geocoding-api.open-meteo.com", limit: .hour)) { _ = try await http.data(url) }
        #expect(stub.requests.count == 1)   // the second one never left: the gate remembered the hour
    }

    @Test func identifyingHeaders() {
        let http = HTTPClient(transport: StubTransport { _ in (200, Data(), [:]) }, gate: nil, identity: ClientIdentity(version: "1.2.3", build: "45"))
        let met = http.request(METClient.compactURL(lat: 59.91, lon: 10.75))
        #expect(met.value(forHTTPHeaderField: "User-Agent") == "Glett-iOS/1.2.3 (+https://glett.no; mail@hauganmg.no)")
        #expect(met.value(forHTTPHeaderField: "X-Glett-Client") == nil)
        let g = http.request(URL(string: "https://glett.no/api/alerts.php?lang=nb")!)
        #expect(g.value(forHTTPHeaderField: "User-Agent") == "Glett-iOS/1.2.3 (+https://glett.no; mail@hauganmg.no)")
        #expect(g.value(forHTTPHeaderField: "X-Glett-Client") == "ios/45")
        let om = http.request(OpenMeteoClient.forecastURL(lat: 59.91, lon: 10.75))
        #expect(om.value(forHTTPHeaderField: "X-Glett-Client") == nil)
    }

    @Test func metConditionalRequests() async throws {
        let body = Data(#"{"properties":{"timeseries":[]}}"#.utf8)
        let stub = StubTransport { req in
            if req.value(forHTTPHeaderField: "If-Modified-Since") == "Sun, 25 Oct 2026 18:00:00 GMT" { return (304, Data(), ["Expires": "Sun, 25 Oct 2000 19:00:00 GMT"]) }
            return (200, body, ["Last-Modified": "Sun, 25 Oct 2026 18:00:00 GMT", "Expires": "Sun, 25 Oct 2000 19:00:00 GMT"])
        }
        let cache = ForecastCache(directory: tempDir())
        let met = METClient(http: HTTPClient(transport: stub, gate: nil, identity: .init(version: "1", build: "1")), cache: cache)
        let url = METClient.compactURL(lat: 59.91, lon: 10.75)
        #expect(try await met.conditionalGet(url) == body)
        #expect(try await met.conditionalGet(url) == body)   // expired: asks again with If-Modified-Since, gets 304, keeps the body
        #expect(stub.requests.count == 2)
        #expect(stub.requests[1].value(forHTTPHeaderField: "If-Modified-Since") == "Sun, 25 Oct 2026 18:00:00 GMT")

        let fresh = StubTransport { _ in (200, body, ["Expires": "Sun, 25 Oct 2099 19:00:00 GMT"]) }
        let met2 = METClient(http: HTTPClient(transport: fresh, gate: nil, identity: .init(version: "1", build: "1")), cache: ForecastCache(directory: tempDir()))
        _ = try await met2.conditionalGet(url); _ = try await met2.conditionalGet(url)
        #expect(fresh.requests.count == 1)   // Expires honoured
    }

    @Test func cacheExpiry() async {
        let clock = TestClock(Date(timeIntervalSince1970: 1_800_000_000))
        let dir = tempDir()
        let cache = ForecastCache(directory: dir, clock: { clock.now })
        await cache.put(["a": 1], "fc:59.91:10.75", ttl: 3600)
        #expect(await cache.get([String: Int].self, "fc:59.91:10.75") == ["a": 1])
        #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("fc_59.91_10.75.json").path))
        let reopened = ForecastCache(directory: dir, clock: { clock.now })
        #expect(await reopened.get([String: Int].self, "fc:59.91:10.75") == ["a": 1])
        clock.advance(3601)
        #expect(await cache.get([String: Int].self, "fc:59.91:10.75") == nil)
        #expect(await cache.entry([String: Int].self, "fc:59.91:10.75")?.value == ["a": 1])   // stale, for widgets
        #expect(await cache.mayForceRefresh("fc:x"))
        await cache.markForcedRefresh("fc:x")
        #expect(!(await cache.mayForceRefresh("fc:x")))
        clock.advance(300)
        #expect(await cache.mayForceRefresh("fc:x"))
        await cache.sweep()
        #expect(await cache.entry([String: Int].self, "fc:59.91:10.75")?.value == ["a": 1])   // expired, kept for a week
        clock.advance(CacheKey.staleKeep)
        await cache.sweep()
        #expect(await cache.entry([String: Int].self, "fc:59.91:10.75") == nil)
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("fc_59.91_10.75.json").path))
    }

    @Test func cacheMemoryIsBounded() async {
        let dir = tempDir()
        let cache = ForecastCache(directory: dir)
        for i in 0..<(ForecastCache.memoryLimit + 10) { await cache.put(i, "k\(i)", ttl: 3600) }
        #expect(await cache.memoryCount == ForecastCache.memoryLimit)
        #expect(await cache.get(Int.self, "k0") == 0)   // evicted from memory, read back from its file
        #expect(await cache.get(String.self, "k1") == nil)   // a different type does not reuse the decoded value
    }
}
