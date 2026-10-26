import Charts
import SwiftUI

extension View {
    /// The meteogram's native selection (apple/docs/DESIGN.md, item 7) on one of its charts: a tap picks the step under
    /// the finger, a long press then a drag scrubs through the day, and a plain swipe still scrolls the week. `x` is on
    /// the day's axis (`0...count`, a step's column from `i` to `i + 1`).
    func meteogramSelection(_ x: Binding<Double?>) -> some View {
        chartXSelection(value: x)
            .chartGesture { proxy in
                LongPressGesture(minimumDuration: 0.25)
                    .sequenced(before: DragGesture(minimumDistance: 0))
                    .onChanged { value in
                        if case .second(true, let drag?) = value { proxy.selectXValue(at: drag.location.x) }
                    }
                    .exclusively(before: SpatialTapGesture().onEnded { proxy.selectXValue(at: $0.location.x) })
            }
    }
}
