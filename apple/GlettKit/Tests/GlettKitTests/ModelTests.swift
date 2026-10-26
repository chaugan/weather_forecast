import Testing
import Foundation
@testable import GlettKit

struct ModelTests {
    @Test func yrOntoTheHourlyAxis() throws {
        let json = #"""
        {"properties":{"timeseries":[
          {"time":"2026-10-25T00:00:00Z","data":{"instant":{"details":{"air_temperature":5,"wind_speed":2,"wind_speed_of_gust":3.3,"wind_from_direction":200,"cloud_area_fraction":90,"relative_humidity":80,"air_pressure_at_sea_level":1001.2}},
            "next_1_hours":{"summary":{"symbol_code":"lightrain"},"details":{"precipitation_amount":0.4}},"next_6_hours":{"summary":{"symbol_code":"rain"},"details":{"precipitation_amount":2.5}}}},
          {"time":"2026-10-25T01:00:00Z","data":{"instant":{"details":{"air_temperature":4.5}},
            "next_1_hours":{"summary":{"symbol_code":"cloudy"},"details":{"precipitation_amount":0.6}},"next_6_hours":{"details":{"precipitation_amount":3.0}}}},
          {"time":"2026-10-25T06:00:00Z","data":{"instant":{"details":{"air_temperature":3}},
            "next_6_hours":{"summary":{"symbol_code":"heavysnow"},"details":{"precipitation_amount":1.2}}}}
        ]}}
        """#
        let yr = try JSONDecoder().decode(METCompactResponse.self, from: Data(json.utf8))
        let time = hourAxis(15)   // local 00:00 = 23:00Z the day before
        let p = try #require(METClient.yrProvider(yr, time: time, offset: 3600))
        #expect(p.id == "yr" && p.name == "MET Norway / Yr")
        let t = p.hourly[.temperature2m], pr = p.hourly[.precipitation], code = p.hourly[.weatherCode]
        #expect(t[0] == nil && pr[0] == nil)                 // before the first MET step
        #expect(t[1] == 5 && pr[1] == 0.4 && code[1] == 61)  // 00:00Z on the hour: next_1_hours
        #expect(p.hourly[.windSpeed10m][1] == 7.2 && p.hourly[.windGusts10m][1] == 11.9)
        #expect(t[2] == 4.5 && pr[2] == 0.6 && code[2] == 3)
        #expect(t[3] == 4.5 && pr[3] == 0.5)                 // 02:00Z between steps: next_6_hours / 6
        #expect(t[7] == 3 && pr[7] == 0.2 && code[7] == 75)  // 06:00Z 6-hourly
        #expect(t[13] == 3 && t[14] == nil)                  // more than 6 h after the last step: nothing
        #expect(p.hourly[.apparentTemperature].allSatisfy { $0 == nil } && p.hourly[.cape].allSatisfy { $0 == nil })
    }

    @Test func openMeteoProviders() throws {
        let json = #"""
        {"latitude":59.9375,"longitude":10.75,"utc_offset_seconds":3600,"timezone":"Europe/Oslo","elevation":9.0,
         "hourly":{"time":["2026-10-25T00:00","2026-10-25T01:00"],
           "temperature_2m_icon_seamless":[9.8,10.2],"is_day_icon_seamless":[0,0],
           "temperature_2m_gfs_seamless":[null,null],"is_day_gfs_seamless":[0,0],
           "weather_code_metno_seamless":[3,61]}}
        """#
        let om = try JSONDecoder().decode(OpenMeteoForecastResponse.self, from: Data(json.utf8))
        let ps = OpenMeteoClient.providers(from: om)
        #expect(ps.map(\.id) == ["icon_seamless", "metno_seamless"])   // gfs has only is_day: left out
        #expect(ps[0].hourly[.temperature2m] == [9.8, 10.2] && ps[0].hourly[.precipitation] == [nil, nil])
        #expect(om.utc_offset_seconds == 3600)
    }

    @Test func forecastRoundTripInTheWebShape() throws {
        let f = forecast([provider("icon_seamless", 24) { $0[.temperature2m] = Array(repeating: 1, count: 24); $0[.cloudCover] = Array(repeating: 50, count: 24) }], hours: 24)
        let data = try JSONEncoder().encode(f)
        let o = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(o["utc_offset_seconds"] as? Int == 3600)
        let providers = try #require(o["providers"] as? [[String: Any]])
        #expect((providers[0]["hourly"] as? [String: Any])?["temperature_2m"] != nil)
        let back = try JSONDecoder().decode(Forecast.self, from: data)
        #expect(back.providers[0].hourly.code[0] == 2)
        #expect(back.dates == ["2026-10-25"] && back.isDay.count == 24 && back.generated == f.generated)
        // a recorded web `data` object (no isDay/dates/code) is prepared on decode
        let web = #"{"lat":59.91,"lon":10.75,"timezone":"Europe/Oslo","utc_offset_seconds":3600,"elevation":9,"generated":"2026-10-25T18:00:00.000Z","time":["2026-10-25T00:00"],"providers":[{"id":"icon_seamless","hourly":{"temperature_2m":[1],"precipitation":[0.5],"cloud_cover":[10],"weather_code":[null]}}]}"#
        let w = try JSONDecoder().decode(Forecast.self, from: Data(web.utf8))
        #expect(w.providers[0].hourly.code == [61] && w.isDay == [0] && w.providers[0].name == "DWD ICON")
    }

    @Test func alertsHere() throws {
        let json = #"""
        {"updated":"x","alerts":[
          {"id":"a","name":"Kuling","level":"yellow","type":"wind","from":"2026-10-25T12:00:00+00:00","to":null,
           "geometry":{"type":"Polygon","coordinates":[[[10,59],[11,59],[11,60],[10,60],[10,59]],[[10.7,59.8],[10.8,59.8],[10.8,59.95],[10.7,59.95],[10.7,59.8]]]}},
          {"id":"b","name":"Mye regn","level":"orange","type":"rain","from":"2026-10-26T12:00:00+00:00",
           "geometry":{"type":"MultiPolygon","coordinates":[[[[10,59],[12,59],[12,61],[10,61],[10,59]]]]}},
          {"id":"c","name":"Is","level":"orange","event":"icing","from":"2026-10-25T06:00:00+00:00",
           "geometry":{"type":"GeometryCollection","geometries":[{"type":"Polygon","coordinates":[[[10,59],[11,59],[11,60],[10,60],[10,59]]]}]}}
        ]}
        """#
        let a = try JSONDecoder().decode(AlertsResponse.self, from: Data(json.utf8))
        #expect(a.here(lat: 59.5, lon: 10.5).map(\.id) == ["c", "b", "a"])   // orange first (the earlier one first), then yellow
        #expect(a.here(lat: 59.91, lon: 10.75).map(\.id) == ["c", "b"])       // inside the hole of "a"
        #expect(a.here(lat: 62, lon: 10.5).isEmpty)
        #expect(a.alerts[2].symbol == "ice" && a.alerts[0].symbol == "wind")
    }

    @Test func placesFile() throws {
        let json = #"{"glett_locations":1,"exported":"2026-10-25T10:00:00.000Z","locations":[{"name":"  Hjemme ","lat":"59.123456","lon":10.5},{"name":"","lat":1,"lon":2},{"name":"Bad","lat":91,"lon":0}],"routes":[{"id":"r1"}],"camps":[]}"#
        let (places, file) = try PlacesFile.parse(Data(json.utf8))
        #expect(places.map(\.name) == ["Hjemme"] && places[0].lat == 59.12346 && places[0].lon == 10.5)
        #expect(file?.routes.count == 1)
        #expect(throws: GlettError.importFormat) { try PlacesFile.parse(Data(#"{"x":1}"#.utf8)) }
        #expect(Place(name: "Oslo", lat: 59.9139, lon: 10.7522).placeKey == "59.914,10.752")
    }

    @Test func measuredNow() throws {
        let json = #"{"stations":40,"pts":[[59.91,10.75,20,8.4,3,null]],"rain_pts":[],"wind_pts":[],"radius_km":6,"age_s":300,"temp":{"v":8.5,"median":8.4,"n":30,"dropped":2,"min":7.1,"max":9.9},"hum":{"v":81,"median":80,"n":20,"dropped":0,"min":70,"max":90},"pres":null,"rain":{"n":6,"mm_1h":0.3,"wet_share":0.5},"wind":{"n":5,"kmh":12.6,"gust_kmh":20.1},"ok":true,"fetched":1800000000}"#
        let m = try JSONDecoder().decode(MeasuredNow.self, from: Data(json.utf8))
        #expect(m.ok && m.temp?.v == 8.5 && m.rainState == .mm && m.pts?[0][5] == nil)
        #expect(m.feelsLike == FeelsLike.steadman(8.5, windKmh: 12.6, rh: 81))
        let few = try JSONDecoder().decode(MeasuredNow.self, from: Data(#"{"ok":false,"stations":3}"#.utf8))
        #expect(!few.ok && few.stations == 3 && few.temp == nil)
    }

    @Test func settings() {
        #expect(WindUnit.ms.value(36) == 10 && WindUnit.kmh.value(36) == 36)
        #expect(AppLanguage.system.resolved(preferred: ["nn-NO"]) == "nb")
        #expect(AppLanguage.system.resolved(preferred: ["de-DE"]) == "en")
        #expect(ForecastSettings.decodeDisabled(#"["gfs_seamless","jma_seamless"]"#) == ["gfs_seamless", "jma_seamless"])
        #expect(ForecastSettings.decodeDisabled(ForecastSettings.encodeDisabled(["a"])) == ["a"])
    }
}

struct SearchTests {
    @Test func addressCandidatesAsTheWeb() {
        typealias C = PlaceSearch.AddressCandidate
        // node: addressCandidates() of js/route.js on the same inputs
        #expect(PlaceSearch.addressCandidates("Storgata 12b, Lillehammer") == [C(street: "Storgata", num: "12B", town: "Lillehammer")])
        #expect(PlaceSearch.addressCandidates("12B Storgata Lillehammer") == [C(street: "Storgata Lillehammer", num: "12B", town: ""), C(street: "Storgata", num: "12B", town: "Lillehammer")])
        #expect(PlaceSearch.addressCandidates("Storgata 12 b Lillehammer") == [C(street: "Storgata", num: "12B", town: "Lillehammer")])
        #expect(PlaceSearch.addressCandidates("Storgata 12, 2609") == [C(street: "Storgata", num: "12", town: "2609")])
        #expect(PlaceSearch.addressCandidates("12 Karl Johans gate, Oslo") == [C(street: "Karl Johans gate", num: "12", town: "Oslo")])
        #expect(PlaceSearch.addressCandidates("Kongsberg").isEmpty)
        #expect(PlaceSearch.addressCandidates("Øvre Slottsgate 2-c Oslo") == [C(street: "Øvre Slottsgate", num: "2C", town: "Oslo")])
    }

    @Test func townCase() {
        #expect(["LILLEHAMMER", "MO I RANA", "BØ I TELEMARK", "HØNEFOSS-NORD"].map(PlaceSearch.townCase) == ["Lillehammer", "Mo I Rana", "Bø I Telemark", "Hønefoss-Nord"])
    }

    @Test func placeNames() {
        #expect(PlaceHit(name: "Bergen, Vestland, Norge", lat: 60.39, lon: 5.32, kind: .place).placeName == "Bergen")
        #expect(PlaceHit(name: "Storgata 12, Lillehammer", lat: 61, lon: 10, kind: .addr).placeName == "Storgata 12, Lillehammer")
    }

    @Test func searchFlow() async {
        let stub = StubTransport { req in
            let u = req.url!.absoluteString
            if u.contains("geocoding") { return (200, Data(#"{"results":[{"name":"Kongsberg","admin1":"Buskerud","country":"Norge","latitude":59.66,"longitude":9.65,"country_code":"NO"}]}"#.utf8), [:]) }
            if u.contains("adressenavn=Kongs") {
                return (200, Data(#"{"adresser":[{"adressenavn":"Kongsberggata","nummer":1,"postnummer":"0468","poststed":"OSLO","representasjonspunkt":{"lat":59.93,"lon":10.77}},{"adressenavn":"Kongsberggata","nummer":9,"postnummer":"0468","poststed":"OSLO","representasjonspunkt":{"lat":59.94,"lon":10.78}},{"adressenavn":"Kongsberggata","nummer":5,"postnummer":"0468","poststed":"OSLO","representasjonspunkt":{"lat":59.935,"lon":10.775}}]}"#.utf8), [:])
            }
            return (200, Data(#"{"adresser":[]}"#.utf8), [:])
        }
        let http = HTTPClient(transport: stub, gate: nil, identity: .init(version: "1", build: "1"))
        let s = PlaceSearch(openMeteo: OpenMeteoClient(http: http), http: http)
        let hits = await s.search("Kongs", lang: "nb")
        #expect(hits.map(\.kind) == [.place, .street])
        #expect(hits[0].name == "Kongsberg, Buskerud, Norge")
        #expect(hits[1].name == "Kongsberggata, Oslo" && hits[1].sub == "0468 Oslo" && hits[1].lat == 59.935)   // the middle house
        let addr = await s.search("Storgata 12, Lillehammer", lang: "nb")   // no address hit: the place search without numbers
        #expect(addr.map(\.kind) == [.place])
        #expect(stub.requests.contains { $0.url!.absoluteString.hasSuffix("adresser/v1/sok?utkoordsys=4258&treffPerSide=8&sok=Storgata%2012&poststed=Lillehammer") })
        #expect(stub.requests.contains { $0.url!.absoluteString.contains("name=Storgata%20Lillehammer") })
    }
}
