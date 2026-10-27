# Widgets and Apple Watch: suggestions to choose from

Written 2026-10-26 for the owner to tick off. **Owner's decisions so far (2026-10-26):** widgets on both the Lock
Screen and the Home Screen; the Apple Watch is in the first release, both as its own app and as complications on
any watch face for a quick glance (above all "neste glett"). Nothing here is built yet. Each line is a suggestion. Mark the
ones you want with `[x]`, cross out or delete the rest, and add your own. Details behind each idea are in
`PROJECT.md` §6 (widgets) and §9 (watch). P1 = first version, P2 = next, P3 = later or maybe.

Everything shows Glett's own numbers: the model agreement, the verdict dots, "neste glett" from MET's radar, and the
web's wording. No new data sources.

## Before either can start (one-time setup)

- [x] **App Group** `group.no.glett.shared` registered for the team (2026-10-27). Widgets and the watch read the app's places,
      settings and cached forecast through it. Needs Xcode signed in to the developer account once: Signing &
      Capabilities → App Groups. An API key cannot do it. *(owner, 5 min)*
- [ ] Widget extension target and watch targets in `apple/project.yml`; signing profiles for them. *(agent)*
- [ ] Apple Watch simulator runtime: `xcodebuild -downloadPlatform watchOS`, about 5 GB. *(agent)*
- [ ] Xcode 27.1 for the iPhone Duo simulator, needed for the Duo widget sizes too. *(owner: App Store)*

## Widgets on iPhone and iPad

### P1
- [ ] **Lock Screen, rectangular**: place, temperature, icon, verdict dots and the "neste glett" line ("Regn fra
      ca. 14:20"). The most useful single widget.
- [ ] **Lock Screen, round**: temperature with the weather icon.
- [ ] **Lock Screen, round, rain countdown**: a ring that fills as rain gets closer (minutes until rain starts or
      stops, from the 90-minute radar nowcast). Shows the temperature when nothing changes within 90 minutes.
- [ ] **Lock Screen, line above the clock**: "9° · Overskyet · opphold neste 90 min".
- [ ] **Home Screen, small**: the now card in miniature: icon, temperature, verdict dots, "neste glett". Also
      fills StandBy (the phone on its side while charging).
- [ ] **Home Screen, medium**: now plus the next 6 hours as columns with the coloured agreement bars.
- [ ] **Home Screen, large**: "Dagene fremover", 7 days with icon, high/low, chance and amount, gust.
- [ ] **Choosing the place**: long-press the widget → Edit → "Min posisjon" or one of the saved places. Each
      widget can show its own place.

### P2
- [ ] **Live Activity "Neste glett"**: when rain starts or stops within 90 minutes, a countdown with the radar
      bars on the Lock Screen and in the Dynamic Island. Started with one tap from the now card, ends by itself.
- [ ] **MET warning widget**: the warning triangle in its colour, the title and the time it's valid, while a
      warning is in force for the place. Small and Lock Screen sizes.
- [ ] **Switch place in the widget**: arrows or a button to step through saved places without opening the app.
- [ ] **Control Center button**: "Åpne nedbørradar", which opens the app straight on the radar.
- [ ] **iPad, extra large** (new in iOS 27): the meteogram for today.

### P3
- [ ] **"Hvor enige er modellene"**: today's verdict with the share bars, for those who want Glett's model angle on
      the Home Screen.
- [ ] **Siri and Shortcuts**: "Hva sier Glett om været?" reads the verdict sentence aloud.
- [ ] **Kjørevær departure widget**: the next planned trip and the best time to leave, once Kjørevær is in the app.

### Questions for the owner
- [ ] Default place for a new widget: "Min posisjon", or the last place viewed in the app?
- [ ] Lock Screen: show "6 av 13 modeller", or only the dots?
- [ ] Widgets can't animate continuously. The icons there are the still versions. OK?

## Apple Watch

### P1 (first release, owner 2026-10-26)
- [x] **Watch app**: one page per saved place (swipe between them), each with:
      the now card (temperature, icon, verdict dots, "neste glett"), the next 12 hours as a list, and 7 days.
- [ ] **Works without the iPhone**: the watch fetches Open-Meteo and MET itself on Wi-Fi or cellular. The places
      come from the iPhone.
- [x] **Complications on any watch face** (the quick glance, owner 2026-10-26), "neste glett" first:
      - rectangular: the "neste glett" line ("Regn fra ca. 14:20", "Opphold de neste 90 min");
      - round: minutes until rain starts or stops as a ring, else temperature with icon;
      - corner: temperature with a small curved scale;
      - inline: "9° · opphold neste 90 min".
- [ ] **Places from the iPhone**: saved places and settings (wind unit, language) sync over the phone–watch link.

### P2
- [ ] **Smart Stack card**: appears by itself when rain starts within 90 minutes, or a MET warning is in force,
      where you are.
- [ ] **Rain heads-up**: an optional quiet tap on the wrist, "Regn om ca. 15 min", from the watch's own check of
      MET's radar nowcast. Off by default.
- [ ] **Live Activity on the watch**: the iPhone's "Neste glett" countdown also in the watch's Smart Stack.
- [ ] **Warning complication**: the MET warning triangle on the watch face while a warning is in force.

### P3
- [ ] **Radar on the watch**: a small still radar image for the place, updated every 5 minutes. Full map tiles
      aren't possible on watchOS.
- [ ] **Hiking**: Turvær's trail weather during a hike, once Turvær is in the app.

### Questions for the owner
- [ ] Which of your watches and watchOS version should it be tested on? It's tested in the simulator first.
- [x] ~~Should the watch app be in the first App Store release?~~ Yes, in the first release (owner 2026-10-26).

## Order I'd suggest

1. App Group (owner) → widget targets → Lock Screen rectangular + round + Home small (P1 core) → TestFlight.
2. The rest of the P1 widgets, then the Live Activity "Neste glett".
3. Watch app P1 with complications, "neste glett" first → TestFlight; part of the first App Store release (the watch app ships inside the iPhone app's build).
4. Smart Stack, warnings and the P2 items you've ticked.
