import SwiftUI

/// Column widths of the time-down list (css/style.css:462-465, 489-492 on phones), grown with Dynamic Type.
struct TimeDownMetrics {
    var time: CGFloat
    var summary: CGFloat
    /// The probability column when the model columns make the table scroll sideways (`th.prob { min-width }`).
    var probability: CGFloat
    var model: CGFloat
    var rowHeight: CGFloat
}
