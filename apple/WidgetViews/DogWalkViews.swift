import GlettKit
import SwiftUI
import WidgetKit

// The dog-walk widget (owner, 2026-10-27): a walker with a corgi in the weather of right now, and whether it rains in
// the next 90 minutes. A full-colour picture on the Home Screen (small, 2×2), a silhouette on the Lock Screen
// (rectangular). The pictures are the owner's (apple/docs/DOG-WALK-ART.md); until one is in the asset catalogue a
// drawn placeholder stands in.

/// Who walks the dog; picked per widget.
enum DogWalker: String, CaseIterable, Sendable {
    case woman, man
}

/// The five pictures, from the weather now.
enum DogWeather: String, CaseIterable, Sendable {
    case sunny, overcast, windy, rain, snow

    /// Precipitation first (the radar's say for right now beats the models'), then wind of `ConsensusEngine.windThreshold`
    /// (30 km/h, Glett's "sterk vind") or more, then the sky: clear and partly cloudy are sunny, cloudy and fog overcast.
    init(_ s: GlettSnapshot) {
        let wetModels = [.rain, .drizzle, .thunder, .snow].contains(s.category)
        let wet = s.next.map(\.wetNow) ?? wetModels
        if wet {
            self = s.category == .snow ? .snow : .rain
        } else if (s.wind ?? 0) >= ConsensusEngine.windThreshold {
            self = .windy
        } else {
            self = [.clear, .partly].contains(s.category) ? .sunny : .overcast
        }
    }

    /// The asset's name: `dogwalk-<walker>-<weather>`, with `-lock` for the Lock Screen's silhouette.
    func asset(_ walker: DogWalker, lock: Bool = false) -> String {
        "dogwalk-\(walker.rawValue)-\(rawValue)" + (lock ? "-lock" : "")
    }

    // MARK: Placeholder

    var symbol: String {
        switch self {
        case .sunny: "sun.max.fill"
        case .overcast: "cloud.fill"
        case .windy: "wind"
        case .rain: "cloud.rain.fill"
        case .snow: "cloud.snow.fill"
        }
    }

    var sky: [Color] {
        switch self {
        case .sunny: [Color(hex: 0x7DBEF0), Color(hex: 0xDCEFFC)]
        case .overcast: [Color(hex: 0x9AA6B5), Color(hex: 0xD8DDE4)]
        case .windy: [Color(hex: 0x8FAECB), Color(hex: 0xE1EAF2)]
        case .rain: [Color(hex: 0x5F7088), Color(hex: 0xA5B2C1)]
        case .snow: [Color(hex: 0xB9C8D8), Color(hex: 0xF1F5F9)]
        }
    }

    var ground: Color {
        switch self {
        case .sunny: Color(hex: 0x8DC26F)
        case .overcast: Color(hex: 0x86A07F)
        case .windy: Color(hex: 0x9BB57E)
        case .rain: Color(hex: 0x62806A)
        case .snow: Color(hex: 0xF7F9FB)
        }
    }
}

/// The full-colour picture, filling the widget; a dark fade at the top keeps the place and temperature readable.
struct DogWalkPicture: View {
    let weather: DogWeather
    let walker: DogWalker

    var body: some View {
        ZStack {
            if let ui = UIImage(named: weather.asset(walker)) {
                Image(uiImage: ui).resizable().scaledToFill()
            } else {
                placeholder
            }
            LinearGradient(stops: [.init(color: .black.opacity(0.38), location: 0), .init(color: .clear, location: 0.38)],
                           startPoint: .top, endPoint: .bottom)
        }
    }

    private var placeholder: some View {
        GeometryReader { geo in
            let h = geo.size.height
            ZStack(alignment: .bottom) {
                LinearGradient(colors: weather.sky, startPoint: .top, endPoint: .bottom)
                weather.ground.frame(height: h * 0.4)
                Image(systemName: weather.symbol)
                    .symbolRenderingMode(.multicolor)
                    .font(.system(size: h * 0.12))
                    .foregroundStyle(.white)
                    .position(x: geo.size.width * 0.84, y: h * 0.16)
                HStack(alignment: .bottom, spacing: h * 0.02) {
                    Image(systemName: "figure.walk").font(.system(size: h * 0.26))
                    Image(systemName: "dog.fill").font(.system(size: h * 0.13))
                }
                .foregroundStyle(Color(hex: 0x24324A))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, geo.size.width * 0.1)
                .padding(.bottom, h * 0.34)
            }
        }
    }
}

