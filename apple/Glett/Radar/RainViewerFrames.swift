import Foundation

/// RainViewer's published radar frames (`fetchRadarFrames`, js/data.js:733-743), for the radar map outside the Nordic
/// area. Cached 240 s as the web does.
actor RainViewerFrames {
    struct Frames: Sendable {
        var host: String
        /// Unix seconds and the tile path of each past frame, oldest first.
        var frames: [(t: Double, path: String)]
        var fetched: Date
    }

    static let shared = RainViewerFrames()
    /// The web's cache time for `rv:frames`.
    static let ttl: TimeInterval = 240

    private var cached: Frames?

    func frames(now: Date = Date()) async -> Frames? {
        if let c = cached, now.timeIntervalSince(c.fetched) < Self.ttl { return c }
        guard let (data, response) = try? await RadarConfig.session.data(from: RadarConfig.rvFrames),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let j = try? JSONDecoder().decode(Maps.self, from: data),
              let host = j.host, let past = j.radar?.past, !past.isEmpty else { return nil }
        let f = Frames(host: host, frames: past.map { (t: $0.time, path: $0.path) }, fetched: now)
        cached = f
        return f
    }

    private struct Maps: Decodable {
        struct Radar: Decodable { var past: [Frame]? }
        struct Frame: Decodable { var time: Double; var path: String }
        var host: String?
        var radar: Radar?
    }
}
