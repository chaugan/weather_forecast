#if DEBUG
import GlettKit
import SwiftUI

/// Debug builds only: every widget face at its iPhone 17 Pro size with the app's live forecast, for screenshots before
/// the widgets are on a device (`-GlettScreen widgets`, `-GlettGallery lock|home|homedark`). The Lock Screen faces
/// are drawn white on a dark wallpaper, close to how iOS tints them; the Home Screen ones on their panel colour.
struct WidgetGallery: View {
    let model: AppModel

    private var page: String { UserDefaults.standard.string(forKey: "GlettGallery") ?? "home" }

    var body: some View {
        ZStack {
            LinearGradient(colors: page == "home" ? [Color(hex: 0x9EC5E8), Color(hex: 0xE9D7C3)] : [Color(hex: 0x1D2B4A), Color(hex: 0x4A3B5C)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            if let s = snapshot {
                ScrollView {
                    if page == "lock" { lock(s) } else if page == "live" { live(s) } else if page == "dog" { dog(s) } else { home(s).environment(\.colorScheme, page == "homedark" ? .dark : .light) }
                }
                .scrollIndicators(.hidden)
            } else {
                ProgressView()
            }
        }
        .task { await model.start() }
    }

    private var snapshot: GlettSnapshot? {
        guard let b = model.bundle, let p = model.place else { return nil }
        return GlettSnapshot.make(place: p.shortName, bundle: b, nowcast: model.nowcast, settings: model.forecastSettings,
                                  weights: model.weights, now: model.now)
    }

    private func home(_ s: GlettSnapshot) -> some View {
        VStack(spacing: 22) {
            HStack(spacing: 22) {
                frame(170, 170) { NowSmallView(s: s) }
                frame(170, 170) { NowSmallView(s: ringSamples(s)[0]) }
            }
            frame(364, 170) { HoursMediumView(s: s) }
            frame(364, 382) { DaysLargeView(s: s) }
        }
        .padding(.top, 24)
        .frame(maxWidth: .infinity)
    }

    /// A Home Screen widget: its panel, the system's corner and 16 pt content margins.
    private func frame(_ w: CGFloat, _ h: CGFloat, @ViewBuilder _ face: () -> some View) -> some View {
        face()
            .padding(16)
            .frame(width: w, height: h)
            .background(Color.glett.panel, in: .rect(cornerRadius: 24, style: .continuous))
    }

    private func lock(_ s: GlettSnapshot) -> some View {
        VStack(spacing: 18) {
            LockInlineView(s: s)
                .font(.system(size: 15, weight: .semibold))
                .lineLimit(1)
                .frame(width: 260)
            Text(Date(), format: .dateTime.hour().minute())
                .font(.system(size: 92, weight: .semibold, design: .rounded))
                .padding(.top, -14)
            HStack(spacing: 10) {
                LockRectangularView(s: s).frame(width: 172, height: 76)
                LockCircularView(s: s).frame(width: 76, height: 76)
                LockRingView(s: s).frame(width: 76, height: 76)
            }
            // the ring with rain on its way and with rain falling, whatever the nowcast says today
            ForEach(ringSamples(s), id: \.place) { r in
                HStack(spacing: 10) {
                    LockRectangularView(s: r).frame(width: 172, height: 76)
                    LockRingView(s: r).frame(width: 76, height: 76)
                    LockInlineView(s: r).font(.caption2).frame(width: 76)
                }
            }
        }
        .foregroundStyle(.white)
        .saturation(0)
        .environment(\.colorScheme, .dark)
        .padding(.top, 40)
        .frame(maxWidth: .infinity)
    }

    /// The Live Activity "Neste glett" as the Lock Screen shows it: rain on its way, and rain stopping; light and dark.
    private func live(_ s: GlettSnapshot) -> some View {
        let now = model.now
        let rates: [Double] = [0, 0, 0, 0.3, 0.8, 1.6, 2.4, 1.2, 0.4, 0.4, 0.4, 0.4, 0, 0, 0, 0, 0, 0]
        let rain = NextGlettAttributes.ContentState(wetNow: false, at: now.addingTimeInterval(14 * 60), blip: false, model: false,
                                                    rates: rates, start: now, stepSeconds: 300)
        var dry = rain
        dry.wetNow = true
        dry.at = now.addingTimeInterval(40 * 60)
        dry.rates = [1.8, 2.2, 1.4, 1.1, 0.9, 0.7, 0.5, 0.3, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        return VStack(spacing: 14) {
            Text(Date(), format: .dateTime.hour().minute())
                .font(.system(size: 72, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
            // iOS 26 and later: on the system's glass; before: on the panel colour
            if #available(iOS 26, *) {
                ForEach(Array([rain, dry].enumerated()), id: \.offset) { _, st in
                    NextGlettLockView(place: s.place, state: st, glass: true)
                        .frame(width: 370)
                        .glassEffect(.regular, in: .rect(cornerRadius: 22, style: .continuous))
                        .environment(\.colorScheme, .dark)
                }
            }
            ForEach(Array([(rain, ColorScheme.light), (dry, .dark)].enumerated()), id: \.offset) { _, item in
                let (st, scheme) = item
                NextGlettLockView(place: s.place, state: st)
                    .background(Color.glett.panel, in: .rect(cornerRadius: 22, style: .continuous))
                    .environment(\.colorScheme, scheme)
                    .frame(width: 370)
            }
        }
        .padding(.top, 30)
        .frame(maxWidth: .infinity)
    }

    /// The dog-walk widget for each weather: the Lock Screen's, or (`-GlettDogPart home`) the Home Screen's and the
    /// one for the place now; `-GlettPure YES` without the next 90 minutes, `-GlettWalker man|woman`.
    private func dog(_ s: GlettSnapshot) -> some View {
        let walker = DogWalker(rawValue: UserDefaults.standard.string(forKey: "GlettWalker") ?? "") ?? .woman
        let samples = DogWeather.allCases.map { w -> GlettSnapshot in
            var x = ringSamples(s)[0]
            let dry = NextGlett(kind: .dryAll, wetNow: false, model: false)
            switch w {
            case .sunny: x.category = .clear; x.wind = 10; x.next = dry; x.rain = x.rain.map { GlettSnapshot.Rain(rates: $0.rates.map { _ in 0 }, start: $0.start, stepSeconds: $0.stepSeconds) }
            case .overcast: x.category = .cloudy; x.wind = 10
            case .windy: x.category = .partly; x.wind = 45; x.next = dry; x.rain = x.rain.map { GlettSnapshot.Rain(rates: $0.rates.map { _ in 0 }, start: $0.start, stepSeconds: $0.stepSeconds) }
            case .rain: x.category = .rain; x.next = NextGlett(kind: .wetUntil(s.date.addingTimeInterval(40 * 60)), wetNow: true, model: false)
            case .snow: x.category = .snow; x.next = NextGlett(kind: .wetAll, wetNow: true, model: false)
            }
            // made-up rain that fits the sentence: starting in 14 minutes, stopping in 40, falling all along
            let shapes: [DogWeather: [Double]] = [
                .overcast: [0, 0, 0, 0.15, 0.5, 1.1, 1.9, 2.4, 2.0, 1.4, 0.9, 0.7, 0.8, 1.0, 0.8, 0.5, 0.3, 0.2],
                .rain: [2.2, 2.6, 2.1, 1.7, 1.2, 0.9, 0.6, 0.35, 0.15, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                .snow: [0.6, 0.8, 1.0, 1.2, 1.1, 0.9, 0.8, 0.9, 1.1, 1.3, 1.2, 1.0, 0.8, 0.7, 0.7, 0.8, 0.9, 0.8],
            ]
            if let rates = shapes[w] { x.rain = GlettSnapshot.Rain(rates: rates, start: s.date, stepSeconds: 300) }
            return x
        }
        let home = UserDefaults.standard.string(forKey: "GlettDogPart") == "home"
        return VStack(spacing: 14) {
            ForEach(Array((home ? [] : samples).enumerated()), id: \.offset) { _, x in
                DogWalkLockView(s: x, walker: walker, timeline: !UserDefaults.standard.bool(forKey: "GlettPure"))
                    .frame(width: 172, height: 76)
                    .foregroundStyle(.white)
                .environment(\.colorScheme, .dark)
            }
            ForEach(0..<(home ? 3 : 0), id: \.self) { row in
                HStack(spacing: 22) {
                    ForEach(Array((samples + [s])[row * 2 ..< row * 2 + 2].enumerated()), id: \.offset) { _, x in
                        DogWalkSmallView(s: x, walker: walker, timeline: !UserDefaults.standard.bool(forKey: "GlettPure"))
                            .padding(12)
                            .frame(width: 170, height: 170)
                            .background {
                                DogWalkPicture(weather: DogWeather(x), walker: walker,
                                               bottomFade: !UserDefaults.standard.bool(forKey: "GlettPure") && x.rain?.wet == true)
                            }
                            .clipShape(.rect(cornerRadius: 22, style: .continuous))
                    }
                }
            }
        }
        .padding(.top, 24)
        .frame(maxWidth: .infinity)
    }

    /// The same place with "neste glett" set to rain in 14 minutes and to dry in 40, to show the ring's two states.
    private func ringSamples(_ s: GlettSnapshot) -> [GlettSnapshot] {
        var dry = s, wet = s
        dry.next = NextGlett(kind: .dryUntil(s.date.addingTimeInterval(14 * 60)), wetNow: false, model: false)
        wet.next = NextGlett(kind: .wetUntil(s.date.addingTimeInterval(40 * 60)), wetNow: true, model: false)
        wet.place += " "
        return [dry, wet]
    }
}
#endif
