import Foundation
@testable import GlettKit

/// Local midnight 2026-10-25 in Oslo (UTC+1 that day on Open-Meteo's axis), as unix seconds.
let osloMidnight: Double = 1792882800

/// "2026-10-25T00:00", "2026-10-25T01:00", … for n hours.
func hourAxis(_ n: Int, from midnightUnix: Double = osloMidnight, offset: Int = 3600) -> [String] {
    (0..<n).map { JS.isoUTC(midnightUnix + Double(offset) + Double($0) * 3600, 16) }
}

/// A provider whose series are filled by the closure (missing variables stay null).
func provider(_ id: String, _ n: Int, _ fill: (inout [HourlyVariable: [Double?]]) -> Void) -> Provider {
    var v: [HourlyVariable: [Double?]] = [:]
    for k in HourlyVariable.allCases { v[k] = Array(repeating: nil, count: n) }
    fill(&v)
    return Provider(id: id, hourly: Hourly(values: v, count: n))
}

func forecast(_ providers: [Provider], hours n: Int = 48) -> Forecast {
    Forecast(lat: 59.91, lon: 10.75, timezone: "Europe/Oslo", utcOffsetSeconds: 3600, elevation: 10, generated: Date(timeIntervalSince1970: osloMidnight),
             time: hourAxis(n), providers: providers).prepared()
}

/// Local time on the test axis.
func localDate(hour: Double) -> Date { Date(timeIntervalSince1970: osloMidnight + hour * 3600) }

/// A transport that answers from a closure and records the requests.
final class StubTransport: HTTPTransport, @unchecked Sendable {   // unchecked: the lock guards `requests`; tests only
    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    let handler: @Sendable (URLRequest) throws -> (Int, Data, [String: String])

    init(_ handler: @escaping @Sendable (URLRequest) throws -> (Int, Data, [String: String])) { self.handler = handler }

    var requests: [URLRequest] { lock.withLock { _requests } }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.withLock { _requests.append(request) }
        let (status, data, headers) = try handler(request)
        return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
    }
}

/// A clock the test moves.
final class TestClock: @unchecked Sendable {   // unchecked: the lock guards `now`; tests only
    private let lock = NSLock()
    private var t: Date
    init(_ t: Date) { self.t = t }
    var now: Date { lock.withLock { t } }
    func advance(_ s: TimeInterval) { lock.withLock { t = t.addingTimeInterval(s) } }
}

func tempDir() -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("glettkit-tests-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}
