# Glett for iPhone, iPad and Apple Watch: todo

The running list for the native app (started 2026-10-27). Widget and watch ideas to tick off are in
`TODO-widgets-watch.md`; the plan behind everything is `PROJECT.md` (§12 has the work packages). The owner approves
design decisions; items marked *(owner)* wait on him.

## Waiting on the owner
- [ ] **Choices from the review page** (claude.ai/artifact/DwM8n7qdEd5eZ6Wrvftdjd): "Del" in the day menu; the card
      restyle; the smaller hero temperature; navy or black in the dark-mode sheets; the width at the largest text
      size (AX5). *(owner)*
- [ ] **iPhone on a cable once**, so Xcode can install builds over Wi-Fi afterwards. *(owner)*

## Done
- [x] **App Group** `group.no.glett.shared` registered (owner, 2026-10-27); both profiles remade with it, and the
      app moves the places and settings that earlier TestFlight builds kept in its own container (`AppGroupMove`).
- [x] **Light rain and coarser radar tiles on glett.no** (web agent, 9b84610).
- [x] **Radar draws its own frames** (6b807cc): no flash or empty map at a refresh, no retry storm, a zoom shows
      coarser tiles until the new ones are in.
- [x] **Widgets, first set** (owner approved the designs 2026-10-27; TestFlight 202610270718): now card (small, Lock
      Screen rectangular, round, inline), next hours (medium), days (large), rain ring (Lock Screen).
- [x] **Widgets, more**: the app reloads them after a fetch, "Min posisjon" as a widget place, the Live Activity
      "Neste glett" (on the system's glass from iOS 26, owner 2026-10-27).
- [x] **Wind map** (owner, 2026-10-27): the radar map's "Vind" side as on glett.no (MET Nordic via api/wind.php).

## Next up
- [ ] **Apple Watch** (WP-4, app and complications, first release).
- [ ] The web's local map ("Temperatur nå", "Nedbør nå", "Vind nå" from Netatmo, "Snøgrense", "Farevarsler").

## Smaller fixes
- [ ] "Vis alle 13 modellene" shows twice.

## Later (PROJECT.md §12)
- [ ] WP-5 web touchpoints: universal links, the privacy page's app section.
- [ ] WP-6 Kjørevær; WP-7 Turvær, Leirplass, Historikk and the rest of the local map.
- [ ] WP-8 release: App Store record and screenshots, privacy labels, the developer name shown on the App Store
      (a human step in App Store Connect).
