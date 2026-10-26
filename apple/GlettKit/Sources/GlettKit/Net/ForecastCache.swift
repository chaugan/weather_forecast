import Foundation

/// Glett's cache keys and lifetimes, as the web's (js/data.js:11-13, 178, 678, 691, 704, 722, 745).
public enum CacheKey {
    /// `fc:<lat2>:<lon2>`, 1 hour (`FORECAST_TTL`).
    public static func forecast(lat: Double, lon: Double) -> String { "fc:\(JS.string(lat)):\(JS.string(lon))" }
    /// `nc2:<lat2>:<lon2>`, 5 minutes (`NOWCAST_TTL`).
    public static func nowcast(lat: Double, lon: Double) -> String { "nc2:\(JS.string(lat)):\(JS.string(lon))" }
    /// `ncm:<lat2>:<lon2>`, 15 minutes: the model fallback.
    public static func nowcastModel(lat: Double, lon: Double) -> String { "ncm:\(JS.string(lat)):\(JS.string(lon))" }
    /// `alerts:<lang>`, 10 minutes (`ALERTS_TTL`).
    public static func alerts(lang: String) -> String { "alerts:\(lang)" }
    /// `nl:<lat2>:<lon2>`: measured now, 9 minutes (5 when too few stations).
    public static func local(lat: Double, lon: Double) -> String { "nl:\(JS.string(lat)):\(JS.string(lon))" }
    /// `nlm3:<r>:<lat2>:<lon2>`: the station map, 9 minutes.
    public static func localMap(r: Double, lat: Double, lon: Double) -> String { "nlm3:\(JS.string(r)):\(JS.string(lat)):\(JS.string(lon))" }
    /// `vf3:<lat1>:<lon1>`: verification, 24 hours (`VERIFY_TTL`).
    public static func verify(lat: Double, lon: Double) -> String { "vf3:\(JS.string(lat)):\(JS.string(lon))" }

    public static let forecastTTL: TimeInterval = 3600
    /// `REFRESH_MIN_INTERVAL` (js/data.js:12): "Refresh" may bypass the cache at most this often per cell.
    public static let refreshMinInterval: TimeInterval = 300
    public static let verifyTTL: TimeInterval = 86400
    public static let nowcastTTL: TimeInterval = 300
    public static let nowcastModelTTL: TimeInterval = 900
    public static let alertsTTL: TimeInterval = 600
    public static let localTTL: TimeInterval = 540
    public static let localFewTTL: TimeInterval = 300
    /// App only (the web drops entries at expiry): `sweep()` keeps an expired entry this long, so a stored forecast or
    /// reliability result can still be shown offline, on first paint and in widgets (`entry(_:_:)`).
    public static let staleKeep: TimeInterval = 7 * 86400
}

/// One cached value with its times (the web's `{body, fetched_at, expires_at}`).
public struct CacheEntry<T: Sendable>: Sendable {
    public var value: T
    public var fetchedAt: Date
    public var expiresAt: Date
    public func isFresh(at now: Date = Date()) -> Bool { expiresAt > now }
}