/// The Lock Screen's silhouette (drawn in the Lock Screen's tint), or a placeholder.
struct DogWalkSilhouette: View {
    let weather: DogWeather
    let walker: DogWalker

    var body: some View {
        if let ui = UIImage(named: weather.asset(walker, lock: true)) {
            Image(uiImage: ui).renderingMode(.template).resizable().scaledToFit()
        } else {
            VStack(alignment: .leading, spacing: 0) {
                Image(systemName: weather.symbol).font(.system(size: 12, weight: .semibold))
                Spacer(minLength: 0)
                HStack(alignment: .bottom, spacing: 0) {
                    Image(systemName: "figure.walk").font(.system(size: 40))
                    Image(systemName: "dog.fill").font(.system(size: 20))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}

/// The nowcast's steps as bars: rain in the rain colour (or the Lock Screen's tint), dry steps as a thin line.
struct RainBars: View {
    let rain: GlettSnapshot.Rain
    /// On the Lock Screen: drawn in the foreground style, dry steps faint.
    var vibrant = false

    var body: some View {
        Canvas { ctx, size in
            let n = max(1, rain.rates.count)
            let w = size.width / CGFloat(n)
            let top = max(2.0, rain.rates.max() ?? 0)
            let dry: GraphicsContext.Shading = vibrant ? .color(.primary.opacity(0.35)) : .color(.glett.line)
            let wet: GraphicsContext.Shading = vibrant ? .foreground : .color(.glett.rain)
            for (i, r) in rain.rates.enumerated() {
                let x = CGFloat(i) * w
                if r >= NextGlett.wetRate {
                    let h = max(3, size.height * CGFloat(min(1, (r / top).squareRoot())))
                    ctx.fill(Path(roundedRect: CGRect(x: x + 1, y: size.height - h, width: max(1, w - 2), height: h), cornerRadius: 1), with: wet)
                } else {
                    ctx.fill(Path(CGRect(x: x + 1, y: size.height - 1.5, width: max(1, w - 2), height: 1.5)), with: dry)
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// systemSmall (2×2, owner): the picture edge to edge; the place and temperature at the top; the next 90 minutes in a
/// small card at the bottom, in words and as bars.
struct DogWalkSmallView: View {
    let s: GlettSnapshot
    let walker: DogWalker
    /// Off: the picture with the place and temperature only.
    var timeline = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: -3) {
                Text(verbatim: s.place).font(.caption.weight(.semibold)).lineLimit(1)
                Text(verbatim: Format.temp(s.temperature))
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .monospacedDigit()
            }
            .foregroundStyle(.white)
            .shadow(color: .black.opacity(0.3), radius: 4, y: 1)
            Spacer(minLength: 4)
            if timeline && (s.next != nil || s.rain != nil) { card }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let n = s.next {
                Text(verbatim: n.shortText)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.glett.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            if let r = s.rain { RainBars(rain: r).frame(height: 14) }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.glett.panel.opacity(0.9), in: .rect(cornerRadius: 12, style: .continuous))
    }
}

/// accessoryRectangular: the silhouette in a square of the widget's full height (room for the drawing, owner), then
/// the temperature, the next 90 minutes in words and as bars. No place name: there is no room beside the picture.
struct DogWalkLockView: View {
    let s: GlettSnapshot
    let walker: DogWalker
    /// Off: no bars.
    var timeline = true

    var body: some View {
        GeometryReader { geo in
            HStack(spacing: 6) {
                DogWalkSilhouette(weather: DogWeather(s), walker: walker)
                    .frame(width: geo.size.height, height: geo.size.height)
                    .widgetAccentable()
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: Format.temp(s.temperature)).font(.headline).lineLimit(1)
                    Text(verbatim: s.next?.shortText ?? s.category.map(Format.category) ?? "")
                        .font(.caption).lineLimit(2).minimumScaleFactor(0.8)
                        .fixedSize(horizontal: false, vertical: true)
                    if timeline, let r = s.rain { RainBars(rain: r, vibrant: true).frame(height: 10).padding(.top, 1) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
