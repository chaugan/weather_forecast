<?php
// Server configuration. Copy this file to ONE of these places (first match wins) and fill in your values:
//   1. the path in the WEFO_CONFIG environment variable,
//   2. wefo-config.php one level ABOVE the web root (e.g. /home/<user>/wefo-config.php next to public_html) –
//      recommended on shared hosting, the file is then never reachable over HTTP at all,
//   3. api/config.php (git-ignored; .htaccess denies web access to it).
// Every key can also be given as an environment variable (name in the comment); an environment variable
// always wins over the value in the file.
//
// The server only needs a database for two small caches (METAR observations and reverse-geocoded place
// names). It stores no personal data and no user content: saved locations live in the visitor's browser.
return [
    // MySQL / MariaDB (InnoDB, utf8mb4). A database with a few MB of cache rows is all that is needed.
    'db_host' => 'localhost',   // WEFO_DB_HOST
    'db_port' => 3306,          // WEFO_DB_PORT
    'db_name' => '',            // WEFO_DB_NAME
    'db_user' => '',            // WEFO_DB_USER
    'db_pass' => '',            // WEFO_DB_PASS

    // Used in the User-Agent (and Referer) of every request the server makes to aviationweather.gov and
    // Nominatim, which both require an identifiable client: "Glett/1.0 (+<site_url>; <contact_email>)".
    'site_url'      => 'https://glett.no',   // WEFO_SITE_URL
    'contact_email' => 'mail@hauganmg.no',   // WEFO_CONTACT_EMAIL

    // MET Norway Frost API (https://frost.met.no) - daily station observations used for the history of Norwegian
    // places. Register a free client ID at https://frost.met.no/auth/requestCredentials.html. The REST API only
    // needs the ID (HTTP basic auth, empty password); the secret is not used by Glett. Leave empty to use
    // Open-Meteo's ERA5 reanalysis everywhere instead.
    'frost_client_id'     => '',   // WEFO_FROST_CLIENT_ID
    'frost_client_secret' => '',   // WEFO_FROST_CLIENT_SECRET (unused)

    // Netatmo public weather stations (https://dev.netatmo.com): "measured nearby right now" line and the local
    // observation snapshots. Create an app, then use the portal's token generator with scope "read_station" and paste
    // the refresh token here; Glett refreshes it itself and stores the rotating token in MySQL. Leave empty to disable.
    'netatmo_client_id'     => '',   // WEFO_NETATMO_CLIENT_ID
    'netatmo_client_secret' => '',   // WEFO_NETATMO_CLIENT_SECRET
    'netatmo_refresh_token' => '',   // WEFO_NETATMO_REFRESH_TOKEN

    // Statens vegvesen Ruteplantjeneste v3 (Kjørevær, the route planner for Norway). Free when Statens vegvesen is
    // cited; ask for a username and password at ruteplan@vegvesen.no. Leave empty to route with Valhalla
    // (OpenStreetMap) in the browser instead.
    'vegvesen_ruteplan_user' => '',   // WEFO_VEGVESEN_RUTEPLAN_USER
    'vegvesen_ruteplan_pass' => '',   // WEFO_VEGVESEN_RUTEPLAN_PASS

    // Google Street View in Kjørevær (click the route on the map). A Google Cloud API key with the Maps Embed API (free,
    // unlimited) and the Street View Static API enabled; only its metadata is used, which is free and uses no quota. The
    // project needs a billing account even though nothing is charged. Restrict the key to the HTTP referrers
    // https://glett.no/* and https://www.glett.no/* and to those two APIs. Leave empty to offer only a link to Google Maps.
    'google_maps_key' => '',   // WEFO_GOOGLE_MAPS_KEY

    // Statens vegvesen DATEX II (traffic messages, closures, convoy driving, road weather stations) for Kjørevær.
    // Username and password from Vegvesen's DATEX registration. Leave empty to go without.
    'vegvesen_datex_user' => '',   // WEFO_VEGVESEN_DATEX_USER
    'vegvesen_datex_pass' => '',   // WEFO_VEGVESEN_DATEX_PASS
];
