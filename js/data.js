'use strict';
/* WeFo browser data layer.
   Everything that used to be done by PHP on the server now runs here, in the visitor's browser:
   - forecasts from Open-Meteo (13 models) and MET Norway / Yr, fetched directly and cached in IndexedDB
   - model verification (archived forecasts vs ERA5 and vs METAR observations; METAR comes through api/metar.php)
   - the long-term daily history since 1940 (downloaded once per data grid point, stored in IndexedDB, topped up)
   - saved locations (IndexedDB, with export / import as a JSON file)
   The server is only asked for two things the browser cannot fetch itself: METAR observations and reverse geocoding. */
const WEFO = (() => {
  /* ---------------- tunables (see README "Configuration") ---------------- */
  const FORECAST_TTL = 60 * 60;            // s  forecast cache (models update every 1-6 h)
  const REFRESH_MIN_INTERVAL = 5 * 60;     // s  "Refresh" may bypass the cache at most this often per location
  const VERIFY_TTL = 24 * 3600;            // s  reliability cache
  const WINDOW_DAYS = 28;                  // ERA5 comparison window
  const LAG_DAYS = 6;                      // ERA5 is published with a delay of a few days
  const MIN_OBS = 48;                      // minimum matched hourly METAR observations
  const OBS_WEIGHT = 0.6;                  // share of METAR in the blended skill (rest = ERA5)
  const NETATMO_WEIGHT = 0.3;              // Norway: share of Glett's Netatmo snapshots in the blended skill (rest = MET stations via Frost)
  const RECENT_DAYS = 7;                   // the "last 7 days" score
  const HIST_START = '1940-01-01';         // earliest day loaded from ERA5 ("whole history")
  const FROST_FLOOR = '1800-01-01';        // Frost station chains reach the 1800s in the big cities: take what they have
  const HIST_DEFAULT_START = '1991-01-01'; // first load covers the current climate-normal period; the rest on request
  const HIST_LAG_DAYS = 6;
  const FROST_CHUNK_YEARS = 10;            // api/frost.php serves at most this many years per request
  // MET Norway's Frost stations cover Norway (mainland, Svalbard, Jan Mayen); elsewhere the ERA5 reanalysis is used
  const inNorway = (lat, lon) => (lat >= 57.5 && lat <= 71.5 && lon >= 4 && lon <= 31.5) || (lat >= 70 && lat <= 81 && lon >= -10 && lon <= 35);
  const HIST_CHECK_SECONDS = 6 * 3600;     // top-up check at most this often (unless "Check for new data now")

  const MODELS = ['ecmwf_aifs025_single', 'ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'gem_seamless', 'meteofrance_seamless', 'ukmo_seamless',
                  'jma_seamless', 'cma_grapes_global', 'bom_access_global', 'knmi_seamless', 'dmi_seamless', 'metno_seamless'];
  const VARS = ['temperature_2m', 'apparent_temperature', 'precipitation', 'wind_speed_10m', 'wind_gusts_10m',
                'wind_direction_10m', 'cloud_cover', 'relative_humidity_2m', 'pressure_msl', 'weather_code', 'cape', 'is_day'];
  const VERIFY_MODELS = ['ecmwf_aifs025_single', 'ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'gem_seamless', 'meteofrance_seamless', 'ukmo_seamless',
                         'jma_seamless', 'cma_grapes_global', 'knmi_seamless', 'dmi_seamless', 'metno_seamless'];
  const VERIFY_VARS = ['temperature_2m', 'precipitation', 'wind_speed_10m', 'cloud_cover', 'relative_humidity_2m', 'pressure_msl', 'weather_code'];
  const VTOL = { temperature_2m: 4.0, wind_speed_10m: 15.0, cloud_cover: 50.0, relative_humidity_2m: 25.0, pressure_msl: 4.0 };   // error at which skill = 0
  const KEYS = { temperature_2m: 't', wind_speed_10m: 'w', cloud_cover: 'c', relative_humidity_2m: 'h', pressure_msl: 'p' };
  const HIST_VARS = ['temperature_2m_max', 'temperature_2m_min', 'temperature_2m_mean', 'precipitation_sum', 'wind_speed_10m_max', 'wind_gusts_10m_max', 'snowfall_sum'];
  const HIST_COLS = ['tmax', 'tmin', 'tmean', 'prcp', 'wmax', 'gust', 'snow'];

  const now = () => Math.floor(Date.now() / 1000);
  const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
  const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  const sum = (a) => a.reduce((s, x) => s + x, 0);

  class DataError extends Error { constructor(message, kind) { super(message); this.kind = kind || 'error'; } }

  /* ---------------- storage: IndexedDB with an in-memory (+ localStorage for locations) fallback ---------------- */
  const STORES = ['locations', 'cache', 'history', 'histmap'];
  const mem = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        if (!window.indexedDB) return resolve(null);
        const req = indexedDB.open('glett', 1);
        req.onupgradeneeded = () => { const d = req.result; STORES.forEach((s) => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); }); };
        req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return dbPromise;
  }
  function tx(store, mode, fn) {
    return openDb().then((d) => {
      if (!d) throw new Error('no idb');
      return new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    });
  }
  // localStorage mirror so saved places survive a reload even when IndexedDB is unavailable (some private modes)
  const lsKey = 'glett.locations';
  function lsLoad() { try { const a = JSON.parse(localStorage.getItem(lsKey) || '[]'); if (Array.isArray(a)) a.forEach((l) => mem.locations.set(l.id, l)); } catch (e) { /* ignore */ } }
  function lsSave() { try { localStorage.setItem(lsKey, JSON.stringify([...mem.locations.values()])); } catch (e) { /* ignore */ } }
  lsLoad();
  const kv = {
    async get(store, key) { try { return await tx(store, 'readonly', (s) => s.get(key)); } catch (e) { return mem[store].get(key); } },
    async put(store, key, value) { try { await tx(store, 'readwrite', (s) => s.put(value, key)); } catch (e) { mem[store].set(key, value); if (store === 'locations') lsSave(); } },
    async del(store, key) { try { await tx(store, 'readwrite', (s) => s.delete(key)); } catch (e) { /* ignore */ } mem[store].delete(key); if (store === 'locations') lsSave(); },
    async all(store) { try { const a = await tx(store, 'readonly', (s) => s.getAll()); return a.length ? a : [...mem[store].values()]; } catch (e) { return [...mem[store].values()]; } },
    async keys(store) { try { return await tx(store, 'readonly', (s) => s.getAllKeys()); } catch (e) { return [...mem[store].keys()]; } },
  };

  async function cacheGet(k) { const r = await kv.get('cache', k); return r && r.expires_at > now() ? r.body : null; }
  async function cachePut(k, body, ttl) { await kv.put('cache', k, { body, fetched_at: now(), expires_at: now() + ttl }); }
  async function cacheSweep() {   // drop expired entries (runs once per page view, after the first render)
    try {
      const d = await openDb(); if (!d) return;
      await new Promise((resolve) => {
        const t = d.transaction('cache', 'readwrite'), s = t.objectStore('cache'), req = s.openCursor(), ts = now();
        req.onsuccess = () => { const c = req.result; if (!c) return; if (!c.value || c.value.expires_at < ts) c.delete(); c.continue(); };
        t.oncomplete = resolve; t.onerror = resolve; t.onabort = resolve;
      });
    } catch (e) { /* ignore */ }
  }

  /* ---------------- HTTP ---------------- */
  async function getJson(url, plain = false) {
    const host = new URL(url, location.href).host;
    let res;
    try { res = await fetch(url, plain ? undefined : { cache: 'no-store' }); } catch (e) { throw new DataError(t('err.network', { host }), 'network'); }
    if (res.status === 429) throw new DataError(t('err.quota', { host }), 'quota');
    if (!res.ok) {
      let reason = '';
      try { const j = await res.json(); reason = String(j.reason || j.error || ''); } catch (e) { /* ignore */ }
      if (/limit|quota/i.test(reason)) throw new DataError(t('err.quota', { host }), 'quota');
      throw new DataError(reason ? `${host}: ${reason}` : t('err.upstream', { host, s: res.status }), 'http');
    }
    return res.json();
  }
  const qs = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  /* ================= FORECAST ================= */
  // Local time string "YYYY-MM-DDTHH:MM" (Open-Meteo, timezone=auto) -> unix seconds, given the UTC offset
  const localToUnix = (s, offset) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +(s.slice(14, 16) || 0)) / 1000 - offset;

  function yrCode(s) {
    const heavy = s.includes('heavy');
    if (s.includes('thunder')) return 95;
    if (s.includes('snow')) return heavy ? 75 : (s.includes('showers') ? 85 : 73);
    if (s.includes('sleet')) return 68;
    if (s.includes('showers')) return heavy ? 82 : 80;
    if (s.includes('rain')) return heavy ? 65 : (s.includes('light') ? 61 : 63);
    if (s.includes('fog')) return 45;
    if (s.startsWith('cloudy')) return 3;
    if (s.startsWith('partlycloudy')) return 2;
    if (s.startsWith('fair')) return 1;
    return 0;
  }

  // MET Norway / Yr, resampled onto Open-Meteo's hourly time axis (symbol -> WMO code, m/s -> km/h, 6-hour precipitation / 6)
  function yrProvider(yr, time, offset) {
    const list = yr && yr.properties && yr.properties.timeseries;
    if (!list || !list.length) return null;
    const pts = list.map((p) => ({ t: Date.parse(p.time) / 1000, d: p.data }));
    const h = Object.fromEntries(VARS.map((v) => [v, []]));
    let j = 0;
    for (const localStr of time) {
      const tt = localToUnix(localStr, offset);
      while (j + 1 < pts.length && pts[j + 1].t <= tt) j++;
      const p = pts[j];
      if (tt < pts[0].t || tt - p.t > 6 * 3600) { VARS.forEach((v) => h[v].push(null)); continue; }
      const d = p.d, i = d.instant.details || {};
      const hasHour = !!d.next_1_hours;
      const blk = d.next_1_hours || d.next_6_hours || null;
      let prec = null;
      if (hasHour && p.t === tt) prec = d.next_1_hours.details ? d.next_1_hours.details.precipitation_amount ?? null : null;
      else if (d.next_6_hours && d.next_6_hours.details && d.next_6_hours.details.precipitation_amount != null) prec = d.next_6_hours.details.precipitation_amount / 6;
      else if (hasHour) prec = d.next_1_hours.details ? d.next_1_hours.details.precipitation_amount ?? null : null;
      const sym = blk && blk.summary ? blk.summary.symbol_code : null;
      h.temperature_2m.push(i.air_temperature ?? null);
      h.apparent_temperature.push(null);
      h.precipitation.push(prec != null ? round(prec, 2) : null);
      h.wind_speed_10m.push(i.wind_speed != null ? round(i.wind_speed * 3.6, 1) : null);
      h.wind_gusts_10m.push(i.wind_speed_of_gust != null ? round(i.wind_speed_of_gust * 3.6, 1) : null);
      h.wind_direction_10m.push(i.wind_from_direction ?? null);
      h.cloud_cover.push(i.cloud_area_fraction ?? null);
      h.relative_humidity_2m.push(i.relative_humidity ?? null);
      h.pressure_msl.push(i.air_pressure_at_sea_level ?? null);
      h.weather_code.push(sym ? yrCode(sym) : null);
      h.cape.push(null);
      h.is_day.push(null);
    }
    return { id: 'yr', name: 'MET Norway / Yr', hourly: h };
  }

  const refreshKey = (k) => 'glett.refresh.' + k;
  async function fetchForecast(lat, lon, refresh = false) {
    const la = +lat.toFixed(2), lo = +lon.toFixed(2);   // 0.01° grid: nearby places share one request and one cache entry
    const key = `fc:${la}:${lo}`;
    if (refresh) {
      let last = 0; try { last = +localStorage.getItem(refreshKey(key)) || 0; } catch (e) { /* ignore */ }
      if (now() - last < REFRESH_MIN_INTERVAL) refresh = false;   // throttled: serve the cache
    }
    if (!refresh) { const c = await cacheGet(key); if (c) return c; }
    const omUrl = 'https://api.open-meteo.com/v1/forecast?' + qs({ latitude: la, longitude: lo, hourly: VARS.join(','), models: MODELS.join(','), timezone: 'auto', forecast_days: 7 });
    // MET Norway: a plain request with no custom headers (a CORS preflight is not supported), at most 4 decimals
    const yrUrl = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${la.toFixed(4)}&lon=${lo.toFixed(4)}`;
    const [om, yr] = await Promise.all([getJson(omUrl), getJson(yrUrl, true).catch(() => null)]);
    if (!om || !om.hourly || !om.hourly.time) throw new DataError(t('err.upstream', { host: 'api.open-meteo.com', s: '' }));
    const time = om.hourly.time, offset = +(om.utc_offset_seconds || 0);
    const providers = [];
    for (const id of MODELS) {
      const h = {};
      let has = false;
      for (const v of VARS) {
        const arr = om.hourly[`${v}_${id}`] || Array(time.length).fill(null);
        h[v] = arr;
        if (v !== 'is_day' && arr.some((x) => x != null)) has = true;
      }
      if (has) providers.push({ id, hourly: h });
    }
    const y = yrProvider(yr, time, offset);
    if (y) providers.push(y);
    const data = { lat: la, lon: lo, timezone: om.timezone || null, utc_offset_seconds: offset, elevation: om.elevation ?? null, generated: new Date().toISOString(), time, providers };
    await cachePut(key, data, FORECAST_TTL);
    if (refresh) { try { localStorage.setItem(refreshKey(key), String(now())); } catch (e) { /* ignore */ } }
    return data;
  }

  /* ================= VERIFICATION (reliability) ================= */
  // Weather category of a WMO code, with drizzle merged into rain (METAR cannot tell them apart reliably)
  function vcat(c) {
    if (c == null) return null;
    c = Math.trunc(c);
    if (c <= 1) return 'clear';
    if (c === 2) return 'partly';
    if (c === 3) return 'cloudy';
    if (c === 45 || c === 48) return 'fog';
    if ((c >= 51 && c <= 57) || (c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
    if (c >= 95) return 'thunder';
    return 'cloudy';
  }
  /* Compares one model with a list of truth rows [{j: forecast index, t,w,c,h,p, wet, cat}] */
  function evaluate(fc, m, rows) {
    const s = { mae: {}, bias: {}, n: 0 };
    for (const [v, k] of Object.entries(KEYS)) {
      const a = fc.hourly[`${v}_${m}`]; if (!a) continue;
      let acc = 0, bias = 0, cnt = 0;
      for (const r of rows) { const x = a[r.j]; if (x == null || r[k] == null) continue; const d = x - r[k]; acc += Math.abs(d); bias += d; cnt++; }
      if (cnt >= 24) { s.mae[v] = acc / cnt; s.bias[v] = bias / cnt; s.n = Math.max(s.n, cnt); }
    }
    const p = fc.hourly[`precipitation_${m}`];   // rain: critical success index over wet hours (model >= 0.1 mm)
    if (p) {
      let hit = 0, miss = 0, fa = 0;
      for (const r of rows) { const x = p[r.j]; if (x == null || r.wet == null) continue; const f = x >= 0.1; if (r.wet && f) hit++; else if (r.wet) miss++; else if (f) fa++; }
      if (hit + miss + fa > 0) s.csi = hit / (hit + miss + fa);
      s.rain_events = hit + miss;
    }
    const c = fc.hourly[`weather_code_${m}`];   // weather category agreement
    if (c) {
      let ok = 0, tot = 0;
      for (const r of rows) { const x = c[r.j]; if (x == null || r.cat == null) continue; tot++; if (vcat(x) === r.cat) ok++; }
      if (tot >= 24) s.code_acc = ok / tot;
    }
    return s;
  }
  function skills(s, minRain) {
    const sk = {};
    for (const [v, tol] of Object.entries(VTOL)) if (s.mae[v] != null) sk[v] = Math.max(0, 1 - s.mae[v] / tol);
    if (s.csi != null && (s.rain_events || 0) >= minRain) sk.precip = s.csi;
    if (s.code_acc != null) sk.code = s.code_acc;
    return sk;
  }
  function normWeights(vals) {   // mean = 1, limited to [0.5, 1.8] so that no model dominates
    const ids = Object.keys(vals); if (!ids.length) return {};
    const raw = ids.map((m) => vals[m] + 0.15), mean = sum(raw) / raw.length;
    return Object.fromEntries(ids.map((m, i) => [m, round(Math.min(1.8, Math.max(0.5, raw[i] / mean)), 3)]));
  }
  const roundMap = (o, d) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v, d)]));

  /* Frost observations (Norway): nearest MET station per measurement, hourly, up to yesterday */
  function frostRows(frost, fIdx) {
    const rows = [];
    const hasCloud = Object.values(frost.obs || {}).filter((o) => o.c != null).length >= 24;   // no cloud station nearby: no weather-type check (rain hours alone would skew it)
    for (const [hk, o] of Object.entries(frost.obs || {})) {
      const j = fIdx.get(hk); if (j === undefined) continue;
      const wet = o.r != null ? o.r >= 0.1 : null;
      let cat = null;   // weather type from what was measured: precipitation first, else cloud cover (oktas as %)
      if (!hasCloud) cat = null;
      else if (wet) cat = o.t != null && o.t <= 0.5 ? 'snow' : 'rain';
      else if (wet === false && o.c != null) cat = o.c <= 37.5 ? 'clear' : o.c <= 62.5 ? 'partly' : 'cloudy';
      rows.push({ j, tm: hk, t: o.t ?? null, w: o.w ?? null, c: o.c ?? null, h: o.h ?? null, p: o.p ?? null, wet, cat });
    }
    return rows;
  }
  /* Glett's own hourly Netatmo snapshots for the cell (temperature, humidity, rain) */
  function netatmoRows(nt, fIdx) {
    const rows = [];
    for (const [hk, o] of Object.entries(nt.obs || {})) {
      const j = fIdx.get(hk); if (j === undefined) continue;
      rows.push({ j, tm: hk, t: o.t ?? null, h: o.h ?? null, w: null, c: null, p: null, wet: o.r != null ? (o.r >= 0.2 && (o.ws ?? 0) >= 0.3) : null, cat: null });
    }
    return rows;
  }
  /* Skill per measurement from a main truth and an optional second source (share w2) */
  function blendSkills(fc, m, rows1, rows2, w2, minRain1, minRain2) {
    const a = rows1.length ? evaluate(fc, m, rows1) : { mae: {} };
    const b = rows2.length ? evaluate(fc, m, rows2) : null;
    const s1 = skills(a, minRain1), s2 = b ? skills(b, minRain2) : {}, sk = {};
    for (const v of new Set([...Object.keys(s1), ...Object.keys(s2)])) sk[v] = (s1[v] != null && s2[v] != null) ? w2 * s2[v] + (1 - w2) * s1[v] : (s1[v] ?? s2[v]);
    return { a, b, sk };
  }
  const meanScore = (sk) => { const vals = Object.values(sk); return vals.length ? Math.round(sum(vals) / vals.length * 100) : null; };

  async function fetchVerify(lat, lon) {
    const la = +lat.toFixed(1), lo = +lon.toFixed(1);   // 0.1° cell (also what api/metar.php caches by)
    const key = `vf3:${la}:${lo}`;
    const c = await cacheGet(key); if (c) return c;
    const T = Date.now(), fcEnd = isoDate(T - 86400e3);
    // Norway: MET station observations (Frost) up to yesterday, plus Glett's Netatmo snapshots. Elsewhere: ERA5 (few days late) + METAR.
    let frost = null, nt = null;
    if (inNorway(la, lo)) {
      const fStart = isoDate(T - WINDOW_DAYS * 86400e3);
      [frost, nt] = await Promise.all([
        // the first request for a new area can hit the web host's ~15 s limit after the station choice is saved; one retry is then quick
        getJson(`api/frost.php?truth=1&lat=${la}&lon=${lo}&from=${fStart}&to=${fcEnd}`).catch(() => getJson(`api/frost.php?truth=1&lat=${la}&lon=${lo}&from=${fStart}&to=${fcEnd}`)).catch(() => null),
        getJson(`api/netatmo.php?history=1&lat=${la}&lon=${lo}&days=${WINDOW_DAYS}`).catch(() => null),
      ]);
      if (!frost || !frost.obs || Object.keys(frost.obs).length < 24 * 7) frost = null;
    }
    const useFrost = !!frost;
    const start = useFrost ? isoDate(T - WINDOW_DAYS * 86400e3) : isoDate(T - (LAG_DAYS + WINDOW_DAYS) * 86400e3);
    const truthEnd = useFrost ? fcEnd : isoDate(T - LAG_DAYS * 86400e3);
    const base = { latitude: la, longitude: lo, hourly: VERIFY_VARS.join(','), timezone: 'UTC' };
    let truthErr = null;
    const [fc, truth, metar] = await Promise.all([
      getJson('https://historical-forecast-api.open-meteo.com/v1/forecast?' + qs({ ...base, start_date: start, end_date: fcEnd, models: VERIFY_MODELS.join(',') })),
      useFrost ? null : getJson('https://archive-api.open-meteo.com/v1/archive?' + qs({ ...base, start_date: start, end_date: truthEnd })).catch((e) => { truthErr = e; return null; }),
      useFrost ? null : getJson(`api/metar.php?lat=${la}&lon=${lo}`).catch(() => null),
    ]);
    if (!fc || !fc.hourly || !fc.hourly.time) throw new DataError(t('err.verify'));
    if (!useFrost && (!truth || !truth.hourly || !truth.hourly.time)) throw new DataError(truthErr ? truthErr.message : t('err.verify'));   // no ERA5 = nothing to score against
    const fIdx = new Map(fc.hourly.time.map((tm, i) => [tm, i]));
    let rows1 = [], rows2 = [], w2 = 0, stationInfo = null;
    if (useFrost) {
      rows1 = frostRows(frost, fIdx);
      rows2 = nt ? netatmoRows(nt, fIdx) : [];
      if (rows2.length < 24) rows2 = [];
      w2 = rows2.length ? NETATMO_WEIGHT : 0;
    } else {
      const H = truth.hourly;
      H.time.forEach((tm, i) => {
        const j = fIdx.get(tm); if (j === undefined) return;
        rows1.push({ j, tm, t: H.temperature_2m?.[i] ?? null, w: H.wind_speed_10m?.[i] ?? null, c: H.cloud_cover?.[i] ?? null, h: H.relative_humidity_2m?.[i] ?? null,
          p: H.pressure_msl?.[i] ?? null, wet: H.precipitation?.[i] != null ? H.precipitation[i] >= 0.1 : null, cat: vcat(H.weather_code?.[i] ?? null) });
      });
      if (metar && metar.station && metar.obs) {
        for (const [hk, o] of Object.entries(metar.obs)) { const j = fIdx.get(hk); if (j !== undefined) rows2.push({ j, tm: hk, ...o }); }
        if (rows2.length >= MIN_OBS) {
          const times = Object.keys(metar.obs).sort();
          stationInfo = { id: metar.station.id, name: metar.station.name, km: metar.station.km, elev: metar.station.elev, reports: rows2.length, start: times[0].slice(0, 10), end: times[times.length - 1].slice(0, 10) };
          w2 = OBS_WEIGHT;
        } else rows2 = [];
      }
    }
    const recentFrom = isoDate(T - RECENT_DAYS * 86400e3);
    const recent = (rows) => rows.filter((r) => r.tm >= recentFrom);
    const out = {}, blend = {};
    for (const m of VERIFY_MODELS) {
      const { a, b, sk } = blendSkills(fc, m, rows1, rows2, w2, useFrost ? 10 : 15, 6);
      const maes = Object.values(a.mae);
      if (!maes.length || sum(maes) < 0.001) continue;   // outside coverage: the archive returns a copy of ERA5 (error 0)
      const r7 = blendSkills(fc, m, recent(rows1), recent(rows2), w2, 3, 3);
      blend[m] = sk;
      out[m] = { score: meanScore(sk), score7: meanScore(r7.sk), skill: roundMap(sk, 3), mae: roundMap(a.mae, 2), bias: roundMap(a.bias, 2),
        csi: a.csi != null ? round(a.csi, 3) : null, code_acc: a.code_acc != null ? round(a.code_acc, 3) : null,
        obs: b ? { mae: roundMap(b.mae, 2), bias: roundMap(b.bias, 2), csi: b.csi != null ? round(b.csi, 3) : null, code_acc: b.code_acc != null ? round(b.code_acc, 3) : null } : null };
    }
    const byParam = {};
    for (const [m, ps] of Object.entries(blend)) for (const [v, x] of Object.entries(ps)) (byParam[v] = byParam[v] || {})[m] = x;
    const W = {};
    for (const [v, vals] of Object.entries(byParam)) for (const [m, w] of Object.entries(normWeights(vals))) (W[m] = W[m] || {})[v] = w;
    for (const m of Object.keys(out)) {
      const w = W[m] || {};
      out[m].weights = { weather: w.code ?? null, temperature_2m: w.temperature_2m ?? null, precip: w.precip ?? null, wind: w.wind_speed_10m ?? null, storm: w.code ?? null,
        cloud_cover: w.cloud_cover ?? null, relative_humidity_2m: w.relative_humidity_2m ?? null, pressure_msl: w.pressure_msl ?? null };
    }
    const result = { truth: useFrost ? 'frost' : 'era5', start, end: truthEnd, hours: rows1.length, recent_from: recentFrom,
      frost: useFrost ? { stations: frost.stations } : null, netatmo_hours: useFrost ? rows2.length : 0,
      station: stationInfo, obs_weight: w2, models: out };
    await cachePut(key, result, VERIFY_TTL);
    return result;
  }


  /* ================= HISTORY (daily series since 1940, per data grid point) ================= */
  const histUrl = (lat, lon, from, to, daily = HIST_VARS.join(',')) => 'https://archive-api.open-meteo.com/v1/archive?' + qs({ latitude: lat, longitude: lon, start_date: from, end_date: to, timezone: 'auto', daily });
  const gridKey = (j) => `${(+j.latitude).toFixed(4)},${(+j.longitude).toFixed(4)}`;
  const locKey = (loc) => `${(+loc.lat).toFixed(3)},${(+loc.lon).toFixed(3)}`;

  /* Merge an archive response into a stored series (or create one). Days without any of tmax/tmin/prcp are not published yet and are skipped. */
  function mergeSeries(h, j, prevLast, keep = false) {
    const D = j.daily, idx = new Map();
    if (!h) h = { source: 'era5', grid_lat: +j.latitude, grid_lon: +j.longitude, elevation: j.elevation ?? null, timezone: j.timezone || null, first: null, last: null, fetched_at: 0, d: [], ...Object.fromEntries(HIST_COLS.map((c) => [c, []])) };
    h.d.forEach((d, i) => idx.set(d, i));
    let added = 0;
    D.time.forEach((d, i) => {
      const row = HIST_VARS.map((v) => D[v]?.[i] ?? null);
      if (row[0] == null && row[1] == null && row[3] == null) return;
      let k = idx.get(d);
      if (k === undefined) { k = h.d.length; h.d.push(d); idx.set(d, k); }
      HIST_COLS.forEach((c, n) => { if (!keep || h[c][k] == null) h[c][k] = row[n]; });
      if (prevLast == null || d > prevLast) added++;
    });
    // keep chronological order (top-ups normally append, but be safe)
    const order = h.d.map((d, i) => i).sort((a, b) => (h.d[a] < h.d[b] ? -1 : h.d[a] > h.d[b] ? 1 : 0));
    if (order.some((o, i) => o !== i)) { h.d = order.map((i) => h.d[i]); HIST_COLS.forEach((c) => { h[c] = order.map((i) => h[c][i]); }); }
    h.first = h.d[0] || null; h.last = h.d[h.d.length - 1] || null; h.fetched_at = now();
    return { h, added };
  }

  function haversineKm(la1, lo1, la2, lo2) {
    const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /* Aggregations (records, monthly climate, month series, annual summary), same definitions as the former SQL queries */
  function aggregate(h) {
    const n = h.d.length, rec = {};
    const pick = (col, best) => { let bi = -1; for (let i = 0; i < n; i++) { const v = h[col][i]; if (v == null) continue; if (bi < 0 || best(v, h[col][bi])) bi = i; } return bi < 0 ? null : { d: h.d[bi], v: round(h[col][bi], 1) }; };
    rec.hottest = pick('tmax', (a, b) => a > b); rec.coldest = pick('tmin', (a, b) => a < b); rec.wettest = pick('prcp', (a, b) => a > b);
    rec.windiest = pick('gust', (a, b) => a > b); rec.snowiest = pick('snow', (a, b) => a > b);
    // per (year, month) and per year accumulators
    const ym = new Map(), yy = new Map();
    const acc = () => ({ n: 0, tm: 0, tmn: 0, tx: 0, txn: 0, tn: 0, tnn: 0, p: 0, pn: 0, rainy: 0, txmax: null, tnmin: null, gust: null, snow: 0, snown: 0, snowmax: null });
    for (let i = 0; i < n; i++) {
      const y = +h.d[i].slice(0, 4), m = +h.d[i].slice(5, 7), k = y * 100 + m;
      let a = ym.get(k); if (!a) ym.set(k, (a = acc()));
      let b = yy.get(y); if (!b) yy.set(y, (b = acc()));
      for (const x of [a, b]) {
        x.n++;
        if (h.tmean[i] != null) { x.tm += h.tmean[i]; x.tmn++; }
        if (h.tmax[i] != null) { x.tx += h.tmax[i]; x.txn++; x.txmax = x.txmax == null ? h.tmax[i] : Math.max(x.txmax, h.tmax[i]); }
        if (h.tmin[i] != null) { x.tn += h.tmin[i]; x.tnn++; x.tnmin = x.tnmin == null ? h.tmin[i] : Math.min(x.tnmin, h.tmin[i]); }
        if (h.prcp[i] != null) { x.p += h.prcp[i]; x.pn++; if (h.prcp[i] >= 1) x.rainy++; }
        if (h.gust[i] != null) x.gust = x.gust == null ? h.gust[i] : Math.max(x.gust, h.gust[i]);
        if (h.snow[i] != null) { x.snow += h.snow[i]; x.snown++; x.snowmax = x.snowmax == null ? h.snow[i] : Math.max(x.snowmax, h.snow[i]); }
      }
    }
    const avg = (s, c) => (c ? s / c : null);
    const series = [], mAcc = Array.from({ length: 13 }, () => ({ tm: 0, tmn: 0, tx: 0, txn: 0, tn: 0, tnn: 0, p: 0, pn: 0, r: 0, rn: 0 }));
    for (const k of [...ym.keys()].sort((a, b) => a - b)) {
      const a = ym.get(k), y = Math.floor(k / 100), m = k % 100;
      series.push([y, m, round(avg(a.tm, a.tmn), 1), a.pn ? round(a.p, 0) : null, a.n]);
      if (a.n >= 25) {   // complete months only
        const M = mAcc[m], tmean = avg(a.tm, a.tmn), tmax = avg(a.tx, a.txn), tmin = avg(a.tn, a.tnn);
        if (tmean != null) { M.tm += tmean; M.tmn++; } if (tmax != null) { M.tx += tmax; M.txn++; } if (tmin != null) { M.tn += tmin; M.tnn++; }
        if (a.pn) { M.p += a.p; M.pn++; } M.r += a.rainy; M.rn++;
      }
    }
    const monthly = [];
    for (let m = 1; m <= 12; m++) { const M = mAcc[m]; if (!M.rn) continue; monthly.push({ m, tmean: round(avg(M.tm, M.tmn), 1), tmax: round(avg(M.tx, M.txn), 1), tmin: round(avg(M.tn, M.tnn), 1), prcp: round(avg(M.p, M.pn), 1), rainy: round(avg(M.r, M.rn), 1) }); }
    const annual = [...yy.keys()].sort((a, b) => a - b).map((y) => { const a = yy.get(y); return { y, n: a.n, tmean: round(avg(a.tm, a.tmn), 1), tmax: round(a.txmax, 1), tmin: round(a.tnmin, 1), prcp: a.pn ? round(a.p, 0) : null, rainy: a.rainy, gust: round(a.gust, 0), snow: a.snown ? round(h.source === 'frost' ? a.snowmax : a.snow, 1) : null }; });
    return { records: rec, monthly, series, annual };
  }

  const yearOf = (d) => +String(d).slice(0, 4);
  const meta = (loc, h) => ({
    source: h.source || 'era5', station: h.station || null, chain: h.chain || null, grid_lat: h.grid_lat, grid_lon: h.grid_lon, elevation: h.elevation,
    distance_km: round(haversineKm(+loc.lat, +loc.lon, h.grid_lat, h.grid_lon), 1), first: h.first, last: h.last, days: h.d.length, fetched_at: h.fetched_at,
    can_extend: h.source === 'frost' ? ((h.loaded_from ?? yearOf(h.first)) > yearOf(h.station && h.station.from > FROST_FLOOR ? h.station.from : FROST_FLOOR)) : (!!h.first && h.first > HIST_START),
  });

  /* ERA5 (Open-Meteo archive): first load from HIST_DEFAULT_START, `full` extends back to HIST_START, top-ups fetch only missing days */
  async function historyEra5(loc, refresh, full, progress) {
    const lk = locKey(loc), end = isoDate(Date.now() - HIST_LAG_DAYS * 86400e3);
    let grid = await kv.get('histmap', lk);
    if (!grid) {   // learn the grid point with one tiny request, so two nearby places share one stored series
      const probe = await getJson(histUrl(loc.lat, loc.lon, end, end, 'temperature_2m_max'));
      if (probe && probe.latitude != null) { grid = gridKey(probe); await kv.put('histmap', lk, grid); }
    }
    let h = grid ? await kv.get('history', grid) : null;
    let downloaded = false, added = 0;
    const fetchRange = async (from, to) => {
      progress && progress(t('h.loading.range', { from: from.slice(0, 4), to: to.slice(0, 4) }));
      const j = await getJson(histUrl(loc.lat, loc.lon, from, to));
      if (!j || !j.daily || !j.daily.time) return false;
      const g = gridKey(j);
      if (g !== grid) { grid = g; await kv.put('histmap', lk, g); h = await kv.get('history', g); }
      const prevLast = h ? h.last : null;
      const r = mergeSeries(h, j, prevLast);
      h = r.h; if (to > (prevLast || '')) added += r.added;
      await kv.put('history', g, h);
      return true;
    };
    if (!h) { await fetchRange(HIST_DEFAULT_START, end); downloaded = !!h; }
    else if (h.last < end && (refresh || now() - h.fetched_at > HIST_CHECK_SECONDS)) {
      const from = isoDate(Date.parse(h.last + 'T00:00:00Z') - 3 * 86400e3);
      let ok = false;
      try { ok = await fetchRange(from, end); } catch (e) { /* keep serving the stored data */ }
      if (!ok) { h.fetched_at = now(); await kv.put('history', grid, h); }
    }
    if (h && full && h.first > HIST_START) {
      const to = isoDate(Date.parse(h.first + 'T00:00:00Z') - 86400e3);
      await fetchRange(HIST_START, to);
    }
    if (!h) throw new DataError(t('err.history', { e: '' }));
    return { h, downloaded, added };
  }

  /* MET Norway Frost (via api/frost.php): daily station observations, loaded in 5-year chunks */
  let mergeSeriesKeepOff = false;
  /* How far back the history goes for a place, for the button label: Norway = the station chain's first year (Frost lookup,
     one small cached request, remembered per place for 30 days); elsewhere ERA5 from 1940. No data series is downloaded here. */
  async function historySince(lat, lon) {
    if (!inNorway(+lat, +lon)) return { year: +HIST_START.slice(0, 4), source: 'era5' };
    const key = `since:${(+lat).toFixed(2)}:${(+lon).toFixed(2)}`;
    const c = await cacheGet(key); if (c) return c;
    let r = null;
    try { r = await getJson(`api/frost.php?lat=${(+lat).toFixed(4)}&lon=${(+lon).toFixed(4)}`); } catch (e) { return null; }
    const out = r && r.station && r.station.from ? { year: +String(r.station.from).slice(0, 4), source: 'frost' } : { year: +HIST_START.slice(0, 4), source: 'era5' };
    await cachePut(key, out, 30 * 86400);
    return out;
  }
  async function historyFrost(loc, refresh, full, progress) {
    const lk = locKey(loc);
    let key = await kv.get('histmap', lk);
    let st = null, lookup = null;
    if (!key || !key.startsWith('frost:')) {
      lookup = await getJson(`api/frost.php?lat=${(+loc.lat).toFixed(4)}&lon=${(+loc.lon).toFixed(4)}`);
      if (!lookup || !lookup.station) return null;   // no station near enough: ERA5 instead
      st = lookup.station; key = 'frost:' + st.id;
      await kv.put('histmap', lk, key);
    }
    let h = await kv.get('history', key);
    const thisYear = new Date().getFullYear();
    let chain = h && h.chain;
    if (!chain) {   // station chain not known yet (fresh place, or a record stored before chains existed)
      const r = lookup || await getJson(`api/frost.php?lat=${(+loc.lat).toFixed(4)}&lon=${(+loc.lon).toFixed(4)}`);
      if (!r || !r.station) return null;
      st = st || r.station; chain = r.chain || [{ ...st, to: null }];
      if (h) { h.chain = chain; h.station = { ...h.station, from: st.from }; await kv.put('history', key, h); }
    }
    st = st || (h && h.station) || chain[0];
    const floor = st.from > FROST_FLOOR ? st.from : FROST_FLOOR;
    const empty = () => ({ source: 'frost', station: st, chain, grid_lat: st.lat, grid_lon: st.lon, elevation: st.masl, timezone: null, first: null, last: null, fetched_at: 0, d: [], ...Object.fromEntries(HIST_COLS.map((c) => [c, []])) });
    let mergeQueue = Promise.resolve();
    // Which station serves which years: the current one from its first year on, each predecessor before that
    const segments = chain.map((c, i) => ({ id: c.id, y0: yearOf(c.from), y1: i === 0 ? thisYear : Math.min(yearOf(c.to || thisYear + '-01-01'), yearOf(chain[i - 1].from)) }));
    const chunk = async (from, to, stationId = chain[0].id) => {
      progress && progress(t('h.loading.range', { from, to }));
      const j = await getJson(`api/frost.php?station=${stationId}&from=${from}&to=${to}`);
      return (mergeQueue = mergeQueue.then(() => mergeChunk(j)));
    };
    const mergeChunk = async (j) => {
      if (!(j.d || []).length && !h) return 0;   // nothing yet and nothing here
      const daily = { time: j.d || [] }; HIST_VARS.forEach((v, i) => { daily[v] = j[HIST_COLS[i]] || []; });
      const prevLast = h ? h.last : null;
      const r = mergeSeries(h || empty(), { daily, latitude: (h || empty()).grid_lat, longitude: (h || empty()).grid_lon }, prevLast, !mergeSeriesKeepOff);
      h = r.h; h.source = 'frost'; if (!h.station) h.station = st; if (!h.chain) h.chain = chain;
      await kv.put('history', key, h);
      return r.added;
    };
    let downloaded = false, added = 0;
    const partial = () => ({ location: loc, meta: { ...meta(loc, h), partial: true }, downloaded: false, added: 0, ...aggregate(h) });
    // Whole record, newest years first: the page can show the recent decades while the older ones still arrive.
    // Each 5-year span is fetched from every station of the chain that covers part of it (current station first).
    const loadYears = async (y0, y1, live = false) => {
      const spans = [];
      for (let y = y1; y >= y0; y -= FROST_CHUNK_YEARS) spans.push([Math.max(y0, y - FROST_CHUNK_YEARS + 1), y]);
      for (let i = 0; i < spans.length; i += 2) {   // two spans at a time (the server allows 60 requests/min per client)
        const pieces = [];
        for (const [f, tt] of spans.slice(i, i + 2)) for (const sg of segments) { const a = Math.max(f, sg.y0), b = Math.min(tt, sg.y1); if (a <= b) pieces.push([a, b, sg.id]); }
        await Promise.all(pieces.map(([f, tt, sid]) => chunk(f, tt, sid)));
        if (h) { h.loaded_from = Math.min(h.loaded_from ?? 9999, spans[Math.min(i + 1, spans.length - 1)][0]); await kv.put('history', key, h); }
        if (live && progress && i + 2 < spans.length) progress(null, partial());
      }
    };
    const end = isoDate(Date.now() - 86400e3);
    if (!h) { await loadYears(yearOf(floor), thisYear, true); downloaded = true; }
    else if (h.last < end && (refresh || now() - h.fetched_at > HIST_CHECK_SECONDS)) {
      const y = yearOf(h.last);
      try { mergeSeriesKeepOff = true; added = await chunk(Math.max(y, thisYear - FROST_CHUNK_YEARS + 1), thisYear); } catch (e) { h.fetched_at = now(); await kv.put('history', key, h); } finally { mergeSeriesKeepOff = false; }
    }
    // A stored record that starts later than the station's first year (an interrupted earlier load) is completed on open
    if (h && (h.loaded_from ?? yearOf(h.first)) > yearOf(floor)) {
      if (progress) progress(null, partial());
      await loadYears(yearOf(floor), (h.loaded_from ?? yearOf(h.first)) - 1, true);
    }
    if (!h || !h.d.length) return null;
    return { h, downloaded, added };
  }

  async function fetchHistory(loc, refresh = false, full = false, progress = null) {
    let r = null;
    const existing = await kv.get('histmap', locKey(loc));
    const isFrost = existing && existing.startsWith('frost:');
    if (isFrost || inNorway(+loc.lat, +loc.lon)) {   // Norway: station record, also replacing an ERA5 record stored before Frost existed
      if (existing && !isFrost) await kv.del('histmap', locKey(loc));
      try { r = await historyFrost(loc, refresh, full, progress); }
      catch (e) { if (isFrost) throw e; r = null; }   // Frost unavailable before anything was stored: fall back
      if (!r && existing && !isFrost) await kv.put('histmap', locKey(loc), existing);   // keep the old ERA5 record after all
    }
    if (!r) r = await historyEra5(loc, refresh, full, progress);
    return { location: loc, meta: meta(loc, r.h), downloaded: r.downloaded, added: r.added, ...aggregate(r.h) };
  }
  /* Called when a location is deleted: drop its stored series unless another saved place shares the grid point */
  async function forgetHistory(loc, remaining) {
    const lk = locKey(loc), grid = await kv.get('histmap', lk);
    await kv.del('histmap', lk);
    if (!grid) return;
    for (const other of remaining) if ((await kv.get('histmap', locKey(other))) === grid) return;
    await kv.del('history', grid);
  }

  /* ================= SAVED LOCATIONS ================= */
  const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const clean = (l) => {
    const lat = +l.lat, lon = +l.lon, name = String(l.name || '').trim().slice(0, 120);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { name, lat: +lat.toFixed(5), lon: +lon.toFixed(5) };
  };
  const locations = {
    async list() { const a = (await kv.all('locations')).filter((l) => l && l.id); a.sort(cmp); return a; },
    async add(input) {
      const l = clean(input); if (!l) throw new DataError(t('err.pick'));
      const loc = { id: uuid(), ...l, created: now() };
      await kv.put('locations', loc.id, loc);
      return loc;
    },
    async remove(id) {
      const all = await this.list(), loc = all.find((l) => l.id === id);
      await kv.del('locations', id);
      if (loc) await forgetHistory(loc, all.filter((l) => l.id !== id));
    },
    async exportJson() { return JSON.stringify({ glett_locations: 1, exported: new Date().toISOString(), locations: (await this.list()).map(({ name, lat, lon }) => ({ name, lat, lon })) }, null, 2); },
    async importJson(text) {
      let j; try { j = JSON.parse(text); } catch (e) { throw new DataError(t('err.import')); }
      const list = Array.isArray(j) ? j : (j && Array.isArray(j.locations) ? j.locations : null);
      if (!list) throw new DataError(t('err.import'));
      const have = new Set((await this.list()).map((l) => `${l.name.toLowerCase()}|${l.lat.toFixed(4)}|${l.lon.toFixed(4)}`));
      let n = 0;
      for (const raw of list.slice(0, 500)) {
        const l = clean(raw); if (!l) continue;
        const k = `${l.name.toLowerCase()}|${l.lat.toFixed(4)}|${l.lon.toFixed(4)}`;
        if (have.has(k)) continue;
        have.add(k); n++;
        await kv.put('locations', (raw.id = uuid()), { id: raw.id, ...l, created: now() });
      }
      return n;
    },
  };

  /* ================= GEOCODING ================= */
  async function search(q, lang) {   // Open-Meteo geocoding, called directly (the caller debounces >= 350 ms and requires >= 2 characters)
    const j = await getJson('https://geocoding-api.open-meteo.com/v1/search?' + qs({ count: 8, language: lang, name: q }));
    return (j.results || []).map((r) => ({ name: [r.name, r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude }));
  }
  async function reverse(lat, lon, lang, detailed = false) {   // Nominatim through the server (cached, rate-gated there); detailed = nearest locality + municipality
    const j = await getJson(`api/reverse.php?lat=${(+lat).toFixed(4)}&lon=${(+lon).toFixed(4)}&lang=${lang}${detailed ? '&z=14' : ''}`);
    return j.name || null;
  }

  /* ================= NOWCAST (MET Norway radar nowcast, Nordic coverage only, next ~90 min in 5-minute steps) ================= */
  const NOWCAST_TTL = 5 * 60;
  async function nowcastPoint(la, lo) {   // one point: [{t, rate}] or null (outside radar coverage / failure)
    let j;
    try { j = await getJson(`https://api.met.no/weatherapi/nowcast/2.0/complete?lat=${la.toFixed(4)}&lon=${lo.toFixed(4)}`, true); }
    catch (e) { return null; }   // 422 = outside the radar coverage, or any other failure: simply no nowcast
    const list = j && j.properties && j.properties.timeseries;
    if (!list || !list.length) return null;
    return list.map((p) => ({ t: Date.parse(p.time) / 1000, rate: p.data && p.data.instant && p.data.instant.details ? (p.data.instant.details.precipitation_rate ?? null) : null })).filter((p) => p.rate != null);
  }
  /* The place itself plus eight points about 5 km around it (N, NE, E, ...), so "rain nearby" can be told apart from rain here */
  const NOWCAST_RING_KM = 5, RING_DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  /* Outside MET's radar: the best model's 15-minute precipitation for the next 2.5 hours (Open-Meteo), as the same series shape, flagged model */
  async function nowcastModel(la, lo) {
    const key = `ncm:${la}:${lo}`;
    const c = await cacheGet(key); if (c) return c;
    let j;
    try { j = await getJson('https://api.open-meteo.com/v1/forecast?' + qs({ latitude: la, longitude: lo, minutely_15: 'precipitation', forecast_minutely_15: 10, timezone: 'auto', models: 'best_match' })); } catch (e) { return null; }
    const m = j && j.minutely_15; if (!m || !m.time) return null;
    const offset = +(j.utc_offset_seconds || 0);
    const series = m.time.map((s, i) => ({ t: localToUnix(s, offset), rate: m.precipitation[i] == null ? null : +(m.precipitation[i] * 4).toFixed(2) })).filter((p) => p.rate != null);
    if (!series.length) return null;
    const data = { series, ring: [], km: 0, model: true, fetched: now() };
    await cachePut(key, data, 15 * 60);
    return data;
  }
  async function fetchNowcast(lat, lon) {
    const la = +lat.toFixed(2), lo = +lon.toFixed(2), key = `nc2:${la}:${lo}`;
    const c = await cacheGet(key); if (c) return c;
    const series = await nowcastPoint(la, lo);
    if (!series) return nowcastModel(la, lo);
    let ring = [];
    if (series.length) {   // inside radar coverage: ask the neighbours too (in parallel; a failed neighbour is simply left out)
      const dLat = NOWCAST_RING_KM / 111.2, dLon = dLat / Math.max(0.2, Math.cos((la * Math.PI) / 180));
      const pts = RING_DIRS.map((dir, k) => { const a = (k * Math.PI) / 4; return { dir, la: +(la + dLat * Math.cos(a)).toFixed(3), lo: +(lo + dLon * Math.sin(a)).toFixed(3) }; });
      const got = await Promise.all(pts.map((p) => nowcastPoint(p.la, p.lo)));
      ring = pts.map((p, k) => ({ dir: p.dir, series: got[k] })).filter((r) => r.series && r.series.length);
    }
    const data = { series, ring, km: NOWCAST_RING_KM, fetched: now() };
    await cachePut(key, data, NOWCAST_TTL);
    return data;
  }

  /* ================= "Measured nearby right now" (public Netatmo stations, via api/netatmo.php; cached 10 min) ================= */
  async function fetchLocal(lat, lon) {
    const la = +lat.toFixed(2), lo = +lon.toFixed(2), key = `nl:${la}:${lo}`;
    const c = await cacheGet(key); if (c) return c;
    let j;
    try { j = await getJson(`api/netatmo.php?lat=${la}&lon=${lo}`); } catch (e) { return null; }   // not configured / hiccup: no line at all
    if (!j || !j.ok) { const few = { ok: false, stations: (j && j.stations) || 0 }; await cachePut(key, few, 300); return few; }
    await cachePut(key, j, 540);
    return j;
  }

  /* ================= LOCAL MAP: radar frames, MET warnings, snow line, elevation grid ================= */
  // RainViewer radar composite (free, attribution required): the list of the last ~2 hours of frames, 10-minute steps; cached 4 minutes
  async function fetchRadarFrames() {
    const key = 'rv:frames';
    const c = await cacheGet(key); if (c) return c;
    let j;
    try { j = await getJson('https://api.rainviewer.com/public/weather-maps.json', true); } catch (e) { return null; }
    const past = (j && j.radar && j.radar.past) || [];
    if (!j || !j.host || !past.length) return null;
    const data = { host: j.host, frames: past.map((f) => ({ t: +f.time, path: f.path })), nowcast: ((j.radar && j.radar.nowcast) || []).map((f) => ({ t: +f.time, path: f.path })), generated: +j.generated || now(), fetched: now() };
    await cachePut(key, data, 240);
    return data;
  }

  const ALERTS_TTL = 600;
  async function fetchAlerts(lang) {   // MET Norway MetAlerts through api/alerts.php (site-wide 10-minute cache there); null when unavailable
    const key = `alerts:${lang}`;
    const c = await cacheGet(key); if (c) return c;
    let j;
    try { j = await getJson(`api/alerts.php?lang=${lang === 'en' ? 'en' : 'nb'}`); } catch (e) { return null; }
    if (!j || !Array.isArray(j.alerts)) return null;
    await cachePut(key, j, ALERTS_TTL);
    return j;
  }

  // Freezing level per model for the next 3 days: one small opt-in request (5 models x 2 variables), cached an hour per 0.01° cell
  const SNOW_MODELS = ['ecmwf_ifs025', 'icon_seamless', 'metno_seamless', 'gfs_seamless', 'ukmo_seamless'];
  async function fetchSnowline(lat, lon) {
    const la = +lat.toFixed(2), lo = +lon.toFixed(2), key = `snow:${la}:${lo}`;
    const c = await cacheGet(key); if (c) return c;
    const j = await getJson('https://api.open-meteo.com/v1/forecast?' + qs({ latitude: la, longitude: lo, hourly: 'freezing_level_height,precipitation', models: SNOW_MODELS.join(','), timezone: 'auto', forecast_days: 3 }));
    if (!j || !j.hourly || !j.hourly.time) throw new DataError(t('err.upstream', { host: 'api.open-meteo.com', s: '' }));
    const time = j.hourly.time, offset = +(j.utc_offset_seconds || 0), models = [];
    for (const id of SNOW_MODELS) {
      const fl = j.hourly[`freezing_level_height_${id}`], pr = j.hourly[`precipitation_${id}`];
      if (fl && fl.some((x) => x != null)) models.push({ id, fl, pr: pr || Array(time.length).fill(null) });
    }
    const data = { time, offset, models, fetched: now() };
    await cachePut(key, data, 3600);
    return data;
  }

  // Terrain around the place: a 20 x 20 grid (about ±13 km) from the Open-Meteo elevation API (Copernicus DEM, 90 m), 100 points per
  // request = 4 small requests, stored for good per 0.05° cell (terrain does not change)
  const ELEV_N = 20, ELEV_HALF_KM = 13;
  async function fetchElevGrid(lat, lon) {
    const la = Math.round(lat * 20) / 20, lo = Math.round(lon * 20) / 20, key = `elev:${la}:${lo}`;
    const c = await cacheGet(key); if (c) return c;
    const dLat = ELEV_HALF_KM / 111.2, dLon = dLat / Math.max(0.2, Math.cos((la * Math.PI) / 180));
    const south = la - dLat, north = la + dLat, west = lo - dLon, east = lo + dLon;
    const lats = [], lons = [];
    for (let i = 0; i < ELEV_N; i++) for (let k = 0; k < ELEV_N; k++) { lats.push(+(south + ((north - south) * i) / (ELEV_N - 1)).toFixed(4)); lons.push(+(west + ((east - west) * k) / (ELEV_N - 1)).toFixed(4)); }
    const elev = [];
    for (let i = 0; i < lats.length; i += 100) {
      const j = await getJson(`https://api.open-meteo.com/v1/elevation?latitude=${lats.slice(i, i + 100).join(',')}&longitude=${lons.slice(i, i + 100).join(',')}`);
      if (!j || !Array.isArray(j.elevation)) throw new DataError(t('err.upstream', { host: 'api.open-meteo.com', s: '' }));
      elev.push(...j.elevation.map((v) => (v == null ? 0 : +v)));
    }
    const data = { n: ELEV_N, south, north, west, east, elev, min: Math.min(...elev), max: Math.max(...elev) };
    await cachePut(key, data, 10 * 365 * 86400);
    return data;
  }

  /* Station cells for one map area (the temperature map as it is panned): api/netatmo.php?map=1, cached 9 minutes */
  async function fetchLocalMap(lat, lon, r = 0.25) {
    const la = +lat.toFixed(2), lo = +lon.toFixed(2), key = `nlm3:${r}:${la}:${lo}`;
    const c = await cacheGet(key); if (c) return c;
    let j;
    try { j = await getJson(`api/netatmo.php?map=1&r=${r}&lat=${la}&lon=${lo}`); } catch (e) { return null; }
    const arr = (k) => (j && Array.isArray(j[k]) ? j[k] : []);
    const data = { pts: arr('pts'), rain: arr('rain_pts'), wind: arr('wind_pts') };
    await cachePut(key, data, 540);
    return data;
  }

  setTimeout(cacheSweep, 4000);
  return { historySince, fetchForecast, fetchVerify, fetchHistory, fetchNowcast, fetchLocal, fetchLocalMap, fetchRadarFrames, fetchAlerts, fetchSnowline, fetchElevGrid, locations, search, reverse, DataError, FORECAST_TTL, VERIFY_TTL, REFRESH_MIN_INTERVAL };
})();
