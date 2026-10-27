import Testing
import Foundation
@testable import GlettKit

struct WindFieldTests {
    /// The same answers as js/windmap.js `covers` under node.
    @Test func coverage() {
        let cases: [(Double, Double, Bool)] = [(59.91, 10.75, true), (51.5, -0.13, false), (69.65, 18.96, true), (78.2, 15.6, false),
                                               (55.7, 12.6, true), (60.17, 24.94, true), (64.1, -21.9, false)]
        for (lat, lon, want) in cases { #expect(WindGrid.covers(lat: lat, lon: lon) == want, "\(lat), \(lon)") }
    }

    @Test func bilinear() throws {
        // 2 × 2, rows south to north: u 0 1 / 2 3, v all 1; one corner missing in the second frame
        let f = WindFrame(run: "r", t: 0, s: 60, w: 10, n: 61, e: 11, nx: 2, ny: 2, u: [0, 1, 2, 3], v: [1, 1, 1, 1])
        let mid = try #require(f.sample(lat: 60.5, lon: 10.5))
        #expect(abs(mid.u - 1.5) < 1e-9 && abs(mid.v - 1) < 1e-9)
        #expect(f.sample(lat: 60, lon: 11)?.u == 1)
        #expect(f.sample(lat: 59.9, lon: 10.5) == nil)
        var g = f
        g.u[3] = .nan
        #expect(g.sample(lat: 60.5, lon: 10.5) == nil)
    }

    @Test func direction() {
        #expect(WindGrid.compass8(WindGrid.from(u: 0, v: -5)) == "n")   // blowing south: from the north
        #expect(WindGrid.compass8(WindGrid.from(u: 5, v: 0)) == "w")
        #expect(WindGrid.compass8(WindGrid.from(u: -3, v: 3)) == "se")
    }

    @Test func hours() {
        let now = Date(timeIntervalSince1970: 1_800_001_800)   // half past an hour
        let h = 1_800_000_000.0
        let m = WindMeta(run: "r", ref: h - 7200, times: (-2...60).map { h + Double($0) * 3600 })
        let (ts, i) = m.hours(want: nil, now: now)
        #expect(ts.first == h && ts.last == h + 48 * 3600 && i == 0)
        #expect(m.hours(want: h + 5 * 3600 + 100, now: now).index == 5)
    }

    @Test func viewBox() {
        // a phone at the radar's opening view over Oslo: 3 km points, not finer than ~10 pt
        let v = WindView(south: 58.8, west: 8.5, north: 61.0, east: 13.0, width: 402, height: 600)
        #expect(!v.fine && v.nx <= 61 && v.ny <= 90 && v.s < 58.8 && v.n > 61)
        #expect(v.contains(south: 59, west: 9, north: 60.5, east: 12.5))
        #expect(WindView(south: 59.9, west: 10.7, north: 59.95, east: 10.8, width: 402, height: 600).fine)
    }
}