/// The on-disk cache: one Codable JSON file per key in a caches folder (the App Group's `Library/Caches/Glett` on iOS,
/// so widgets read what the app fetched). Same keys and lifetimes as the web's IndexedDB `cache` store.
public actor ForecastCache {
    private struct Envelope<T: Codable>: Codable { var fetched_at: Double; var expires_at: Double; var body: T }
    private struct Times: Codable { var fetched_at: Double; var expires_at: Double }

    /// A file's bytes and, once read, the decoded entry (so a forecast is not decoded again on every call).
    private struct Held { var data: Data; var decoded: Any? }

    public let directory: URL
    private let clock: @Sendable () -> Date
    /// The in-memory mirror, least recently used first out; at most `memoryLimit` entries (the files stay).
    private var memory: [String: Held] = [:]
    private var recent: [String] = []
    /// About one place's keys (forecast, MET body, 9 nowcast points, warnings, measured now, reliability) plus a few more.
    public static let memoryLimit = 24

    public static let shared = ForecastCache()

    /// - Parameter directory: where the files go; nil = the App Group's caches (iOS/watchOS) or the user caches folder.
    public init(directory: URL? = nil, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory ?? Self.defaultDirectory()
        self.clock = clock
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
    }

    public static func defaultDirectory() -> URL {
        let fm = FileManager.default
        #if !os(macOS)
        if let g = fm.containerURL(forSecurityApplicationGroupIdentifier: AppGroup.identifier) {
            return g.appendingPathComponent("Library/Caches/Glett", isDirectory: true)
        }
        #endif
        let base = fm.urls(for: .cachesDirectory, in: .userDomainMask).first ?? fm.temporaryDirectory
        return base.appendingPathComponent("no.glett.cache", isDirectory: true)
    }

    /// The file for a key: unsafe characters become "_" ("fc:59.91:10.75" → "fc_59.91_10.75.json").
    public nonisolated func fileURL(for key: String) -> URL {
        let safe = String(key.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || "._-".unicodeScalars.contains($0) ? Character($0) : "_" })
        return directory.appendingPathComponent(safe + ".json")
    }

    private func hold(_ key: String, _ held: Held) {
        memory[key] = held
        recent.removeAll { $0 == key }
        recent.append(key)
        while recent.count > Self.memoryLimit { memory[recent.removeFirst()] = nil }
    }

    /// Entries held in memory (tests).
    var memoryCount: Int { memory.count }

    private func forget(_ key: String) {
        memory[key] = nil
        recent.removeAll { $0 == key }
    }

    /// `cacheGet(k)`: the value while it has not expired.
    public func get<T: Codable & Sendable>(_ type: T.Type, _ key: String) -> T? {
        guard let e = entry(type, key), e.isFresh(at: clock()) else { return nil }
        return e.value
    }

    /// The value with its times, also when it has expired (widgets show the newest forecast they have).
    public func entry<T: Codable & Sendable>(_ type: T.Type, _ key: String) -> CacheEntry<T>? {
        if let h = memory[key], let e = h.decoded as? CacheEntry<T> {
            hold(key, h)
            return e
        }
        guard let d = memory[key]?.data ?? (try? Data(contentsOf: fileURL(for: key))),
              let env = try? JSONDecoder().decode(Envelope<T>.self, from: d) else { return nil }
        let e = CacheEntry(value: env.body, fetchedAt: Date(timeIntervalSince1970: env.fetched_at), expiresAt: Date(timeIntervalSince1970: env.expires_at))
        hold(key, Held(data: d, decoded: e))
        return e
    }

    /// `cachePut(k, body, ttl)`.
    public func put<T: Codable & Sendable>(_ value: T, _ key: String, ttl: TimeInterval) {
        let now = clock().timeIntervalSince1970
        guard let d = try? JSONEncoder().encode(Envelope(fetched_at: now, expires_at: now + ttl, body: value)) else { return }
        let e = CacheEntry(value: value, fetchedAt: Date(timeIntervalSince1970: now), expiresAt: Date(timeIntervalSince1970: now + ttl))
        hold(key, Held(data: d, decoded: e))
        try? d.write(to: fileURL(for: key), options: .atomic)
    }

    public func remove(_ key: String) {
        forget(key)
        try? FileManager.default.removeItem(at: fileURL(for: key))
    }

    /// `cacheSweep()` (js/data.js:93-102): drops entries that expired more than `CacheKey.staleKeep` ago. The web drops
    /// them at expiry; the app keeps them a week because it shows stored data when offline.
    public func sweep() {
        let cutoff = clock().timeIntervalSince1970 - CacheKey.staleKeep
        memory.removeAll()
        recent.removeAll()
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        for f in files where f.pathExtension == "json" {
            guard let d = try? Data(contentsOf: f), let t = try? JSONDecoder().decode(Times.self, from: d) else { continue }
            if t.expires_at < cutoff { try? FileManager.default.removeItem(at: f) }
        }
    }

    /// The forced-refresh throttle of js/data.js:179-182 and :205 (`glett.refresh.<key>`): true when a "Refresh" may
    /// bypass the cache now (the last forced one was 5 minutes ago or more).
    public func mayForceRefresh(_ key: String) -> Bool {
        guard let last = get(Double.self, "refresh:" + key) else { return true }
        return clock().timeIntervalSince1970 - last >= CacheKey.refreshMinInterval
    }

    public func markForcedRefresh(_ key: String) {
        put(clock().timeIntervalSince1970, "refresh:" + key, ttl: CacheKey.refreshMinInterval)
    }
}
