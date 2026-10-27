import GlettKit
import MapKit
import SwiftUI

/// The radar's map (`rmInit`/`rmRender`, js/app.js:2460-2511): an `MKMapView` with Kartverket's topographic map in
/// Norway (unless the map setting says OpenStreetMap; Apple's muted map then, and outside Norway), the radar frames
/// from `RadarController` drawn as one layer above it, and the place's marker. Opens on the region (zoom 7), not the town.
struct RadarMap: UIViewRepresentable {
    let controller: RadarController
    /// The wind side (`WindController`), drawn when `windOn`.
    let wind: WindController
    var windOn = false
    /// The app is in front (the streaks rest otherwise).
    var active = true
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

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller, wind: wind) }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        // the map's area is all of it, also under the status bar and the top bar where it runs to the screen's edge:
        // with the safe area as margins, MapKit left Kartverket's tiles out up there (the panel's margin is set below)
        map.insetsLayoutMarginsFromSafeArea = false
        if topo {
            // The topo map has its own names, so the base under it is Apple's imagery (no labels). It sits a level below
            // the radar: MapKit draws a level afresh whenever an overlay joins it, and on the radar's level the map
            // flashed blank at each frame added during the playback.
            map.preferredConfiguration = MKImageryMapConfiguration(elevationStyle: .flat)
            let base = KartverketTileOverlay(dark: context.environment.colorScheme == .dark)
            context.coordinator.base = base
            map.addOverlay(base, level: .aboveRoads)
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
        // the wind: its colours a layer above the radar, its streaks a view over the map
        map.addOverlay(context.coordinator.windLayer, level: .aboveLabels)
        let streaks = context.coordinator.streaks
        streaks.frame = map.bounds
        streaks.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        streaks.map = map
        streaks.wind = { [weak wind] in wind?.drawing ?? (nil, nil, 0) }
        streaks.onResize = { [weak coordinator = context.coordinator, weak map] in if let map { coordinator?.placeWind(map) } }
        map.addSubview(streaks)
        map.addGestureRecognizer(UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:))))
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        if map.layoutMargins.bottom != bottomInset {
            map.layoutMargins = UIEdgeInsets(top: 0, left: 0, bottom: bottomInset, right: 0)
        }
        context.coordinator.wet = wet
        context.coordinator.reduceMotion = reduceMotion
        // the theme changed: Kartverket's tiles for it (`MapTheme`; Apple's map follows by itself)
        let dark = context.environment.colorScheme == .dark
        if let old = context.coordinator.base, old.dark != dark {
            let base = KartverketTileOverlay(dark: dark)
            map.removeOverlay(old)
            map.addOverlay(base, level: .aboveRoads)
            context.coordinator.base = base
        }
        context.coordinator.windOn = windOn
        // the wind's hour (or blend) and whether it shows; reading `revision` has SwiftUI call this again on each change
        _ = wind.revision
        let d = wind.drawing
        context.coordinator.windRenderer?.display(windOn ? d.a : nil, d.b, tau: d.tau)
        let streaks = context.coordinator.streaks
        streaks.reduceMotion = reduceMotion
        streaks.running = windOn && active
        streaks.windChanged()
        if windOn, !context.coordinator.windPlaced { context.coordinator.windPlaced = true; context.coordinator.placeWind(map) }
        if !windOn { context.coordinator.windPlaced = false }
        for a in map.annotations {
            if let v = map.view(for: a) as? PlaceMarkerView { v.isWet = wet; v.reduceMotion = reduceMotion }
        }
    }

    @MainActor
    final class Coordinator: NSObject, MKMapViewDelegate {
        let controller: RadarController
        let wind: WindController
        var wet = false
        var reduceMotion = false
        var windOn = false
        /// The wind side has been told the view since it was switched on.
        var windPlaced = false
        let windLayer = WindLayer()
        /// Kartverket's base map, for the current theme.
        var base: KartverketTileOverlay?
        private(set) var windRenderer: WindRenderer?
        let streaks = WindStreaksView(frame: .zero)

        /// The zoom limit is set (once the map has a size).
        private var capped = false

        init(controller: RadarController, wind: WindController) {
            self.controller = controller
            self.wind = wind
        }

        /// The view the wind is fetched for, and the streaks placed on it.
        func placeWind(_ map: MKMapView) {
            guard windOn, map.bounds.width > 0, map.bounds.height > 0 else { return }
            streaks.place()
            let r = map.wholeMapRect
            let nw = MKMapPoint(x: r.minX, y: r.minY).coordinate, se = MKMapPoint(x: r.maxX, y: r.maxY).coordinate
            let box = WindView(south: se.latitude, west: nw.longitude, north: nw.latitude, east: se.longitude,
                               width: Double(map.bounds.width), height: Double(map.bounds.height))
            wind.viewChanged(box, south: se.latitude, west: nw.longitude, north: nw.latitude, east: se.longitude)
            #if DEBUG
            testTap(map)
            #endif
        }

        #if DEBUG
        /// `-GlettWindTap "x,y"`: a tap at that point once the wind is in, for screenshots (the simulator tool cannot tap).
        private var tappedForTest = false
        func testTap(_ map: MKMapView) {
            guard !tappedForTest, let v = UserDefaults.standard.string(forKey: "GlettWindTap") else { return }
            let xy = v.split(separator: ",").compactMap { Double($0) }
            guard xy.count == 2 else { return }
            tappedForTest = true
            Task { @MainActor [weak self, weak map] in
                try? await Task.sleep(for: .seconds(5))
                guard let self, let map else { return }
                let p = CGPoint(x: xy[0], y: xy[1]), c = map.convert(p, toCoordinateFrom: map)
                self.wind.read(lat: c.latitude, lon: c.longitude, at: p)
            }
        }
        #endif

        /// A tap on the wind side: the wind at that spot (js/windmap.js `probe`).
        @objc func tapped(_ g: UITapGestureRecognizer) {
            guard windOn, let map = g.view as? MKMapView else { return }
            let p = g.location(in: map), c = map.convert(p, toCoordinateFrom: map)
            wind.read(lat: c.latitude, lon: c.longitude, at: p)
        }

        func mapView(_ mapView: MKMapView, regionWillChangeAnimated animated: Bool) {
            streaks.hide()
            wind.clearReading()
        }

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
            if overlay is WindLayer {
                let r = WindRenderer(overlay: overlay)
                windRenderer = r
                let d = wind.drawing
                r.display(windOn ? d.a : nil, d.b, tau: d.tau)
                return r
            }
            guard let tiles = overlay as? MKTileOverlay else { return MKOverlayRenderer(overlay: overlay) }
            return MKTileOverlayRenderer(tileOverlay: tiles)
        }

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            controller.mapMoved()
            if windOn { placeWind(mapView) }
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: any MKAnnotation) -> MKAnnotationView? {
            let v = mapView.dequeueReusableAnnotationView(withIdentifier: PlaceMarkerView.reuseID, for: annotation)
            if let p = v as? PlaceMarkerView { p.isWet = wet; p.reduceMotion = reduceMotion }
            return v
        }
    }
}
