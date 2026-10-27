import GlettKit
import MapKit
import SwiftUI

/// The radar's map (`rmInit`/`rmRender`, js/app.js:2460-2511): an `MKMapView` with Kartverket's topographic map in
/// Norway (unless the map setting says OpenStreetMap; Apple's muted map then, and outside Norway), the radar frames
/// from `RadarController` drawn as one layer above it, and the place's marker. Opens on the region (zoom 7), not the town.
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
            // The topo map has its own names, so the base under it is Apple's imagery (no labels). It sits a level below
            // the radar: MapKit draws a level afresh whenever an overlay joins it, and on the radar's level the map
            // flashed blank at each frame added during the playback.
            map.preferredConfiguration = MKImageryMapConfiguration(elevationStyle: .flat)
            map.addOverlay(KartverketTileOverlay(), level: .aboveRoads)
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

        /// The zoom limit is set (once the map has a size).
        private var capped = false

        init(controller: RadarController) { self.controller = controller }

        /// Leaflet's `maxZoom: 18` (js/app.js:2469, 2569-2571): past it Kartverket and the radar have no tiles and the map
        /// went grey. MapKit's limit is a camera distance: the current one scaled from the current zoom to 18.
        func mapViewDidChangeVisibleRegion(_ mapView: MKMapView) {
            guard !capped, mapView.bounds.width > 0, mapView.region.span.longitudeDelta > 0 else { return }
            capped = true
            let zoom = log2(360 / mapView.region.span.longitudeDelta * Double(mapView.bounds.width) / 256)
            let distance = mapView.camera.centerCoordinateDistance * pow(2, zoom - Double(RadarTiles.mapMaxZoom))
            mapView.cameraZoomRange = MKMapView.CameraZoomRange(minCenterCoordinateDistance: distance)
            if mapView.camera.centerCoordinateDistance < distance {   // the range holds gestures; a camera already closer stays
                let c = mapView.camera.copy() as! MKMapCamera
                c.centerCoordinateDistance = distance
                mapView.setCamera(c, animated: false)
            }
        }

        func mapView(_ mapView: MKMapView, rendererFor overlay: any MKOverlay) -> MKOverlayRenderer {
            if overlay is RadarLayer { return controller.makeRenderer() }
            guard let tiles = overlay as? MKTileOverlay else { return MKOverlayRenderer(overlay: overlay) }
            return MKTileOverlayRenderer(tileOverlay: tiles)
        }

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            controller.mapMoved()
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: any MKAnnotation) -> MKAnnotationView? {
            let v = mapView.dequeueReusableAnnotationView(withIdentifier: PlaceMarkerView.reuseID, for: annotation)
            if let p = v as? PlaceMarkerView { p.isWet = wet; p.reduceMotion = reduceMotion }
            return v
        }
    }
}
