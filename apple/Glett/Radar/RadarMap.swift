import GlettKit
import MapKit
import SwiftUI

/// The radar's map (`rmInit`/`rmRender`, js/app.js:2460-2511): an `MKMapView` with Kartverket's topographic map in
/// Norway (unless the map setting says OpenStreetMap; Apple's muted map then, and outside Norway), the radar frames
/// from `RadarController` as tile overlays above it, and the place's marker. Opens on the region (zoom 7), not the town.
struct RadarMap: UIViewRepresentable {
    let controller: RadarController
    let place: Place
    /// Kartverket's topo map as the base.
    let topo: Bool
    /// Raining at the place now: the marker pulses.
    let wet: Bool
    let reduceMotion: Bool
    /// The height the panel covers at the map's foot: MapKit keeps its Legal label and scale above it.
    var bottomInset: CGFloat = 0

    /// The region shown first: about Leaflet's zoom 7 on a phone at these latitudes.
    static let regionMeters: CLLocationDistance = 260_000

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller) }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        if topo {
            map.addOverlay(KartverketTileOverlay(), level: .aboveLabels)   // over MapKit's labels: the topo map has its own names
        } else {
            map.preferredConfiguration = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
        }
        map.pointOfInterestFilter = .excludingAll
        map.isPitchEnabled = false
        map.isRotateEnabled = false
        map.showsScale = true
        map.register(PlaceMarkerView.self, forAnnotationViewWithReuseIdentifier: PlaceMarkerView.reuseID)
        let c = CLLocationCoordinate2D(latitude: place.lat, longitude: place.lon)
        map.setRegion(MKCoordinateRegion(center: c, latitudinalMeters: Self.regionMeters, longitudinalMeters: Self.regionMeters), animated: false)
        let pin = MKPointAnnotation()
        pin.coordinate = c
        pin.title = place.name.split(separator: ",").first.map(String.init) ?? place.name
        map.addAnnotation(pin)
        controller.attach(map)
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        if map.layoutMargins.bottom != bottomInset {
            map.layoutMargins = UIEdgeInsets(top: 0, left: 0, bottom: bottomInset, right: 0)
        }
        context.coordinator.wet = wet
        context.coordinator.reduceMotion = reduceMotion
        for a in map.annotations {
            if let v = map.view(for: a) as? PlaceMarkerView { v.isWet = wet; v.reduceMotion = reduceMotion }
        }
    }

    @MainActor
    final class Coordinator: NSObject, MKMapViewDelegate {
        let controller: RadarController
        var wet = false
        var reduceMotion = false

        init(controller: RadarController) { self.controller = controller }

        func mapView(_ mapView: MKMapView, rendererFor overlay: any MKOverlay) -> MKOverlayRenderer {
            guard let tiles = overlay as? MKTileOverlay else { return MKOverlayRenderer(overlay: overlay) }
            let r = MKTileOverlayRenderer(tileOverlay: tiles)
            if tiles is RadarTileOverlay { r.alpha = controller.alpha(for: tiles) }
            return r
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: any MKAnnotation) -> MKAnnotationView? {
            let v = mapView.dequeueReusableAnnotationView(withIdentifier: PlaceMarkerView.reuseID, for: annotation)
            if let p = v as? PlaceMarkerView { p.isWet = wet; p.reduceMotion = reduceMotion }
            return v
        }
    }
}
