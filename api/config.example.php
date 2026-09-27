<?php
// Personal, local configuration. Copy this file to config.php (same folder) and fill in your own
// values there — config.php is listed in .gitignore, so it is never committed or pushed.
// If config.php does not exist, or a key is left empty, the matching optional feature is simply
// disabled: nothing else in the app requires this file.
return [

    // Google Maps Platform "Weather API" key (Google DeepMind's WeatherNext 3 AI forecast), used to
    // add "Google WeatherNext 3" as one more model in the comparison.
    //   Docs:    https://developers.google.com/maps/documentation/weather/overview
    //   Get a key: https://console.cloud.google.com/ → create a project → enable billing
    //              (required even for the free tier) → enable the "Weather API" → create an API key
    //              → restrict it to the Weather API.
    //   Cost:    the first 10,000 calls/month are free, then pay-as-you-go (see the docs above).
    //            api/google_weather.php caches responses for a few hours and caps daily calls
    //            (see the constants at the top of that file) to stay well inside the free tier for
    //            normal personal use — but you are responsible for your own Google Cloud billing.
    //   Leave empty to disable this feature entirely (nothing else in the app is affected).
    'google_weather_api_key' => '',

];
