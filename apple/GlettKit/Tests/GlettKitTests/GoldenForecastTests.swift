import Foundation
import Testing
@testable import GlettKit

/// The forecast engine against the web's JS on the recorded places (Fixtures/expected/<slug>.json).
@Suite("Golden forecast") struct GoldenForecastTests {
    @Test func manifestHasThePlaces() throws {
        let m = try #require(Golden.manifest)
        #expect(Golden.slugs == ["oslo", "bergen", "tromso", "finse", "london"])
        #expect(m.forecastNow == 1792958400)
    }

    /// The app asks for exactly the URLs the web built (js/data.js:184/186) and identifies itself to MET.
    @Test(arguments: Golden.slugs) func requests(_ slug: String) async throws {
        let (_, stub, place) = try await GoldenReplay.forecast(slug)
        let urls = Set(stub.requests.compactMap { $0.url?.absoluteString })
        #expect(urls == Set([place.openMeteo.url] + (place.met.map { [$0.url] } ?? [])))
        for r in stub.requests where r.url?.host == "api.met.no" {
            #expect(r.value(forHTTPHeaderField: "User-Agent")?.hasPrefix("Glett-iOS/") == true)
        }
    }

    /// The prepared forecast: axis, day/night, providers and their order, codes, duplicates, Yr, active models, now.
    @Test(arguments: Golden.slugs) func preparedForecast(_ slug: String) async throws {
        let exp = try await GoldenStore.shared.expected(slug)
        let f = try await GoldenStore.shared.forecast(slug)
        let engine = ConsensusEngine(forecast: f, weighted: true, weights: nil, now: Date(timeIntervalSince1970: exp.now))
        var d = GoldenDiff("\(slug) prepared")

        d.num("data.lat", f.lat, exp.data.lat)
        d.num("data.lon", f.lon, exp.data.lon)
        d.eq("data.timezone", f.timezone, exp.data.timezone)
        d.eq("data.utc_offset_seconds", f.utcOffsetSeconds, exp.data.utc_offset_seconds)
        d.num("data.elevation", f.elevation, exp.data.elevation)
        d.eq("data.time", f.time, exp.data.time)
        d.eq("data.dates", f.dates, exp.data.dates)
        d.eq("data.isDay", f.isDay, exp.data.isDay)
        d.eq("nowIdx", engine.nowIndex, exp.nowIdx)

        d.eq("providers.ids", f.providers.map(\.id), exp.providers.map(\.id))
        for (p, e) in zip(f.providers, exp.providers) {
            d.eq("providers[\(e.id)].dupOf", p.dupOf, e.dupOf)
            d.nums("providers[\(e.id)].code", p.hourly.code, e.code)
        }
        var dup: [String: String] = [:]
        for p in f.providers { if let o = p.dupOf { dup[p.id] = o } }
        d.eq("dupOf", dup, exp.dupOf)
        d.eq("active", engine.providers.map(\.id), exp.active)

        if let yr = exp.yr {
            let p = try #require(f.providers.first { $0.id == ModelCatalog.yrID }, "\(slug): no Yr provider")
            #expect(Set(yr.keys) == Set(HourlyVariable.allCases.map(\.rawValue)))
            for (k, series) in yr {
                let v = try #require(HourlyVariable(rawValue: k))
                d.nums("yr.\(k)", p.hourly[v], series)
            }
        } else {
            #expect(!f.providers.contains { $0.id == ModelCatalog.yrID })
        }

        d.eq("heroColumn.a", engine.nowColumn()?.a, exp.heroColumn.a)
        d.report()
    }

    /// columns(), the short-range boost, every provider's step aggregates, icons and thunder signal, agreement and sd.
    @Test(arguments: Golden.slugs, Golden.steps) func steps(_ slug: String, _ step: Int) async throws {
        let exp = try await GoldenStore.shared.expected(slug)
        let es = try #require(exp.steps[String(step)])
        let f = try await GoldenStore.shared.forecast(slug)
        let engine = ConsensusEngine(forecast: f, weighted: true, weights: nil, now: Date(timeIntervalSince1970: exp.now))
        var d = GoldenDiff("\(slug) step \(step)")

        let cols = engine.columns(step: step)
        d.eq("columns.count", cols.count, es.columns.count)
        for (k, (c, e)) in zip(cols, es.columns).enumerated() {
            let p = "columns[\(k)]"
            d.eq("\(p).a", c.a, e.a); d.eq("\(p).b", c.b, e.b); d.eq("\(p).day", c.day, e.day)
            d.eq("\(p).first", c.first, e.first); d.eq("\(p).label", c.label, e.label); d.eq("\(p).hour", c.hour, e.hour)
            d.eq("\(p).past", c.past, e.past); d.eq("\(p).now", c.now, e.now); d.eq("\(p).night", c.night, e.night)
        }
        guard cols.count == es.columns.count else { return d.report() }

        #expect(Set(es.boost.keys) == ConsensusEngine.shortBoostIDs)
        for (id, want) in es.boost {
            let p = f.providers.first { $0.id == id } ?? Provider(id: id, hourly: Hourly(values: [:], count: 0))
            d.nums("boost.\(id)", cols.map { engine.shortBoost(p, $0.a) }, want)
        }

        d.eq("agg.ids", Set(f.providers.map(\.id)), Set(es.agg.keys))
        for p in f.providers {
            guard let e = es.agg[p.id] else { continue }
            for (name, param, want) in e.numeric {
                d.nums("agg.\(p.id).\(name)", cols.map { engine.aggregate(p, param, $0) }, want)
            }
            for (k, c) in cols.enumerated() {
                let code = engine.aggregate(p, .code, c)
                d.eq("agg.\(p.id).category[\(k)]", WeatherCategory(code: code)?.rawValue, e.category[k])
                d.eq("agg.\(p.id).icon[\(k)]", WeatherIcon(code: code, night: c.night)?.rawValue, e.icon[k])
            }
            d.nums("agg.\(p.id).thunder", cols.map { engine.thunderSignal(p, $0) }, e.thunder)
        }

        d.eq("agreement.params", Set(es.agreement.keys), Set(ConsensusEngine.tolerance.keys.map(\.rawValue)))
        for (name, want) in es.agreement {
            let v = try #require(HourlyVariable(rawValue: name))
            for (k, c) in cols.enumerated() { d.eq("agreement.\(name)[\(k)]", engine.agreement(v, c), want[k]) }
        }
        for (name, want) in es.sd {
            let v = try #require(HourlyVariable(rawValue: name))
            d.nums("sd.\(name)", cols.map { engine.spread(v, $0) }, want)
        }
        d.report()
    }

