import Foundation
import GlettKit

/// The glett.no link for a place: the site with the place's coordinates and name,
/// `https://glett.no/?lat=59.910&lon=10.750&n=Oslo`. Not shared yet: glett.no's Været page does not read these
/// parameters (it opens the visitor's last place), so the day menu's "Del" waits for the owner's call on the web side.
enum GlettLink {
    static let site = URL(string: "https://glett.no/")!

    static func place(_ p: Place) -> URL {
        var c = URLComponents(url: site, resolvingAgainstBaseURL: false)
        c?.queryItems = [
            URLQueryItem(name: "lat", value: String(format: "%.3f", p.lat)),
            URLQueryItem(name: "lon", value: String(format: "%.3f", p.lon)),
            URLQueryItem(name: "n", value: p.name),
        ]
        return c?.url ?? site
    }
}
