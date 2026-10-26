import SwiftUI

/// Row heights and widths of the time-across strip (the five lanes of js/app.js:319-325, css/style.css:776-791).
/// Every lane has a fixed height so the pinned labels and the lazily built columns line up.
struct TimeAcrossMetrics {
    var label: CGFloat
    var column: CGFloat
    var day: CGFloat
    var time: CGFloat
    var weather: CGFloat
    var agree: CGFloat
    var temp: CGFloat
    var rain: CGFloat
    var wind: CGFloat
    var model: CGFloat
}
