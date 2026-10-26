import Testing
import Foundation
@testable import GlettKit

struct WeatherCodeTests {
    private func h(pr: Double? = nil, t: Double? = nil, c: Double? = nil, cape: Double? = nil) -> Hourly {
        Hourly(values: [.precipitation: [pr], .temperature2m: [t], .cloudCover: [c], .cape: [cape]], count: 1)
    }

    @Test func derivedCode() {
        #expect(WeatherCode.derive(h(c: 10), 0) == 0)
        #expect(WeatherCode.derive(h(c: 20), 0) == 1)
        #expect(WeatherCode.derive(h(c: 44.9), 0) == 1)
        #expect(WeatherCode.derive(h(c: 45), 0) == 2)
        #expect(WeatherCode.derive(h(c: 75), 0) == 3)
        #expect(WeatherCode.derive(h(), 0) == nil)
        #expect(WeatherCode.derive(h(pr: 0.09, c: 80), 0) == 3)
        #expect(WeatherCode.derive(h(pr: 0.1, t: 0.5), 0) == 73)
        #expect(WeatherCode.derive(h(pr: 0.1, t: 0.6), 0) == 51)
        #expect(WeatherCode.derive(h(pr: 0.3), 0) == 61)
        #expect(WeatherCode.derive(h(pr: 4), 0) == 65)
        #expect(WeatherCode.derive(h(pr: 1, t: -3, cape: 1500), 0) == 95)   // thunder before snow
        #expect(WeatherCode.derive(h(pr: 0.9, cape: 2000), 0) == 61)
    }

    @Test func categories() {
        let cases: [(Double, WeatherCategory)] = [(0, .clear), (1, .clear), (2, .partly), (3, .cloudy), (45, .fog), (48, .fog), (51, .drizzle), (57, .drizzle),
                                                  (61, .rain), (67, .rain), (68, .cloudy), (80, .rain), (82, .rain), (71, .snow), (77, .snow), (85, .snow),
                                                  (86, .snow), (95, .thunder), (99, .thunder), (10, .cloudy)]
        for (c, cat) in cases { #expect(WeatherCategory(code: c) == cat, "code \(c)") }
        #expect(WeatherCategory(code: nil) == nil)
        #expect(WeatherCategory.verification(code: 53) == .rain)
        #expect(WeatherCategory.verification(code: 2.7) == .partly)
        #expect(WeatherCategory.allCases.map(\.representativeCode) == [0, 2, 3, 45, 51, 63, 73, 95])
    }

    @Test func iconsInTheWebOrder() {
        let cases: [(Double, Bool, WeatherIcon)] = [
            (0, false, .clearDay), (1, true, .clearNight), (2, false, .partlyDay), (2, true, .partlyNight), (3, true, .cloudy), (48, false, .fog),
            (56, false, .drizzle), (66, false, .sleet), (67, false, .sleet), (65, false, .heavyRain), (82, true, .heavyRain), (80, true, .showersNight),
            (81, false, .showersDay), (61, false, .rain), (64, false, .rain), (73, false, .snow), (86, false, .snow), (95, true, .thunder), (68, false, .cloudy),
        ]
        for (c, n, icon) in cases { #expect(WeatherIcon(code: c, night: n) == icon, "code \(c) night \(n)") }
        #expect(WeatherIcon(category: .rain, night: false) == .rain)
        #expect(WeatherIcon.allCases.count == 14)
    }

    @Test func yrSymbols() {
        let cases: [(String, Int)] = [("heavyrainshowers_day", 82), ("lightrainshowersandthunder_day", 95), ("heavysnow", 75), ("snowshowers_night", 85),
                                      ("snow", 73), ("lightsleet", 68), ("rain", 63), ("lightrain", 61), ("heavyrain", 65), ("rainshowers_day", 80),
                                      ("fog", 45), ("cloudy", 3), ("partlycloudy_day", 2), ("fair_night", 1), ("clearsky_day", 0)]
        for (s, c) in cases { #expect(METClient.yrCode(s) == c, "\(s)") }
    }

    @Test func feelsLike() {
        #expect(abs(FeelsLike.steadman(10, windKmh: 18, rh: 80)! - 5.736577045630858) < 1e-12)
        #expect(abs(FeelsLike.steadman(-5, windKmh: nil, rh: nil)! - -8.165947378052298) < 1e-12)
    }
}
