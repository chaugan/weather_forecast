# Glett for iPhone, iPad and Apple Watch: todo

The running list for the native app (started 2026-10-27). Widget and watch ideas to tick off are in
`TODO-widgets-watch.md`; the plan behind everything is `PROJECT.md` (§12 has the work packages). The owner approves
design decisions; items marked *(owner)* wait on him.

## Waiting on the owner
- [ ] **Choices from the review page** (claude.ai/artifact/DwM8n7qdEd5eZ6Wrvftdjd): "Del" in the day menu; the card
      restyle; the smaller hero temperature; navy or black in the dark-mode sheets; the width at the largest text
      size (AX5). *(owner)*
- [ ] **Light rain on glett.no**: the iOS radar colours rain from 0.035 mm/h (yr.no's lowest class) and fetches
      coarser MET tiles; sent to the web agent 2026-10-27 to do the same on the website. *(owner approves the web diff)*
- [ ] **iPhone on a cable once**, so Xcode can install builds over Wi-Fi afterwards. *(owner)*

## Done
- [x] **App Group** `group.no.glett.shared` registered (owner, 2026-10-27); both profiles remade with it, and the
      app moves the places and settings that earlier TestFlight builds kept in its own container (`AppGroupMove`).

## Next up
- [ ] **Widgets** (WP-3, Lock Screen and Home Screen) and **Apple Watch** (WP-4, app and complications, first
      release).
- [ ] **Wind map** (owner, 2026-10-27): the web's local map has "Vind nå", wind measured now by private Netatmo
      wind modules (js/app.js, `LM_LAYERS`), next to "Temperatur nå", "Nedbør nå", "Snøgrense" and
      "Farevarsler". None of the local map is in the app yet. Start with the wind layer, on the map screen next to
      the radar.

## Smaller fixes
- [ ] "Vis alle 13 modellene" shows twice.
- [ ] Radar: at each refresh (every 4–5 minutes) the map flashes for about 0.3 s with many frames on top of each
      other (recorded 2026-10-27): adding and removing the frames' overlays redraws the whole radar layer.
- [ ] Radar: frames not yet allowed to load make MapKit ask for their tiles again and again during the first loop
      (CPU, no network).
- [ ] Radar: after a zoom, all frames already loaded reload at the new zoom together.

## Later (PROJECT.md §12)
- [ ] WP-5 web touchpoints: universal links, the privacy page's app section.
- [ ] WP-6 Kjørevær; WP-7 Turvær, Leirplass, Historikk and the rest of the local map.
- [ ] WP-8 release: App Store record and screenshots, privacy labels, the developer name shown on the App Store
      (a human step in App Store Connect).
