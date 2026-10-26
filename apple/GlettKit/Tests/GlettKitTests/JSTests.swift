import Testing
import Foundation
@testable import GlettKit

/// Expected values come from node (V8), see the brief's rule that the port mirrors JS numerically.
struct JSTests {
    @Test func mathRound() {
        #expect(JS.round(2.5) == 3)
        #expect(JS.round(-2.5) == -2)
        #expect(JS.round(0.49999999999999994) == 0)
        #expect(JS.round(-0.5) == 0)
        #expect(JS.round(1.005, 2) == 1)
        #expect(JS.round(3.3 * 3.6, 1) == 11.9)
    }

    @Test(arguments: [
        (1.005, "1.00", "1.0", "1", "1.0050"), (0.125, "0.13", "0.1", "0", "0.1250"), (-0.125, "-0.13", "-0.1", "-0", "-0.1250"),
        (59.9139, "59.91", "59.9", "60", "59.9139"), (10.7522, "10.75", "10.8", "11", "10.7522"), (1.45, "1.45", "1.4", "1", "1.4500"),
        (8.345, "8.35", "8.3", "8", "8.3450"), (2.5, "2.50", "2.5", "3", "2.5000"), (-2.5, "-2.50", "-2.5", "-3", "-2.5000"),
        (-0.001, "-0.00", "-0.0", "-0", "-0.0010"), (1234.5678, "1234.57", "1234.6", "1235", "1234.5678"), (18.9553, "18.96", "19.0", "19", "18.9553"),
    ])
    func toFixed(_ x: Double, _ f2: String, _ f1: String, _ f0: String, _ f4: String) {
        #expect(JS.toFixed(x, 2) == f2)
        #expect(JS.toFixed(x, 1) == f1)
        #expect(JS.toFixed(x, 0) == f0)
        #expect(JS.toFixed(x, 4) == f4)
    }

    @Test func numberToString() {
        let xs: [Double] = [59.91, 10, 0.01, 1e-7, 1e21, 1.2345678901234568e20, -0.5, 0.1 + 0.2, 1e-6, 5e-7, 100.5, 9007199254740992]
        let js = ["59.91", "10", "0.01", "1e-7", "1e+21", "123456789012345680000", "-0.5", "0.30000000000000004", "0.000001", "5e-7", "100.5", "9007199254740992"]
        #expect(xs.map(JS.string) == js)
    }

    @Test func encodingAndTime() {
        #expect(JS.encodeURIComponent("a,b æ!*()~'") == "a%2Cb%20%C3%A6!*()~'")
        #expect(JS.localToUnix("2026-10-25T00:00", offset: 3600) == 1792882800)
        #expect(JS.parseISO("2026-10-25T18:00:00Z") == 1792951200)
        #expect(JS.parseISO("2026-10-25T18:00:00+01:00") == 1792947600)
        #expect(JS.parseISO("2026-10-25T18:00:00.500Z") == 1792951200.5)
        #expect(JS.isoUTC(1761400800 + 3600, 13) == "2025-10-25T15")
        #expect(hourAxis(3) == ["2026-10-25T00:00", "2026-10-25T01:00", "2026-10-25T02:00"])
    }

    @Test func stableSort() {
        let a = [(1, "a"), (2, "b"), (1, "c"), (2, "d")]
        #expect(JS.stableSorted(a) { $0.0 > $1.0 }.map(\.1) == ["b", "d", "a", "c"])
    }
}
