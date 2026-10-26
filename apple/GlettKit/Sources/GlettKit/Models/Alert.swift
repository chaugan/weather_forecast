import Foundation

/// MET warnings as `api/alerts.php` returns them (MetAlerts 2.0 reduced to what Glett draws): `{updated, alerts: [...]}`.
public struct AlertsResponse: Sendable, Codable {
    public var updated: String?
    public var alerts: [MetAlert]

    public init(updated: String?, alerts: [MetAlert]) { self.updated = updated; self.alerts = alerts }

    /// `lmAlertsHere()` of js/app.js:2311-2314: the warnings whose area holds the point, the most serious first, then the earliest.
    public func here(lat: Double, lon: Double) -> [MetAlert] {
        let hits = alerts.filter { $0.geometry?.contains(lat: lat, lon: lon) ?? false }
        return JS.stableSorted(hits) { p, q in
            let r = p.levelRank - q.levelRank
            if r != 0 { return r > 0 }
            return (p.fromDate?.timeIntervalSince1970 ?? 0) < (q.fromDate?.timeIntervalSince1970 ?? 0)
        }
    }
}

/// One warning (the fields of api/alerts.php:24-31).
public struct MetAlert: Sendable, Codable, Identifiable, Hashable {
    public var id: String
    public var event: String
    /// MET's headline, e.g. "Kraftige vindkast".
    public var name: String
    /// "yellow", "orange", "red" (or "green").
    public var level: String
    /// The awareness type in lower case: "wind", "rain", "snow", "ice", "thunder", "forestfire", ...
    public var type: String
    public var severity: String
    public var area: String
    /// "land" or "marine".
    public var domain: String
    public var desc: String
    public var instr: String
    public var cons: String
    public var trigger: String
    public var from: String?
    public var to: String?
    public var web: String
    public var geometry: GeoJSONGeometry?

    public var fromDate: Date? { from.flatMap(JS.parseISO).map(Date.init(timeIntervalSince1970:)) }
    public var toDate: Date? { to.flatMap(JS.parseISO).map(Date.init(timeIntervalSince1970:)) }

    /// `LEVEL_RANK` (js/app.js:35): red 3, orange 2, yellow 1, green 0.
    public var levelRank: Int { ["red": 3, "orange": 2, "yellow": 1, "green": 0][level] ?? 0 }

    /// The symbol inside MET's triangle (`AW_KIND`, js/app.js:52): "wind", "rain", "snow", "ice", "thunder", "coastalevent", "forestfire" or "".
    public var symbol: String {
        let k = (type.isEmpty ? event : type).lowercased()
        let direct = ["wind", "rain", "snow", "ice", "thunder", "coastalevent", "forestfire"]
        if direct.contains(k) { return k }
        let map = ["lightning": "thunder", "stormsurge": "coastalevent", "snow-ice": "snow", "icing": "ice", "blowingsnow": "snow", "gale": "wind", "polarlow": "wind"]
        return map[k] ?? ""
    }

    private enum CodingKeys: String, CodingKey { case id, event, name, level, type, severity, area, domain, desc, instr, cons, trigger, from, to, web, geometry }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func s(_ k: CodingKeys) -> String { ((try? c.decodeIfPresent(String.self, forKey: k)) ?? nil) ?? "" }
        id = s(.id); event = s(.event); name = s(.name); level = s(.level); type = s(.type); severity = s(.severity)
        area = s(.area); domain = s(.domain); desc = s(.desc); instr = s(.instr); cons = s(.cons); trigger = s(.trigger); web = s(.web)
        from = try? c.decodeIfPresent(String.self, forKey: .from)
        to = try? c.decodeIfPresent(String.self, forKey: .to)
        geometry = try? c.decodeIfPresent(GeoJSONGeometry.self, forKey: .geometry)
    }
}

/// The GeoJSON geometries MetAlerts uses. Coordinates are [lon, lat].
public indirect enum GeoJSONGeometry: Sendable, Codable, Hashable {
    case polygon([[[Double]]])
    case multiPolygon([[[[Double]]]])
    case collection([GeoJSONGeometry])
    case other(String)

    private enum CodingKeys: String, CodingKey { case type, coordinates, geometries }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "Polygon": self = .polygon(try c.decode([[[Double]]].self, forKey: .coordinates))
        case "MultiPolygon": self = .multiPolygon(try c.decode([[[[Double]]]].self, forKey: .coordinates))
        case "GeometryCollection": self = .collection(try c.decodeIfPresent([GeoJSONGeometry].self, forKey: .geometries) ?? [])
        default: self = .other(type)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .polygon(let p): try c.encode("Polygon", forKey: .type); try c.encode(p, forKey: .coordinates)
        case .multiPolygon(let m): try c.encode("MultiPolygon", forKey: .type); try c.encode(m, forKey: .coordinates)
        case .collection(let g): try c.encode("GeometryCollection", forKey: .type); try c.encode(g, forKey: .geometries)
        case .other(let t): try c.encode(t, forKey: .type)
        }
    }

    /// `pointInGeom` of js/app.js:2299-2305 (outer ring in, no hole).
    public func contains(lat: Double, lon: Double) -> Bool {
        switch self {
        case .polygon(let rings):
            guard let outer = rings.first else { return false }
            return Self.inRing(lat, lon, outer) && !rings.dropFirst().contains { Self.inRing(lat, lon, $0) }
        case .multiPolygon(let polys):
            return polys.contains { poly in
                guard let outer = poly.first else { return false }
                return Self.inRing(lat, lon, outer) && !poly.dropFirst().contains { Self.inRing(lat, lon, $0) }
            }
        case .collection(let g): return g.contains { $0.contains(lat: lat, lon: lon) }
        case .other: return false
        }
    }

    /// `pointInRing` of js/app.js:2291-2298 (even-odd ray casting).
    static func inRing(_ lat: Double, _ lon: Double, _ ring: [[Double]]) -> Bool {
        var inside = false
        var k = ring.count - 1
        for i in 0..<ring.count {
            guard ring[i].count >= 2, ring[k].count >= 2 else { k = i; continue }
            let xi = ring[i][0], yi = ring[i][1], xk = ring[k][0], yk = ring[k][1]
            if (yi > lat) != (yk > lat) && lon < ((xk - xi) * (lat - yi)) / (yk - yi) + xi { inside.toggle() }
            k = i
        }
        return inside
    }

    /// `geomBBox` of js/app.js:2306-2310: [minLon, minLat, maxLon, maxLat].
    public var bbox: [Double] {
        var b = [Double.infinity, .infinity, -Double.infinity, -Double.infinity]
        func add(_ p: [Double]) { guard p.count >= 2 else { return }; b[0] = min(b[0], p[0]); b[1] = min(b[1], p[1]); b[2] = max(b[2], p[0]); b[3] = max(b[3], p[1]) }
        func walk(_ g: GeoJSONGeometry) {
            switch g {
            case .polygon(let r): r.forEach { $0.forEach(add) }
            case .multiPolygon(let m): m.forEach { $0.forEach { $0.forEach(add) } }
            case .collection(let gs): gs.forEach(walk)
            case .other: break
            }
        }
        walk(self)
        return b
    }
}
