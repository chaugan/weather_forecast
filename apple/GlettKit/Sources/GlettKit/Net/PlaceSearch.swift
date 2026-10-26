import Foundation

/// Place search as the web does it.
/// - `places(_:lang:)`: the forecast page's search, Open-Meteo geocoding (js/data.js:668-671; js/app.js:1386-1404).
/// - `search(_:lang:)`: Kjørevær's search (js/route.js:2815-2829): an address (Kartverket's address register) when the
///   text has a house number, else places first and then streets that start with the text.
/// - `namedPlaces(_:)`: Kartverket's place names, exact matches ranked town-first (js/route.js:1906-1918).
/// The caller debounces (350 ms) and searches from 2 characters, as the web does.
public struct PlaceSearch: Sendable {
    public let openMeteo: OpenMeteoClient
    public let http: HTTPClient
    public let geonorge: URL

    public init(openMeteo: OpenMeteoClient, http: HTTPClient, geonorge: URL = Endpoints.production.geonorge) {
        self.openMeteo = openMeteo; self.http = http; self.geonorge = geonorge
    }

    /// The forecast page's search.
    public func places(_ q: String, lang: String) async throws -> [PlaceHit] {
        try await openMeteo.search(q, lang: lang)
    }

    /// `placeSearch(q)` of js/route.js:2815-2829.
    public func search(_ q: String, lang: String) async -> [PlaceHit] {
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasNumber = q.range(of: "[0-9]", options: .regularExpression) != nil && trimmed.range(of: "^[0-9]{4}$", options: .regularExpression) == nil
        if hasNumber {   // an address: address hits stand alone; places only when nothing matched
            let addr = await addresses(q)
            if !addr.isEmpty { return Array(addr.prefix(8)) }
            var place = Self.replace(q, "[0-9]+[a-zA-Z]?", " ")
            place = Self.replace(place, "[\\s,]+", " ").trimmingCharacters(in: .whitespaces)
            let hits = (try? await places(place.isEmpty ? q : place, lang: lang)) ?? []
            return Array(hits.prefix(8))
        }
        // a name: places first (Kongsberg the town), then streets that start with it (Kongsberggata in Oslo)
        async let p = (try? await places(q, lang: lang)) ?? []
        async let s = trimmed.count >= 3 ? streets(q) : []
        let P = Array(await p.prefix(5))
        let S = await s
        return P + Array(S.prefix(max(3, 8 - P.count)))
    }

    // MARK: Kartverket's address register (js/route.js:2770-2813)

    private struct Adresser: Decodable {
        struct Punkt: Decodable { var lat: Double; var lon: Double }
        struct A: Decodable {
            var adressetekst: String?; var adressenavn: String?; var nummer: Double?; var postnummer: String?; var poststed: String?
            var kommunenavn: String?; var representasjonspunkt: Punkt?
        }
        var adresser: [A]?
    }

    var adresserBase: String { Endpoints.url(geonorge, "adresser/v1/sok", "utkoordsys=4258").absoluteString }

    private func get(_ u: String) async -> [Adresser.A] {
        guard let url = URL(string: u), let j = try? await http.json(Adresser.self, url) else { return [] }
        return (j.adresser ?? []).filter { $0.representasjonspunkt != nil }
    }

    /// `townCase(x)` of js/route.js:2775: lower case, then every word (also after "-") capitalised.
    public static func townCase(_ x: String?) -> String {
        var out = "", up = true
        for ch in (x ?? "").lowercased() {
            if up && !ch.isWhitespace { out += ch.uppercased(); up = false } else { out.append(ch) }
            if ch.isWhitespace || ch == "-" { up = true }
        }
        return out
    }

    /// A way to read the typed address: street, house number, town (empty when none).
    public struct AddressCandidate: Sendable, Hashable { public var street: String; public var num: String; public var town: String }

    /// `addressCandidates(q)` of js/route.js:2779-2791, the likeliest first.
    public static func addressCandidates(_ q0: String) -> [AddressCandidate] {
        // 12b, 12 B, 12-B -> 12B
        var q = q0.trimmingCharacters(in: .whitespacesAndNewlines)
        q = replaceEach(q, "([0-9]+)\\s*-?\\s*([a-zA-ZæøåÆØÅ])(?![A-Za-z0-9_æøåÆØÅ])") { g in g[1] + g[2].uppercased() }
        if let m = match(q, "^([0-9]+[A-ZÆØÅ]?)\\s+(.+)$") {   // number first
            let num = m[1], rest = m[2]
            if rest.contains(",") {
                let parts = rest.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
                return [AddressCandidate(street: parts[0].trimmingCharacters(in: .whitespaces), num: num,
                                         town: parts.dropFirst().joined(separator: ",").trimmingCharacters(in: .whitespaces))]
            }
            let w = rest.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            var out = [AddressCandidate(street: rest, num: num, town: "")]
            var k = 1
            while k <= 2 && k < w.count {
                out.append(AddressCandidate(street: w.dropLast(k).joined(separator: " "), num: num, town: w.suffix(k).joined(separator: " ")))
                k += 1
            }
            return out
        }
        if let m = match(q, "^(.*?)\\s+([0-9]+[A-ZÆØÅ]?)(?![A-Za-z0-9_æøåÆØÅ])\\s*,?\\s*(.*)$"), !m[1].isEmpty {   // number after the street
            return [AddressCandidate(street: m[1].trimmingCharacters(in: .whitespaces), num: m[2],
                                     town: replace(m[3].trimmingCharacters(in: .whitespaces), "^,\\s*", ""))]
        }
        return []
    }

