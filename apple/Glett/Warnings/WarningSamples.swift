import Foundation
import GlettKit

/// Two MET warnings around the preview fixture's time (2026-10-25 20:00 UTC), in api/alerts.php's shape: gusts over
/// land (with a gauge) and a storm surge (no model number).
enum WarningSamples {
    static let alerts: [MetAlert] = {
        let json = #"""
        [
          {"id": "sample-wind", "event": "wind", "name": "Kraftige vindkast", "level": "orange", "type": "wind",
           "severity": "Severe", "area": "Oslo og Akershus", "domain": "land",
           "desc": "Sørvest stiv kuling 15 m/s. Kraftige vindkast 25-30 m/s. Følg med på www.yr.no/farevarsler.",
           "instr": "", "cons": "", "trigger": "25 m/s",
           "from": "2026-10-25T22:00:00+00:00", "to": "2026-10-26T10:00:00+00:00",
           "web": "https://www.met.no/vaer-og-klima/ekstremvaervarsler-og-andre-farevarsler"},
          {"id": "sample-surge", "event": "stormSurge", "name": "Høy vannstand", "level": "yellow", "type": "stormsurge",
           "severity": "Moderate", "area": "Oslofjorden", "domain": "marine",
           "desc": "Vannstanden kan nå 30 cm over gult nivå. Se https://www.kartverket.no/til-sjos/se-havniva.",
           "instr": "", "cons": "", "trigger": "",
           "from": "2026-10-26T05:00:00+00:00", "to": "2026-10-26T09:00:00+00:00", "web": ""}
        ]
        """#
        return (try? JSONDecoder().decode([MetAlert].self, from: Data(json.utf8))) ?? []
    }()
}
