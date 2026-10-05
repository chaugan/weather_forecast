# Glett – a glimpse of the weather

**Glett** (Norwegian for a break in the clouds, live at [glett.no](https://glett.no)) is a small, free web app that puts the forecasts of many **free** weather models side by side, hour by hour, and adds a final row with a **probability derived from how much the models agree** (optionally weighted by how reliable each model has recently been for your location).
> **Credit and licence.** Glett is a fork of [weather_forecast](https://github.com/santonoreg/weather_forecast) by [@santonoreg](https://github.com/santonoreg), who came up with the idea of showing the weather models side by side with their agreement. The original is released under the [MIT License](LICENSE) (© 2026 Spyros Antonopoulos). Glett's own changes are by Haugan Media Group and are released under the same MIT License.


- Runs on **cheap shared hosting**: plain **HTML / CSS / JavaScript** (no build step) plus two tiny **PHP 8** endpoints backed by **MySQL** (no framework, no Composer)
- The heavy lifting happens **in the visitor's browser**: forecasts, verification and history are fetched from Open-Meteo and MET Norway directly and cached in IndexedDB, so every visitor uses their own API quota and the server stays idle
- Saved locations live **only in the browser** (with JSON export / import); the server stores no user data at all
- [Leaflet](https://leafletjs.com/) map with **Kartverket** topographic tiles (Norway) and OpenStreetMap as the worldwide layer; Leaflet and the Inter font are self-hosted (no CDN, no Google Fonts)
- UI languages: **Norwegian bokmål** and **English**, chosen from the browser's language settings (Norwegian for `nb`/`nn`/`no`, English otherwise) – the `NO | EN` buttons in the header override it
- Landing page shows a forecast at once (Oslo on the first visit, the last viewed place afterwards): a search field, a *Min posisjon* button, place chips (your starred places, the last five searches, the five predefined cities Oslo, Bergen, Trondheim, Stavanger, Tromsø), then a **"now" card** with the place name, current temperature, most likely weather with the share of models behind it, wind, the radar nowcast and rain summary, and the Historikk button. On desktop the now card and the *Dagene fremover* list sit in the left column with the hour views on the right
- The *Most likely weather* probability row comes **first** in every table; the individual model rows sit behind a *Show all models* toggle (collapsed by default on phones)
- The **now card** also states the verdict in words with a five-dot confidence scale ("Modellene er enige · 13 av 13 modeller for klarvær · temperatur 6–10°"), every hour row carries a **segmented agreement bar** (how the models split by weather type), and a collapsed **"Se hva modellene sier"** section under the table draws all 13 models as thin lines under Glett's bold weighted line (temperature, 48 h) plus rain bars, so disagreement is visible as line spread
- The hour table has three views, switched right above it (*↓ Tid nedover / → Tid bortover / Meteogram*). **Meteogram**: the yr-style chart per day (icon row with agreement %, temperature curve with the min–max spread band, rain bars with the wettest model behind, wind arrows with m/s and gusts). **Time downwards** (default on phones): one row per hour, the probability and average as the first columns, a rolling window of the next 24 hours from now that grows automatically as you scroll (or with *Vis 24 timer til*), a *Viser til …* footer with *Til toppen*; a day row restarts the list at that day. **Time sideways** (default on desktop): one continuous strip for the whole week with day headers; scroll past 23:00 and tomorrow follows, day rows jump, and the highlighted day follows the scroll
- **Historikk** in the toolbar opens the daily history (records, climate, heatmap, year by year) for the place currently shown; it is also available per saved place under *Kart og steder*. For places in Norway the whole station record is loaded (Blindern since 1937, Tromsø since 1920), newest years first so the page renders while older decades arrive
- The now card also shows **"Målt nå i nærheten"**: a robust average (median, outliers dropped, at least five stations) of the publicly shared private Netatmo weather stations around the place, with the model consensus difference. The bounding box grows from ±0.1° to ±0.5° until enough stations report. Needs a Netatmo developer app (`netatmo_client_id`, `netatmo_client_secret`, `netatmo_refresh_token`, scope `read_station`); the server refreshes the token itself and keeps the rotated refresh token in MySQL (`kv` table). Every fetch also stores one hourly snapshot per 0.05° cell in `obs_local`, Glett's own local observation series
- Norwegian places use **MET Norway's Frost API** (real daily measurements from the nearest long-running weather station, via `api/frost.php` with a server-side client ID and MySQL cache, no Open-Meteo quota involved); elsewhere, or without a Frost client ID, the ERA5 reanalysis via Open-Meteo is used, where the first load covers 1991 to today and *Last ned hele historikken* extends it back to 1940 (a full ERA5 series costs about a quarter of a visitor's hourly Open-Meteo allowance)
- **Local map** inside the now card (tap the *Målt nå* line): five layers on a Leaflet map around the place, one measured layer at a time. **Temperatur nå** draws the public Netatmo stations, averaged per 1 km cell (no station ids), as a continuous temperature field: inverse-distance interpolation on a 100 m grid, a fixed absolute colour scale in 1 °C classes with hairline isotherms and a heavy 0 °C line, painted only within about 2 km of a station, with the cell means as numbers on the map (thinned so they never overlap), a legend bar with the forecast marked, a tap readout, and a sentence about inversions (warmer higher up than in the lowland); the grid follows the view and more station cells are fetched as the map is panned or zoomed out. **Nedbør nå** and **Vind nå** draw the same stations' rain gauges (mm in the last hour) and wind modules (mean wind with an arrow for the direction, gusts in the readout) with the same engine. **Snøgrense** shades the terrain white where every model's snow line (0 °C level minus 200 m) lies below the ground and light blue where only some do, with an hour slider for the next two days; it costs one small Open-Meteo request (5 models) plus four elevation requests that are stored for good per area. **Farevarsler** draws MET Norway's warning polygons (via `api/alerts.php`, cached 10 minutes site-wide) and, for a place inside a warning, puts the model split next to it ("vind 8–15 m/s, 0 av 13 modeller over 17 m/s"); the most serious warning also appears as a line in the summary strip
- **Rain radar map** under the radar strip (button *Vis nedbørradar* in the strip, or the *Nedbør i nærheten* line): in the Nordic area it is MET Norway's own 1 km composite, a frame every 5 minutes for the last hour, served as WMS tiles straight from [thredds.met.no](https://thredds.met.no/) (the same product Yr draws), followed by MET's radar nowcast from the newest 5-minute issue, +5 to +90 minutes, marked with a dashed badge; elsewhere it is [RainViewer](https://www.rainviewer.com/)'s 10-minute composite. Frames are stacked tile layers switched by opacity with a play button, a slider and a time badge; nothing is interpolated or extrapolated. MET's 90-minute nowcast for the place is one pill on the map and the strip above it
- A short summary strip answers the practical questions (rain from when, strong gusts, and a **radar nowcast** from MET Norway telling when rain starts or stops in the next 90 minutes – the "neste glett")
- Wind in **m/s** (km/h can be chosen in the settings popover), large weather icons are subtly animated (off with *prefers-reduced-motion*)
- **Light / dark theme** – follows your system setting; use the sun/moon button next to the language switch to override it
- Free, no ads, no API keys, no accounts, no cookies

> The probabilities are a measure of model agreement. They are **not** an official forecast and must not be used for safety-critical decisions.

---

## Screenshots

**Forecast** – the now card with Glett's verdict, the *Measured now* line, the summary strip and the radar strip on the left, the hour table on the right (Oslo, English UI)

![Forecast](docs/screenshots/forecast-desktop.png)

**Temperature map** – public Netatmo stations as a continuous field with the cell means as numbers, isotherms, and the forecast marked on the legend (Bergen); the same map has rain, wind, snow-line and warnings layers

![Temperature map](docs/screenshots/map-temperature.png)

**Wind map** and **warnings** – wind modules with arrows and speeds; MET Norway's warning polygons with the model split for the place

<p>
  <img src="docs/screenshots/map-wind.png" alt="Wind map" width="330">
  &nbsp;
  <img src="docs/screenshots/map-warnings.png" alt="Warnings" width="330">
</p>

**Weather history** – the whole station record for a place in Norway (Oslo-Blindern since 1837 through its predecessor stations): records, annual charts, the month-by-year heatmap, monthly climate and year by year

![Weather history](docs/screenshots/history.png)

**Dark theme** and **phone layout**

![Dark theme](docs/screenshots/forecast-dark.png)

<p>
  <img src="docs/screenshots/mobile-forecast.png" alt="Phone layout" width="300">
  &nbsp;
  <img src="docs/screenshots/mobile-hours.png" alt="Phone, hour by hour" width="300">
</p>

---


## Table of contents

1. [Screenshots](#screenshots)
2. [What it shows](#what-it-shows)
3. [How it works](#how-it-works)
4. [Architecture](#architecture)
5. [Requirements](#requirements)
6. [Installation on shared hosting](#installation-on-shared-hosting)
7. [Local test copy with Docker](#local-test-copy-with-docker)
8. [Configuration](#configuration)
9. [Project structure](#project-structure)
10. [HTTP API](#http-api)
11. [Data, privacy and external services](#data-privacy-and-external-services)
12. [Limitations](#limitations)
13. [Adding a language](#adding-a-language)
14. [Troubleshooting](#troubleshooting)

---

## What it shows

### Places and map (*Kart og steder*)

- The landing page shows a forecast at once: Oslo on the first visit, the last viewed place afterwards. Search by name, use **Min posisjon**, or tap a place chip (your starred places, the last five searches, five predefined cities).
- The *Kart og steder* page has the full map: pick a place by **clicking on the map**, typing **latitude/longitude** or searching; the name is filled in automatically (reverse geocoding) and can be edited.
- **Save** a place (the star): it is stored **in your browser** (IndexedDB) and appears as a chip. Saved places are shown on the map and can be deleted; **Export / Import** moves the list to another device as a small JSON file.
- **Vis været tilbake til …** in the now card (and the *History* button next to every saved place) opens the long-term weather history for that place (see below).

### Driving weather (*Kjørevær*)

- **Kjørevær** in the menu: the weather along a driving route, at the time you will be at each point. A → B (plus up to three via points), car or motorcycle, departure now or up to three days ahead (Norway for now).
- **Routes:** Statens vegvesen's route planner (Ruteplantjeneste v3) through `api/route.php`: with a username and password the full service (free with attribution, 2500 calls/day), without them the service's open variant (one route for *best*, two for *tourist*; the proxy asks both and merges them, up to three routes), and as the fallback [Valhalla](https://github.com/valhalla/valhalla) on the FOSSGIS server straight from the browser. Up to three alternatives, with the road's own heights along them (Kartverket's height API as the fallback in Norway).
- **Weather:** a sample every 10 minutes of driving or 20 km and at every mountain-pass top, all fetched in **one Open-Meteo multi-location request**, at the real height. Similar weather is grouped into driver classes (dry, fog, rain incl. drizzle, heavy rain, sleet, snow, freezing rain, thunder); badges for temperatures crossing 0 °C (±1 °C hysteresis), *mulig glatt* (air ≤ +3 °C with precipitation or a damp clear night), drifting snow, gusts (20 m/s car, 13 m/s motorcycle), darkness and MET warnings on the route. Snow and ice slow the expected pace, which moves the later samples.
- **Compare:** route cards with a mini weather ribbon and a sentence on why; *Når bør du kjøre?* scores every departure hour for the next 72 hours; the chart shows the weather band, air temperature with the 0 °C line and the height profile, synced with the map.
- **Options:** *Unngå ferjer* (Valhalla `use_ferry: 0`, Vegvesen `AvoidRoadFeatureTypes=Ferge`), *Unngå grusvei* (Valhalla `exclude_unpaved`; if no route exists without gravel the route is calculated anyway and says so), *Svingete veier* for car and motorcycle (Valhalla off motorways; the routes say how bendy they are) and *Unngå mørkekjøring* (darkness weighs heavily in the scoring and the departure strip, no new route needed). Route options grey out the result until *Finn ruter* is pressed.
- **Narrow roads (Norway):** after the result, the carriageway width of every stage's road is read from NVDB (object type 838, open, no key; one small request per stage, 4 at a time, at most 80 stretches); stretches under 5.5 m give a *Smal vei* badge on the card and a note per stage with the narrowest width. Municipal and private roads are not in it.
- **Map:** MapLibre with the shadow map's 2D / 3D button (terrain at 1.5×), Leaflet where WebGL is missing; *Større kart* moves the map and the chart to the top together and sizes the map so both are fully visible.
- **No turn-by-turn:** a road-number itinerary (E 16, Rv 7, …) with clock times and the weather per stage, mountain passes with a link to Vegvesen's traffic page, GPX export, a share link (`#kv?a=…&b=…&o=…`) and *Åpne i:* Google Maps (up to 6 via points, 3 on phones, each in the middle of a long stretch of one road, far from junctions, so the app cannot snap it to a side road), Apple Maps (Apple devices only; via points from iOS 18.4 / macOS 15.4) and Waze (destination only). The links open the installed app on a phone.
- **Street addresses** in Fra / Til / Via (route planner only): with a house number, Kartverket's address register (ws.geonorge.no/adresser, CORS open, no key) is asked first; the town after the number becomes a postal-town, municipality or postcode filter, letters are normalised (12b / 12 B -> 12B), and a number that does not exist falls back to numbers that start the same, then the street. The house number may also come first ("12B Storgata, Lillehammer"; without a comma the last word or two are tried as the town). Without a number, places come first and then streets whose name starts with the text ("Kongsberg": the town, then Kongsberggata in Oslo), one row per street; every row is labelled place, street or address.
- **Live road reports (DATEX):** closures, short closures, convoy driving (*kolonnekjøring*), obstructions and roadworks that change how you drive (fewer or narrower lanes, traffic lights, manual direction) from Statens vegvesen, matched to the stretch of each route they lie on (a line must run along the route, a closed ramp counts only when the route drives along all of it) and checked against the time you are there, in Oslo time with recurring periods (e.g. 20–06 Mon–Wed). A closure in both directions with no signed detour, in force when you get there, marks the route *Stengt* and it is never recommended; one-way closures (named by direction, *i retning mot Oslo*), short closures, convoys and obstructions are warnings on the card, notes on the stage, and markers on the map (tap for the full message). Roadworks are one badge (*Vegarbeid 2 steder*); reports not in force when you are there fold away under the stage and stay off the map. Mountain-pass stages say *ingen meldt stenging* when nothing is reported.
- **Road-surface forecast (DATEX):** Statens vegvesen's forecast for ~400 points on the road network (road temperature and condition, ~25 hours ahead). A weather sample uses the nearest point within 10 km along the route at about the same height (±200 m), at the time you are there: slippery, snow or slush there (or a damp road at ≤ 0.5 °C) is a confirmed *Vegvesen varsler glatt føre ved …*; a road at ≥ 2 °C without that clears our own *mulig glatt* guess from the air temperature. Stages show *Veibane: 0–11°, glatt*. Beyond the forecast or away from its points the air-temperature guess stays.
- **Narrow roads:** NVDB widths of ramps and side facilities (KD / SD in the road reference, one-lane one-way by design) are ignored, and a width object must lie mostly along the route.
- **Rush hours (Kjørevær):** `tools/traffic/counts.py` (monthly) builds `data/traffic/counts.json` from Statens vegvesen's Trafikkdata API (NLOD): per counting point on E- and R-roads and per direction, the usual weekday rush hours (hours at 85 % or more of the direction's busiest hour, 1.3 times the weekend level, peak at least 600 vehicles an hour), with the direction's compass bearing from NVDB. A route matches points within 80 m driving within 50° of their direction; passing one on a weekday in its rush hour gives a tile badge ("Vanligvis rushtid ved Vestby ca. 07:20"), a note in the stage list and 12 points per area in the departure score. Counts show demand, not speed, so no minutes are claimed. `tools/traffic/record.py` records Statens vegvesen's DATEX travel times every 5 minutes on 202 city stretches (cron on the development server, SQLite, nightly off-site backup) to give minutes of delay later; see `tools/traffic/README.md`.
- **Webcams:** the *Webkamera* button on the map shows Statens vegvesen's cameras within 500 m of the chosen route (of 896 at 729 sites; broken cameras faded). A click shows the latest image with the direction it looks (*Mot Lærdal*) and a button per direction where a site has several; a click on the image opens it large (← → change direction, Esc closes). Images come straight from kamera.atlas.vegvesen.no and refresh every minute while open.
- **Street View:** click (tap) the chosen route on the map: the chart's time line jumps there and a popup (a bottom panel on phones) shows the time, km and weather with a clean Street View still image looking along the road (as intelmap): ‹ › turn 45°, the photo date, and a click on the image opens Google's interactive view in full screen (free Maps Embed API; drag to look all around). `api/streetview.php` keeps the key on the server: a free metadata check (a panorama within 50 m?), the still images fetched and cached a day by the server (Street View Static API, free up to 10,000 a month; a monthly counter stops at 9,000 and the popup then uses the free interactive frame), and a redirect for the iframe. The visitor's browser does not contact Google for the still image; before the interactive view it asks once (*Husk valget*). Needs `google_maps_key` (Maps Embed API + Street View Static API, website-restricted to glett.no/* and *.glett.no/*); without it the popup links to Google Maps. Note: Google's terms (3.2.3(e)) do not allow Street View on the same screen as a non-Google map; the owner chose this knowingly.
- **Model agreement** (design reviewed with Codex, Grok and GLM, 2026-10-02): the route weather is Open-Meteo's best match (in Norway MET Nordic for the first ~2½ days). At each route's passes and about every 25 km, four more models (ECMWF IFS, DWD ICON, NOAA GFS, UK Met Office; temperature, precipitation, weather code, gusts) are fetched alongside. Within 48 hours MET Nordic decides what is shown and the others only flag doubt. From 48 hours ahead the weighted majority decides (precipitation or not, then the kind; weighted median temperature, precipitation and gusts), with the main forecast's 28-day skill weights (`WEFO.fetchVerify`, up to 4 areas per route, loaded after the route is shown) shrunk toward equal (0.75–1.4) because they measure short-lead forecasts; at a pass the global models vote on wet or dry only and MET Nordic decides rain or snow. Five correlated models are no probability, so a stage never repeats its own weather: it only names a worse alternative, in two steps (*Kanskje snø ved Hardangervidda ca. 21:40*, *Liten sjanse for torden ca. 13:03*), at thresholds by severity (freezing rain 10 %, thunder/snow/sleet 20 % and snow only near 0 °C or at a pass, rain where the stage is dry 35 % and two models, gusts 25 % and two models and only where no gusts are shown), and not snow or ice where *mulig glatt* is already shown. A card badge repeats a snow/ice alternative when *mulig glatt* is not on the card. Cost: 1.6 Open-Meteo calls per key point (~+70 on Oslo–Bergen's ~95) plus about 20 per newly scored area (cached a day); the free limits are per visitor IP (600/min, 5000/h, 10 000/day).
- **Sights along the route** (row *Severdigheter:* in the planner, under *Vis:*; chips for nature, cultural heritage, tourist routes, national parks and *Mindre kjente*, saved in the browser): `tools/poi/build.mjs` (run monthly on a developer machine; node and the duckdb CLI with the spatial extension) downloads open data (NLOD) and writes small static files to `data/poi/` (~0.8 MB, grid cells of 0.5° × 1°, served by the site itself): a hand-picked list of well-known sights (`tools/poi/top.txt`, positions from Kartverket's place names via `geocode-top.mjs`), Riksantikvaren's 27 standing stave churches, medieval and other protected churches, NGU's geosites marked for tourism, the National Tourist Routes from NVDB, and national parks and landscape protection areas from Naturbase (simplified outlines, ~0.2 MB). On a route: well-known sights within 10 km (shown as a detour), churches within 3 km, the rest within 1 km, none within 10 km of A or B; each gets the time you pass, the weather then and whether it is dark. Only the well-known ones unless *Mindre kjente* is on. National parks (and, with *Mindre kjente*, landscape protection areas) from Miljødirektoratet's Naturbase map service are drawn on the map with the times you are inside them. A sight's popup has *Legg til som stopp*: it becomes a via point in its order along the route and the routes are found again; the same button, or ✕ on the via row, takes it out and recalculates. Up to 8 via points (Statens vegvesen's route planner allows 8).
- **Vis: Veimeldinger / Veibredde** (planner, saved in the browser; road reports on, road width off by default): off removes the road reports or the narrow roads everywhere (route cards and their verdict, closures included, stages, chart, map) without fetching the routes again; slippery-road warnings, darkness and weather always show.
- **Road-report direction:** a one-way report ("i retning mot Oslo") is placed with Kartverket's place names: if the route moves away from the named place there, the report is folded away as the opposite direction. Reports on another road number than the route's (Fv 577 beside E 16) are dropped; a closure with a signed detour reads as a detour; a closure only for large vehicles is a vehicle limit.
- **Routes abroad:** Valhalla may route through Sweden or Finland (e.g. Narvik–Kirkenes). `js/borders.js` (Natural Earth, simplified, loaded on first use) marks stretches inside Sweden, Finland or Russia: their road numbers keep their own form with the country beside them, the Norway-only extras (NVDB widths, Vegvesen pass link) are skipped there, the card says *Via Sverige, Finland*, and OpenStreetMap tiles lie under Kartverket's (transparent outside Norway). The Storskog crossing is closed for Valhalla (`exclude_polygons`), and a route found to pass through Russia is marked and never recommended.
- **Saved routes** stay in the browser (`localStorage`) and travel with the places in export / import.
- Expandable by design: `KV_ROUTERS`, `KV_REGIONS` and `KV_PROFILES` in `js/route.js` (a new region, a router such as a curvy-road motorcycle service, or a vehicle profile is a registry entry).

### Hiking weather (*Turvær*)

- **Turvær** in the menu: the weather along a marked hiking trail, at the time you reach each point. A hike is two named points (tourist huts, car parks, summits, viewpoints, shelters) on Norway's marked trails, a classic from the *Klassikere* picker (29 well-known hikes in `tools/tur/classics.json`, hand-written blurbs, DNT grade, a *why* line on the direction; the panel groups them by region, Jotunheimen to Nord-Norge, with a region filter, and each card shows the two ends, length, climb and a rough Normal-pace time from the built profile; the build warns when a classic walks back over its own path for more than 60 m, which happens when a point or a via sits on a dead-end spur of the network (Torghatten was one entry with a via at the hole and the end at the top, so the route went in to the hole, out again and round the mountain; it is two classics now, the hole and the summit); only hikes that route on Turrutebasen's marked trails can be classics, which is why Knutshøe, Reinebringen, Molden, Slogen, Saksa, Dronningstien and Ryten are missing: their trails are not in the marked layer), or one of Turrutebasen's own named routes of 5 km and more (a route is any connected set of its edges with 0 or 2 odd-degree nodes, walked as an Euler path so a small loop on the way is fine; kept when the marked network reproduces it through four waypoints within 5 %; 1 044 routes); walked in either direction (*Snu turen*), starting now or up to three days ahead, at *Rolig / Normal / Rask* pace. Design reviewed with Codex, Grok, Kimi and GLM on 2026-10-03.
- **Routing on the marked trails alone:** a general router (OpenRouteService, BRouter, Valhalla) misses classic hikes (all three walked past Besseggen along the lake shore); shortest path on Kartverket's marked trails finds them. `tools/tur/build.mjs` turns Turrutebasen (Fotrute with *merking* JA, about 48 000 km) into static tiles in `data/tur/g/` (cells of 0.25° × 0.5°, ~20 MB in all, 10–60 KB a cell), with every named point snapped in as a node; the browser loads the cells around the hike and runs Dijkstra itself. No routing service, no key, no daily limit. Where no marked trail connects two points the planner says so (the network is in islands: the largest, Jotunheimen–Rondane–Dovre, is ~9 000 km). Joins in the build: trail ends within 25 m of another end become one node, any two nodes within 12 m become one (two trails that pass each other, a path beside a road, a route digitised twice: without this the router went round loops to change trail), a dead end within 40 m of another trail's line is joined onto it, and any two edges that cross without a shared vertex get a junction at the crossing (trail × trail as well as road × trail, 33 000 of them; two edges that already meet at a node are not crossed, since that is a digitised spike). Nodes close by along the same trail (a hairpin) are left apart.
- **Forest roads as a second-class network (summer):** OpenStreetMap's tracks and forest roads (`highway=track`, and `unclassified` / `service` roads with a *tracktype*, closed to private motor traffic or with a gravel-like surface; nothing with *foot=no* or *access=private*; from the Geofabrik extract of Norway, read with DuckDB's `ST_ReadOSM`; about 67 000 km) are built into `data/tur/t/` with the same node ids as the marked trails, so they join the trails at the nodes they meet; where a road crosses a marked trail without a shared vertex (the two sources are drawn apart) the build makes a junction at the crossing (66 000 of them). A marked trail that follows a road (an OSM road within 15 m for 60 % of its length; 7 400 km of them) is flagged as road surface in the tiles. The router minimises walking time rather than length: a road surface, marked or not, costs 0.7 of its length (5 km/h against 3.5 on a path), so a road is taken where it is quicker and a marked path where that is; the classics and Turrutebasen's named routes are routed on the marked trails alone at build time. On the map the road stretches are drawn with white dashes over the line (all routes), the route chips and a chip under the headline say how far ("3,1 km på skogsvei/traktorvei"), and on a road surface the pace is 5.5 km/h with 10 min per 100 m of climb and nothing for descents, instead of DNT's 3.5 km/h and 15 min (33 km of Nordmarka gravel: about 6 h at a fast pace). Winter stays on the marked ski trails. Attribution: © OpenStreetMap contributors, ODbL.
- **Layout:** the page selector sits in the top bar; on Kjørevær and Turvær the question is one line with *Endre* (the form folds once a trip is shown), the map comes first with a verdict card and weather icons along the way, the routes are tiles compared by weather, and the map's switches (større, hele vinduet, kartkilde, webkamera) are icon buttons in the map's corner.
- **A point on the map** as start or end (*Velg i kartet* beside Fra and Til): the map opens around the forecast's place (the browser asks for your position only when you press *Min posisjon* in the bar above the map), a tap is snapped to the nearest trail of the chosen season within 400 m, and the spot is named by Kartverket's nearest place name (a street, a farm, a lake; the forecast's reverse geocoder as the fallback). The tapped point stays the start: the straight stretch from it to the trail is part of the trip (dashed on the map, counted in the distance and time, elevated through Kartverket's height API since it carries no tile height), with a chip and a leg note ("144 m utenom merket sti"; on skis "… du må kanskje bære skiene"). A link or a saved hike with such a point snaps it again when opened, to the trails of the season it opens in.
- **Skogsbilvei og grusvei: Minst mulig | Mest mulig** (summer only): a metre of forest road or gravel road costs 1.6 trail metres in the routing, or 0.6 when you want the roads; changing it plans the hike again, and a shared link carries the choice (`w=m`).
- **Via points** (*+ Via* under Fra and Til, up to five): a place from the search or a tap on the map (*Velg i kartet*), each a row with × to remove and a numbered marker on the map; the route goes through them in order, the suggestions (another way, the loops) go through them too, and each one is a row in the itinerary with its weather. A tap anywhere on the map, for a via point as for the start or end, is snapped to the nearest point of a trail or road within 400 m: when that point lies between two junctions the edge is split there in the browser, so a tap mid-way along a long road is found. The link carries them (`&v=lat,lon,name;…`); a classic or a named route brings its own waypoints and hides *+ Via*.
- **Turer nær meg on skis:** the huts, shelters and summits reached on ski trails from where you stand (1–25 km of trail), a tap fills both Fra (your position, or a named point within 300 m) and Til and plans the trip; when no ski trail is within 1.5 km, the nearby starting points as before.
- **Named points:** Turrutebasen's info points (car parks, tourist and day huts, shelters, rest huts, viewpoints) within 60–120 m of a marked trail, and Kartverket's place names of the kinds *turisthytte*, *topp* and *fjell* within 150 m of one; the same place twice is kept once. Info-point names lose registration notes after a dash ("… - Beliggenhet er henta fra register"). Turrutebasen's named routes keep their maintainer's name only when it reads as a place name: labels with digits, campaign words or organisations ("70 turer for store og små", "Lysløypa") become the route's two named ends ("Rondvassbu – Rondslottet") or are dropped. The search index (`data/tur/names.json`, ~3 700 names) is loaded on first search; *Turer nær meg* lists the classics and the named routes within 80 km.
- **Steep ground:** the gradient of each 100 m step from the terrain model; stretches of at least 150 m over 25 % (14°) are *bratt*, over 40 % (22°) *svært bratt*: a row on the chart and a tint on the profile itself, the gradient of the step under the time line in the readout ("↗ 44 %"), a chip under the headline ("Bratt 3,0 km (opptil 45 %)"), a flag on the leg, and the steep length on each route's chip among the alternatives. The gradient is read over a 100 m window every 25 m, so the answer does not depend on where the 100 m profile's steps fall, and on the same trail back the stretches are mirrored. On such a step the walking time is 10 % longer (25 % over 40 %), up or down: DNT's rule charges for the climb already, this is for how it is spread, and the 50 m terrain model sees the slope beside a zigzagging trail, so the factor stays mild (Galdhøpiggen from Spiterstulen: 6 h instead of 5¾ one way).
- **Heights and time:** every trail vertex carries its height in the tiles, sampled at build time from Kartverket's DTM 50 (76 GeoTIFF cells, read with the `geotiff` package; 99.5 % of the vertices, the rest at sea or in gaps), so the browser draws the profile at once; Kartverket's height API is asked only for vertices without one. The profile is read every 100 m (lightly smoothed, 5 m hysteresis for the climb). Walking time by DNT's rule of thumb (3.5 km/h plus 15 min per 100 m of climb) plus 5 min per 100 m of descent and 10 % for breaks (Besseggen: 7¾ h at normal pace); *Rolig* adds 25 %, *Rask* takes 20 % off. The times are shown as a range of legs, never as a promise.
- **Weather:** the engine shared with Kjørevær (`js/kvcore.js`): a sample every kilometre or 20 minutes, at the tops, the named points and both ends, from one Open-Meteo multi-location request at the trail's real height (air temperature, precipitation, weather code, gusts, wind, *føles som*, day/night), the four other models at the key points with the weighted vote, MET warnings. In addition DMI's HARMONIE model (2 km, visibility, thunder potential, freezing level) at key points about every 5 km, since MET Nordic carries no visibility or thunder variables: fog on an exposed stretch means visibility under 400 m above 800 m or at a top.
- **The screen:** one headline with the thing that changes the plan, in priority order (thunder on exposed ground, gusts over 20 m/s at a top or ridge, snow / sleet / freezing rain up high, fog on the exposed part, gusts over 15 m/s, darkness before you are back, heavy rain, otherwise the worst weather and for how long); chips with *føles som* at the top, gusts, the freezing level against the top, sunset against the finish, a MET warning and a model-agreement hint; *Når bør du gå?* scores every start hour 04–16 for three days (weather class minutes weighted, gusts and fog weighted 1.5× on exposed ground, darkness, cold); the chart with the profile as the shape, the weather band, gusts, dark and fog rows and the air temperature; the map (Leaflet on Kartverket's topographic map, the trail coloured by the weather of each stretch, the named points and tops marked); the legs between named points and tops with time, height, climb, weather, *føles som* and gusts; GPX export, a share link (`#tv?a=…&b=…&c=classic&p=pace&d=start`) and saved hikes (`localStorage` `glett.turer`).
- **Winter · på ski:** a season switch (*Sommer · til fots / Vinter · på ski*, winter by default from November to April). Winter routes on Turrutebasen's marked ski trails (Skiløype with *merking* JA or SM, ~13 000 km, `data/tur/s/`, 2.7 MB, with the same named points snapped in where they lie by a ski trail); the time rule becomes 4 km/h plus 10 min per 100 m of climb and nothing for descents (a touring rule of thumb, not DNT's); whiteout (snow or fog in wind of 8 m/s or more on open ground) and hard cold (*føles som* −15° or lower) join the headline; and NVE's regional avalanche danger for the start day (Varsom's API, browser-direct, CORS open) is shown for the start and the highest point: level 1–2 as a chip, level 3 and up as the headline, always with the region's text and a link to varsom.no. Glett never judges the terrain itself. The summer classics and named routes are hidden on skis.
- **MET's own fog and thunder:** at the key points MET Norway's Locationforecast (browser-direct, as the forecast page) adds the fog area fraction (fog on an exposed stretch at 50 % and up) and the probability of thunder (thunder risk at 30 % and up), beside DMI's visibility and CAPE.
- **Større kart:** as in Kjørevær, the map and the chart move to the top together and the map takes the screen height that is left.
- **Base map:** a button on the map switches between Kartverket's topographic map and OpenStreetMap (with shaded relief from the terrain tiles and Kartverket's contour lines from the Geonorge WMS, CC BY 4.0, laid over it from zoom 11) (which lies under Kartverket's layer anyway, for stretches abroad), in Turvær and Kjørevær alike; the choice is kept in the browser.
- **Alternatives on the map**, as in Kjørevær: when the network holds other marked ways between the same points (the ways found so far cost ten times as much in the next search; a way is kept when it shares under 60 % of its trails with each of them and is at most three times as long; up to two), the first way up (and back) and, with a return planned, the loop both ways round (up direct and back the other way; up the other way and back direct), and a third way there (and back), are built as full routes with their own weather and times, drawn in grey with a label showing the time difference where they run farthest from the others, and chosen by a tap on the line, the label or the chip under the headline (`&x=up|loop|loop2` in the link, which also carries the return and its pause, the pace, the season and the start). An unnamed way is named by the place it passes. Also under the headline: the destination's other named starting points with a marked trail to it, one per approach (*annen vei opp*). Turrutebasen's trails often stop a few metres short of the trail they join (2 859 of 14 277 dead ends lay within 30 m of another node), so the build joins trail ends within 25 m of each other, and a dead end within 40 m of another trail's line or vertex onto that trail (about 1 600 joins); otherwise the network falls into islands and a way up a summit goes unfound (Jonsknuten's road-side trail ended 31 m from the trail it meets).
- **Not a safety verdict:** the page says so, links to *fjellvettreglene* and varsom.no, and never grades a hike itself (the grades shown are Turrutebasen's). Not in this version: free routing off the marked trails, photos, UT.no content (no API, all rights reserved), bus and boat timetables, winter.

### Location history

The history section shows what the weather has been like at a place since **1940** (ERA5), or since the nearest MET Norway station started measuring for places in Norway (Oslo-Blindern 1837 through its predecessor stations, Tromsø 1920):

- **Coverage:** which data grid point was used (its coordinates, its distance from your location and its elevation), the period and the number of days available.
- **Records:** hottest day, coldest night, wettest day, strongest gust, snowiest day, with dates.
- **Charts (full width):** *Annual mean temperature* (with a trend line in °C per decade) and *Annual precipitation*. Each chart has its own **Period** drop-down: *Whole year* shows the annual value, while choosing a month (e.g. *January*) shows the mean temperature – or the total rainfall – of that month for every year in the history.
- **Temperature heatmap:** one cell for every month of every year since 1940 (columns = years, rows = months). By default the colour is the **difference from that month's long-term average** (red warmer, blue colder), so you can see at once how every month has changed over the whole history; a switch shows the actual temperature instead.
- **Monthly climate:** average temperature (mean / max / min), rainfall and rainy days for each month over all years.
- **Year by year:** mean / max / min temperature, precipitation (with bars), rainy days (≥ 1 mm), strongest gust and snowfall.

Outside Norway, the first time you open it the app downloads the complete daily series (about 1.5 MB, a few seconds) from the Open-Meteo Historical Weather API for the grid point **nearest to the coordinates** (ERA5 / ERA5-Land reanalysis, ~10 km resolution) and **stores it in your browser** (IndexedDB, keyed by the data grid point so nearby places share one series). Every later visit is served from the browser storage in a fraction of a second, and **only the days that are not stored yet are downloaded and appended** (checked at most once every 6 hours, or immediately with *Check for new data now*). Deleting a location also deletes its stored history. Note that this is a reanalysis (a model constrained by observations), not station measurements.

### Forecast

The forecast page is built around three cards:

1. **The now card**: current temperature and feels-like, the most likely weather with the share of models behind it, wind and gusts, a five-dot verdict on how much the models agree, the *Målt nå* line (public Netatmo stations, see below), the summary strip (rain from when, strong gusts, MET warning, the radar *Neste glett* line), the *Radar neste 2 timer* strip and the local maps.
2. **Dagene fremover** (7 days, one aligned row each): most likely weather icon, expected high / low, chance of rain with the amount, strongest gust and, when relevant, chance of thunderstorm. Tap a day to see it hour by hour.
3. **Time for time**: the hour table in three views (*Tid nedover*, *Tid bortover*, *Meteogram*) with one tab per parameter. Every tab shows Glett's own answer first and the individual models behind a *Vis alle modeller* toggle:

   | Tab | Provider cells | Summary row | **Glett's row (probability)** |
   |---|---|---|---|
   | **Vær** (weather) | weather icon + temperature | average temperature | every weather category predicted by the models with its share, a segmented agreement bar, the top one as a large icon |
   | **Temperatur** | °C, colour-coded | average, min–max | agreement % and ± standard deviation |
   | **Nedbør** (rain) | mm per step | average, max | chance of rain (share of models giving ≥ 0.2 mm in the step) |
   | **Vind** | 10 m speed, arrow = direction the wind blows towards, gust in brackets | average and range, mean direction | chance of strong wind (share of models ≥ 30 km/h) and of gusts ≥ 60 km/h |
   | **Torden** | CAPE (J/kg) and a bolt when the model forecasts a thunderstorm | average CAPE | chance of thunderstorm |
   | **Skydekke / Fuktighet / Lufttrykk** | value, colour-coded | average, min–max | agreement % |
   | **Pålitelighet** | see [Model verification](#model-verification-reliability-tab) | | |

   **Step**: 1, 3, 6 or 12 hours (rain = sum, gust/CAPE = max, weather code = most severe, wind direction = speed-weighted circular mean, others = mean). The current hour is highlighted and past hours are dimmed. The models drop-down enables or disables individual models, the settings popover switches the wind unit and the reliability weighting, and *Se hva modellene sier* under the table draws all models as thin lines under Glett's weighted line.

### Models drop-down

- Each model has a checkbox, a short note about **which regions it is best for**, and its reliability score (0–100) once verification has loaded.
- Disabled models disappear from the tables and from all averages and probabilities. At least one model must stay enabled.
- The choice is **per browser** (saved in `localStorage`, see [privacy](#data-privacy-and-external-services)) and applies to all locations.
- Models that cannot cover the selected location are listed under *No coverage for this location*.
- Some regional models (KNMI, DMI, MET Norway Nordic) silently return a **copy of a global model** outside their domain. Glett detects identical series and counts them **only once**; they are shown greyed out with the note *Same data as …*.

---


## How it works

### Data sources

| Provider | How it is fetched |
|---|---|
| **ECMWF AIFS** (AI / neural-network forecast), ECMWF IFS, NOAA GFS, DWD ICON, Environment Canada GEM, Météo-France, UK Met Office, JMA, CMA GRAPES, BOM ACCESS, KNMI, DMI, MET Norway Nordic | one request **from the browser** to the [Open-Meteo forecast API](https://open-meteo.com/) with the `models=` parameter |
| MET Norway / Yr (global) | **from the browser**, directly from the [MET Norway Locationforecast API](https://api.met.no/) (converted to the same hourly format) |

Real observations used only for the reliability score come from [aviationweather.gov](https://aviationweather.gov/data/api/) (METAR); that API does not allow browser requests, so the server fetches and caches them (`api/metar.php`). Models that return no data for the location are dropped automatically. **ECMWF AIFS** is ECMWF's newer AI/neural-network forecast system (as opposed to the physics-based numerical models everything else here uses) – it is included as just another model in the comparison, weighted like the rest by the [reliability](#model-verification-reliability-tab) score, and additionally shown as its own row right after *Most likely weather* for direct comparison. Forecasts are cached **in the browser** for **60 minutes** per 0.01° cell (*Refresh* bypasses the cache, at most once every 5 minutes per location).

### Consensus and probability

For every time step and every parameter Glett collects one value per active provider and computes:

- **Average / range** – (weighted) mean, min and max of the provider values.
- **Weather category** – WMO weather codes are grouped into *clear, partly cloudy, overcast, fog, drizzle, rain, snow, thunderstorm*. Each provider votes for its category; the shares are shown as percentages. If a provider gives no weather code it is derived from precipitation, temperature (snow), CAPE and cloud cover.
- **Chance of rain** – share of providers with ≥ **0.2 mm** in the step.
- **Chance of strong wind** – share of providers with ≥ **30 km/h** (Beaufort 5).
- **Chance of thunderstorm** – each provider gives a signal: weather code 95–99 = 1, CAPE ≥ 1000 J/kg = 0.5, otherwise 0; the chance is the (weighted) mean signal.
- **Agreement** (temperature, cloud, humidity, pressure) – `100 % × (1 − σ / tolerance)`, where σ is the standard deviation between providers and the tolerance is 4 °C, 50 %, 25 %, 4 hPa respectively (0 % when σ ≥ tolerance).

The thresholds are constants at the top of `js/app.js` (`RAIN_THR`, `WIND_THR`, `TOL`).


### Model verification (Reliability tab)

To find out which models have recently been closest to reality **for your location**, the browser (`js/data.js`) compares every model's *archived forecasts* (Open-Meteo **Historical Forecast API**) with real measurements. In Norway the truth is the nearest **MET Norway stations** (via `api/frost.php`, hourly series up to yesterday, the last 28 days) blended with Glett's own **Netatmo snapshots** for the cell; elsewhere it is two references:

1. **ERA5 reanalysis** (Open-Meteo **Archive API**) – a gridded "what actually happened" for the last **28 days** (ending 6 days ago, because ERA5 is published with a delay). Available everywhere, but it is a model product, produced with ECMWF's system, so it slightly favours ECMWF.
2. **Real METAR observations** – the hourly weather reports of the **nearest airport station** within 60 km (from [aviationweather.gov](https://aviationweather.gov/data/api/), no key needed). Roughly the last 1–2 weeks (the API returns up to ~400 reports). METAR gives measured temperature, dew point (→ relative humidity), wind, pressure, cloud cover and present weather (rain, snow, thunderstorm, fog).

For each model and reference it computes: mean absolute error and bias for temperature, wind, cloud cover, humidity and pressure; the *critical success index* for detecting wet hours; and the share of hours with the correct weather category (drizzle and rain are treated as one category for this comparison).

**Combining the two:** per parameter, `skill = 0.6 × METAR skill + 0.4 × ERA5 skill` when at least 48 matched hourly observations exist; otherwise ERA5 alone is used. Observations get the larger share because ERA5 is not independent of the models being judged. The **score (0–100)** is the mean skill across parameters, and the skills are turned into **weights between 0.5 and 1.8** (average = 1) per parameter. With *Weight by reliability* enabled, the averages, chances and weather-category shares use these weights, so better models count more. Results are cached for 24 hours per location.

In the Reliability table every cell shows the error against ERA5 and, in blue, the error against METAR; the note under the table names the station, its distance and the number of reports used.

Notes and caveats:

- An airport is a point measurement. Distance, elevation and local effects (sea breeze, urban heat) add errors that affect all models similarly; the station is shown so you can judge how representative it is.
- Pressure comes from the METAR sea-level pressure (or altimeter setting), and rain/weather from the *present-weather* code at report time – rain detection against METAR is therefore approximate.
- Models without archived data for the area (regional models outside their domain) and Yr are not scored and count with weight 1. Rain weights are only used when the period contains enough rain events to be meaningful.
- If no METAR station with enough reports is near the location, ERA5 alone is used and the note says so.


---

## Architecture

```
Browser (index.html + js/*)
 ├─ Open-Meteo forecast / historical-forecast / archive / geocoding ── direct (each visitor uses their own quota)
 ├─ MET Norway locationforecast ───────────────────────────────────── direct (simple request, no custom headers)
 ├─ Map tiles: Kartverket topo (default) / OpenStreetMap ─────────── direct
 ├─ IndexedDB: saved locations, cached forecasts & verification, daily history since 1940 per grid point
 └─ /api/*.php on the web host (PHP 8 + MySQL, both cache-only)
      ├─ metar.php   → aviationweather.gov   (station per 0.1° cell 30 days, observations per station 24 h)
      ├─ frost.php   → frost.met.no          (Norwegian station history in 10-year chunks; closed years cached 90 days, compressed)
      ├─ netatmo.php → api.netatmo.com       (robust average of public Netatmo stations around the place + 1 km cells for the map, 10 min cache, hourly snapshot store)
      ├─ alerts.php  → api.met.no/metalerts  (MET warnings as GeoJSON, one fetch per 10 minutes for the whole site, per language)
      └─ reverse.php → Nominatim             (permanent cache per 0.001°, site-wide gate of 1 request/s)
```

Why this split: Open-Meteo's free tier is limited **per IP** (10,000 calls/day, 600/min) and is for non-commercial use. Proxying through the server would put every visitor on one IP; calling from the browser gives each visitor their own budget. The server therefore never contacts Open-Meteo or MET Norway (`grep -r open-meteo api/` finds nothing). The two PHP endpoints exist only because METAR and Nominatim do not permit browser requests, and both are rate-limited per client (60 requests/min, IPs stored only as a hash) and protected against cache stampedes (`GET_LOCK`). Housekeeping (expired rows, a 20 MB cap on the cache table) runs probabilistically on ~1% of requests, so no cron is needed; `php api/cleanup.php` can be scheduled as well.

## Requirements

- **PHP 8.1+** (tested on 8.4) with the extensions **`pdo_mysql`**, **`curl`**, `json`, `mbstring`
- **MySQL 5.7+ / MariaDB 10.3+** with InnoDB (a few MB is plenty)
- A web server that reads `.htaccess` (Apache or LiteSpeed): `mod_rewrite` and `mod_headers` for the HTTPS redirect and the security headers
- Outbound HTTPS from PHP to `aviationweather.gov`, `frost.met.no`, `api.netatmo.com`, `api.met.no` and `nominatim.openstreetmap.org` (TLS verification is on)
- Optional: a free **Frost client ID** from [frost.met.no](https://frost.met.no/auth/requestCredentials.html) for station-based history in Norway (`frost_client_id` in the config)
- Visitors' browsers need access to `*.open-meteo.com`, `api.met.no`, `cache.kartverket.no` and, for the alternative map layer, `tile.openstreetmap.org`, and for the rain radar map `thredds.met.no` (Nordic) or `api.rainviewer.com` and `tilecache.rainviewer.com` (elsewhere)

## Installation on shared hosting

There is no build step: upload plain files.

1. Create a MySQL database and a user with full rights on it (control panel). The tables are created automatically on first use.
2. Copy `api/config.example.php` to **`wefo-config.php` one level above the web root** (e.g. `/home/<user>/wefo-config.php` next to `public_html`; that file can never be served over HTTP) and fill in the database credentials, the site URL and a contact e-mail (both go into the `User-Agent` the server sends to aviationweather.gov and Nominatim, which require an identifiable client). `api/config.php` inside the site also works (it is git-ignored and denied by `.htaccess`), as does the `WEFO_CONFIG` environment variable pointing at any path.
3. Upload everything **except** `docker/`, `docs/` and `.git` to the web root (or a sub-folder: all URLs are relative). `.htaccess` blocks web access to `api/config.php`, `api/db.php`, `api/cleanup.php`, `*.md`, `*.yml`, `docker/`, `docs/` and `.git` anyway, and forces HTTPS.
4. Open the site, go to *Locations & Map*, click somewhere: a place name should appear (that is `api/reverse.php` working). Save the location and open the *Reliability* tab: a *METAR* column means `api/metar.php` and MySQL work.
5. Optional: schedule `php /path/to/api/cleanup.php` daily if the host offers cron.

**Updating:** upload the changed files and bump the `?v=` version in `index.html` and `privacy.html` so browsers fetch the new CSS/JS (static assets are served with a one-year cache).

## Local test copy with Docker

`docker/` contains a stack that mimics the host (PHP 8.4 + Apache reading the same `.htaccess`, MariaDB); it is for testing only and is not part of the deployment.

```bash
docker compose -f docker/docker-compose.yml up -d --build
# → http://127.0.0.1:4680/   (the repo is mounted read-only into the container)
docker compose -f docker/docker-compose.yml down -v    # stop and drop the test database
```

The HTTPS redirect in `.htaccess` is skipped for `localhost` / `127.0.0.1`, so the test copy works over plain HTTP.

## Configuration

Server settings live in `wefo-config.php` above the web root, or `api/config.php` (both copied from `api/config.example.php`); every key can also be an environment variable (`WEFO_DB_HOST`, `WEFO_DB_PORT`, `WEFO_DB_NAME`, `WEFO_DB_USER`, `WEFO_DB_PASS`, `WEFO_SITE_URL`, `WEFO_CONTACT_EMAIL`), which wins over the file.

| Where | Constant | Meaning |
|---|---|---|
| `js/data.js` | `FORECAST_TTL` (3600), `REFRESH_MIN_INTERVAL` (300) | forecast cache in seconds, minimum interval between forced refreshes |
| `js/data.js` | `VERIFY_TTL` (86400), `WINDOW_DAYS` (28), `LAG_DAYS` (6), `MIN_OBS` (48), `OBS_WEIGHT` (0.6) | reliability cache, ERA5 window and delay, METAR minimum and blend share |
| `js/data.js` | `HIST_START`, `HIST_LAG_DAYS` (6), `HIST_CHECK_SECONDS` (21600) | history start date, archive delay, top-up check interval |
| `js/data.js` | `MODELS`, `VERIFY_MODELS` | Open-Meteo model ids fetched / scored |
| `js/app.js` | `RAIN_THR` (0.2), `WIND_THR` (30), `TOL` | thresholds for the probabilities and agreement |
| `api/db.php` | `RATE_LIMIT_PER_MIN` (60), `CACHE_MAX_BYTES` (20 MB), `HOUSEKEEPING_CHANCE` (100) | per-client limit, cache table cap, 1-in-N cleanup |
| `api/metar.php` | `MAX_STATION_KM` (60), `METAR_HOURS` (360), `STATION_TTL`, `OBS_TTL` | station search radius, observation window, cache lifetimes |
| `api/reverse.php` | `NOMINATIM_MIN_INTERVAL` (1.1 s), `NOMINATIM_LOCK_WAIT` (3 s) | site-wide spacing of Nominatim calls, how long a request waits for its turn |
| `.htaccess` | `Content-Security-Policy` | the only hosts the browser may contact; extend it if you add a data source or tile provider |

## Project structure

```
index.html          the whole UI (one page: forecast with the now card and local maps, places page with the map, history)
privacy.html        privacy page (NB + EN)
.htaccess           HTTPS redirect, deny list, security headers (CSP), cache headers
css/style.css       styles, light/dark themes, responsive layout
js/theme.js         applies the saved theme before first paint
js/consent.js       analytics consent sheet (Google Analytics loads only after consent)
js/i18n.js          translations (NB, EN), browser-language detection and t()
js/icons.js         inline SVG weather icons and WMO code categories
js/data.js          browser data layer: Open-Meteo + Yr fetching, verification maths, history, radar frames, snow line, elevation, IndexedDB, places
js/kvcore.js        the route-weather engine shared by Kjørevær and Turvær: fetches, heights, the forecast at a point and time, the model vote, stretches, warnings
js/route.js         Kjørevær: routers (Vegvesen, Valhalla), regions, vehicle profiles, sampling, weather classes, chart, map, itinerary, saved routes
js/turvaer.js       Turvær: the marked-trail network in the browser (tiles, Dijkstra), profile, DNT walking time, headline, start-time bars, chart, map, legs, saved hikes
data/tur/           Turvær's static data: trail tiles (g/), forest-road tiles (t/), ski-trail tiles (s/), names, Turrutebasen's named routes, the classics (built by tools/tur/build.mjs, monthly)
tools/tur/          the Turvær data build (Turrutebasen + SSR + OpenStreetMap + classics.json; downloads in cache/, not in git) and route.mjs, a command-line router over the tiles for checks
js/app.js           UI: now card, tables, probabilities, weighting, local maps (temperature / rain / wind fields, snow line, warnings), radar map, places map, history
fonts/              Inter (SIL OFL), latin + greek subsets, self-hosted
vendor/leaflet/     Leaflet 1.9.4 (BSD-2), self-hosted
api/db.php          MySQL connection, cache, rate limit, housekeeping, outbound HTTP (server-only)
api/metar.php       nearest METAR station + hourly observations (cached in MySQL)
api/frost.php       MET Norway Frost: nearest long-running station and its daily series (cached in MySQL)
api/reverse.php     reverse geocoding through Nominatim (cached, 1 request/s gate)
api/netatmo.php     public Netatmo stations: robust average, 1 km cells for the maps, hourly snapshot store (cached in MySQL)
api/route.php       Statens vegvesen route planner proxy for Kjørevær (Basic auth stays on the server; cached 30 min, daily budget)
api/streetview.php  Google Street View for Kjørevær: free metadata check and the Embed iframe redirect (key stays on the server)
api/datex.php       Statens vegvesen DATEX for Kjørevær: road reports (5 min cache) and webcams (10 min), parsed to compact JSON (credentials stay on the server)
api/alerts.php      MET Norway warnings (MetAlerts GeoJSON) for the local map, cached 10 minutes per language
api/cleanup.php     optional CLI cron job
api/config.example.php  template for api/config.php (git-ignored)
docker/             local test stack (not deployed)
```

Database tables (created automatically): `cache(k, body, fetched_at, expires_at)`, `geocode_rev(lat_r, lon_r, lang, name, fetched_at)`, `throttle(name, last_at, calls)`, `ratelimit(ip_hash, window_start, n)`.

## HTTP API

The endpoints return JSON (`{"error": "..."}` with a 4xx/5xx status on failure, `429` when a client exceeds 60 requests/min) and are meant for the app's own front end.

| Endpoint | Parameters | Returns |
|---|---|---|
| `GET api/metar.php` | `lat`, `lon` (rounded to 0.1°) | `{station: {id, name, lat, lon, km, elev} \| null, obs: {"YYYY-MM-DDTHH:00": {t, w, c, h, p, wet, cat}}}` |
| `GET api/frost.php` | `lat`, `lon` → nearest station; or `station` (`SNxxxxx`), `from`, `to` (years, ≤ 5) → daily series | `{station: {id, name, lat, lon, km, masl, from} \| null}` or `{d: [...], tmax, tmin, tmean, prcp, wmax, gust, snow}` (`unavailable: true` when Frost is not configured) |
| `GET api/reverse.php` | `lat`, `lon` (rounded to 0.001°), `lang` = `nb` \| `en` | `{name: "Oslo, Norway" \| null}` (`busy: true` when the Nominatim gate was occupied for more than 3 s) |
| `GET api/netatmo.php` | `lat`, `lon` → robust average of the public stations around the place + 1 km cells (`pts`, `rain_pts`, `wind_pts`); `map=1&r=` → cells for one map area; `history=1&days=` → Glett's hourly snapshots for the cell | `{ok, stations, radius_km, temp, hum, pres, rain, wind, pts, rain_pts, wind_pts}` |
| `GET api/route.php` | `status=1`; or `stops` = `lat,lon;lat,lon[;…]` (2–10, rounded to 0.001°), `kind` = `best` \| `tourist`, `start` = `YYYYMMDDHHmm`, `lang` | `{vegvesen: bool}`, or Vegvesen's GeoJSON routes (`503 unavailable` until `vegvesen_ruteplan_user` / `_pass` are set) |
| `GET api/streetview.php` | `status=1`; `meta=1&lat&lon` (panorama within 50 m, cached 30 days); `embed=1&pano\|lat&lon&heading&pitch&fov` (302 to the Embed API) | `{ok}`, `{ok, pano, lat, lon, date, m}`, or a redirect (`503 unavailable` until `google_maps_key` is set) |
| `GET api/datex.php` | `sit=1` (closures, short closures, convoys, obstructions: kind, text, place, road, one-way, detour, validity with recurring periods, points); `cams=1` (webcam sites with their cameras, direction and state); `road=1` (road-surface forecast: hourly condition and road temperature per point) | `{at, items}`, `{cams}`, `{at, t0, pts}` (`503 unavailable` until `vegvesen_datex_user` / `_pass` are set) |
| `GET api/alerts.php` | `lang` = `nb` \| `en` | `{updated, alerts: [{id, event, name, level, type, severity, area, domain, desc, instr, cons, trigger, from, to, web, geometry}]}` – MET Norway MetAlerts 2.0, cached 10 minutes site-wide |

## Data, privacy and external services

- **Server side:** only caches without any visitor information (METAR observations, station series, warnings, place names, Netatmo station cells and hourly cell snapshots) and, for one hour, a request counter per client keyed by a one-way hash of the IP address. No accounts, no logs beyond the web host's own. Google Analytics is loaded only after the visitor accepts it in the consent sheet.
- **Browser side (never sent to the server):** saved locations, cached forecasts / verification / history (IndexedDB), and in `localStorage` the language, theme, map layer, disabled models, weighting switch and last selected location. Clearing the site data removes everything.
- **Requests made by the browser:** Open-Meteo (forecast, historical forecast, archive, geocoding, elevation), MET Norway (Yr forecast and radar nowcast), Kartverket tiles and, in Kjørevær and Turvær, Kartverket heights (ws.geonorge.no), in Turvær MET Norway's Locationforecast (fog, thunder) and NVE's Varsom avalanche warnings (api01.nve.no, in winter), and, in Kjørevær, Valhalla routes (FOSSGIS), Statens vegvesen webcam images when Webcams is on and a camera is opened, if chosen OpenStreetMap tiles, and radar tiles from MET Norway's THREDDS server (Nordic) or RainViewer (elsewhere) when the rain radar map is open. Those providers see the visitor's IP address and the requested coordinates (see `privacy.html`).
- **Requests made by the server:** aviationweather.gov, frost.met.no, Nominatim and (when configured) Statens vegvesen's route planner, with the `User-Agent` `Glett/1.0 (+<site_url>; <contact_email>)`.
- **Terms:** Open-Meteo's free API is for **non-commercial** use (ads count as commercial) – this site is free and ad-free and must stay so. MET Norway permits simple cross-origin requests from low-volume sites and asks for a caching proxy if traffic grows a lot. Nominatim allows at most 1 request/s for the whole site (enforced). Kartverket tiles are CC BY 4.0; OpenStreetMap tiles are offered only as the alternative layer.
- **Attribution** is shown in the footer: Open-Meteo (CC BY 4.0), MET Norway (CC BY 4.0), ERA5 / Copernicus via Open-Meteo, METAR via the NOAA Aviation Weather Center, © Kartverket, © OpenStreetMap contributors.

## Limitations

- ERA5 is a reanalysis produced with ECMWF's model, so on its own it slightly favours ECMWF; real METAR observations reduce this bias where a station is near, but an airport is a single point that may not represent your exact spot.
- Archived forecasts mostly represent short lead times, so the score reflects short-range skill more than day-5 skill.
- Weather icons for models without a weather code are derived heuristically.
- The Open-Meteo quota is per visitor IP. The first download of a location's history (1940 → today) is a heavy request; a visitor who opens the history and the reliability tab in the same minute may briefly see "request limit reached" for the latter – it simply retries on the next visit. Visitors behind one big corporate NAT share a quota.
- Saved locations are per browser. Export / Import is the way to move them; there is no sync.

## Adding a language

Open `js/i18n.js`, copy the `en` block to a new key (for example `sv: { ... }`), extend `detectLang()`, translate the values, add the month names to `MONTHS` / `MONTHS_SHORT`, and add a button `<button data-lang="nb">NB</button>` to the `.lang` group in `index.html`. Missing keys automatically fall back to English. `api/reverse.php` only knows `nb` and `en` for localised place names; add the code there too if you want names in the new language.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Map click gives no place name | `api/reverse.php` failing: check `api/config.php` (database credentials), that `pdo_mysql` is enabled, and outbound HTTPS from PHP. Open `api/reverse.php?lat=59.91&lon=10.75&lang=en` in the browser to see the JSON error. |
| Reliability tab says "unavailable" | the Open-Meteo historical APIs could not be reached or the per-IP limit was hit (retry later); a missing *METAR* column alone means `api/metar.php` failed or no station is within 60 km |
| "Request limit reached" | Open-Meteo's free per-IP quota (600 calls/min, 10,000/day, heavy requests count more) – wait a minute; the forecast is cached for an hour anyway |
| Table looks old after an update | hard refresh (Ctrl+F5); bump the `?v=` version in `index.html` |
| `403` on the page itself | `.htaccess` `Require all denied` blocks: make sure you did not rename files to match the deny list (`db.php`, `config.php`, `cleanup.php`, `*.md`, `*.yml`) |
| Redirect loop to HTTPS | the host terminates TLS in front of the web server without `X-Forwarded-Proto`; remove the redirect block from `.htaccess` and use the control panel's own HTTPS enforcement |
| KNMI / DMI / MET Norway Nordic rows are "greyed out" | they do not cover your location and returned a copy of another model; they are counted once |