    /// `townFilters(town)`: postcode, or postal town and municipality (they often differ: poststed Moelv, kommune Ringsaker).
    static func townFilters(_ town: String) -> [String] {
        if town.isEmpty { return [""] }
        if town.range(of: "^[0-9]{4}$", options: .regularExpression) != nil { return ["&postnummer=" + town] }
        return ["&poststed=" + JS.encodeURIComponent(town), "&kommunenavn=" + JS.encodeURIComponent(town)]
    }

    /// `ADDRESS_SOURCES.geonorge.search(q)`: exact first, then numbers that start the same (12 → 120A), then the street in that town.
    public func addresses(_ q: String) async -> [PlaceHit] {
        for c in Self.addressCandidates(q) {
            let f = Self.townFilters(c.town)
            let sok = { (x: String) in "\(adresserBase)&treffPerSide=8&sok=\(JS.encodeURIComponent(x))" }
            let urls = f.map { sok("\(c.street) \(c.num)") + $0 } + f.map { sok("\(c.street) \(c.num)*") + $0 } + (c.town.isEmpty ? [] : f.map { sok(c.street) + $0 })
            for u in urls {
                let a = await get(u)
                if !a.isEmpty {
                    return a.map { x in
                        let town = Self.townCase(x.poststed)
                        let kommune = (x.kommunenavn ?? "").isEmpty || x.kommunenavn!.lowercased() == (x.poststed ?? "").lowercased() ? "" : " · " + Self.townCase(x.kommunenavn)
                        return PlaceHit(name: "\(x.adressetekst ?? ""), \(town)", sub: "\(x.postnummer ?? "") \(town)\(kommune)",
                                        lat: x.representasjonspunkt!.lat, lon: x.representasjonspunkt!.lon, kind: .addr)
                    }
                }
            }
        }
        return []
    }

    /// `ADDRESS_SOURCES.geonorge.streets(q)`: streets whose name starts with the text, one per street and postcode, at a middle house.
    public func streets(_ q: String) async -> [PlaceHit] {
        let a = await get("\(adresserBase)&treffPerSide=100&adressenavn=\(JS.encodeURIComponent(q.trimmingCharacters(in: .whitespacesAndNewlines) + "*"))")
        var order: [String] = [], groups: [String: [Adresser.A]] = [:]
        for x in a {
            let k = "\(x.adressenavn ?? "")|\(x.postnummer ?? "")"
            if groups[k] == nil { order.append(k) }
            groups[k, default: []].append(x)
        }
        return order.map { k in
            let xs = JS.stableSorted(groups[k]!) { ($0.nummer ?? 0) < ($1.nummer ?? 0) }
            let x = xs[xs.count / 2]
            let town = Self.townCase(x.poststed)
            return PlaceHit(name: "\(x.adressenavn ?? ""), \(town)", sub: "\(x.postnummer ?? "") \(town)",
                            lat: x.representasjonspunkt!.lat, lon: x.representasjonspunkt!.lon, kind: .street)
        }
    }

    // MARK: Kartverket's place names (js/route.js:1898-1918)

    /// `PLACE_TYPES` (js/route.js:1898): town-like types first.
    public static let placeTypes = ["By", "Tettsted", "Bydel", "Tettstedsdel", "Tettbebyggelse", "Kommune", "Grend", "Bygdelag (bygd)"]

    private struct Navn: Decodable {
        struct Punkt: Decodable { var nord: Double; var øst: Double }
        struct N: Decodable { var skrivemåte: String?; var navneobjekttype: String?; var representasjonspunkt: Punkt? }
        var navn: [N]?
    }

    /// `placeNamed(name)`: Kartverket names spelled exactly like the text (brackets removed), with the type rank.
    public func namedPlaces(_ name: String) async throws -> [PlaceHit] {
        let q = Self.replace(name, "\\s*\\(.*\\)\\s*", " ").trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return [] }   // an empty search is a 422
        let url = Endpoints.url(geonorge, "stedsnavn/v1/navn", "sok=\(JS.encodeURIComponent(q))&fuzzy=false&treffPerSide=30&utkoordsys=4258")
        let j = try await http.json(Navn.self, url)
        return (j.navn ?? []).compactMap { x in
            guard let p = x.representasjonspunkt, (x.skrivemåte ?? "").lowercased() == q.lowercased() else { return nil }
            let rank = (Self.placeTypes.firstIndex(of: x.navneobjekttype ?? "").map { $0 + 1 }) ?? 99
            return PlaceHit(name: x.skrivemåte ?? q, sub: x.navneobjekttype, lat: p.nord, lon: p.øst, cc: "NO", kind: .name, rank: rank)
        }
    }

    // MARK: regex helpers with JS semantics (patterns are written with ASCII classes where JS's \d and \w are ASCII)

    static func replace(_ s: String, _ pattern: String, _ with: String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return s }
        return re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: NSRegularExpression.escapedTemplate(for: with))
    }

    static func replaceEach(_ s: String, _ pattern: String, _ f: ([String]) -> String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return s }
        var out = s
        for m in re.matches(in: s, range: NSRange(s.startIndex..., in: s)).reversed() {
            let groups = (0..<m.numberOfRanges).map { i -> String in
                guard let r = Range(m.range(at: i), in: s) else { return "" }; return String(s[r])
            }
            if let r = Range(m.range, in: out) { out.replaceSubrange(r, with: f(groups)) }
        }
        return out
    }

    static func match(_ s: String, _ pattern: String) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern), let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } ?? "" }
    }
}
