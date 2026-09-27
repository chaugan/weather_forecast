<?php
// Personal, local configuration. Copy this file to config.php (same folder) and fill in your own
// values there — config.php is listed in .gitignore, so it is never committed or pushed.
// If config.php does not exist, or a key is left empty, the matching optional feature is simply
// disabled: nothing else in the app requires this file.
//
// Prefer not to keep secrets in a file at all? Every key here can instead be set as an environment
// variable — see the WEFO_* name next to each one below — which always takes priority over the value
// here. That's the "WEFO_GOOGLE_WEATHER_API_KEY" line in the README's setup instructions for Apache,
// Nginx+PHP-FPM and systemd. You can use config.php, an env var, or both (env wins); config.php can
// stay empty either way.
return [

    // Google Maps Platform "Weather API" key (Google DeepMind's WeatherNext 3 AI forecast), used to
    // add "Google WeatherNext 3" as one more model in the comparison.
    //   Env var: WEFO_GOOGLE_WEATHER_API_KEY (takes priority over the line below if set)
    //   Docs:    https://developers.google.com/maps/documentation/weather/overview
    //   Get a key: https://console.cloud.google.com/ → create a project → enable billing
    //              (required even for the free tier) → enable the "Weather API" → create an API key
    //              → restrict it to the Weather API.
    //   Cost:    the first 10,000 calls/month are free, then pay-as-you-go (see the docs above). Cap
    //            the API's own daily quota in Google Cloud Console (APIs & Services → Weather API →
    //            Quotas) so Google itself refuses calls past whatever limit you set — see the README.
    //            api/google_weather.php also caches responses for a few hours and caps its own daily
    //            calls (see the constants at the top of that file), but you are responsible for your
    //            own Google Cloud billing either way.
    //   Leave empty (and the env var unset) to disable this feature entirely — nothing else in the
    //   app is affected.
    'google_weather_api_key' => '',

];
