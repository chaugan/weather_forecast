import MapKit

extension MKMapView {
    /// The part of the world under the whole view, edge to edge. `visibleMapRect` leaves out what lies under the layout
    /// margins (the map panel raises the bottom one), and the radar and the wind fetched nothing under the panel.
    var wholeMapRect: MKMapRect {
        let a = MKMapPoint(convert(.zero, toCoordinateFrom: self))
        let b = MKMapPoint(convert(CGPoint(x: bounds.width, y: bounds.height), toCoordinateFrom: self))
        return MKMapRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }
}
