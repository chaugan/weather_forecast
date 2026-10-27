import SwiftUI

/// The radar's time slider (`#rmSlider` and `rmTicks`, js/app.js:2590-2612): one stop per frame, the nowcast part of
/// the track dashed, "nå" under the newest observed frame. Dragging or tapping picks a frame.
struct RadarTimeline: View {
    let count: Int
    let index: Int
    /// The newest observed frame (-1 when there is none); the frames after it are MET's nowcast.
    let lastObserved: Int
    /// VoiceOver's value for the shown frame.
    let valueText: String
    /// Named marks under the track (the wind's days); the radar's "nå" otherwise.
    var marksAt: [(index: Int, text: String)] = []
    /// VoiceOver's name for the slider.
    var name = L10n.t("sm.time")
    let onSeek: (Int) -> Void

    /// The thumb's diameter; its centre runs from half a thumb in from each end, so a mark sits where the thumb would.
    static let thumb: CGFloat = 24

    var body: some View {
        VStack(spacing: 2) {
            GeometryReader { geo in
                let w = geo.size.width, mid = geo.size.height / 2
                ZStack(alignment: .topLeading) {
                    track(width: w, y: mid)
                    if count > 0 {
                        Circle()
                            .fill(.glett.accent)
                            .overlay(Circle().strokeBorder(.white, lineWidth: 3))
                            .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
                            .frame(width: Self.thumb, height: Self.thumb)
                            .position(x: x(max(0, index), w), y: mid)
                    }
                }
                .contentShape(.rect)
                .gesture(DragGesture(minimumDistance: 0).onChanged { g in onSeek(frame(at: g.location.x, w)) })
            }
            .frame(height: Self.thumb + 8)
            marks
        }
        .accessibilityElement()
        .accessibilityLabel(Text(verbatim: name))
        .accessibilityValue(Text(verbatim: valueText))
        .accessibilityAdjustableAction { dir in
            switch dir {
            case .increment: onSeek(min(count - 1, index + 1))
            case .decrement: onSeek(max(0, index - 1))
            @unknown default: break
            }
        }
    }

    private var hasForecast: Bool { lastObserved >= 0 && lastObserved < count - 1 }

    private func track(width w: CGFloat, y: CGFloat) -> some View {
        let split = hasForecast ? x(lastObserved, w) : w - Self.thumb / 2
        return ZStack(alignment: .topLeading) {
            Path { p in p.move(to: CGPoint(x: Self.thumb / 2, y: y)); p.addLine(to: CGPoint(x: split, y: y)) }
                .stroke(.glett.muted, style: StrokeStyle(lineWidth: 4, lineCap: .round))
            if hasForecast {
                Path { p in p.move(to: CGPoint(x: split, y: y)); p.addLine(to: CGPoint(x: w - Self.thumb / 2, y: y)) }
                    .stroke(.glett.muted, style: StrokeStyle(lineWidth: 4, lineCap: .round, dash: [4, 5]))
                Capsule().fill(.glett.text).frame(width: 2, height: 12).position(x: split, y: y)
            }
            ForEach(0..<max(0, count), id: \.self) { i in
                Circle().fill(.glett.panel.opacity(0.9)).frame(width: 2, height: 2).position(x: x(i, w), y: y)
            }
        }
    }

    @ViewBuilder
    private var marks: some View {
        GeometryReader { geo in
            ForEach(marksAt, id: \.index) { m in
                Text(verbatim: m.text)
                    .scaledFont(11, weight: .semibold, relativeTo: .caption2)
                    .foregroundStyle(.glett.text)
                    .fixedSize()
                    .position(x: x(m.index, geo.size.width), y: 7)
            }
            if hasForecast {
                Text(verbatim: L10n.t("rm.tick.now"))
                    .scaledFont(11, weight: .semibold, relativeTo: .caption2)
                    .foregroundStyle(.glett.text)
                    .fixedSize()
                    .position(x: x(lastObserved, geo.size.width), y: 7)
            }
        }
        .frame(height: 14)
    }

    private func x(_ i: Int, _ w: CGFloat) -> CGFloat {
        let r = Self.thumb / 2
        return count > 1 ? r + (w - 2 * r) * CGFloat(i) / CGFloat(count - 1) : r
    }

    private func frame(at px: CGFloat, _ w: CGFloat) -> Int {
        guard count > 1 else { return 0 }
        let r = Self.thumb / 2
        return Int(((px - r) / (w - 2 * r) * CGFloat(count - 1)).rounded()).clamped(0, count - 1)
    }
}

private extension Int {
    func clamped(_ a: Int, _ b: Int) -> Int { Swift.min(b, Swift.max(a, self)) }
}

#Preview(traits: .sizeThatFitsLayout) {
    @Previewable @State var i = 13
    RadarTimeline(count: 32, index: i, lastObserved: 13, valueText: "", onSeek: { i = $0 })
        .padding()
        .frame(width: 360)
}