    /// The consensus of one run (no weights, or the synthetic reliability weights): shares, icon, chances, weighted
    /// means, direction and the five-dot verdict, for every column.
    @Test(arguments: Golden.slugs, Golden.runs) func runs(_ slug: String, _ run: String) async throws {
        let exp = try await GoldenStore.shared.expected(slug)
        let f = try await GoldenStore.shared.forecast(slug)
        let weights = exp.weights(run: run)
        #expect((weights == nil) == (run == "unweighted"))
        let engine = ConsensusEngine(forecast: f, weighted: true, weights: weights, now: Date(timeIntervalSince1970: exp.now))
        var d = GoldenDiff("\(slug) \(run)")

        for step in Golden.steps {
            let es = try #require(exp.steps[String(step)])
            let r = try #require(es.runs[run])
            let cols = engine.columns(step: step)
            guard cols.count == es.columns.count else { d.fail("step \(step) columns.count", cols.count, es.columns.count); continue }
            for (k, c) in cols.enumerated() {
                let p = "\(step)h[\(k)]"
                let shares = engine.weatherShares(c)
                d.eq("\(p).shares.cats", shares?.map(\.category.rawValue), r.shares[k]?.map(\.cat))
                if let s = shares, let w = r.shares[k], s.count == w.count {
                    for (i, (a, b)) in zip(s, w).enumerated() { d.num("\(p).shares[\(i)].share", a.share, b.share) }
                }
                d.eq("\(p).icon", shares?.first.map { WeatherIcon(category: $0.category, night: c.night).rawValue }, r.icon[k])
                d.num("\(p).rainChance", engine.rainChance(c), r.rainChance[k])
                d.num("\(p).windChance", engine.windChance(c), r.windChance[k])
                d.eq("\(p).gustPct", engine.gustShare(c).map { Int(JS.round($0 * 100)) }, r.gustPct[k])
                d.num("\(p).thunderChance", engine.thunderChance(c), r.thunderChance[k])
                d.num("\(p).temp", engine.temperature(c), r.temp[k])
                d.num("\(p).feels", engine.feelsLike(c), r.feels[k])
                d.num("\(p).wind", engine.wind(c), r.wind[k])
                d.num("\(p).gust", engine.gustMean(c), r.gust[k])
                d.num("\(p).precip", engine.precipitation(c), r.precip[k])
                d.num("\(p).dir", engine.direction(c), r.dir[k])

                let v = engine.verdict(c), w = r.verdict[k]
                d.eq("\(p).verdict?", v != nil, w != nil)
                if let v, let w {
                    d.eq("\(p).verdict.level", v.level.rawValue, w.level)
                    d.eq("\(p).verdict.dots", v.dots, w.dots)
                    d.eq("\(p).verdict.k", v.agreeing, w.k)
                    d.eq("\(p).verdict.n", v.total, w.n)
                    d.eq("\(p).verdict.cat", v.category.rawValue, w.cat)
                    d.num("\(p).verdict.minT", v.temperatureMin, w.minT)
                    d.num("\(p).verdict.maxT", v.temperatureMax, w.maxT)
                    d.eq("\(p).verdict.min", JS.fmt(v.temperatureMin), w.min)
                    d.eq("\(p).verdict.max", JS.fmt(v.temperatureMax), w.max)
                }
            }

            // The same numbers through step(c), the bundle the hour table and meteogram read.
            for (k, c) in cols.enumerated() {
                let s = engine.step(c), p = "\(step)h[\(k)].step()"
                d.num("\(p).temperature", s.temperature, r.temp[k])
                d.num("\(p).rainChance", s.rainChance, r.rainChance[k])
                d.eq("\(p).icon", s.icon?.rawValue, r.icon[k])
                d.eq("\(p).temperatureAgreement", s.temperatureAgreement, es.agreement["temperature_2m"]?[k] ?? nil)
            }
        }

        // The now card is the hero column's step-1 values.
        if let a = exp.heroColumn.a, let es = exp.steps["1"], let r = es.runs[run], let k = es.columns.firstIndex(where: { $0.a == a }),
           let now = engine.nowSummary() {
            d.eq("now.column", now.column.a, a)
            d.num("now.temperature", now.temperature, r.temp[k])
            d.num("now.feelsLike", now.feelsLike, r.feels[k])
            d.num("now.wind", now.wind, r.wind[k])
            d.num("now.gust", now.gust, r.gust[k])
            d.num("now.direction", now.direction, r.dir[k])
            d.eq("now.icon", now.icon?.rawValue, r.icon[k])
            d.eq("now.verdict.dots", now.verdict?.dots, r.verdict[k]?.dots)
            d.eq("now.agreeing", now.agreeing, r.verdict[k]?.k ?? 0)
        } else {
            d.fail("nowSummary", nil, exp.heroColumn.a)
        }
        d.report()
    }
}
