'use strict';

/* ================= Helpers ================= */
const $ = (id) => document.getElementById(id);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const nn = (arr) => arr.filter((x) => x != null && !Number.isNaN(x));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const fmt = (v, d = 0) => (v == null ? '–' : Number(v).toFixed(d).replace(/^-0$/, '0'));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k, d = null) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
const lsJson = (k, d) => { try { const v = JSON.parse(lsGet(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } };

/* Predefined places: the five largest cities plus Tromsø for the north */
const CITIES = [
  { id: 'city:oslo', name: 'Oslo', lat: 59.9139, lon: 10.7522 },
  { id: 'city:bergen', name: 'Bergen', lat: 60.3913, lon: 5.3221 },
  { id: 'city:trondheim', name: 'Trondheim', lat: 63.4305, lon: 10.3951 },
  { id: 'city:stavanger', name: 'Stavanger', lat: 58.9700, lon: 5.7331 },
  { id: 'city:tromso', name: 'Tromsø', lat: 69.6492, lon: 18.9553 },
];
const RECENT_MAX = 5;
const placeKey = (p) => `${(+p.lat).toFixed(3)},${(+p.lon).toFixed(3)}`;

const state = { exLarge: lsGet('glett.ex_large') === '1', locations: [], recent: lsJson('glett.recent', []), current: null, data: null, verify: null, nowcast: null, weighted: true, day: 0, step: 1, param: 'weather', token: 0, modelsOpen: null };
state.weighted = lsGet('glett.weighted') !== '0';
const AUTO_REFRESH_MS = 30 * 60 * 1000;   // a forecast older than this is fetched again (on load, and when the app comes back)
state.disabled = new Set(lsJson('glett.disabled', []));   // models switched off by this browser's user
state.windUnit = lsGet('glett.wind') || 'ms';   // m/s unless the visitor picked km/h in the settings popover
/* Local map (now card): layer choice and per-place data; the drawing code sits at the end of this file */
const LM_LAYERS = ['obs', 'rain', 'wind', 'snow', 'alerts'];
const RING_DIRS8 = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const SNOW_OFFSET_M = 200;   // precipitation turns to snow roughly 200 m below the 0 °C level
const LEVEL_RANK = { red: 3, orange: 2, yellow: 1, green: 0 };
const fmt1 = (v) => Number(v).toLocaleString(dateLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const lm = { open: false, map: null, groups: {}, center: null, radarIdx: -1, snowIdx: 0, snowMax: 0, snow: null, elev: null, snowErr: null, snowKey: null, alertsHere: [],
  layers: new Set((lsGet('glett.lmap.layers') || 'obs').split(',').filter((x) => LM_LAYERS.includes(x) && x !== 'snow')) };   // the snow line is never on by default: it costs requests and is a per-visit choice
state.alerts = null;
const WARN_ICON = '<svg class="warn" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5"/><path d="M12 18v.5"/></svg>';
state.orient = lsGet('glett.orient2') || 'v';   // v = time runs downwards: the default everywhere (new key, so everyone starts there once); h = sideways, m = meteogram
const uniqueProviders = () => state.data.providers.filter((p) => !p.dupOf);   // identical series (a model outside its area) count once
const MODEL_NAMES = {
  ecmwf_aifs025_single: 'ECMWF AIFS (AI)', ecmwf_ifs025: 'ECMWF IFS', gfs_seamless: 'NOAA GFS', icon_seamless: 'DWD ICON', gem_seamless: 'Environment Canada GEM',
  meteofrance_seamless: 'Météo-France', ukmo_seamless: 'UK Met Office', jma_seamless: 'JMA (Japan)', cma_grapes_global: 'CMA GRAPES (China)',
  bom_access_global: 'BOM ACCESS (Australia)', knmi_seamless: 'KNMI (Netherlands)', dmi_seamless: 'DMI (Denmark)', metno_seamless: 'MET Norway (Nordic)', yr: 'MET Norway / Yr',
};
const nameById = (id) => (hasT('mn.' + id) ? t('mn.' + id) : MODEL_NAMES[id] || id);
const pname = (p) => nameById(p.id);
const activeProviders = () => {
  const all = uniqueProviders(), act = all.filter((p) => !state.disabled.has(p.id));
  return act.length ? act : all;   // never an empty set
};

/* Apparent ("feels like") temperature from temperature (°C), wind (km/h) and relative humidity (%): Steadman's formula,
   the same family Open-Meteo uses for its apparent_temperature (without the radiation term) */
function feelsLike(tC, windKmh, rh) {
  if (tC == null) return null;
  const ws = (windKmh || 0) / 3.6, e = ((rh ?? 60) / 100) * 6.105 * Math.exp((17.27 * tC) / (237.7 + tC));
  return tC + 0.33 * e - 0.7 * ws - 4.0;
}

/* Wind units: data is km/h, Norwegians read m/s */
const windMs = () => state.windUnit === 'ms';
const wv = (kmh) => (kmh == null ? null : windMs() ? kmh / 3.6 : kmh);
const wu = () => t(windMs() ? 'u.ms' : 'u.kmh');

/* ================= Data preparation ================= */
function deriveCode(p, i) {
  const h = p.hourly, pr = h.precipitation[i], tt = h.temperature_2m[i], c = h.cloud_cover[i], cape = h.cape[i];
  if (pr != null && pr >= 0.1) {
    if (cape != null && cape >= 1500 && pr >= 1) return 95;
    if (tt != null && tt <= 0.5) return 73;
    return pr >= 4 ? 65 : pr >= 0.3 ? 61 : 51;
  }
  if (c == null) return null;
  return c < 20 ? 0 : c < 45 ? 1 : c < 75 ? 2 : 3;
}

function prepare(data) {
  const n = data.time.length;
  data.providers.forEach((p) => {
    p.hourly.code = p.hourly.weather_code.map((c, i) => (c != null ? c : deriveCode(p, i)));
  });
  const seen = new Map();
  data.providers.forEach((p) => {
    const sig = ['temperature_2m', 'precipitation', 'wind_speed_10m', 'pressure_msl'].map((k) => p.hourly[k].join(',')).join('|');
    if (seen.has(sig)) p.dupOf = seen.get(sig); else seen.set(sig, p.id);
  });
  data.isDay = Array.from({ length: n }, (_, i) => {
    for (const p of data.providers) if (p.hourly.is_day[i] != null) return p.hourly.is_day[i];
    const hr = +data.time[i].slice(11, 13);
    return hr >= 7 && hr < 20 ? 1 : 0;
  });
  data.dates = [...new Set(data.time.map((s) => s.slice(0, 10)))];
  return data;
}

/* Aggregate one provider over one step (hours a..b) */
function circMean(dirs, weights) {
  let x = 0, y = 0;
  dirs.forEach((d, i) => { const w = weights[i] || 1; x += Math.cos(d * Math.PI / 180) * w; y += Math.sin(d * Math.PI / 180) * w; });
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function agg(p, param, a, b) {
  aggLastA = a;   // remembered for the short-range weighting below
  const h = p.hourly, sl = (arr) => nn(arr.slice(a, b));
  switch (param) {
    case 'precip': { const v = sl(h.precipitation); return v.length ? v.reduce((s, x) => s + x, 0) : null; }
    case 'gust': { const v = sl(h.wind_gusts_10m); return v.length ? Math.max(...v) : null; }
    case 'cape': { const v = sl(h.cape); return v.length ? Math.max(...v) : null; }
    case 'code': { const v = sl(h.code); return v.length ? Math.max(...v) : null; }
    case 'dir': {
      const idx = []; for (let i = a; i < b; i++) if (h.wind_direction_10m[i] != null) idx.push(i);
      return idx.length ? circMean(idx.map((i) => h.wind_direction_10m[i]), idx.map((i) => h.wind_speed_10m[i] || 1)) : null;
    }
    default: { const v = sl(h[param]); return mean(v); }
  }
}

/* ================= Colours ================= */
const heat = (x, h1, h2, alpha = 0.3) => `hsla(${h1 + (h2 - h1) * clamp(x)},78%,52%,${alpha})`;
const bgTemp = (v) => (v == null ? '' : heat((v + 5) / 45, 220, 0));
const bgWind = (v) => (v == null ? '' : heat(v / 60, 170, 10));
const bgCloud = (v) => (v == null ? '' : `hsla(215,18%,55%,${0.04 + clamp(v / 100) * 0.34})`);
const bgHum = (v) => (v == null ? '' : `hsla(200,80%,50%,${0.03 + clamp(v / 100) * 0.3})`);
const bgPress = (v) => (v == null ? '' : heat((v - 990) / 50, 260, 120, 0.2));
const bgRain = (v, step) => (v == null || v < 0.05 ? '' : `hsla(215,85%,50%,${0.12 + clamp(v / (step * 2.5)) * 0.5})`);

/* ================= Parameters ================= */
const TOL = { temperature_2m: 4, wind_speed_10m: 15, cloud_cover: 50, relative_humidity_2m: 25, pressure_msl: 4 };   // sd at which agreement = 0
const RAIN_THR = 0.2;   // mm per step to count as "rain"
const WIND_THR = 30;    // km/h (Beaufort 5)
const GUST_THR = 60;    // km/h
const STRONG_GUST = 43; // km/h (~12 m/s): gusts below this are not worth a summary line

const PARAMS = {
  weather: {  },
  temperature_2m: { unit: '°C', d: 1, bg: bgTemp },
  precip: {  },
  wind: {  },
  storm: {  },
  cloud_cover: { unit: '%', d: 0, bg: bgCloud },
  relative_humidity_2m: { unit: '%', d: 0, bg: bgHum },
  pressure_msl: { unit: ' hPa', d: 0, bg: bgPress },
  reliability: {  },
};

const agreementPill = (vals, tol) => {
  if (vals.length < 2) return '<span class="na">–</span>';
  const m = mean(vals), sd = Math.sqrt(mean(vals.map((x) => (x - m) ** 2)));
  const a = Math.round(clamp(1 - sd / tol) * 100);
  return `<span class="pill ${a >= 75 ? 'hi' : a >= 50 ? 'mid' : 'lo'}">${a}%</span>`;
};

/* ================= Table ================= */
/* Columns for the whole week (one continuous strip), or for one day when `day` is given */
function columns(step = state.step, day = null) {
  const { data } = state, cols = [];
  const nowStr = new Date(Date.now() + data.utc_offset_seconds * 1000).toISOString().slice(0, 13);
  for (let d = 0; d < data.dates.length; d++) {
    if (day != null && d !== day) continue;
    const base = d * 24;
    for (let s = 0; s < 24; s += step) {
      const a = base + s, b = Math.min(base + s + step, data.time.length);
      if (a >= data.time.length) break;
      const last = data.time[b - 1].slice(0, 13);
      cols.push({
        a, b, day: d, first: s === 0,
        label: step > 1 ? `${data.time[a].slice(11, 13)}–${String((+data.time[a].slice(11, 13) + step) % 24).padStart(2, '0')}` : data.time[a].slice(11, 16),
        hour: +data.time[a].slice(11, 13),
        past: last < nowStr,
        now: data.time[a].slice(0, 13) <= nowStr && nowStr <= last,
        night: data.isDay[Math.min(a + Math.floor(step / 2), b - 1)] === 0,
      });
    }
  }
  return cols;
}
const todayIndex = () => { const local = new Date(Date.now() + state.data.utc_offset_seconds * 1000).toISOString().slice(0, 10); const i = state.data.dates.indexOf(local); return i < 0 ? 0 : i; };
const dayName = (d) => { const dt = new Date(state.data.dates[d] + 'T12:00:00'), ti = todayIndex(); return d === ti ? t('today') : d === ti + 1 ? t('tomorrow') : dt.toLocaleDateString(dateLocale(), { weekday: 'short' }); };
const dayLabel = (d) => `${dayName(d)} ${new Date(state.data.dates[d] + 'T12:00:00').toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })}`;

const cell = (html, bg = '', cls = '') => ({ html, bg, cls });

/* Reliability weighting: each provider has a weight per parameter (1 = neutral) */
const weightsOn = () => state.weighted && !!state.verify;
const W = (p, key) => (weightsOn() && state.verify.models[p.id]?.weights?.[key]) || 1;
/* PROVISIONAL (2026-09-29, pending the Norway back-test): MET's observation-corrected short-range forecasts (MET Nordic and Yr)
   get up to twice their weight for the current hour, fading back to normal over the next 6 hours. Past hours are not affected. */
const SHORT_BOOST_HOURS = 6, SHORT_BOOST_MAX = 1.0, SHORT_BOOST_IDS = new Set(['metno_seamless', 'yr']);
let aggLastA = null;
const nowIdx = () => { if (!state.data) return -1; if (state._nowKey !== state.data.generated + (Date.now() / 3600e3 | 0)) { const s = new Date(Date.now() + state.data.utc_offset_seconds * 1000).toISOString().slice(0, 13); state._nowIdx = state.data.time.findIndex((x) => x.startsWith(s)); state._nowKey = state.data.generated + (Date.now() / 3600e3 | 0); } return state._nowIdx; };
function shortBoost(p, a) {
  if (!SHORT_BOOST_IDS.has(p.id) || a == null) return 1;
  const n = nowIdx(); if (n < 0) return 1;
  const h = a - n; if (h < 0 || h >= SHORT_BOOST_HOURS) return 1;
  return 1 + SHORT_BOOST_MAX * (1 - h / SHORT_BOOST_HOURS);
}
const wpairs = (key, fn) => activeProviders().map((p) => { aggLastA = null; const v = fn(p); return { v, w: W(p, key) * shortBoost(p, aggLastA) }; }).filter((x) => x.v != null && !Number.isNaN(x.v));
const wsum = (pr) => pr.reduce((a, x) => a + x.w, 0);
const wmean = (pr) => (pr.length ? pr.reduce((a, x) => a + x.v * x.w, 0) / wsum(pr) : null);
const wshare = (pr, f) => (pr.length ? pr.filter((x) => f(x.v)).reduce((a, x) => a + x.w, 0) / wsum(pr) : null);

/* Weighted shares of the weather categories over one step */
function weatherShares(c) {
  const pr = wpairs('weather', (p) => { const code = agg(p, 'code', c.a, c.b); return code == null ? null : WI.category(code); });
  if (!pr.length) return null;
  const tot = wsum(pr), cnt = {}; pr.forEach((x) => (cnt[x.v] = (cnt[x.v] || 0) + x.w));
  return Object.entries(cnt).map(([k, w]) => [k, w / tot]).sort((x, y) => y[1] - x[1]);
}
const rainChance = (c) => wshare(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b)), (x) => x >= RAIN_THR);
/* Radar nowcast (MET, 5-minute precipitation rate for the next ~2 h) mapped onto a table column */
const colUnix = (c) => { const s = state.data.time[c.a]; return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13)) / 1000 - state.data.utc_offset_seconds; };
function radarForCol(c) {
  const nc = state.nowcast && !state.nowcast.model && state.nowcast.series; if (!nc || !nc.length) return null;   // badges say 'radar': measured only
  const t0 = colUnix(c), t1 = t0 + (c.b - c.a) * 3600, pts = nc.filter((p) => p.t >= t0 && p.t < t1);
  if (pts.length < 4) return null;   // less than 20 minutes of the step covered by radar: say nothing
  return { mm: pts.reduce((s, p) => s + p.rate * 5 / 60, 0), cover: pts.length * 5 / 60 / ((c.b - c.a)) };
}
/* Badge when the radar disagrees with the models for this step (radar sees rain the models miss, or the reverse) */
function radarBadge(c) {
  const r = radarForCol(c); if (!r) return '';
  const chance = rainChance(c);
  if (r.mm >= 0.2 && (chance == null || chance < 0.35)) return `<span class="radar wet" title="${t('radar.src')}">${t('radar.badge.rain', { mm: r.mm.toLocaleString(dateLocale(), { maximumFractionDigits: 1 }) })}</span>`;
  if (r.mm < 0.05 && chance != null && chance >= 0.6 && r.cover >= 0.75) return `<span class="radar dry" title="${t('radar.src')}">${t('radar.badge.dry')}</span>`;
  return '';
}
/* Segmented bar: how the models split by weather type for one step */
const canHover = window.matchMedia('(hover: hover)');   // touch-only devices get no hover readouts (WebKit synthesises stray mouse moves after a tap)
const segBar = (shares) => shares ? `<div class="segbar" role="img" data-shares="${shares.map(([k, sh]) => `${k}:${Math.round(sh * 100)}`).join(',')}" aria-label="${shares.map(([k, sh]) => `${t('cat.' + k)} ${Math.round(sh * 100)}%`).join(', ')}">${shares.map(([k, sh]) => `<i class="c-${k}" data-k="${k}" style="width:${(sh * 100).toFixed(1)}%"></i>`).join('')}</div>` : '';
/* Explain an agreement bar where it is: hover (mouse) or tap shows every weather type with its colour and share */
const segTip = document.createElement('div'); segTip.className = 'segtip'; segTip.hidden = true; document.body.appendChild(segTip);
function showSegTip(bar, k, x, y) {
  const parts = bar.dataset.shares.split(',').map((p) => p.split(':'));
  segTip.innerHTML = `<div class="st-h">${t('seg.tip')}</div>` + parts.map(([c, v]) => `<div class="st-r${c === k ? ' on' : ''}"><i class="c-${c}"></i><span>${t('cat.' + c)}</span><b>${v} %</b></div>`).join('');
  segTip.hidden = false;
  const w = segTip.offsetWidth, h = segTip.offsetHeight;
  segTip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))}px`;
  segTip.style.top = `${y + 18 + h > window.innerHeight ? y - h - 12 : y + 18}px`;
}
const hideSegTip = () => { segTip.hidden = true; };
document.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !canHover.matches) return;
  const i = e.target.closest && e.target.closest('.segbar i');
  if (i) showSegTip(i.parentElement, i.dataset.k, e.clientX, e.clientY); else if (!segTip.hidden) hideSegTip();
}, { passive: true });
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') { if (!(e.target.closest && e.target.closest('.segbar'))) hideSegTip(); return; }
  // touch: the whole weather area of an hour (names, shares and the bar) opens the same tooltip, nothing highlighted
  const area = e.target.closest && (e.target.closest('td.prob .wlist') || e.target.closest('tr.lane.agree td') || e.target.closest('.segbar'));
  const bar = area && (area.classList.contains('segbar') ? area : area.querySelector('.segbar'));
  if (bar) { const r = area.getBoundingClientRect(); showSegTip(bar, null, r.left + r.width / 2, r.bottom - 10); } else hideSegTip();
}, { passive: true });
window.addEventListener('scroll', () => { if (!segTip.hidden) hideSegTip(); }, { passive: true });
const gustMean = (c) => wmean(wpairs('wind', (p) => agg(p, 'gust', c.a, c.b)));

// The flagship single-model AI forecast (ECMWF AIFS) gets its own row, tagged AI, instead of mixing with the other models
const HEADLINE_MODEL_IDS = ['ecmwf_aifs025_single'];

function buildRows(param, cols) {
  const { step } = state;
  const P = activeProviders();
  const rows = [];
  let summary, prob, summaryLabel, probLabel, rainCol = null, lanes = null;
  const radarOK = !orientV();   // the vertical list stays calm: no radar pills there
  const perProvider = (fn, list = P) => list.map((p) => ({ name: pname(p), id: p.id, cells: cols.map((c) => fn(p, c)) })).filter((r) => r.cells.some((c) => c.has));
  let extraRows;

  if (param === 'weather') {
    const weatherCell = (p, c) => {
      const code = agg(p, 'code', c.a, c.b), tt = agg(p, 'temperature_2m', c.a, c.b), ws = agg(p, 'wind_speed_10m', c.a, c.b), wd = agg(p, 'dir', c.a, c.b);
      const wind = ws == null ? '' : ` <span class="wnd">${wd != null ? WI.arrow(wd) : ''}${fmt(wv(ws))}</span>`;
      return { has: code != null, html: code == null ? '<span class="na">–</span>' : `${WI.svg(code, c.night, '', colUnix(c) * 1000)}<small>${fmt(tt)}°${wind}</small>`, cls: 'cell' };
    };
    rows.push(...perProvider(weatherCell, P.filter((p) => !HEADLINE_MODEL_IDS.includes(p.id))));
    summaryLabel = t('g.twr');   // vertical list only (the strip uses the lanes below): temperature, wind and rain in one column
    summary = cols.map((c) => {
      const m = wmean(wpairs('temperature_2m', (p) => agg(p, 'temperature_2m', c.a, c.b)));
      const ws = wmean(wpairs('wind', (p) => agg(p, 'wind_speed_10m', c.a, c.b))), g = gustMean(c);
      const dd = nn(P.map((p) => agg(p, 'dir', c.a, c.b)));
      const wind = ws == null ? '' : `<small class="wnd">${dd.length ? WI.arrow(circMean(dd, dd.map(() => 1))) : ''}${fmt(wv(ws))}${g != null ? ` (${fmt(wv(g))})` : ''} ${wu()}</small>`;
      const pr = rainChance(c), mm = wmean(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b)));
      const rain = pr == null ? '' : `<small class="rn ${Math.round(pr * 100) === 0 ? 'dim' : ''}">${Math.round(pr * 100)}&nbsp;%${mm != null && mm >= 0.05 ? ` · ${fmt(mm, 1)}&nbsp;mm` : ''}</small>`;
      return cell(`<b>${fmt(m)}°</b>${wind}${rain}`);   // no heat tint here: in the Vær tab the colour explained nothing
    });
    probLabel = `${t('g.prob_weather')}<small class="hint2">${t('g.prob_weather.hint')}</small>`;
    prob = cols.map((c) => {
      const sorted = weatherShares(c);
      if (!sorted) return cell('–');
      const top = sorted[0][0];
      const lines = sorted.slice(0, 4).map(([k, sh], i) => `<div class="wline${i === 0 ? ' top' : ''}">${WI.svg(WI.CAT_CODE[k], c.night, 'mini', colUnix(c) * 1000)}<span>${t('cat.' + k)}</span><b>${Math.round(sh * 100)}%${i === 0 ? ` <em>${t('g.agree_short')}</em>` : ''}</b></div>`).join('');
      return cell(`${WI.svg(WI.CAT_CODE[top], c.night, 'big', colUnix(c) * 1000)}<div class="wlist">${lines}${segBar(sorted)}${radarOK ? radarBadge(c) : ''}</div>`);
    });
    extraRows = perProvider(weatherCell, HEADLINE_MODEL_IDS.map((id) => P.find((p) => p.id === id)).filter(Boolean));
    // Rain column for the vertical list, and the five lanes of the horizontal strip (weather, agreement, temperature, rain, wind)
    const rainCell = (c) => {
      const pr = rainChance(c), m = wmean(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b)));
      if (pr == null) return cell('–');
      const pct = Math.round(pr * 100);
      return cell(`<div class="pct ${pct === 0 ? 'dim' : ''}">${pct}&nbsp;%</div>${m != null && m >= 0.05 ? `<small>${fmt(m, 1)} mm</small>` : ''}${radarOK ? radarBadge(c) : ''}`, '', pct === 0 ? 'dim' : '');
    };
    rainCol = cols.map(rainCell);
    lanes = [
      { label: t('ln.weather'), cls: 'wx', cells: cols.map((c) => { const sh = weatherShares(c); return sh ? cell(WI.svg(WI.CAT_CODE[sh[0][0]], c.night, 'big', colUnix(c) * 1000)) : cell('–'); }) },
      { label: t('ln.agree'), cls: 'agree', cells: cols.map((c) => { const sh = weatherShares(c); if (!sh) return cell('–'); const p = Math.round(sh[0][1] * 100); return cell(`<span class="agr ${p >= 70 ? 'hi' : ''}">${p}&nbsp;%</span>${segBar(sh)}`); }) },
      { label: t('ln.temp'), cls: 'temp', cells: cols.map((c) => { const m = wmean(wpairs('temperature_2m', (p) => agg(p, 'temperature_2m', c.a, c.b))); return cell(`<b>${fmt(m)}°</b>`); }) },
      { label: t('ln.rain'), cls: 'rain', cells: rainCol },
      { label: t('ln.wind', { u: wu() }), cls: 'wind', cells: cols.map((c) => { const ws = wmean(wpairs('wind', (p) => agg(p, 'wind_speed_10m', c.a, c.b))), g = gustMean(c), dd = nn(P.map((p) => agg(p, 'dir', c.a, c.b))); return ws == null ? cell('–') : cell(`${dd.length ? WI.arrow(circMean(dd, dd.map(() => 1))) : ''}${fmt(wv(ws))}${g != null ? `<small>${t('ln.gust')} ${fmt(wv(g))}</small>` : ''}`); }) },
    ];
  } else if (param === 'precip') {
    rows.push(...perProvider((p, c) => {
      const v = agg(p, 'precip', c.a, c.b);
      return { has: v != null, html: v == null ? '<span class="na">–</span>' : v < 0.05 ? '<span class="na">0</span>' : fmt(v, 1), bg: bgRain(v, step), cls: 'cell' };
    }));
    summaryLabel = t('g.avg_mm');
    summary = cols.map((c) => {
      const v = nn(P.map((p) => agg(p, 'precip', c.a, c.b)));
      const m = wmean(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b)));
      return cell(v.length ? `<b>${fmt(m, 1)}<span class="un">${t(step === 1 ? 'u.mmh' : 'u.mm')}</span></b><small>${t('g.upto', { v: fmt(Math.max(...v), 1) + ' mm' })}</small>` : '–', bgRain(m, step));
    });
    probLabel = t('g.prob_rain');
    prob = cols.map((c) => {
      const pr = rainChance(c);
      if (pr == null) return cell('–');
      return cell(`<div class="pct">${Math.round(pr * 100)}%</div>${radarOK ? radarBadge(c) : ''}`, `hsla(215,85%,50%,${pr * 0.55})`);
    });
  } else if (param === 'wind') {
    rows.push(...perProvider((p, c) => {
      const s = agg(p, 'wind_speed_10m', c.a, c.b), g = agg(p, 'gust', c.a, c.b), d = agg(p, 'dir', c.a, c.b);
      return { has: s != null, html: s == null ? '<span class="na">–</span>' : `${d != null ? WI.arrow(d) : ''}${fmt(wv(s))}${g != null ? `<small>(${fmt(wv(g))})</small>` : ''}`, bg: bgWind(s), cls: 'cell' };
    }));
    summaryLabel = t('g.avg_kmh', { u: wu() });
    summary = cols.map((c) => {
      const v = nn(P.map((p) => agg(p, 'wind_speed_10m', c.a, c.b)));
      const dd = nn(P.map((p) => agg(p, 'dir', c.a, c.b)));
      const m = wmean(wpairs('wind', (p) => agg(p, 'wind_speed_10m', c.a, c.b)));
      return cell(v.length ? `<b>${dd.length ? WI.arrow(circMean(dd, dd.map(() => 1))) : ''}${fmt(wv(m))}<span class="un"> ${wu()}</span></b><small>${fmt(wv(Math.min(...v)))}–${fmt(wv(Math.max(...v)))} ${wu()}</small>` : '–', bgWind(m));
    });
    probLabel = t('g.prob_wind', { v: fmt(wv(WIND_THR)), u: wu() });
    prob = cols.map((c) => {
      const v = nn(P.map((p) => agg(p, 'wind_speed_10m', c.a, c.b)));
      if (!v.length) return cell('–');
      const pr = wshare(wpairs('wind', (p) => agg(p, 'wind_speed_10m', c.a, c.b)), (x) => x >= WIND_THR);
      const g = nn(P.map((p) => agg(p, 'gust', c.a, c.b)));
      const gp = g.length ? `<small>${t('g.gusts', { g: fmt(wv(GUST_THR)), v: Math.round(g.filter((x) => x >= GUST_THR).length / g.length * 100) })}</small>` : '';
      return cell(`<div class="pct">${Math.round(pr * 100)}%</div>${gp}`, `hsla(170,70%,40%,${pr * 0.5})`);
    });
  } else if (param === 'storm') {
    const signal = (p, c) => {
      const code = agg(p, 'code', c.a, c.b), cape = agg(p, 'cape', c.a, c.b);
      const raw = p.hourly.weather_code.slice(c.a, c.b).some((x) => x != null);
      const thunder = raw ? code >= 95 : null;
      if (thunder == null && cape == null) return { s: null, cape };
      return { s: thunder ? 1 : cape != null && cape >= 1000 ? 0.5 : 0, cape };
    };
    rows.push(...perProvider((p, c) => {
      const { s, cape } = signal(p, c);
      const html = s == null ? '<span class="na">–</span>' : `${s === 1 ? WI.bolt24 + ' ' : ''}${cape != null ? fmt(cape) : ''}<small>${s === 1 ? t('g.storm_yes') : s === 0.5 ? t('g.storm_maybe') : cape != null ? 'J/kg' : t('g.storm_no')}</small>`;
      return { has: s != null, html, bg: s ? `hsla(35,95%,50%,${0.15 + s * 0.4})` : '', cls: 'cell' };
    }));
    summaryLabel = t('g.cape_avg');
    summary = cols.map((c) => {
      const v = nn(P.map((p) => agg(p, 'cape', c.a, c.b)));
      return cell(v.length ? `<b>${fmt(mean(v))}</b>` : '–');
    });
    probLabel = t('g.prob_storm');
    prob = cols.map((c) => {
      const pw = wpairs('storm', (p) => signal(p, c).s);
      if (!pw.length) return cell('–');
      const pr = wmean(pw);
      return cell(`${pr >= 0.5 ? WI.bolt24 + ' ' : ''}<div class="pct" style="display:inline">${Math.round(pr * 100)}%</div>`, `hsla(35,95%,50%,${pr * 0.6})`);
    });
  } else {
    const def = PARAMS[param];
    rows.push(...perProvider((p, c) => {
      const v = agg(p, param, c.a, c.b);
      return { has: v != null, html: v == null ? '<span class="na">–</span>' : fmt(v, def.d) + (def.unit === '°C' ? '°' : ''), bg: def.bg(v), cls: 'cell' };
    }));
    summaryLabel = def.unit === '%' ? t('g.avg_pct') : def.unit === '°C' ? t('g.avg_c') : t('g.avg_hpa');
    summary = cols.map((c) => {
      const v = nn(P.map((p) => agg(p, param, c.a, c.b)));
      const m = wmean(wpairs(param, (p) => agg(p, param, c.a, c.b)));
      const u = def.unit === '°C' ? '°' : def.unit;
      return cell(v.length ? `<b>${fmt(m, def.d)}<span class="un">${u}</span></b><small>${fmt(Math.min(...v), def.d)}–${fmt(Math.max(...v), def.d)}${u}</small>` : '–', def.bg(m));
    });
    probLabel = t('g.agree');
    prob = cols.map((c) => {
      const v = nn(P.map((p) => agg(p, param, c.a, c.b)));
      const sd = v.length > 1 ? Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2))) : 0;
      return cell(`${agreementPill(v, TOL[param])}${param === 'temperature_2m' && v.length > 1 ? `<small>±${fmt(sd, 1)}°</small>` : ''}`);
    });
  }
  return { rows, summary, prob, summaryLabel, probLabel, extraRows, rainCol, lanes };
}

/* Centre the current hour horizontally when the table scrolls */
function centerNow() {
  const wrap = document.querySelector('.table-wrap'), th = document.querySelector('#grid thead th.now'), first = document.querySelector('#grid thead .rowh');
  if (!wrap) return;
  if (!th || wrap.scrollWidth <= wrap.clientWidth) { wrap.scrollLeft = 0; return; }
  const w = wrap.getBoundingClientRect(), r = th.getBoundingClientRect();
  const visible = wrap.clientWidth - first.offsetWidth;   // the first column stays pinned
  wrap.scrollLeft = Math.max(0, wrap.scrollLeft + (r.left - w.left) - first.offsetWidth - (visible - r.width) / 2);
}

/* The table is one strip for the whole week: the day cards jump to a day, and the highlighted day follows the scroll */
let scrollLockUntil = 0;
function scrollToDay(d, smooth = true) {
  const wrap = document.querySelector('.table-wrap'), first = document.querySelector('#grid thead .rowh');
  if (!wrap || !first) return;
  scrollLockUntil = Date.now() + (smooth ? 900 : 150);
  if (orientV() || orientM()) return;   // vertical / meteogram: day cards re-render instead
  if (d === todayIndex() && document.querySelector('#grid thead th.now')) {
    if (!smooth) return centerNow();
    const w = wrap.getBoundingClientRect(), th = document.querySelector('#grid thead th.now'), r = th.getBoundingClientRect();
    const visible = wrap.clientWidth - first.offsetWidth;
    return wrap.scrollTo({ left: Math.max(0, wrap.scrollLeft + (r.left - w.left) - first.offsetWidth - (visible - r.width) / 2), behavior: 'smooth' });
  }
  const th = document.querySelector(`#grid thead tr:nth-child(2) th[data-day="${d}"]`);
  if (!th) return;
  wrap.scrollTo({ left: Math.max(0, th.offsetLeft - first.offsetWidth), behavior: smooth ? 'smooth' : 'auto' });
}
function syncDayFromScroll() {
  if (Date.now() < scrollLockUntil || !state.data) return;
  if (orientV()) {
    const rows = document.querySelectorAll('#grid tr.dayrow th[data-day]');
    if (!rows.length || state.param === 'reliability') return;
    const line = 130;   // the day that owns the first visible rows (just under the sticky top bar)
    let d = null;
    rows.forEach((th) => { if (th.getBoundingClientRect().top <= line) d = +th.dataset.day; });
    if (d == null) d = +rows[0].dataset.day;
    if (d == null || d === state.day) return;
    state.day = d;
    document.querySelectorAll('#days [data-day]').forEach((b) => { b.classList.toggle('sel', +b.dataset.day === d); b.classList.toggle('active', +b.dataset.day === d); });
    document.querySelectorAll('#grid th.dh').forEach((th) => th.classList.toggle('cur', +th.dataset.day === d));
    renderSummary(); syncHoursTitle();
    return;
  }
  const wrap = document.querySelector('.table-wrap'), first = document.querySelector('#grid thead .rowh');
  const ths = document.querySelectorAll('#grid thead tr:nth-child(2) th[data-day]');
  if (!wrap || !first || !ths.length) return;
  const x = wrap.scrollLeft + first.offsetWidth + (wrap.clientWidth - first.offsetWidth) * 0.4;   // a bit left of centre feels right
  let d = null;
  for (const th of ths) { if (th.offsetLeft <= x && x < th.offsetLeft + th.offsetWidth) { d = +th.dataset.day; break; } }
  if (d == null || d === state.day) return;
  state.day = d;
  document.querySelectorAll('#days [data-day]').forEach((b) => { b.classList.toggle('sel', +b.dataset.day === d); b.classList.toggle('active', +b.dataset.day === d); });
  document.querySelectorAll('#grid thead th.dh').forEach((th) => th.classList.toggle('cur', +th.dataset.day === d));
  renderSummary(); syncHoursTitle();
}
let scrollRaf = 0;
document.querySelector('.table-wrap').addEventListener('scroll', () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; syncDayFromScroll(); }); }, { passive: true });
window.addEventListener('scroll', () => { if (orientV() && !scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; syncDayFromScroll(); syncNowPill(); }); }, { passive: true });
/* Floating "back to now" pill (vertical mode): appears once the reader is more than 12 hours past the current hour */
function syncNowPill() {
  const pill = $('nowPill');
  queueMicrotask(() => document.body.classList.toggle('haspill', !pill.hidden));   // room under the footer while the pill floats
  if (!orientV() || !state.data || state.param === 'reliability') { pill.hidden = true; return; }
  const gridBottom = $('grid').getBoundingClientRect().bottom;
  if (gridBottom < window.innerHeight * 0.55) { pill.hidden = true; return; }   // the table has left the lower half of the screen: keep the footer readable
  const rows = document.querySelectorAll('#grid tr.hr[data-i]');
  let first = null;
  for (const r of rows) { if (r.getBoundingClientRect().bottom > 130) { first = r; break; } }
  const nowI = $('grid')._nowIndex ?? -1;
  if (!first || nowI < 0) { pill.hidden = true; return; }
  const hoursAhead = (+first.dataset.i - nowI) * state.step;
  if (hoursAhead < 12) { pill.hidden = true; return; }
  pill.querySelector('span').textContent = t('g.back_now', { h: hoursAhead });
  pill.hidden = false;
}
$('nowPill').addEventListener('click', () => {
  state.day = todayIndex(); state.vStartDay = state.day; state.vCount = null; renderDays(); renderSummary(); renderGrid();
  scrollLockUntil = Date.now() + 900; window.scrollTo({ top: $('tablebar').getBoundingClientRect().top + window.scrollY - 70, behavior: 'smooth' });
  $('nowPill').hidden = true;
});
/* Only the probability icons currently in view are animated (the strip holds up to 168 of them) */
let probIo = null;
/* Meteogram icon row: animated while visible (clipped by its own sideways scroller) */
const mgIo = window.IntersectionObserver ? new IntersectionObserver((entries) => entries.forEach((e) => e.target.classList.toggle('anim', e.isIntersecting)), { rootMargin: '60px' }) : null;
function observeProbIcons() {
  if (probIo) probIo.disconnect();
  if (!window.IntersectionObserver) return;
  const vertical = $('grid').classList.contains('vert');
  probIo = new IntersectionObserver((entries) => entries.forEach((e) => e.target.classList.toggle('anim', e.isIntersecting)), vertical ? { rootMargin: '120px 0px' } : { root: document.querySelector('.table-wrap'), rootMargin: '0px 80px' });
  document.querySelectorAll(vertical ? '#grid td.prob .wi.big' : '#grid tr.prob .wi.big, #grid tr.lane.wx .wi.big').forEach((el) => probIo.observe(el));
  document.querySelectorAll('#meteo .mrow.icons .wi').forEach((el) => mgIo && mgIo.observe(el));
}

const scoreCls = (v) => (v >= 80 ? 'hi' : v >= 60 ? 'mid' : 'lo');

function renderReliability() {
  const v = state.verify;
  $('modelsToggle').hidden = true;
  if (!v) {
    $('grid').innerHTML = `<tbody><tr><td class="pad">${state.verifyErr ? esc(t('r.unavailable', { e: state.verifyErr })) : t('r.loading')}</td></tr></tbody>`;
    $('legend').innerHTML = '';
    $('relNote').hidden = true;
    return;
  }
  const ids = Object.entries(v.models).sort((a, b) => (b[1].score ?? -1) - (a[1].score ?? -1));
  const frost = v.truth === 'frost', L1 = frost ? t('r.src.met') : 'ERA5', L2 = frost ? 'Netatmo' : 'METAR';
  const src = (label, value, extra = '', cls = '') => `<div class="src ${cls}"><i>${label}</i> <b>${value}</b>${extra}</div>`;
  // best model per measurement (highest blended skill) gets a small marker
  const best = {};
  ['temperature_2m', 'wind_speed_10m', 'cloud_cover', 'relative_humidity_2m', 'pressure_msl', 'precip', 'code'].forEach((k) => {
    let b = null; ids.forEach(([id, m]) => { const x = m.skill?.[k]; if (x != null && !state.disabled.has(id) && (b === null || x > b.x)) b = { id, x }; });
    if (b) best[k] = b.id;
  });
  const mark = (id, k) => (best[k] === id ? `<span class="bestmark">${t('r.best')}</span>` : '');
  const mae = (m, k, d = 1) => {
    if (m.mae[k] == null) return '–';
    const f = k === 'wind_speed_10m' && windMs() ? 1 / 3.6 : 1;   // wind errors are stored in km/h
    const o = m.obs?.mae?.[k];
    const bias = `<small>${t('r.bias', { v: (m.bias[k] > 0 ? '+' : '') + (m.bias[k] * f).toFixed(d) })}</small>`;
    return src(L1, (m.mae[k] * f).toFixed(d), bias) + (o != null ? src(L2, (o * f).toFixed(d), '', 'obs') : '');
  };
  const pct = (e, o) => (e != null ? src(L1, Math.round(e * 100) + '%') : '–') + (o != null ? src(L2, Math.round(o * 100) + '%', '', 'obs') : '');
  let html = `<thead><tr><th class="rowh">${t('r.model')}</th><th>${t('r.score')}</th><th>${t('r.score7')}</th><th>${t('r.temp')}</th><th>${t('r.wind', { u: wu() })}</th><th>${t('r.cloud')}</th><th>${t('r.hum')}</th><th>${t('r.press')}</th><th>${t('r.rain')}</th><th>${t('r.code')}</th></tr></thead><tbody>`;
  ids.forEach(([id, m]) => {
    html += `<tr class="${state.disabled.has(id) ? 'off' : ''}"><th class="rowh">${esc(nameById(id))}${state.disabled.has(id) ? ` <small>${t('r.disabled')}</small>` : ''}</th>
      <td><div class="bar"><i style="width:${m.score ?? 0}%"></i></div><b class="score ${scoreCls(m.score)}">${m.score ?? '–'}</b></td>
      <td><b class="score ${scoreCls(m.score7)}">${m.score7 ?? '–'}</b></td>
      <td class="cell">${mae(m, 'temperature_2m')}${mark(id, 'temperature_2m')}</td><td class="cell">${mae(m, 'wind_speed_10m')}${mark(id, 'wind_speed_10m')}</td><td class="cell">${mae(m, 'cloud_cover', 0)}${mark(id, 'cloud_cover')}</td>
      <td class="cell">${mae(m, 'relative_humidity_2m', 0)}${mark(id, 'relative_humidity_2m')}</td><td class="cell">${mae(m, 'pressure_msl', 2)}${mark(id, 'pressure_msl')}</td>
      <td class="cell">${pct(m.csi, m.obs?.csi)}${mark(id, 'precip')}</td><td class="cell">${pct(m.code_acc, m.obs?.code_acc)}${mark(id, 'code')}</td></tr>`;
  });
  $('grid').innerHTML = html + '</tbody>';
  $('relNote').innerHTML = t(frost ? 'r.howto.frost' : 'r.howto'); $('relNote').hidden = false;
  if (frost) {
    const S = v.frost.stations || {}, nm = (k) => (S[k] ? `${esc(S[k].name)} (${S[k].km} km)` : '–');
    $('legend').innerHTML = t('r.legend.frost', { start: v.start, end: v.end, hours: v.hours, loc: esc(state.current.name), t: nm('t'), w: nm('w'), c: nm('c'), p: nm('p'), r: nm('r'),
      nt: v.netatmo_hours ? t('r.netatmo.used', { n: v.netatmo_hours, w: Math.round((v.obs_weight || 0) * 100) }) : t('r.netatmo.none'), d: 7 });
    return;
  }
  const st = v.station
    ? t('r.station', { id: v.station.id, name: esc(v.station.name), km: v.station.km, n: v.station.reports, start: v.station.start, end: v.station.end })
    : t('r.nostation', { km: 60 });
  $('legend').innerHTML = `${st}<br>${t('r.legend', { start: v.start, end: v.end, hours: v.hours, loc: esc(state.current.name), w: Math.round((v.obs_weight || 0) * 100) })}<br>${t('r.limits')}`;
}

const badge = (id) => { const sc = state.verify?.models?.[id]?.score; return sc != null ? `<span class="rel ${scoreCls(sc)}" title="${t('r.badge')}">${sc}</span>` : ''; };

/* Individual model rows: collapsed by default on phones, open on larger screens, the user's choice is remembered */
// Models collapsed by default everywhere (the answer rows first); the choice is remembered (new key: earlier defaults are not carried over)
const modelsOpen = () => state.modelsOpen ?? lsGet('glett.models_open2') === '1';

/* Vertical layout: one row per hour (time runs down the page), the probability / average / models as columns.
   Past hours of today are left out; the day headers are rows that span the table. */
const V_WINDOW = { 1: 24, 3: 16, 6: 16, 12: 14 };   // rows shown initially, by step length (about two screens)
const V_APPEND = { 1: 6, 3: 4, 6: 4, 12: 2 };       // rows added per press of the "more" button (6 h, 12 h, 24 h, 24 h)
function renderGridVertical(cols, { rows, summary, prob, summaryLabel, probLabel, extraRows, rainCol }) {
  const open = modelsOpen();
  const series = [{ label: probLabel, cells: prob, cls: 'prob' }, { label: summaryLabel, cells: summary, cls: 'summary' }];
  if (open) {
    (extraRows || []).forEach((r) => series.push({ label: r.name, id: r.id, cells: r.cells, cls: 'ai' }));
    rows.forEach((r) => series.push({ label: r.name, id: r.id, cells: r.cells, cls: 'model' }));
  }
  // Rolling window: from the selected day (today: from the current hour) the next V_WINDOW[step] steps; more steps are
  // appended (never rebuilt: iOS Safari jumps when a table is replaced while its toolbar collapses) as the reader
  // approaches the bottom, or presses the button, up to the end of the 7-day forecast.
  const win = V_WINDOW[state.step] || 24, chunk = V_APPEND[state.step] || 6;
  const startDay = state.vStartDay ?? state.day;   // the day chosen with a card (the highlighted day follows the scroll and must not restart the list)
  let start = cols.findIndex((c) => c.day === startDay && (!c.past || c.now));   // a selected day in the past starts at its first future hour
  if (start < 0) start = cols.findIndex((c) => !c.past || c.now);
  if (start < 0) start = 0;
  if (state.vCount == null) state.vCount = win;
  let lastDay = -1;
  const rowsHtml = (from, to) => {
    let h = '';
    for (let i = from; i < Math.min(to, cols.length); i++) {
      const c = cols[i];
      if (c.day !== lastDay) { lastDay = c.day; h += `<tr class="dayrow"><th class="dh ${c.day === state.day ? 'cur' : ''}" data-day="${c.day}" colspan="${series.length + 1}"><span>${dayLabel(c.day)}</span></th></tr>`; }
      const same = (o) => o && !!o.night === !!c.night && o.day === c.day;   // day and night bands: round only their ends
      const nb = `${!same(cols[i - 1]) ? ' b-first' : ''}${!same(cols[i + 1]) ? ' b-last' : ''}${c.night ? `${!same(cols[i - 1]) ? ' n-first' : ''}${!same(cols[i + 1]) ? ' n-last' : ''}` : ''}`;
      h += `<tr class="hr ${c.now ? 'now' : ''} ${c.night ? 'night' : ''}${nb}" data-day="${c.day}" data-hour="${c.hour}" data-i="${i}"><th class="rowh">${c.label}</th>${series.map((sr) => { const cell = sr.cells[i] || {}; return `<td class="${sr.cls} ${cell.cls || ''} ${c.now ? 'now' : ''}"${cell.bg ? ` style="background-image:linear-gradient(${cell.bg},${cell.bg})"` : ''}>${cell.html || '–'}</td>`; }).join('')}</tr>`;
    }
    return h;
  };
  let html = `<thead><tr><th class="rowh">${t('g.time')}</th>${series.map((sr) => `<th class="${sr.cls}">${sr.id ? esc(sr.label) + badge(sr.id) : sr.label}</th>`).join('')}</tr></thead><tbody>`;
  html += rowsHtml(start, start + state.vCount);
  html += `<tr class="nextday"><td colspan="${series.length + 1}"><div class="vfoot"><span class="until" id="vUntil"></span><button type="button" class="btn primary small" id="nextDay">${t('g.more_hours', { n: chunk * state.step })}</button><button type="button" class="btn ghost small" id="toTop">↑ ${t('g.to_top')}</button></div></td></tr></tbody>`;
  $('grid').innerHTML = html;
  $('grid').classList.add('vert'); $('grid').classList.toggle('allm', open);   // all models: wide table that scrolls sideways
  document.querySelector('.table-wrap').classList.add('vert');
  document.querySelector('.table-wrap').scrollLeft = 0;   // the strip may have been scrolled to "now"; the list starts at its first column
  const footer = () => {
    const end = Math.min(start + state.vCount, cols.length), lastC = cols[end - 1];
    $('vUntil').textContent = end >= cols.length ? t('g.end') : lastC ? t('g.until', { d: dayLabel(lastC.day), h: lastC.label }) : '';
    $('nextDay').hidden = end >= cols.length;
  };
  const appendMore = (upTo) => {   // insert the next rows above the footer row, leaving everything above untouched
    const from = start + state.vCount, to = upTo != null ? Math.max(upTo + 1, from + chunk) : from + chunk;
    if (from >= cols.length) return;
    const tmp = document.createElement('tbody'); tmp.innerHTML = rowsHtml(from, to);
    const foot = $('grid').querySelector('tr.nextday'), footTop = foot.getBoundingClientRect().top;
    const fresh = [...tmp.children];
    fresh.forEach((tr) => foot.parentNode.insertBefore(tr, foot));
    // keep the reader where they were: the first new row takes the place the footer had (scroll anchoring would
    // otherwise keep the footer in view on some browsers and immediately trigger the next append)
    const delta = fresh[0].getBoundingClientRect().top - footTop;
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
    state.vCount = Math.min(to, cols.length) - start;
    observeProbIcons(); footer();
  };
  $('grid')._appendTo = (i) => { if (i >= start + state.vCount) appendMore(i); };
  $('grid')._nowIndex = cols.findIndex((c) => c.now);
  $('nextDay').addEventListener('click', () => appendMore());
  $('toTop').addEventListener('click', () => { scrollLockUntil = Date.now() + 900; window.scrollTo({ top: $('hoursCard').getBoundingClientRect().top + window.scrollY - 64, behavior: 'smooth' }); });
  footer();
  const nModels = rows.length + (extraRows ? extraRows.length : 0);
  $('modelsToggle').hidden = false;
  $('modelsToggle').textContent = open ? t('g.models_hide') : t('g.models_show', { n: nModels });
  $('modelsToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  observeProbIcons();
  return nModels;
}
/* ================= Meteogram: one chart per day (icon row, agreement, temperature with spread, rain, wind) ================= */
let CW = 46;   // px per hour column; widened in renderMeteogram so a day fills the card
/* Smooth line through points [[x, y], ...] (Catmull-Rom converted to cubic Béziers) */
function smoothPath(pts, close = false) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d + (close ? 'Z' : '');
}
function dayStats(d) {
  return columns(1, d).map((c) => {
    const P = activeProviders();
    const tv = nn(P.map((p) => agg(p, 'temperature_2m', c.a, c.b))), rv = nn(P.map((p) => agg(p, 'precip', c.a, c.b)));
    const shares = weatherShares(c), dd = nn(P.map((p) => agg(p, 'dir', c.a, c.b)));
    return { c, shares, temp: wmean(wpairs('temperature_2m', (p) => agg(p, 'temperature_2m', c.a, c.b))), tmin: tv.length ? Math.min(...tv) : null, tmax: tv.length ? Math.max(...tv) : null,
      rain: wmean(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b))), rainMax: rv.length ? Math.max(...rv) : null,
      wind: wmean(wpairs('wind', (p) => agg(p, 'wind_speed_10m', c.a, c.b))), gust: gustMean(c), dir: dd.length ? circMean(dd, dd.map(() => 1)) : null };
  });
}
const mgStats = {};   // per rendered day: the hour stats behind the meteogram (for the tooltip)
function meteogramDay(d) {
  const S = dayStats(d); if (!S.length) return '';
  mgStats[d] = S;
  const W = S.length * CW, H = 170, pt = 14, pb = 10;
  const temps = S.flatMap((s) => [s.tmin, s.tmax, s.temp]).filter((v) => v != null);
  let lo = Math.floor(Math.min(...temps) - 1), hi = Math.ceil(Math.max(...temps) + 1); if (hi - lo < 6) { hi = lo + 6; }
  const y = (v) => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo));
  const x = (i) => i * CW + CW / 2;
  const radar = S.map((s) => radarForCol(s.c));
  const rMax = Math.max(1, ...S.map((s) => s.rainMax || 0), ...radar.map((r) => (r ? r.mm : 0)));
  const RH = 60, ry = (v) => RH - (v / rMax) * (RH - 6);
  // radar nowcast for the hours it covers: an outlined bar over the model bars, labelled when it contradicts them
  const radarBars = S.map((s, i) => { const r = radar[i]; if (!r) return ''; const bad = radarBadge(s.c) !== '';
    return `<rect class="rradar${bad ? ' bad' : ''}" x="${i * CW + 6}" y="${ry(Math.max(r.mm, 0.04)).toFixed(1)}" width="${CW - 12}" height="${(RH - ry(Math.max(r.mm, 0.04))).toFixed(1)}"/>${bad ? `<text class="rl radar" x="${x(i)}" y="9" text-anchor="middle">${t('mg.radar')}</text>` : ''}`; }).join('');
  // temperature band + line
  const withT = S.map((s, i) => ({ s, i })).filter(({ s }) => s.tmin != null);
  const upper = withT.map(({ s, i }) => [x(i), y(s.tmax)]), lower = withT.slice().reverse().map(({ s, i }) => [x(i), y(s.tmin)]);
  const band = withT.length > 1 ? smoothPath(upper) + smoothPath(lower).replace(/^M/, 'L') + 'Z' : '';
  const line = smoothPath(S.map((s, i) => ({ s, i })).filter(({ s }) => s.temp != null).map(({ s, i }) => [x(i), y(s.temp)]));
  const labels = S.map((s, i) => (s.temp != null && i % 3 === 1 ? `<text class="tl" x="${x(i)}" y="${(y(s.temp) - 8).toFixed(1)}" text-anchor="middle">${fmt(s.temp)}°</text>` : '')).join('');
  const grid = [lo, Math.round((lo + hi) / 2), hi].map((v) => `<line class="gl" x1="0" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="gt" x="4" y="${(y(v) - 3).toFixed(1)}">${v}°</text>`).join('');
  const night = S.map((s, i) => (s.c.night ? `<rect class="nt" x="${i * CW}" y="0" width="${CW}" height="${H}"/>` : '')).join('');
  const nowI = S.findIndex((s) => s.c.now);
  const nowLine = nowI >= 0 ? `<line class="nowl" x1="${x(nowI)}" x2="${x(nowI)}" y1="0" y2="${H}"/>` : '';
  const rainBars = S.map((s, i) => (s.rainMax ? `<rect class="rmax" x="${i * CW + 8}" y="${ry(s.rainMax).toFixed(1)}" width="${CW - 16}" height="${(RH - ry(s.rainMax)).toFixed(1)}"/>` : '') + (s.rain && s.rain >= 0.05 ? `<rect class="rmean" x="${i * CW + 8}" y="${ry(s.rain).toFixed(1)}" width="${CW - 16}" height="${(RH - ry(s.rain)).toFixed(1)}"/>${s.rain >= 0.25 ? `<text class="rl" x="${x(i)}" y="${(ry(s.rain) - 3).toFixed(1)}" text-anchor="middle">${fmt(s.rain, 1)}</text>` : ''}` : '')).join('');
  const agreeCls = (v) => (v >= 0.75 ? 'hi' : v >= 0.5 ? 'mid' : 'lo');
  const cells = (fn) => S.map((s, i) => `<div class="mc ${s.c.night ? 'night' : ''} ${s.c.now ? 'now' : ''} ${s.c.past ? 'past' : ''}" style="width:${CW}px">${fn(s, i)}</div>`).join('');
  return `<section class="mgday" data-day="${d}">
    <h3>${dayLabel(d)}</h3>
    <div class="mgscroll"><div class="mgin" style="width:${W}px">
      <div class="mrow hours">${cells((s) => `<span>${s.c.label.slice(0, 2)}</span>`)}</div>
      <div class="mrow icons">${cells((s) => (s.shares ? WI.svg(WI.CAT_CODE[s.shares[0][0]], s.c.night, 'mini', colUnix(s.c) * 1000) : ''))}</div>
      <div class="mrow agree">${cells((s) => (s.shares ? `<span class="${agreeCls(s.shares[0][1])}">${Math.round(s.shares[0][1] * 100)}%</span>` : ''))}</div>
      <svg class="mgsvg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${night}${grid}<path class="band" d="${band}"/><path class="tline" d="${line}"/>${labels}${nowLine}</svg>
      <svg class="mgsvg rain" viewBox="0 0 ${W} ${RH}" width="${W}" height="${RH}"><line class="gl" x1="0" x2="${W}" y1="${RH - 0.5}" y2="${RH - 0.5}"/>${rainBars}${radarBars}</svg>
      <div class="mrow wind">${cells((s) => (s.wind != null ? `${s.dir != null ? WI.arrow(s.dir) : ''}<span>${fmt(wv(s.wind))}</span><small>${s.gust != null ? fmt(wv(s.gust)) : ''}</small>` : ''))}</div>
      <div class="mghl" style="width:${CW}px"></div><div class="mgtip" role="status"></div>
    </div></div>
  </section>`;
}
/* Meteogram tooltip: tap or hover a column and the hour's numbers appear just under the finger / cursor */
function mgTooltip(day, sc, i, clientY) {
  const S = mgStats[day]; if (!S || !S[i]) return;
  const s = S[i], inEl = sc.querySelector('.mgin'), hl = inEl.querySelector('.mghl'), tip = inEl.querySelector('.mgtip');
  hl.style.left = `${i * CW}px`; hl.style.display = 'block';
  const parts = [];
  if (s.temp != null) parts.push(t('mg.tip.temp', { v: fmt(s.temp), lo: fmt(s.tmin), hi: fmt(s.tmax) }));
  parts.push(s.rain != null && s.rain >= 0.05 ? t('mg.tip.rain', { v: fmt(s.rain, 1), mx: fmt(s.rainMax || 0, 1) }) : t('mg.tip.norain'));
  if (s.wind != null) parts.push(t('mg.tip.wind', { v: fmt(wv(s.wind)), g: fmt(wv(s.gust ?? s.wind)), u: wu() }));
  tip.innerHTML = `<b>${s.c.now ? t('hero.now') : t('mg.tip.at', { h: s.c.label })}</b>${s.shares ? ` · ${t('cat.' + s.shares[0][0])} <span class="agr">${t('mg.tip.agree', { p: Math.round(s.shares[0][1] * 100) })}</span>` : ''}<br>${parts.join(' · ')}`;
  tip.style.display = 'block';
  const r = inEl.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  const visL = sc.scrollLeft, visR = sc.scrollLeft + sc.clientWidth;
  const cx = Math.min(visR - tw / 2 - 6, Math.max(visL + tw / 2 + 6, i * CW + CW / 2));
  let top = clientY - r.top + 18;                         // just under the finger / cursor
  if (top + th > inEl.offsetHeight - 4) top = Math.max(4, clientY - r.top - th - 12);   // no room below: above instead
  tip.style.left = `${cx}px`; tip.style.top = `${top}px`;
}
function mgClear() { document.querySelectorAll('#meteo .mghl, #meteo .mgtip').forEach((el) => { el.style.display = 'none'; }); }
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.mgscroll')) mgClear(); }, { passive: true });
function renderMeteogram() {
  document.querySelector('.table-wrap').classList.add('meteo-mode');
  $('grid').hidden = true; $('meteo').hidden = false; $('modelsToggle').hidden = true;
  const d0 = state.vStartDay ?? state.day, d1 = Math.min(state.data.dates.length - 1, d0 + 1);
  const avail = ($('meteo').clientWidth || document.querySelector('.table-wrap').clientWidth || 0) - 18;   // card padding of each day
  CW = Math.max(46, Math.floor(avail / 24));
  $('meteo').innerHTML = `<div class="mglabels"><span>${t('mg.agree')}</span><span>${t('mg.temp')}</span><span>${t('mg.rain')} mm</span><span>${t('mg.wind')} ${wu()} (${t('mg.gust')})</span></div>` + meteogramDay(d0) + (d1 !== d0 ? meteogramDay(d1) : '');
  $('meteo').querySelectorAll('.mgscroll').forEach((sc, i) => { const now = sc.querySelector('.mc.now'); if (now && i === 0) sc.scrollLeft = Math.max(0, now.offsetLeft - sc.clientWidth / 3); });
  if (mgIo) $('meteo').querySelectorAll('.mrow.icons .wi').forEach((el) => mgIo.observe(el));
  $('meteo').querySelectorAll('.mgday').forEach((sec) => {
    const sc = sec.querySelector('.mgscroll'), day = +sec.dataset.day;
    const pick = (e) => { const r = sc.querySelector('.mgin').getBoundingClientRect(); const i = Math.floor((e.clientX - r.left) / CW); if (i >= 0 && i < (mgStats[day] || []).length) mgTooltip(day, sc, i, e.clientY); };
    sc.addEventListener('pointerdown', (e) => { mgClear(); pick(e); });   // a tap shows; a horizontal drag still scrolls the day
    sc.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && canHover.matches) pick(e); });
    sc.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && canHover.matches) mgClear(); });
  });
  $('legend').innerHTML = t('mg.legend') + t('lg.providers', { n: activeProviders().length }) + (weightsOn() ? t('lg.weighted') : '') + t('lg.shortmet');
}

/* ================= Expert section: every model as a thin line, the weighted consensus bold ================= */
function renderExpert() {
  if (!state.data) return;
  const cols = columns(1), start = Math.max(0, cols.findIndex((c) => !c.past || c.now)), span = cols.slice(start, start + 48);
  if (span.length < 2) { $('expertBody').innerHTML = ''; return; }
  const cw = $('expertBody').clientWidth || 960, narrow = cw < 700;
  // Phones: compact charts that fit the screen (both visible at once); "Vis større grafer" switches to the wide, scrolling ones
  const large = !narrow || state.exLarge;
  const P = activeProviders(), W = large ? Math.max(narrow ? 960 : 720, cw) : cw, H = large ? (narrow ? 320 : 280) : 180, pl = 36, pr = 10, pt = 14, pb = 24;
  const bw = Math.max(2, (W - pl - pr) / 48 - (large ? 2 : 1));   // bar width; the plot is inset by half a bar so the first bar clears the axis labels
  const series = P.map((p) => span.map((c) => agg(p, 'temperature_2m', c.a, c.b)));
  const cons = span.map((c) => wmean(wpairs('temperature_2m', (p) => agg(p, 'temperature_2m', c.a, c.b))));
  const all = series.flat().concat(cons).filter((v) => v != null);
  const lo = Math.floor(Math.min(...all) - 1), hi = Math.ceil(Math.max(...all) + 1);
  const x = (i) => pl + bw / 2 + (i * (W - pl - pr - bw)) / (span.length - 1), y = (v) => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo || 1));
  const path = (arr) => { const pts = arr.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean); return smoothPath(pts); };
  const days = span.map((c, i) => (c.first || i === 0 ? `<line class="gl d" x1="${x(i)}" x2="${x(i)}" y1="${pt}" y2="${H - pb}"/><text class="gt" x="${x(i) + 4}" y="${H - 6}">${dayLabel(c.day)}</text>` : '')).join('');
  const every = large ? 6 : 12;
  const ticks = span.map((c, i) => (c.hour % every === 0 && i > 0 ? `<text class="gt" x="${x(i)}" y="${pt - 2}" text-anchor="middle">${c.label.slice(0, 2)}</text>` : '')).join('');
  const gridl = [lo, Math.round((lo + hi) / 2), hi].map((v) => `<line class="gl" x1="${pl}" x2="${W - pr}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="gt" x="${pl - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v}°</text>`).join('');
  const xh = (h) => `<g class="xh"><line class="xl" x1="0" x2="0" y1="${pt}" y2="${h - pb}"/><circle class="xd" r="4" cx="0" cy="0"/></g>`;
  const temp = `<svg class="exsvg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${gridl}${days}${ticks}${series.map((sr, k) => `<path class="ml" d="${path(sr)}"><title>${esc(pname(P[k]))}</title></path>`).join('')}<path class="cl" d="${path(cons)}"/>${xh(H)}</svg>`;
  // rain: consensus bars with the wettest model behind
  const RH = large ? (narrow ? 170 : 150) : 100, rmean = span.map((c) => wmean(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b))) || 0), rmax = span.map((c) => Math.max(0, ...nn(P.map((p) => agg(p, 'precip', c.a, c.b)))));
  const top = Math.max(1, ...rmax), ry = (v) => pt + (RH - pt - pb) * (1 - v / top);
  const rain = `<svg class="exsvg" viewBox="0 0 ${W} ${RH}" width="${W}" height="${RH}" role="img"><line class="gl" x1="${pl}" x2="${W - pr}" y1="${RH - pb}" y2="${RH - pb}"/><text class="gt" x="${pl - 4}" y="${pt + 3}" text-anchor="end">${fmt(top, 1)}</text><text class="gt" x="${pl - 4}" y="${RH - pb + 3}" text-anchor="end">0</text>${span.map((c, i) => `${rmax[i] > 0.05 ? `<rect class="rmax" x="${(x(i) - bw / 2).toFixed(1)}" y="${ry(rmax[i]).toFixed(1)}" width="${bw.toFixed(1)}" height="${(RH - pb - ry(rmax[i])).toFixed(1)}"/>` : ''}${rmean[i] > 0.05 ? `<rect class="rmean" x="${(x(i) - bw / 2).toFixed(1)}" y="${ry(rmean[i]).toFixed(1)}" width="${bw.toFixed(1)}" height="${(RH - pb - ry(rmean[i])).toFixed(1)}"/>` : ''}`).join('')}${days}${xh(RH)}</svg>`;
  const sizeBtn = narrow ? `<button type="button" class="btn ghost small exsize" id="exSize">${t(state.exLarge ? 'ex.smaller' : 'ex.larger')}</button>` : '';
  const lgTemp = `<div class="exlegend"><span><i class="sw l-model"></i>${t('ex.lg.model')}</span><span><i class="sw l-glett"></i>${t('ex.lg.glett')}</span></div>`;
  const lgRain = `<div class="exlegend"><span><i class="sw b-mean"></i>${t('ex.lg.mean')}</span><span><i class="sw b-max"></i>${t('ex.lg.max')}</span></div>`;
  const hint = `<span class="hint">${t('ex.hint')}</span>`;
  $('expertBody').innerHTML = `<p class="hint">${t('ex.intro')}</p><h4>${t('ex.temp')}</h4>${lgTemp}<div class="exread" id="exReadT">${hint}</div><div class="exscroll">${temp}</div><h4>${t('ex.rain')}</h4>${lgRain}<div class="exread" id="exReadR">${hint}</div><div class="exscroll">${rain}</div>${sizeBtn}`;
  if (narrow) $('exSize').addEventListener('click', () => { state.exLarge = !state.exLarge; lsSet('glett.ex_large', state.exLarge ? '1' : '0'); renderExpert(); });
  // Crosshair + readout for one hour, on both charts at once: Glett's value with the lowest and highest model
  const svgs = [...$('expertBody').querySelectorAll('.exsvg')], tMin = span.map((c, i) => { const v = nn(series.map((sr) => sr[i])); return v.length ? Math.min(...v) : null; }), tMax = span.map((c, i) => { const v = nn(series.map((sr) => sr[i])); return v.length ? Math.max(...v) : null; });
  const showAt = (i) => {
    const c = span[i], hl = `${dayLabel(c.day)} ${c.label}`;
    svgs.forEach((svg, k) => { const g = svg.querySelector('.xh'); g.classList.add('on'); const xi = x(i).toFixed(1); g.querySelector('.xl').setAttribute('x1', xi); g.querySelector('.xl').setAttribute('x2', xi); const d = g.querySelector('.xd'); d.setAttribute('cx', xi); d.setAttribute('cy', (k === 0 ? (cons[i] != null ? y(cons[i]) : -20) : ry(rmean[i] || 0)).toFixed(1)); });
    $('exReadT').innerHTML = cons[i] == null ? hint : `<b>${hl}</b> · ${t('ex.read.temp', { v: fmt(cons[i]), lo: fmt(tMin[i]), hi: fmt(tMax[i]) })}`;
    $('exReadR').innerHTML = `<b>${hl}</b> · ${t('ex.read.rain', { v: fmt(rmean[i], 1), mx: fmt(rmax[i], 1) })}`;
  };
  const clear = () => { svgs.forEach((svg) => { svg.querySelector('.xh').classList.remove('on'); }); $('exReadT').innerHTML = hint; $('exReadR').innerHTML = hint; };
  $('expertBody')._clearXh = clear;
  scrollers0 = [...$('expertBody').querySelectorAll('.exscroll')];
  scrollers0.forEach((sc, k) => {
    const pick = (e) => { const r = svgs[k].getBoundingClientRect(); const i = Math.round(((e.clientX - r.left) - pl - bw / 2) / ((W - pl - pr - bw) / (span.length - 1))); if (i >= 0 && i < span.length) showAt(i); };
    sc.addEventListener('pointerdown', (e) => { pick(e); try { sc.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } });
    sc.addEventListener('pointermove', (e) => { if ((e.pointerType === 'mouse' && canHover.matches) || e.buttons) pick(e); });
    sc.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && canHover.matches) clear(); });
  });
  const scrollers = [...$('expertBody').querySelectorAll('.exscroll')];   // the two charts scroll as one
  scrollers.forEach((el) => el.addEventListener('scroll', () => scrollers.forEach((o) => { if (o !== el && Math.abs(o.scrollLeft - el.scrollLeft) > 1) o.scrollLeft = el.scrollLeft; }), { passive: true }));
}
let scrollers0 = [];
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.exscroll') && $('expertBody')._clearXh) $('expertBody')._clearXh(); }, { passive: true });
$('expert').addEventListener('toggle', () => { if ($('expert').open) renderExpert(); });
let mgResize = 0, mgLastW = 0;   // the meteogram's hour width follows the card width
window.addEventListener('resize', () => { if (!state.data || !orientM() || state.param === 'reliability') return; clearTimeout(mgResize); mgResize = setTimeout(() => { const w = document.querySelector('.table-wrap').clientWidth; if (Math.abs(w - mgLastW) > 20) { mgLastW = w; renderGrid(); } }, 200); });
let exResize = 0;
window.addEventListener('resize', () => { if (!$('expert').open) return; clearTimeout(exResize); exResize = setTimeout(renderExpert, 200); });

const orientV = () => state.orient === 'v';
const orientM = () => state.orient === 'm';
$('orientSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-orient]'); if (!b || b.dataset.orient === state.orient) return;
  state.orient = b.dataset.orient; lsSet('glett.orient2', state.orient); syncOrientBtn();
  if (state.data) { state.vStartDay = state.day; state.vCount = null; renderGrid(); }
});
function syncOrientBtn() { document.querySelectorAll('#orientSeg [data-orient]').forEach((b) => { b.classList.toggle('active', b.dataset.orient === state.orient); b.setAttribute('aria-pressed', b.dataset.orient === state.orient ? 'true' : 'false'); }); }
syncOrientBtn();

/* Desktop "Tid nedover" with the models collapsed: the list must not stretch. The page narrows and becomes two columns:
   now card + the week on the left (week sticky), the hour list on the right (sparred with Codex and Grok, 2026-09-29). */
function syncLayout() {
  const on = orientV() && !modelsOpen() && state.param !== 'reliability';
  document.body.classList.toggle('vlayout', on);
}
/* Colour key for the agreement bars (Vær tab, list and strip): only the weather types that occur in the forecast */
const CAT_ORDER = ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'thunder'];
function renderSegKey() {
  const el = $('segKey');
  if (state.param !== 'weather' || orientM() || !state.data) { el.hidden = true; return; }
  const seen = new Set(); columns(1).forEach((c) => { const sh = weatherShares(c); if (sh) sh.forEach(([k]) => seen.add(k)); });
  el.innerHTML = `<span class="sk-l">${t('seg.key')}</span>` + CAT_ORDER.filter((k) => seen.has(k)).map((k) => `<span class="sk-i"><i class="c-${k}"></i>${t('cat.' + k)}</span>`).join('');
  el.hidden = false;
}
function renderGrid() {
  syncLayout(); renderSegKey();
  const { param } = state;
  $('relNote').hidden = param !== 'reliability';
  $('grid').classList.remove('vert'); document.querySelector('.table-wrap').classList.remove('vert', 'meteo-mode');
  $('tablebar').hidden = param === 'reliability'; $('orientSeg').hidden = param === 'reliability';
  $('grid').hidden = false; $('meteo').hidden = true;
  $('expert').hidden = param === 'reliability';
  if ($('expert').open) renderExpert();
  if (param === 'reliability') { renderReliability(); requestAnimationFrame(syncNowPill); return; }
  if (orientM()) { renderMeteogram(); requestAnimationFrame(syncNowPill); return; }
  const cols = columns();
  const built = buildRows(param, cols);
  if (orientV()) {
    const nModels = renderGridVertical(cols, built);
    const compareNote = modelsOpen() && built.extraRows && built.extraRows.length ? t('lg.compare') : '';
    $('legend').innerHTML = t('lg.' + param, { thr: param === 'precip' ? RAIN_THR : fmt(wv(WIND_THR)), u: wu() }) + (param === 'weather' ? t('lg.weather.wind', { u: wu() }) : '') + t('lg.providers', { n: nModels }) + (weightsOn() ? t('lg.weighted') : '') + t('lg.shortmet') + compareNote;
    return;
  }
  const { rows, summary, prob, summaryLabel, probLabel, extraRows, lanes } = built;
  $('grid').classList.toggle('lanes', !!lanes);
  const rowHtml = (r, extraCls = '') => `<tr class="${extraCls}"><th class="rowh">${esc(r.name)}${badge(r.id)}</th>${r.cells.map((c, i) => `<td class="${c.cls || ''} ${cls(cols[i])}" style="background:${c.bg || ''}">${c.html}</td>`).join('')}</tr>`;
  const open = modelsOpen();
  const cls = (c) => `${c.past ? 'past' : ''}${c.now ? ' now' : ''}${c.first ? ' dstart' : ''}`;
  const perDay = []; cols.forEach((c) => { if (c.first) perDay.push({ d: c.day, n: 0 }); perDay[perDay.length - 1].n++; });
  let html = `<thead><tr class="dayrow"><th class="rowh" rowspan="2">${t('g.provider')}</th>${perDay.map((p) => `<th colspan="${p.n}" class="dh ${p.d === state.day ? 'cur' : ''}" data-day="${p.d}"><span>${dayLabel(p.d)}</span></th>`).join('')}</tr>`
    + `<tr>${cols.map((c) => `<th class="${cls(c)}" data-day="${c.day}">${c.label}</th>`).join('')}</tr></thead><tbody>`;
  // The answer first: probability, then the average, then (optionally) every model
  if (lanes) {
    lanes.forEach((ln) => { html += `<tr class="lane ${ln.cls}"><th class="rowh">${ln.label}</th>${ln.cells.map((c, i) => `<td class="${cls(cols[i])} ${c.cls || ''}" style="background:${c.bg || ''}">${c.html}</td>`).join('')}</tr>`; });
  } else {
    html += `<tr class="prob"><th class="rowh">${probLabel}</th>${prob.map((c, i) => `<td class="${cls(cols[i])}" style="background:${c.bg || ''}">${c.html}</td>`).join('')}</tr>`;
    html += `<tr class="summary"><th class="rowh">${summaryLabel}</th>${summary.map((c, i) => `<td class="${cls(cols[i])}" style="background:${c.bg || ''}">${c.html}</td>`).join('')}</tr>`;
  }
  if (open) {
    if (extraRows && extraRows.length) html += extraRows.map((r) => rowHtml(r, 'ai')).join('');
    rows.forEach((r) => { html += rowHtml(r); });
  }
  html += '</tbody>';
  $('grid').innerHTML = html;
  const nModels = rows.length + (extraRows ? extraRows.length : 0);
  $('modelsToggle').hidden = false;
  $('modelsToggle').textContent = open ? t('g.models_hide') : t('g.models_show', { n: nModels });
  $('modelsToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  const firstCol = document.querySelector('#grid thead .rowh');
  if (firstCol) $('grid').style.setProperty('--rowh', firstCol.offsetWidth + 'px');   // day pills stick just right of the pinned column
  scrollToDay(state.day, false);
  requestAnimationFrame(() => requestAnimationFrame(() => scrollToDay(state.day, false)));
  observeProbIcons(); requestAnimationFrame(syncNowPill);   // the "back to now" pill belongs to the vertical list only
  const compareNote = open && extraRows && extraRows.length ? t('lg.compare') : '';
  $('legend').innerHTML = t('lg.' + param, { thr: param === 'precip' ? RAIN_THR : fmt(wv(WIND_THR)), u: wu() }) + (param === 'weather' ? t('lg.weather.wind', { u: wu() }) : '') + t('lg.providers', { n: nModels }) + (weightsOn() ? t('lg.weighted') : '') + t('lg.shortmet') + compareNote;
}
$('modelsToggle').addEventListener('click', () => { state.modelsOpen = !modelsOpen(); lsSet('glett.models_open2', state.modelsOpen ? '1' : '0'); renderGrid(); });

/* ================= Day cards, summary strip, tabs ================= */
const DROP = '<svg class="arrow" viewBox="0 0 24 24" style="transform:none;fill:var(--rain)"><path d="M12 2c4 5 7 8.5 7 12a7 7 0 0 1-14 0c0-3.500 3-7 7-12z"/></svg>';

function dayCategory(codes) {
  const cats = nn(codes).map(WI.category), c = {};
  cats.forEach((k) => (c[k] = (c[k] || 0) + 1));
  if ((c.thunder || 0) >= 2) return 'thunder';
  if ((c.snow || 0) >= 2) return 'snow';
  if ((c.rain || 0) + (c.drizzle || 0) >= 3) return 'rain';
  const rest = Object.entries(c).sort((a, b) => b[1] - a[1]);
  return rest.length ? rest[0][0] : null;
}

function renderDays() {
  const { data } = state;
  $('days').innerHTML = data.dates.map((date, d) => {
    const a = d * 24, b = Math.min(a + 24, data.time.length);
    const cnt = {};
    wpairs('weather', (p) => dayCategory(p.hourly.code.slice(a + 6, a + 22))).forEach((x) => (cnt[x.v] = (cnt[x.v] || 0) + x.w));
    const top = Object.entries(cnt).sort((x, y) => y[1] - x[1])[0];
    const ext = (fn) => wmean(wpairs('temperature_2m', (p) => { const v = nn(p.hourly.temperature_2m.slice(a, b)); return v.length ? fn(...v) : null; }));
    const hi = ext(Math.max), lo = ext(Math.min);
    const rp = wshare(wpairs('precip', (p) => { const v = nn(p.hourly.precipitation.slice(a, b)); return v.length ? v.reduce((s, x) => s + x, 0) : null; }), (x) => x >= 1);
    const rain = rp == null ? null : Math.round(rp * 100);
    const sp = wshare(wpairs('storm', (p) => { const v = nn(p.hourly.weather_code.slice(a, b)); return v.length ? (v.some((x) => x >= 95) ? 1 : 0) : null; }), (x) => x === 1);
    const storm = sp == null ? 0 : Math.round(sp * 100);
    const mm = wmean(wpairs('precip', (p) => { const v = nn(p.hourly.precipitation.slice(a, b)); return v.length ? v.reduce((s, x) => s + x, 0) : null; }));
    const gust = wmean(wpairs('wind', (p) => { const v = nn(p.hourly.wind_gusts_10m.slice(a, b)); return v.length ? Math.max(...v) : null; }));
    const dt = new Date(date + 'T12:00:00');
    const name = dayName(d), sel = d === state.day;
    const dry = mm == null || mm < 0.5;
    const pr = rain == null ? '' : dry ? `<span>${rain}&nbsp;%</span><small>${t('wk.dry')}</small>` : `<b>${rain}&nbsp;%</b><small>${fmt(mm, mm < 10 ? 1 : 0)} mm</small>`;
    return `<button type="button" class="d ${sel ? 'sel active' : ''}" data-day="${d}" aria-pressed="${sel}">
      <div class="lab">${name}<small>${dt.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })}</small></div>
      ${top ? WI.svg(WI.CAT_CODE[top[0]], false, 'anim') : '<span></span>'}
      <div class="hl"><b>${fmt(hi)}°</b><span>${fmt(lo)}°</span></div>
      <div class="pr">${pr}${storm >= 20 ? `<small class="storm">${WI.bolt24}${storm}&nbsp;%</small>` : ''}</div>
      <div class="gu">${gust != null ? `${WI.arrow(0)}<b>${fmt(wv(gust))}</b><span class="u"> ${wu()}</span>` : ''}</div>
    </button>`;
  }).join('');
  $('wkUnit').textContent = wu();
  syncHoursTitle();
}
/* Heading of the hour section: "Time for time · fra nå" for today, else the chosen day */
function syncHoursTitle() {
  if (!state.data) return;
  $('hoursSub').textContent = state.day === todayIndex() ? t('hrs.fromnow') : dayLabel(state.day);
}

/* One-line practical answers for the selected day: rain from when, strongest gusts, model agreement, radar nowcast */
const timeOfDay = (h) => t(h < 6 ? 's.tod.night' : h < 11 ? 's.tod.morning' : h < 14 ? 's.tod.midday' : h < 18 ? 's.tod.afternoon' : 's.tod.evening');
const fmtTime = (ms) => new Date(ms).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
function renderSummary() {
  const sumDay = todayIndex();   // the now card talks about today, whatever day the table shows
  const all = columns(1, sumDay), cols = all.filter((c) => !c.past || c.now);   // what is still ahead
  const partial = cols.length < all.length;   // today, part of it already gone
  const items = [];
  if (cols.length) {
    const rain = cols.map((c) => ({ c, p: rainChance(c) })).filter((x) => x.p != null);
    if (rain.length) {
      const maxP = Math.max(...rain.map((x) => x.p)), pct = Math.round(maxP * 100);
      const first = rain.find((x) => x.p >= 0.5);
      let txt;
      if (maxP < 0.2) txt = t(partial ? 's.dry.rest' : 's.dry');
      else if (first && first === rain[0]) txt = t('s.rain.rest', { p: pct });
      else if (first) txt = t('s.rain.from', { h: first.c.label, p: pct });
      else txt = t('s.rain', { p: pct });
      items.push({ icon: DROP, cls: maxP >= 0.5 ? 'wet' : 'dry', txt, hour: first ? first.c.hour : null });
    }
    const gusts = cols.map((c) => ({ c, g: gustMean(c) })).filter((x) => x.g != null);
    if (gusts.length) {   // only worth a line when it is actually windy (about 12 m/s)
      const top = gusts.reduce((m, x) => (x.g > m.g ? x : m));
      if (top.g >= STRONG_GUST) items.push({ icon: WI.arrow(top.c.hour * 15), cls: top.g >= GUST_THR ? 'wet' : '', txt: t('s.wind', { v: fmt(wv(top.g)), u: wu(), tod: timeOfDay(top.c.hour) }), hour: top.c.hour });
    }
  }
  // Radar nowcast: only for today and only where MET Norway's radar covers
  const nc = state.nowcast && state.nowcast.series;
  if (nc && nc.length) {
    const nowS = Date.now() / 1000, s = nc.filter((p) => p.t >= nowS - 300);
    if (s.length) {
      const wet = (p) => p.rate >= 0.1, rainingNow = wet(s[0]);
      const change = s.findIndex((p, i) => i > 0 && wet(p) !== rainingNow && (i + 1 >= s.length || wet(s[i + 1]) !== rainingNow));
      const blip = !rainingNow && change <= 0 ? s.find((p) => wet(p)) : null;   // one lone wet 5-minute step: say so, the strip shows it
      const txt = rainingNow ? (change > 0 ? t('nc.wet.now', { h: fmtTime(s[change].t * 1000) }) : t('nc.wet.all')) : (change > 0 ? t('nc.dry.now', { h: fmtTime(s[change].t * 1000) }) : blip ? t('nc.dry.blip', { h: fmtTime(blip.t * 1000) }) : t('nc.dry.all'));
      items.unshift({ icon: WI.svg(rainingNow ? 63 : 1, false, 'mini'), cls: 'nowcast ' + (rainingNow ? 'wet' : 'dry'), txt: `<b>${t('nc.label')}:</b> ${txt}${state.nowcast.model ? ` <small>${t('nc.model')}</small>` : ''}`, title: t(state.nowcast.model ? 'nc.src.model' : 'nc.src') });
    }
  }
  // MET warning for this place (the most serious one; the map's warnings layer lists them all)
  if (lm.alertsHere.length) {
    const x = lm.alertsHere[0], more = lm.alertsHere.length - 1;
    items.unshift({ icon: WARN_ICON, cls: 'alert ' + esc(x.level), alert: true, title: t('lm.layer.alerts.tip'), txt: `<b>${t('s.alert')}:</b> ${esc(x.name)}, ${t('lm.level.' + x.level)} ${t('lm.level.word')}${more ? ` · ${t('s.alert.more', { n: more })}` : ''}` });
  }
  $('summary').innerHTML = items.map((i) => `<div class="sum ${i.cls} ${i.hour != null ? 'link' : ''}" ${i.hour != null ? `data-hour="${i.hour}" role="button" tabindex="0"` : ''} ${i.alert ? 'data-alert="1" role="button" tabindex="0"' : ''} ${i.title ? `title="${esc(i.title)}"` : ''}>${i.icon}<span>${i.txt}</span></div>`).join('');
  $('summary').hidden = !items.length;
}
/* Tapping a summary line scrolls the hour table to that hour */
$('summary').addEventListener('click', (e) => {
  if (e.target.closest('[data-alert]')) { lmToggle(true, 'alerts'); return; }
  const el = e.target.closest('[data-hour]'); if (!el) return;
  if (orientV()) {
    const cols = columns(), i = cols.findIndex((c) => c.day === state.day && c.hour + state.step > +el.dataset.hour);
    if (i >= 0 && $('grid')._appendTo) $('grid')._appendTo(i);
    const row = document.querySelector(`#grid tr.hr[data-i="${i}"]`);
    if (row) window.scrollTo({ top: row.getBoundingClientRect().top + window.scrollY - 120, behavior: 'smooth' });
    return;
  }
  const ths = [...document.querySelectorAll('#grid thead tr:nth-child(2) th[data-day]')], cols = columns();
  const i = cols.findIndex((c) => c.day === todayIndex() && c.hour + state.step > +el.dataset.hour);
  const th = ths[i >= 0 ? i : 0], wrap = document.querySelector('.table-wrap'), first = document.querySelector('#grid thead .rowh');
  if (!th || !wrap) return;
  wrap.scrollTo({ left: Math.max(0, th.offsetLeft - first.offsetWidth - 8), behavior: 'smooth' });
  wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

/* Bring an item into view inside a sideways-scrolling row WITHOUT moving the page (scrollIntoView also scrolls the window) */
function scrollRowTo(row, item) {
  if (!row || !item || row.scrollWidth <= row.clientWidth) return;
  const r = row.getBoundingClientRect(), i = item.getBoundingClientRect();
  if (i.left < r.left) row.scrollLeft += i.left - r.left - 12;
  else if (i.right > r.right) row.scrollLeft += i.right - r.right + 12;
}
function renderTabs() {
  $('tabs').innerHTML = Object.entries(PARAMS).map(([k]) => `<button class="tab ${k === state.param ? 'active' : ''}" data-param="${k}">${t('p.' + k)}</button>`).join('');
  scrollRowTo($('tabs'), $('tabs').querySelector('.tab.active'));   // the row scrolls on phones
  requestAnimationFrame(tabsOverflow);
}
/* Fade at the right edge of the tab row only while more tabs are hidden to the right */
const tabsOverflow = () => { const el = $('tabs'); el.classList.toggle('more', el.scrollLeft + el.clientWidth < el.scrollWidth - 2); };
$('tabs').addEventListener('scroll', tabsOverflow, { passive: true });
window.addEventListener('resize', tabsOverflow);
/* Links in the legend ("se Pålitelighet") open that tab */
$('legend').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-tab]'); if (!a) return;
  e.preventDefault(); state.param = a.dataset.tab; renderTabs(); renderGrid();
  window.scrollTo({ top: $('hoursCard').getBoundingClientRect().top + window.scrollY - 64, behavior: 'smooth' });
});

const ALL_MODEL_IDS = Object.keys(MODEL_NAMES);   // used to list models without coverage for a place

function renderModels() {
  const all = state.data.providers, uniq = uniqueProviders(), off = uniq.filter((p) => state.disabled.has(p.id)).length;
  $('mdlCount').textContent = t('m.active', { a: uniq.length - off, n: uniq.length });
  const region = (id) => (hasT('mi.' + id) ? `<small>${t('mi.' + id)}</small>` : '');
  const row = (p) => {
    if (p.dupOf) {
      return `<div class="mdl off"><span class="mtxt"><b>${esc(pname(p))}</b><small>${esc(t('m.dup', { n: nameById(p.dupOf) }))}</small></span></div>`;
    }
    const sc = state.verify?.models?.[p.id]?.score;
    return `<label class="mdl"><input type="checkbox" data-mid="${p.id}" ${state.disabled.has(p.id) ? '' : 'checked'}>
      <span class="mtxt"><b>${esc(pname(p))}</b>${region(p.id)}</span>${sc != null ? `<span class="rel ${scoreCls(sc)}" title="${t('r.badge')}">${sc}</span>` : ''}</label>`;
  };
  const missing = ALL_MODEL_IDS.filter((id) => !all.some((p) => p.id === id));
  $('mdlList').innerHTML = all.map(row).join('')
    + (missing.length ? `<div class="mdl-sep">${t('m.missing')}</div>${missing.map((id) => `<div class="mdl off"><span class="mtxt"><b>${esc(nameById(id))}</b>${region(id)}</span></div>`).join('')}` : '')
    + `<button type="button" class="btn ghost small" id="mdlAll">${t('m.all')}</button>`;
}
function saveDisabled() { lsSet('glett.disabled', JSON.stringify([...state.disabled])); }
$('mdlList').addEventListener('change', (e) => {
  const id = e.target.dataset.mid; if (!id) return;
  if (e.target.checked) state.disabled.delete(id);
  else if (uniqueProviders().filter((p) => !state.disabled.has(p.id)).length > 1) state.disabled.add(id);
  else e.target.checked = true;   // at least one model must stay on
  saveDisabled(); renderAll();
});
$('mdlList').addEventListener('click', (e) => {
  if (e.target.id !== 'mdlAll') return;
  state.disabled.clear(); saveDisabled(); renderAll();
});
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.pop[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
});

/* The "now" card: place, current temperature, most likely weather and wind, then the summary lines */
function renderHero() {
  const d = state.data, loc = state.current;
  if (!d || !loc) { $('hero').hidden = true; return; }
  $('hero').hidden = false;
  const geo = state.recent.find((r) => placeKey(r) === placeKey(loc) && r.geo);
  const isPlaceholder = loc.name === t('pb.geo.name');
  $('heroName').innerHTML = geo ? `<span class="geo">◎</span> ${esc(loc.name)}${isPlaceholder ? '' : ` <span class="tag">${t('pb.geo.name')}</span>`}` : esc(loc.name);
  const saved = !!isSaved(loc);
  $('heroStar').textContent = saved ? '★' : '☆'; $('heroStar').classList.toggle('on', saved);
  $('heroStar').title = t(saved ? 'pb.unstar' : 'pb.star'); $('heroStar').setAttribute('aria-pressed', saved ? 'true' : 'false');
  $('meta').textContent = t('hero.meta', { lat: d.lat.toFixed(3), lon: d.lon.toFixed(3), el: Math.round(d.elevation ?? 0) });
  const cols = columns(1), c = cols.find((x) => x.now) || cols.find((x) => !x.past) || cols[0];
  const shares = weatherShares(c), temp = wmean(wpairs('temperature_2m', (p) => agg(p, 'temperature_2m', c.a, c.b)));
  const ws = wmean(wpairs('wind', (p) => agg(p, 'wind_speed_10m', c.a, c.b))), g = gustMean(c), dd = nn(activeProviders().map((p) => agg(p, 'dir', c.a, c.b)));
  const top = shares ? shares[0] : null;
  const feels = wmean(wpairs('temperature_2m', (p) => agg(p, 'apparent_temperature', c.a, c.b)));
  const nAll0 = activeProviders().length, kTop = top ? Math.round(top[1] * nAll0) : 0;
  $('heroNow').innerHTML = `${top ? WI.svg(WI.CAT_CODE[top[0]], c.night, 'xl anim') : ''}
    <div class="big"><div class="big-temp">${fmt(temp)}°</div>${feels != null && Math.abs(feels - temp) >= 1 ? `<span class="feels">${t('hero.feels', { v: fmt(feels) })}</span>` : ''}</div>
    <div class="desc"><b>${top ? `${t('cat.' + top[0])} ${c.now ? t('hero.now') : c.label}` : ''}</b><span>${top ? t('hero.nmodels', { k: kTop, n: nAll0 }) : ''}</span>
      <div class="wind">${ws != null ? `${dd.length ? WI.arrow(circMean(dd, dd.map(() => 1))) : ''}${fmt(wv(ws))}${g != null ? ` (${fmt(wv(g))})` : ''} ${wu()}` : ''}</div>
    </div>`;
  if (top) {
    const nAll = activeProviders().length, k = Math.round(top[1] * nAll), level = top[1] >= 0.8 ? 'hi' : top[1] >= 0.5 ? 'mid' : 'lo';
    const tv = nn(activeProviders().map((p) => agg(p, 'temperature_2m', c.a, c.b)));
    $('heroVerdict').innerHTML = `<span class="dots ${level}" role="img" aria-label="${Math.max(1, Math.round(top[1] * 5))} / 5">${Array.from({ length: 5 }, (_, i) => `<i class="${i < Math.max(1, Math.round(top[1] * 5)) ? 'on' : ''}"></i>`).join('')}</span><div><b>${t('hero.verdict.' + level)}</b><small>${t('hero.verdict.detail', { k, n: nAll, cat: t('cat.' + top[0]).toLowerCase(), min: fmt(Math.min(...tv)), max: fmt(Math.max(...tv)) })}</small></div>`;
    $('heroVerdict').hidden = false;
  } else $('heroVerdict').hidden = true;
  renderLocal();
  // compact copy for the header, shown once the place heading has scrolled away
  $('miniNow').innerHTML = `${top ? WI.svg(WI.CAT_CODE[top[0]], c.night, 'mini anim') : ''}<span class="mn-place">${esc(loc.name.split(',')[0])}</span><b class="mn-temp">${fmt(temp)}°</b>${top ? `<span class="mn-cat">${t('cat.' + top[0])}</span>` : ''}`;
  $('miniNow').title = t('mini.top');
  $('heroMeta').textContent = t('hero.models', { a: activeProviders().length, n: uniqueProviders().length, time: new Date(d.generated).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }) });
}
$('heroStar').addEventListener('click', async () => {
  const place = state.current; if (!place) return;
  const s = isSaved(place);
  if (s) await WEFO.locations.remove(s.id); else { await WEFO.locations.add(place); addRecent(place); }
  state.locations = await WEFO.locations.list();
  renderChips(); renderSaved(); drawSavedMarkers(); renderHero();
});

function renderAll() {
  renderModels(); renderDays(); renderHero(); renderSummary(); renderTabs(); renderGrid(); syncHoursTitle();
  if (lm.open) lmRender();
}

$('days').addEventListener('click', (e) => {
  const b = e.target.closest('[data-day]'); if (!b) return;
  state.day = +b.dataset.day; renderDays(); renderSummary();
  if (state.param === 'reliability') return;
  if (orientV() || orientM()) { state.vStartDay = state.day; state.vCount = null; renderGrid(); scrollLockUntil = Date.now() + 900; if ($('hoursCard').getBoundingClientRect().top > window.innerHeight * 0.5) window.scrollTo({ top: $('hoursCard').getBoundingClientRect().top + window.scrollY - 64, behavior: 'smooth' }); return; }
  document.querySelectorAll('#grid thead th.dh').forEach((th) => th.classList.toggle('cur', +th.dataset.day === state.day));
  scrollToDay(state.day, true);
  if ($('hoursCard').getBoundingClientRect().top > window.innerHeight * 0.5) window.scrollTo({ top: $('hoursCard').getBoundingClientRect().top + window.scrollY - 64, behavior: 'smooth' });
});
$('grid').addEventListener('click', (e) => {   // the day header in the table works like a day card
  const th = e.target.closest('th.dh'); if (!th || orientV()) return;
  state.day = +th.dataset.day; renderDays(); renderSummary();
  document.querySelectorAll('#grid thead th.dh').forEach((x) => x.classList.toggle('cur', x === th));
  scrollToDay(state.day, true);
});
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-param]'); if (!b) return;
  state.param = b.dataset.param; renderTabs(); renderGrid();
});
state.step = +$('stepSelect').value || 1;
$('stepSelect').addEventListener('change', (e) => { state.step = +e.target.value; state.vCount = null; if (state.data) renderGrid(); });

/* ================= Loading a forecast ================= */
async function loadForecast(refresh = false, quiet = false) {   // quiet: keep the page visible while fetching (pull to refresh, auto refresh)
  const loc = state.current;
  $('empty').hidden = !!loc;
  if (!loc) { $('forecastBody').hidden = true; $('hero').hidden = true; return; }
  const token = ++state.token;
  quiet = quiet && !!state.data && !$('forecastBody').hidden;
  $('error').hidden = true;
  if (!quiet) { $('loading').hidden = false; $('forecastBody').hidden = true; $('hero').hidden = true; }
  try {
    const data = await WEFO.fetchForecast(loc.lat, loc.lon, refresh);
    if (token !== state.token) return;
    state.data = prepare(data);
    state.day = todayIndex(); state.vStartDay = state.day; state.vCount = null;
    state.verify = null; state.verifyErr = null; state.nowcast = null; state.local = 'loading'; $('radarStrip').hidden = true;
    $('loading').hidden = true; $('forecastBody').hidden = false;
    renderAll();
    loadVerify(loc, token);
    loadNowcast(loc, token);
    loadLocal(loc, token);
    loadAlerts(loc, token);
    rmSyncEntry(); if (rm.open) rmRender();
    state.histSince = null; syncHistLabel(); loadHistSince(loc, token);
    state.loadedAt = Date.now();
    // a forecast older than 30 minutes (from the browser's cache) is refreshed right away, quietly, once per place per 30 minutes
    const age = Date.now() - Date.parse(data.generated), k = placeKey(loc);
    state.autoRefreshed = state.autoRefreshed || {};
    if (!refresh && age > AUTO_REFRESH_MS && !(Date.now() - (state.autoRefreshed[k] || 0) < AUTO_REFRESH_MS)) { state.autoRefreshed[k] = Date.now(); loadForecast(true, true); }
  } catch (err) {
    if (token !== state.token) return;
    if (quiet) return;   // keep showing the data we have
    $('loading').hidden = true;
    $('error').textContent = err.message; $('error').hidden = false;
  }
}

async function loadVerify(loc, token) {
  $('vfStatus').textContent = t('vf.loading');
  try {
    const v = await WEFO.fetchVerify(loc.lat, loc.lon);
    if (token !== state.token) return;
    state.verify = v;
    $('vfStatus').textContent = '';
    renderAll();
  } catch (err) {
    if (token !== state.token) return;
    state.verifyErr = err.message;
    $('vfStatus').textContent = t('vf.unavail');
    if (state.param === 'reliability') renderGrid();
  }
}
/* Public Netatmo stations around the place: what is measured right now, next to what the models said */
async function loadLocal(loc, token) {
  const j = await WEFO.fetchLocal(loc.lat, loc.lon);
  if (token !== state.token) return;
  state.local = j || null;
  renderLocal();
  if (lm.open) lmRender();
}
function renderLocal() {
  const el = $('heroLocal'), j = state.local;
  if (!state.data || j === null) { el.hidden = true; return; }                                           // unavailable: nothing
  if (j === 'loading') { el.innerHTML = `<span class="spinner small"></span> <span class="muted">${t('local.loading')}</span>`; el.hidden = false; return; }
  if (!j.ok) { el.innerHTML = `<span class="muted">${t('local.few', { n: j.stations || 0 })}</span>`; el.hidden = false; return; }   // discreet note
  const loc1 = (v, d = 1) => Number(v).toLocaleString(dateLocale(), { minimumFractionDigits: d, maximumFractionDigits: d });
  const fl = feelsLike(j.temp.v, j.wind && j.wind.n >= 5 ? j.wind.kmh : null, j.hum ? j.hum.v : null);
  const parts = [`<b>${loc1(j.temp.v)}°</b>${fl != null && Math.abs(fl - j.temp.v) >= 1 ? ` <span class="feels">(${t('hero.feels', { v: fmt(fl) })})</span>` : ''}`];
  if (j.rain && j.rain.n >= 5) parts.push(j.rain.mm_1h >= 0.2 ? t('local.rain.mm', { mm: loc1(j.rain.mm_1h) }) : j.rain.wet_share >= 0.3 ? t('local.rain.some') : t('local.rain.none'));
  if (j.wind && j.wind.n >= 5) parts.push(t('local.wind', { v: fmt(wv(j.wind.kmh)), u: wu() }));
  if (j.hum) parts.push(t('local.hum', { h: fmt(j.hum.v) }));
  // user's call (2026-09-29): no station count and no model-vs-measured difference here; the source is credited in the footer
  const mappable = !!(j.pts && j.pts.length);
  el.innerHTML = `${mappable ? `<span class="lm-chev">${t(lm.open ? 'lm.close' : 'lm.open')} <i>▾</i></span>` : ''}<span class="lbl">${t('local.title', { name: esc(state.current.name.split(',')[0]) })}</span> ${parts.join(' · ')}`;
  el.title = t('local.src', { n: j.temp.n, km: j.radius_km });
  el.classList.toggle('lm-link', mappable);
  if (mappable) { el.setAttribute('role', 'button'); el.tabIndex = 0; } else { el.removeAttribute('role'); el.removeAttribute('tabindex'); }
  el.hidden = false;
}

/* History button: "Vis været tilbake til 1837" once we know how far back this place goes */
async function loadHistSince(loc, token) {
  const r = await WEFO.historySince(loc.lat, loc.lon).catch(() => null);
  if (token !== state.token) return;
  state.histSince = r ? r.year : null;
  syncHistLabel();
}
function syncHistLabel() {
  const el = $('histBtn').querySelector('span'); if (!el) return;
  el.removeAttribute('data-i18n');
  el.textContent = state.histSince ? t('tb.history.since', { y: state.histSince }) : t('tb.history.short');
}
async function loadNowcast(loc, token) {
  const nc = await WEFO.fetchNowcast(loc.lat, loc.lon);
  if (token !== state.token || !nc) return;
  state.nowcast = nc;
  renderSummary(); renderRadarStrip();
  if (lm.open) lmRender();
  if (nc.series.length && state.param !== 'reliability') renderGrid();   // radar badges on the first hours
}
/* Desktop: the strip sits under the day cards (right column); phone: inside the now card */
const wideMQ = window.matchMedia('(min-width: 1000px)');
function placeRadarStrip() {
  const el = $('radarStrip');   // always inside the now card, on desktop too (user's call)
  if (el.parentElement !== $('hero')) $('hero').insertBefore(el, document.querySelector('#hero .hero-foot'));
}
wideMQ.addEventListener('change', placeRadarStrip);
/* The next two hours from the radar: one bar per 5 minutes (mm/h) with a scale, and a readout on hover / tap */
const radarWord = (r) => t(r < 0.1 ? 'radar.w.none' : r < 1 ? 'radar.w.light' : r < 4 ? 'radar.w.moderate' : 'radar.w.heavy');
function renderRadarStrip() {
  const el = $('radarStrip'), nc = state.nowcast && state.nowcast.series, model = !!(state.nowcast && state.nowcast.model);
  if (!nc || !nc.length || !state.data) { el.hidden = true; rmSyncEntry(); return; }
  const nowS = Date.now() / 1000, stepS = model ? 900 : 300, pts = nc.filter((p) => p.t >= nowS - stepS).slice(0, model ? 8 : 24);
  if (pts.length < (model ? 4 : 6)) { el.hidden = true; rmSyncEntry(); return; }
  placeRadarStrip();
  const peak = Math.max(...pts.map((p) => p.rate));
  // The scale follows the rain: drizzle gets a 0.25 or 0.5 mm/h scale so its bars are visible, a downpour a 10 or 20 mm/h one
  const top = [0.25, 0.5, 1, 2, 5, 10].find((v) => peak <= v) || Math.ceil(peak / 10) * 10;
  const loc1 = (v) => v.toLocaleString(dateLocale(), { maximumFractionDigits: v < 1 ? 2 : 1 });
  const bars = pts.map((p, i) => `<i data-i="${i}" style="height:${Math.max(p.rate > 0 ? 3 : 1, Math.round((p.rate / top) * 40))}px" class="${p.rate >= 4 ? 'heavy' : p.rate >= 1 ? 'mod' : p.rate >= 0.1 ? 'wet' : ''}"></i>`).join('');
  const ticks = pts.map((p, i) => (i % (model ? 2 : 6) === 0 ? `<span style="left:${(i / pts.length) * 100}%">${fmtTime(p.t * 1000)}</span>` : '')).join('');
  const total = pts.reduce((s, p) => s + p.rate * stepS / 3600, 0);
  const wetPts = pts.filter((p) => p.rate >= 0.1);
  const status = !wetPts.length ? t('radar.none') : total >= 0.1 ? t('radar.total', { mm: loc1(total) }) : t('radar.blip', { h: fmtTime(wetPts[0].t * 1000) });
  const near = radarNearby(pts[0].t, pts[pts.length - 1].t);
  el.innerHTML = `<div class="rs-head"><b>${t(model ? 'radar.title.model' : 'radar.title')}</b><button type="button" class="rs-mapbtn" data-rmopen="1" aria-expanded="${rm.open ? 'true' : 'false'}" aria-controls="radarMap">${t(rm.open ? 'rm.close' : 'rm.open')}</button></div><small class="rs-status">${status} · ${t(model ? 'radar.src.model' : 'radar.src')}</small>${near ? `<div class="rs-near">${near}</div>` : ''}
    <div class="rs-plot"><span class="rs-gl top"><em>${loc1(top)} ${t('radar.unit')}</em></span><span class="rs-gl mid"><em>${loc1(top / 2)}</em></span><div class="rs-bars" role="img" aria-label="${t('radar.title')}">${bars}</div></div>
    <div class="rs-ticks">${ticks}</div><div class="rs-read"><span class="hint">${t('radar.hint')}</span></div>`;
  el.hidden = false;
  el.querySelector('.rs-mapbtn').addEventListener('click', () => rmToggle(null));
  rmSyncEntry();
  const nearEl = el.querySelector('.rs-near');
  if (nearEl) { nearEl.classList.add('link'); nearEl.setAttribute('role', 'button'); nearEl.tabIndex = 0; nearEl.title = t('rm.open.tip'); nearEl.addEventListener('click', () => rmToggle(true)); }
  const barsEl = el.querySelector('.rs-bars'), read = el.querySelector('.rs-read');
  const show = (x) => {
    const r = barsEl.getBoundingClientRect(), i = Math.min(pts.length - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * pts.length)));
    barsEl.querySelectorAll('i').forEach((b, k) => b.classList.toggle('sel', k === i));
    const p = pts[i];
    read.innerHTML = `<b>${fmtTime(p.t * 1000)}</b> · ${p.rate >= 0.05 ? `${loc1(p.rate)} ${t('radar.unit')} · ` : ''}${radarWord(p.rate)}`;
  };
  const plot = el.querySelector('.rs-plot');   // the whole plot (not just the thin bars) answers to a finger or the mouse
  plot.addEventListener('pointerdown', (e) => { show(e.clientX); try { plot.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } });
  plot.addEventListener('pointermove', (e) => { if ((e.pointerType === 'mouse' && canHover.matches) || e.buttons) show(e.clientX); });
  plot.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && canHover.matches) clearRadarSel(); });
}
/* "Rain nearby": wet radar points ~5 km around the place within the strip's window, as one sentence */
function radarNearby(t0, t1) {
  const ring = state.nowcast && state.nowcast.ring; if (!ring || !ring.length) return '';
  const hits = ring.map((r) => ({ dir: r.dir, wet: r.series.filter((p) => p.t >= t0 && p.t <= t1 && p.rate >= 0.1) })).filter((r) => r.wet.length);
  if (!hits.length) return '';
  const all = hits.flatMap((r) => r.wet), from = Math.min(...all.map((p) => p.t)), to = Math.max(...all.map((p) => p.t));
  const dirs = hits.map((r) => t('dir.' + r.dir));
  const dirTxt = hits.length >= 6 ? t('radar.near.all') : dirs.length > 1 ? dirs.slice(0, -1).join(', ') + ' ' + t('and') + ' ' + dirs[dirs.length - 1] : dirs[0];
  const when = to - from < 600 ? t('radar.near.at', { h: fmtTime(from * 1000) }) : t('radar.near.span', { a: fmtTime(from * 1000), b: fmtTime(to * 1000) });
  return `${DROP}<span>${t('radar.near', { dirs: dirTxt, km: state.nowcast.km || 5, when })}</span>`;
}
/* A tap or click anywhere outside the radar plot clears the selected bar and its readout */
function clearRadarSel() {
  const el = $('radarStrip'); if (el.hidden) return;
  el.querySelectorAll('.rs-bars i.sel').forEach((b) => b.classList.remove('sel'));
  const read = el.querySelector('.rs-read'); if (read) read.innerHTML = `<span class="hint">${t('radar.hint')}</span>`;
}
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.rs-plot')) clearRadarSel(); }, { passive: true });
$('weightChk').checked = state.weighted;
$('weightChk').addEventListener('change', (e) => {
  state.weighted = e.target.checked;
  lsSet('glett.weighted', state.weighted ? '1' : '0');
  if (state.data) renderAll();
});
$('windSel').value = state.windUnit;
$('windSel').addEventListener('change', (e) => { state.windUnit = e.target.value; lsSet('glett.wind', state.windUnit); if (state.data) renderAll(); });
$('refreshBtn').addEventListener('click', () => { $('settings').open = false; loadForecast(true); });

/* ================= Fresh data: back in the app after 30 minutes, and pull to refresh ================= */
function refreshIfStale() {
  if (document.visibilityState !== 'visible' || !state.data || !state.current) return;
  if (Date.now() - (state.loadedAt || 0) > AUTO_REFRESH_MS) loadForecast(true, true);
}
document.addEventListener('visibilitychange', refreshIfStale);
window.addEventListener('pageshow', (e) => { if (e.persisted) refreshIfStale(); });
window.addEventListener('focus', refreshIfStale);

(function pullToRefresh() {
  if (!('ontouchstart' in window)) return;
  const el = document.createElement('div'); el.id = 'ptr'; el.className = 'ptr'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 20A8 8 0 1 1 20 12"/><path d="M16.5 9.5 20 12 22.5 8.5"/></svg>';   // a 270° arc with a chevron head: clear space between the tail and the head
  document.body.appendChild(el);
  const MAX = 110, TRIGGER = 72;
  let startY = null, pull = 0, busy = false;
  const blocked = (t) => t.closest('dialog[open], .mdl-panel, .segtip, .table-wrap, .mgscroll, .exscroll, .rs-plot, #map, .histsec') || document.querySelector('.topbar.menu-open');
  const set = (y) => { pull = y; el.style.transform = `translate(-50%, ${Math.round(y - 50)}px) rotate(${Math.round(y * 3)}deg)`; el.style.opacity = Math.min(1, y / TRIGGER); el.classList.toggle('ready', y >= TRIGGER); };
  document.addEventListener('touchstart', (e) => {
    if (busy || window.scrollY > 0 || e.touches.length !== 1 || blocked(e.target) || !$('view-forecast').classList.contains('active')) { startY = null; return; }
    startY = e.touches[0].clientY; el.classList.remove('back');
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) { if (pull) set(0); return; }
    set(Math.min(MAX, dy * 0.5));
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (startY == null) return; startY = null;
    if (pull < TRIGGER) { el.classList.add('back'); set(0); return; }
    busy = true; el.classList.add('spin'); set(TRIGGER);
    try { await loadForecast(true, true); } finally {
      setTimeout(() => { el.classList.remove('spin'); el.classList.add('back'); set(0); busy = false; }, 350);
    }
  });
})();

/* ================= Places: current place, chips, search, my location ================= */
const isSaved = (p) => state.locations.find((l) => placeKey(l) === placeKey(p));
const isCity = (p) => CITIES.find((c) => placeKey(c) === placeKey(p));
function setCurrent(place, go = false) {
  state.current = place ? { name: place.name, lat: +place.lat, lon: +place.lon } : null;
  if (histState && !histSec.hidden && (!place || placeKey(histState.loc) !== placeKey(place))) closeHistory();   // history belongs to a place
  lsSet('glett.last', place ? JSON.stringify(state.current) : null);
  renderChips();
  if (go) showView('forecast');
  loadForecast();
}
function addRecent(place) {
  const k = placeKey(place);
  state.recent = [{ name: place.name, lat: +place.lat, lon: +place.lon, geo: !!place.geo, at: Date.now() }, ...state.recent.filter((r) => placeKey(r) !== k)].slice(0, RECENT_MAX);
  lsSet('glett.recent', JSON.stringify(state.recent));
}
function renderChips() {
  const cur = state.current, curK = cur ? placeKey(cur) : '';
  const groups = [
    ['pb.saved', state.locations.map((l) => ({ ...l, kind: 'saved' }))],
    ['pb.recent', state.recent.filter((r) => !isSaved(r) && !isCity(r)).map((r) => ({ ...r, kind: 'recent' }))],
    ['pb.cities', CITIES.filter((c) => !isSaved(c)).map((c) => ({ ...c, kind: 'city' }))],   // a saved city shows once, under Mine steder
  ].filter(([, list]) => list.length);
  const chip = (p) => {
    const active = placeKey(p) === curK;
    const star = active ? `<button type="button" class="star ${p.kind === 'saved' ? 'on' : ''}" data-star="1" title="${t(p.kind === 'saved' ? 'pb.unstar' : 'pb.star')}" aria-label="${t(p.kind === 'saved' ? 'pb.unstar' : 'pb.star')}">${p.kind === 'saved' ? '★' : '☆'}</button>` : '';
    return `<span class="chip ${p.kind} ${p.geo ? 'geo' : ''} ${active ? 'active' : ''}" data-lat="${p.lat}" data-lon="${p.lon}" data-name="${esc(p.name)}"><button type="button" class="pick" aria-pressed="${active}" title="${esc(p.name)}">${esc(p.name.split(',')[0])}</button>${star}</span>`;
  };
  $('chips').innerHTML = groups.map(([label, list]) => `<div class="chipgrp"><span class="chiplbl">${t(label)}</span>${list.map(chip).join('')}</div>`).join('');
  const act = $('chips').querySelector('.chip.active');
  scrollRowTo($('chips'), act);
}
$('chips').addEventListener('click', async (e) => {
  const chipEl = e.target.closest('.chip'); if (!chipEl) return;
  const place = { name: chipEl.dataset.name, lat: +chipEl.dataset.lat, lon: +chipEl.dataset.lon };
  if (e.target.closest('[data-star]')) {
    const s = isSaved(place);
    if (s) await WEFO.locations.remove(s.id); else { await WEFO.locations.add(place); addRecent(place); }
    state.locations = await WEFO.locations.list();
    renderChips(); renderSaved(); drawSavedMarkers(); renderHero();
    return;
  }
  if (e.target.closest('.pick')) { if (chipEl.classList.contains('recent')) addRecent(place); setCurrent(place); }
});

let searchTimer, searchSeq = 0;
function bindSearch(inputId, boxId, onPick) {
  const input = $(inputId), box = $(boxId);
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) { box.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      try {
        const res = await WEFO.search(q, LANG);
        if (seq !== searchSeq) return;   // a newer search is already running
        box.innerHTML = res.length ? res.map((r, i) => `<li data-i="${i}">${esc(r.name)}</li>`).join('') : `<li>${t('search.none')}</li>`;
        box._res = res; box.hidden = false;
      } catch (err) { box.hidden = true; }
    }, 350);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && box._res && box._res.length && !box.hidden) { e.preventDefault(); pick(0); } if (e.key === 'Escape') box.hidden = true; });
  const pick = (i) => { const r = box._res[i]; box.hidden = true; input.value = ''; input.blur(); onPick(r); };
  box.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) pick(+li.dataset.i); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#' + inputId) && !e.target.closest('#' + boxId)) box.hidden = true; });
}
bindSearch('pbSearch', 'pbResults', (r) => {
  const place = { name: r.name.split(',')[0].trim() || r.name, lat: +r.lat, lon: +r.lon };
  addRecent(place); setCurrent(place);
});
bindSearch('searchInput', 'searchResults', (r) => { initMap(); pickPoint(r.lat, r.lon, r.name.split(',')[0]); map.setView([r.lat, r.lon], 11); });

function myLocation(onPoint) {
  if (!navigator.geolocation) return $('error').hidden = false, ($('error').textContent = t('err.geo.unsupported'));
  const btn = $('pbGeo'); btn.classList.add('busy'); btn.disabled = true;
  const done = () => { btn.classList.remove('busy'); btn.disabled = false; };
  navigator.geolocation.getCurrentPosition(
    (pos) => { done(); onPoint(+pos.coords.latitude.toFixed(4), +pos.coords.longitude.toFixed(4)); },
    () => { done(); $('error').textContent = t('err.geo.fail'); $('error').hidden = false; },
    { maximumAge: 5 * 60 * 1000, timeout: 15000 },
  );
}
$('pbGeo').addEventListener('click', () => myLocation(async (lat, lon) => {
  const place = { name: t('pb.geo.name'), lat, lon, geo: true };
  addRecent(place); setCurrent(place);
  try { const name = await WEFO.reverse(lat, lon, LANG, true); if (name && state.current && placeKey(state.current) === placeKey(place)) { place.name = name; state.current.name = name; addRecent(place); lsSet('glett.last', JSON.stringify(state.current)); renderChips(); renderHero(); } } catch (e) { /* keep the generic name */ }
}));

/* ================= Saved places (map view) ================= */
async function loadLocations() {
  state.locations = await WEFO.locations.list();
  renderSaved(); renderChips(); drawSavedMarkers();
}

let map, marker, savedLayer, nameAuto = true;
/* Kartverket's PNG tiles carry a transparent outer pixel row and column, which shows as a hairline grid between tiles
   (very visible once the tiles are colour-inverted for dark mode). Each tile is therefore drawn onto a canvas with that
   edge cropped away, so the tiles are opaque edge to edge. */
const KartverketLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const size = this.getTileSize(), tile = document.createElement('canvas');
    tile.width = size.x; tile.height = size.y;
    const img = new Image();
    img.onload = () => {
      try { tile.getContext('2d').drawImage(img, 1, 1, img.naturalWidth - 2, img.naturalHeight - 2, 0, 0, size.x, size.y); done(null, tile); }
      catch (e) { done(e, tile); }
    };
    img.onerror = () => done(new Error('tile'), tile);
    img.src = `https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/${coords.z}/${coords.y}/${coords.x}.png`;
    return tile;
  },
});
/* Map credits folded into a small (i): a tap unfolds the full attribution line (the footer lists every source as well) */
function glettAttribution(m) {
  const c = m.attributionControl; if (!c) return;
  c.setPrefix('');
  const el = c.getContainer(); el.classList.add('glett-attr'); el.setAttribute('role', 'button'); el.setAttribute('aria-label', t('map.credits')); el.tabIndex = 0;
  const toggle = () => el.classList.toggle('open');
  el.addEventListener('click', toggle);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
}
function initMap() {
  if (map) return;
  map = L.map('map').setView([64.5, 12.0], 4);   // Norway
  glettAttribution(map);
  const topo = new KartverketLayer({ maxZoom: 18, attribution: '<a href="https://www.kartverket.no/" target="_blank" rel="noopener">© Kartverket</a>' });
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>' });
  (lsGet('glett.map') === 'osm' ? osm : topo).addTo(map);
  const layers = {}; layers[t('map.topo')] = topo; layers[t('map.osm')] = osm;
  L.control.layers(layers, null, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => lsSet('glett.map', e.layer === osm ? 'osm' : 'topo'));
  savedLayer = L.layerGroup().addTo(map);
  map.on('click', (e) => pickPoint(e.latlng.lat, e.latlng.lng, null, true));
  drawSavedMarkers();
  if (state.current) map.setView([state.current.lat, state.current.lon], 8);
}
function drawSavedMarkers() {
  if (!savedLayer) return;
  savedLayer.clearLayers();
  state.locations.forEach((l) => L.circleMarker([l.lat, l.lon], { radius: 6, color: '#16a34a', fillOpacity: .8 }).bindTooltip(l.name).addTo(savedLayer));
}
async function pickPoint(lat, lon, name, reverse) {
  lat = +lat.toFixed(4); lon = +(((lon + 540) % 360) - 180).toFixed(4);
  $('latInput').value = lat; $('lonInput').value = lon;
  if (marker) marker.setLatLng([lat, lon]); else marker = L.marker([lat, lon]).addTo(map);
  if (name) { $('nameInput').value = name; nameAuto = false; }
  else if (reverse && nameAuto) {
    $('nameInput').value = '';
    try { const nm = await WEFO.reverse(lat, lon, LANG, true); if (nm && nameAuto && +$('latInput').value === lat && +$('lonInput').value === lon) $('nameInput').value = nm; } catch (e) { /* ignore */ }
  }
}
function msg(text, cls = '') { const el = $('placeMsg'); el.textContent = text; el.className = 'hint ' + cls; }

['latInput', 'lonInput'].forEach((id) => $(id).addEventListener('change', () => {
  const lat = parseFloat($('latInput').value), lon = parseFloat($('lonInput').value);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    // a blur (e.g. clicking Save) fires "change" again with the same coordinates: don't clear the name / re-geocode then
    if (marker) { const m = marker.getLatLng(); if (Math.abs(m.lat - lat) < 5e-5 && Math.abs(m.lng - lon) < 5e-5) return; }
    initMap(); pickPoint(lat, lon, null, true); map.setView([lat, lon], Math.max(map.getZoom(), 9));
  }
}));
$('nameInput').addEventListener('input', () => { nameAuto = !$('nameInput').value.trim(); });

$('saveBtn').addEventListener('click', async () => {
  const lat = parseFloat($('latInput').value), lon = parseFloat($('lonInput').value), name = $('nameInput').value.trim();
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return msg(t('err.pick'), 'err');
  if (!name) return msg(t('err.name'), 'err');
  try {
    const loc = await WEFO.locations.add({ name, lat, lon });
    await loadLocations();
    msg(t('ok.saved', { n: name }), 'ok');
    nameAuto = true; $('nameInput').value = '';
    setCurrent(loc);
  } catch (err) { msg(err.message, 'err'); }
});
$('geoBtn').addEventListener('click', () => { initMap(); myLocation((lat, lon) => { nameAuto = true; pickPoint(lat, lon, null, true); map.setView([lat, lon], 11); }); });

function renderSaved() {
  $('savedList').innerHTML = state.locations.length ? state.locations.map((l) => `
    <li data-id="${l.id}">
      <div class="nm" data-act="fly"><b>${esc(l.name)}</b><small>${l.lat.toFixed(3)}, ${l.lon.toFixed(3)}</small></div>
      <button data-act="hist">${t('saved.history')}</button>
      <button data-act="fc">${t('saved.forecast')}</button>
      <button class="del" data-act="del" title="${t('saved.delete')}">✕</button>
    </li>`).join('') : `<li><span class="hint">${t('saved.none')}</span></li>`;
}
$('savedList').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-id]'), act = e.target.closest('[data-act]')?.dataset.act;
  if (!li || !act) return;
  const loc = state.locations.find((l) => l.id == li.dataset.id);
  if (act === 'fc') setCurrent(loc, true);
  if (act === 'hist') openHistory(loc);
  if (act === 'fly') { initMap(); pickPoint(loc.lat, loc.lon, loc.name); map.setView([loc.lat, loc.lon], 10); }
  if (act === 'del' && confirm(t('confirm.delete', { n: loc.name }))) {
    await WEFO.locations.remove(loc.id);
    if (histState && histState.loc.id === loc.id) closeHistory();
    await loadLocations();
  }
});

/* Saved places live only in this browser: export / import them as a JSON file to move them between devices */
$('exportBtn').addEventListener('click', async () => {
  const blob = new Blob([await WEFO.locations.exportJson()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'glett-locations.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const n = await WEFO.locations.importJson(await f.text());
    await loadLocations();
    msg(t('ok.imported', { n }), 'ok');
  } catch (err) { msg(err.message, 'err'); }
});

/* ================= Navigation ================= */
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.nav-btn').forEach((b) => { b.hidden = b.dataset.view === name; });
  if (name === 'places') { initMap(); setTimeout(() => map.invalidateSize(), 50); drawSavedMarkers(); }
  window.scrollTo({ top: 0 });
}
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
document.addEventListener('click', (e) => { const a = e.target.closest('[data-goto]'); if (a) { e.preventDefault(); showView(a.dataset.goto); } });

/* ================= History (map view) ================= */
const histSec = $('histSec');
let histState = null;   // { loc, data }

function niceNum(v, d = 1) { return v == null ? '–' : Number(v).toLocaleString(dateLocale(), { minimumFractionDigits: d, maximumFractionDigits: d }); }

/* Simple SVG chart: kind = 'line' | 'bar', points = [{x: year, v: value}] */
const CHARTS = {};   // id -> geometry + data of a rendered history chart, for the tooltip layer
let chartSeq = 0;
function histChart(points, { kind, color, unit, d = 1, trend = false, w = 1200, h = 270 }) {
  if (points.length < 2) return '';
  const Wd = w, H = h, pl = 46, pr = 12, pt = 14, pb = 26;
  const id = 'c' + (++chartSeq);
  const ys = points.map((p) => p.v);
  let min = Math.min(...ys), max = Math.max(...ys);
  if (kind === 'bar') min = 0; else { const pad = (max - min) * 0.12 || 1; min -= pad; max += pad; }
  const x = (i) => pl + (i * (Wd - pl - pr)) / (points.length - 1);
  const y = (v) => pt + (H - pt - pb) * (1 - (v - min) / (max - min || 1));
  let g = '';
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3;
    g += `<line x1="${pl}" x2="${Wd - pr}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" class="tx">${niceNum(v, d === 0 ? 0 : d)}</text>`;
  }
  points.forEach((p, i) => { if (p.x % 10 === 0) g += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="tx">${p.x}</text>`; });
  let body = '';
  if (kind === 'bar') {
    const bw = Math.max(1.5, (Wd - pl - pr) / points.length - 1);
    body = points.map((p, i) => `<rect x="${x(i) - bw / 2}" y="${y(p.v)}" width="${bw}" height="${y(min) - y(p.v)}" fill="${color}" opacity=".85"/>`).join('');
  } else {
    body = `<path d="${points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join('')}" fill="none" stroke="${color}" stroke-width="1.6"/>`
      + points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="2.2" fill="${color}"/>`).join('');
    if (trend) {
      const n = points.length, mx = mean(points.map((p) => p.x)), my = mean(ys);
      const slope = points.reduce((a, p) => a + (p.x - mx) * (p.v - my), 0) / points.reduce((a, p) => a + (p.x - mx) ** 2, 0);
      const y0 = my + slope * (points[0].x - mx), y1 = my + slope * (points[n - 1].x - mx);
      body += `<line x1="${x(0)}" y1="${y(y0)}" x2="${x(n - 1)}" y2="${y(y1)}" stroke="var(--bad)" stroke-width="1.6" stroke-dasharray="5 4"/>`;
      body += `<text x="${Wd - pr}" y="${pt + 8}" text-anchor="end" class="tx" fill="var(--bad)">${t('h.trend', { v: (slope * 10 >= 0 ? '+' : '') + niceNum(slope * 10, 2) })}</text>`;
    }
  }
  CHARTS[id] = { type: kind, points, unit, d, W: Wd, H, pl, pr, pt, pb, xs: points.map((_, i) => x(i)), ys: points.map((p) => y(p.v)), yMin: y(min), color };
  return `<svg class="hchart" data-chart="${id}" viewBox="0 0 ${Wd} ${H}" role="img"><g class="hl" hidden><line class="hl-line" y1="${pt}" y2="${H - pb}"/><circle class="hl-dot" r="4"/></g>${g}${body}</svg>`;
}

/* Heatmap: one cell per month of every year. mode 'anom' = difference from that month's long-term average, 'abs' = mean temperature */
function heatColor(v, lo, mid, hi, cols) {
  const [c0, c1, c2] = cols;
  const mix = (a, b, f) => a.map((x, i) => Math.round(x + (b[i] - x) * f));
  const rgb = v <= mid ? mix(c0, c1, clamp((v - lo) / (mid - lo || 1))) : mix(c1, c2, clamp((v - mid) / (hi - mid || 1)));
  return `rgb(${rgb.join(',')})`;
}
function heatmap(series, mode) {
  const rows = series.filter((r) => r[4] >= 25 && r[2] != null);
  if (rows.length < 24) return '';
  const years = rows.map((r) => r[0]), y0 = Math.min(...years), y1 = Math.max(...years), ny = y1 - y0 + 1;
  const sums = Array(13).fill(0), cnts = Array(13).fill(0);
  rows.forEach((r) => { sums[r[1]] += r[2]; cnts[r[1]]++; });
  const avg = sums.map((s, m) => (cnts[m] ? s / cnts[m] : 0));
  const val = (r) => (mode === 'anom' ? r[2] - avg[r[1]] : r[2]);
  const vals = rows.map(val);
  let lo, mid, hi, cols;
  if (mode === 'anom') {
    const abs = vals.map(Math.abs).sort((x, y) => x - y);
    const lim = Math.max(1.5, Math.ceil(abs[Math.floor(abs.length * 0.92)] * 2) / 2);
    lo = -lim; mid = 0; hi = lim; cols = [[37, 99, 235], [243, 244, 246], [220, 38, 38]];
  } else {
    lo = Math.min(...vals); hi = Math.max(...vals); mid = (lo + hi) / 2; cols = [[37, 99, 235], [250, 204, 21], [220, 38, 38]];
  }
  const Wd = 900, pl = 42, pr = 10, pt = 8, ch = 22, pb = 22, H = pt + 12 * ch + pb;
  const cw = (Wd - pl - pr) / ny;
  let cells = '';
  rows.forEach((r) => {
    const v = val(r);
    cells += `<rect x="${(pl + (r[0] - y0) * cw).toFixed(2)}" y="${pt + (r[1] - 1) * ch}" width="${(cw + 0.4).toFixed(2)}" height="${ch - 1}" fill="${heatColor(v, lo, mid, hi, cols)}"/>`;
  });
  const id = 'c' + (++chartSeq);
  const byKey = new Map(rows.map((r) => [r[0] * 100 + r[1], r]));
  CHARTS[id] = { type: 'heat', W: Wd, H, pl, pt, ch, cw, y0, y1, mode, avg, byKey };
  let axes = '';
  for (let m = 1; m <= 12; m++) axes += `<text x="${pl - 6}" y="${pt + (m - 1) * ch + ch / 2 + 3}" text-anchor="end" class="tx">${monthName(m, true)}</text>`;
  for (let y = Math.ceil(y0 / 10) * 10; y <= y1; y += 10) axes += `<text x="${pl + (y - y0 + 0.5) * cw}" y="${H - 6}" text-anchor="middle" class="tx">${y}</text>`;
  const stops = Array.from({ length: 11 }, (_, i) => `<stop offset="${i * 10}%" stop-color="${heatColor(lo + ((hi - lo) * i) / 10, lo, mid, hi, cols)}"/>`).join('');
  const fmtL = (v) => (mode === 'anom' ? `${v > 0 ? '+' : ''}${niceNum(v, 1)}°` : `${niceNum(v, 0)}°`);
  const legend = `<div class="hlegend"><span>${fmtL(lo)}</span><svg viewBox="0 0 200 10" preserveAspectRatio="none"><defs><linearGradient id="hg">${stops}</linearGradient></defs><rect width="200" height="10" rx="5" fill="url(#hg)"/></svg><span>${fmtL(hi)}</span></div>`;
  return `<svg class="hchart heat" data-chart="${id}" viewBox="0 0 ${Wd} ${H}" role="img">${cells}${axes}<rect class="hl-cell" hidden width="${(cw + 0.4).toFixed(2)}" height="${ch - 1}"/></svg>${legend}`;
}

/* Tooltips for the history charts: hover with a mouse, tap or drag on touch screens */
const chartTip = document.createElement('div');
chartTip.className = 'ctip'; chartTip.hidden = true; document.body.appendChild(chartTip);
function chartHover(svg, clientX, clientY) {
  const c = CHARTS[svg.dataset.chart]; if (!c) return false;
  const r = svg.getBoundingClientRect(), sx = c.W / r.width, sy = c.H / r.height;
  const vx = (clientX - r.left) * sx, vy = (clientY - r.top) * sy;
  let text = null, px = 0, py = 0;
  if (c.type === 'heat') {
    const yr = c.y0 + Math.floor((vx - c.pl) / c.cw), mo = Math.floor((vy - c.pt) / c.ch) + 1;
    const row = c.byKey.get(yr * 100 + mo);
    const cell = svg.querySelector('.hl-cell');
    if (!row) { cell.hidden = true; return false; }
    const v = c.mode === 'anom' ? row[2] - c.avg[row[1]] : row[2];
    text = `<b>${monthName(row[1])} ${row[0]}</b><br>${niceNum(row[2])} °C${c.mode === 'anom' ? ` <span class="${v >= 0 ? 'warm' : 'cold'}">(${v >= 0 ? '+' : ''}${niceNum(v)})</span>` : ''}`;
    cell.setAttribute('x', (c.pl + (yr - c.y0) * c.cw).toFixed(2)); cell.setAttribute('y', c.pt + (mo - 1) * c.ch); cell.hidden = false;
    px = r.left + (c.pl + (yr - c.y0 + 0.5) * c.cw) / sx; py = r.top + (c.pt + (mo - 1) * c.ch) / sy;
  } else {
    let i = 0, best = Infinity;
    c.xs.forEach((x, k) => { const dd = Math.abs(x - vx); if (dd < best) { best = dd; i = k; } });
    const p = c.points[i], hl = svg.querySelector('.hl');
    hl.querySelector('.hl-line').setAttribute('x1', c.xs[i]); hl.querySelector('.hl-line').setAttribute('x2', c.xs[i]);
    hl.querySelector('.hl-dot').setAttribute('cx', c.xs[i]); hl.querySelector('.hl-dot').setAttribute('cy', c.ys[i]); hl.hidden = false;
    text = `<b>${p.x}</b><br>${niceNum(p.v, c.d)} ${c.unit}`;
    px = r.left + c.xs[i] / sx; py = r.top + c.ys[i] / sy;
  }
  chartTip.innerHTML = text; chartTip.hidden = false;
  const tw = chartTip.offsetWidth, th = chartTip.offsetHeight;
  let left = px - tw / 2, top = py - th - 12;
  left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));
  if (top < 8) top = py + 16;
  chartTip.style.left = (left + window.scrollX) + 'px'; chartTip.style.top = (top + window.scrollY) + 'px';
  return true;
}
function chartLeave(svg) {
  chartTip.hidden = true;
  if (svg) svg.querySelectorAll('.hl, .hl-cell').forEach((el) => { el.hidden = true; });
}
$('histBody').addEventListener('pointermove', (e) => { const svg = e.target.closest('svg.hchart'); if (svg && (e.pointerType !== 'touch' || e.buttons)) chartHover(svg, e.clientX, e.clientY); });
$('histBody').addEventListener('pointerdown', (e) => { const svg = e.target.closest('svg.hchart'); if (svg) chartHover(svg, e.clientX, e.clientY); });
$('histBody').addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') chartLeave(null); }, true);   // a tap ends with a pointerleave too
$('histBody').addEventListener('pointerout', (e) => { const svg = e.target.closest('svg.hchart'); if (svg && e.pointerType !== 'touch' && !svg.contains(e.relatedTarget)) chartLeave(svg); });
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('svg.hchart')) chartLeave(document.querySelector('svg.hchart .hl:not([hidden])')?.closest('svg') || document.querySelector('svg.hchart .hl-cell:not([hidden])')?.closest('svg')); });

function renderHistory() {
  if (!histState) return;
  const { loc, data: h, fresh, added } = histState;
  if (!h) { return; }
  const m = h.meta, frost = m.source === 'frost';
  const fullYear = frost && m.station && m.station.from > '1940-01-01' ? m.station.from.slice(0, 4) : '1940';
  const snowCol = frost ? 'h.col.snowdepth' : 'h.col.snow', snowRec = frost ? 'h.rec.snowdeepest' : 'h.rec.snowiest';
  const heatMode = histState.heat || 'anom';
  const complete = h.annual.filter((a) => a.n >= 350);
  const pT = histState.periodT || 'all', pP = histState.periodP || 'all';
  const seriesT = pT === 'all' ? complete.filter((a) => a.tmean != null).map((a) => ({ x: a.y, v: a.tmean }))
    : h.series.filter((r) => r[1] === +pT && r[4] >= 25 && r[2] != null).map((r) => ({ x: r[0], v: r[2] }));
  const seriesP = pP === 'all' ? complete.filter((a) => a.prcp != null).map((a) => ({ x: a.y, v: a.prcp }))
    : h.series.filter((r) => r[1] === +pP && r[4] >= 25 && r[3] != null).map((r) => ({ x: r[0], v: r[3] }));
  const periodSel = (id, cur) => `<label class="hperiod">${t('h.periodsel')} <select id="${id}"><option value="all">${t('h.period.all')}</option>${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${+cur === i + 1 ? 'selected' : ''}>${monthName(i + 1)}</option>`).join('')}</select></label>`;
  const fmtDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
  const rec = (k, unit, d = 1, conv = (v) => v, label = 'h.rec.' + k) => (h.records[k] ? `<div class="rcard"><span>${t(label)}</span><b>${niceNum(conv(h.records[k].v), d)} ${unit}</b><small>${fmtDate(h.records[k].d)}</small></div>` : '');
  const months = h.monthly.map((r) => `<tr><th>${monthName(r.m)}</th><td>${niceNum(r.tmean)}</td><td>${niceNum(r.tmax)}</td><td>${niceNum(r.tmin)}</td><td>${niceNum(r.prcp, 0)}</td><td>${niceNum(r.rainy, 1)}</td></tr>`).join('');
  const maxP = Math.max(...h.annual.map((a) => a.prcp || 0), 1);
  const years = h.annual.slice().reverse().map((a) => `<tr><th>${a.y}${a.n < 350 ? '*' : ''}</th><td>${niceNum(a.tmean)}</td><td>${niceNum(a.tmax)}</td><td>${niceNum(a.tmin)}</td>
      <td><div class="pbar"><i style="width:${Math.round(((a.prcp || 0) / maxP) * 100)}%"></i><span>${niceNum(a.prcp, 0)}</span></div></td><td>${a.rainy}</td><td>${niceNum(wv(a.gust), 0)}</td><td>${niceNum(a.snow)}</td></tr>`).join('');
  $('histBody').innerHTML = `
    <h2>${t('h.title')} – ${esc(loc.name)}</h2>
    <div class="h-info">
      <div>📍 ${frost ? t('h.station', { name: esc(m.station.name), id: m.station.id, km: m.distance_km, el: Math.round(m.elevation ?? 0), from: (m.station.from || '').slice(0, 4) }) : t('h.grid', { lat: m.grid_lat.toFixed(4), lon: m.grid_lon.toFixed(4), km: m.distance_km, el: Math.round(m.elevation ?? 0) })}</div>
      ${frost && m.chain && m.chain.length > 1 ? `<details class="h-stations"><summary>${t('h.stations')}</summary><ol>${m.chain.map((c, i) => {
        const from = (c.from || '').slice(0, 4), to = i === 0 ? t('h.stations.now') : String(Math.min(+((c.to || '9999').slice(0, 4)), +((m.chain[i - 1].from || '').slice(0, 4))));
        return `<li><b>${t('h.stations.row', { from, to })}</b> ${esc(c.name)} <small>(${c.id}) · ${c.km} km · ${c.masl != null ? Math.round(c.masl) + ' moh.' : ''}</small></li>`;
      }).reverse().join('')}</ol></details>` : ''}
      <div>📅 ${t('h.period', { first: m.first, last: m.last, days: m.days.toLocaleString(dateLocale()) })}</div>
      <div class="muted">${t(frost ? 'h.source.frost' : 'h.source', { date: new Date(m.fetched_at * 1000).toLocaleDateString(dateLocale()) })}</div>
      <div class="h-status">${m.partial ? `<span class="spinner small"></span> <span id="histPartial">${t('h.loading')}</span>` : fresh ? t('h.status.new') : added > 0 ? t('h.status.added', { n: added }) : t('h.status.cached')} <button type="button" class="btn ghost small" id="histUpdate" ${m.partial ? 'disabled' : ''}>${t('h.update')}</button>
        ${m.can_extend && !m.partial ? `<button type="button" class="btn ghost small" id="histFull" title="${esc(t('h.full.hint', { first: m.first.slice(0, 4), last: m.last.slice(0, 4), y: fullYear }))}">${t('h.full', { y: fullYear })}</button>` : ''}</div>
    </div>
    <h3>${t('h.rec.title')}</h3>
    <div class="rcards">${rec('hottest', '°C')}${rec('coldest', '°C')}${rec('wettest', 'mm')}${rec('windiest', wu(), 0, wv)}${(h.records.snowiest && h.records.snowiest.v > 0) ? rec('snowiest', 'cm', 1, (v) => v, snowRec) : ''}</div>
    <div class="h-chartbox">
      <div class="h-charthead"><h3>${pT === 'all' ? t('h.chart.temp') : t('h.chart.temp.m', { m: monthName(+pT) })}</h3>${periodSel('histPeriodT', pT)}</div>
      ${histChart(seriesT, { kind: 'line', color: 'var(--accent)', unit: '°C', trend: true })}
    </div>
    <div class="h-chartbox">
      <div class="h-charthead"><h3>${pP === 'all' ? t('h.chart.prcp') : t('h.chart.prcp.m', { m: monthName(+pP) })}</h3>${periodSel('histPeriodP', pP)}</div>
      ${histChart(seriesP, { kind: 'bar', color: 'var(--rain)', unit: 'mm', d: 0 })}
    </div>
    <div class="h-heathead"><h3>${t('h.heat')}</h3>
      <div class="seg" role="group"><button type="button" data-heat="anom" class="${heatMode === 'anom' ? 'active' : ''}">${t('h.heat.anom')}</button><button type="button" data-heat="abs" class="${heatMode === 'abs' ? 'active' : ''}">${t('h.heat.abs')}</button></div></div>
    <div class="h-climate">${heatmap(h.series, heatMode)}<p class="hint">${t('h.heat.hint.' + heatMode)}</p></div>
    <h3>${t('h.monthly')}</h3>
    <div class="h-tablewrap"><table class="htable"><thead><tr><th>${t('h.col.month')}</th><th>${t('h.col.mean')}</th><th>${t('h.col.max')}</th><th>${t('h.col.min')}</th><th>${t('h.col.prcp')}</th><th>${t('h.col.rainy')}</th></tr></thead><tbody>${months}</tbody></table></div>
    <h3>${t('h.annual')}</h3>
    <div class="h-tablewrap tall"><table class="htable"><thead><tr><th>${t('h.col.year')}</th><th>${t('h.col.mean')}</th><th>${t('h.col.max')}</th><th>${t('h.col.min')}</th><th>${t('h.col.prcp')}</th><th>${t('h.col.rainy')}</th><th>${t('h.col.gust', { u: wu() })}</th><th>${t(snowCol)}</th></tr></thead><tbody>${years}</tbody></table></div>
    <p class="hint">${t('h.partial')}</p>`;
  $('histUpdate').addEventListener('click', () => openHistory(loc, true));
  if ($('histFull')) $('histFull').addEventListener('click', () => openHistory(loc, false, true));
  document.querySelectorAll('[data-heat]').forEach((b) => b.addEventListener('click', () => { histState.heat = b.dataset.heat; renderHistory(); }));
  $('histPeriodT').addEventListener('change', (e) => { histState.periodT = e.target.value; renderHistory(); });
  $('histPeriodP').addEventListener('change', (e) => { histState.periodP = e.target.value; renderHistory(); });
}

async function openHistory(loc, refresh = false, full = false) {
  histState = { loc, data: null, fresh: false, added: 0, periodT: (histState && histState.loc.id === loc.id && histState.periodT) || 'all', periodP: (histState && histState.loc.id === loc.id && histState.periodP) || 'all', heat: (histState && histState.heat) || 'anom' };
  const wasHidden = histSec.hidden;
  histSec.hidden = false;
  if (wasHidden || !refresh) histSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('histBody').innerHTML = `<h2>${t('h.title')} – ${esc(loc.name)}</h2><div class="loading"><div class="spinner"></div> <span id="histProgress">${t(refresh ? 'h.loading' : 'h.loading.first')}</span></div>`;
  try {
    let scrolled = false;
    const bring = () => { if (!scrolled && wasHidden) { scrolled = true; histSec.scrollIntoView({ behavior: 'smooth', block: 'start' }); } };   // the section only has its real height once data rendered
    const h = await WEFO.fetchHistory(loc, refresh, full, (txt, part) => {
      if (part && histState && histState.loc.id === loc.id) { histState.data = part; histState.fresh = false; renderHistory(); bring(); return; }   // older years still loading
      const el = $('histProgress'); if (el) el.textContent = txt;
      const p = $('histPartial'); if (p && txt) p.textContent = txt;
    });
    if (!histState || histState.loc.id !== loc.id) return;
    histState.data = h; histState.fresh = h.downloaded; histState.added = h.added || 0;
    renderHistory(); bring();
  } catch (err) {
    $('histBody').innerHTML = `<h2>${t('h.title')} – ${esc(loc.name)}</h2><div class="notice error">${esc(err.message)}</div>`;
  }
}
function closeHistory() { histSec.hidden = true; histState = null; $('histBody').innerHTML = ''; }
$('histClose').addEventListener('click', closeHistory);
$('histBtn').addEventListener('click', () => { if (state.current) openHistory({ ...state.current, id: placeKey(state.current) }); });

/* ================= Language ================= */
function onLangChange() {
  renderSaved(); renderChips();
  if (!histSec.hidden && histState && histState.data) renderHistory();
  if (state.data) { renderAll(); renderRadarStrip(); }   // the radar strip and its button are not part of renderAll
  syncHistLabel();
  rmSyncEntry(); if (rm.open) rmRender();   // the radar map: caption, badge, slider label, play button
  if (lm.busyN) lmBusy(0);
  if (typeof mapBigLabels === 'function') mapBigLabels();
}
document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
applyStaticI18n();

/* ================= Theme (light / dark) ================= */
const sysDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const effectiveTheme = () => document.documentElement.getAttribute('data-theme') || (sysDark && sysDark.matches ? 'dark' : 'light');
const syncThemeBtn = () => $('themeBtn').classList.toggle('is-dark', effectiveTheme() === 'dark');
$('themeBtn').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  lsSet('glett.theme', next);
  syncThemeBtn();
});
if (sysDark && sysDark.addEventListener) sysDark.addEventListener('change', syncThemeBtn);
syncThemeBtn();

/* ================= Start: last viewed place, or Oslo on the very first visit ================= */
$('brandIcon').innerHTML = '<img src="brand/mark.svg?v=20261005g" alt="" width="30" height="25">';   // Glett logo: "Glipe sol"
(async () => {
  try { await loadLocations(); } catch (err) { $('error').textContent = err.message; $('error').hidden = false; }
  const last = lsJson('glett.last', null);
  setCurrent(last && Number.isFinite(+last.lat) && Number.isFinite(+last.lon) && last.name ? last : CITIES[0]);
})();

if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => setTimeout(centerNow, 50));
window.addEventListener('load', () => setTimeout(centerNow, 100));

/* ================= "Hva er Glett?" ================= */
function openAbout() { $('aboutBody').innerHTML = t('about.html'); const d = $('aboutDlg'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
$('aboutBtn').addEventListener('click', openAbout);
document.addEventListener('click', (e) => { if (e.target.closest('[data-about]')) { e.preventDefault(); openAbout(); } });
$('aboutDlg').addEventListener('click', (e) => { if (e.target.closest('.ad-close') || e.target === $('aboutDlg')) $('aboutDlg').close(); });

/* The logo goes back to the forecast, scrolled to the top (no reload) */
$('brandLink').addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;   // let "open in new tab" work
  e.preventDefault();
  if (histSec && !histSec.hidden) closeHistory();
  showView('forecast');
  window.glettToTop();
});

/* Header mini summary (place, weather, temperature): visible only while the place heading is out of view */
(function () {
  const target = document.querySelector('.placehead'), mini = $('miniNow');
  const sync = (visible) => { const show = !visible && !!state.data && $('view-forecast').classList.contains('active'); mini.hidden = !show; document.body.classList.toggle('minion', show); };
  if ('IntersectionObserver' in window && target) {
    new IntersectionObserver((es) => sync(es[0].isIntersecting), { rootMargin: '-70px 0px 0px 0px' }).observe(target);
  }
  // smooth scroll can be cut short on iOS when the page re-renders underneath; finish the job if it stopped early
  const toTop = () => { window.scrollTo({ top: 0, behavior: 'smooth' }); setTimeout(() => { if (window.scrollY > 0) window.scrollTo(0, 0); }, 700); };
  mini.addEventListener('click', toTop);
  window.glettToTop = toTop;
})();

/* Phones: the header controls live behind a menu button (the same elements, shown as a drop-down panel) */
(function () {
  const btn = $('menuBtn'), bar = document.querySelector('.topbar');
  const set = (open) => { bar.classList.toggle('menu-open', open); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); set(!bar.classList.contains('menu-open')); });
  document.addEventListener('click', (e) => { if (bar.classList.contains('menu-open') && !e.target.closest('#topMenu') && !e.target.closest('#menuBtn')) set(false); });
  // an action in the menu (map page, what is Glett, language) closes it; the theme toggle keeps it open so the change is visible
  $('topMenu').addEventListener('click', (e) => { if (e.target.closest('.nav-btn, #aboutBtn, [data-lang]')) set(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  window.matchMedia('(min-width: 701px)').addEventListener('change', () => set(false));
})();

/* ================= Local map inside the now card: temperature field (Netatmo cells), radar animation, snow line on the terrain, MET warnings ================= */
const inNorwayLL = (lat, lon) => (lat >= 57.5 && lat <= 71.5 && lon >= 4 && lon <= 31.5) || (lat >= 70 && lat <= 81 && lon >= -10 && lon <= 35);
Object.assign(lm, { fld: null, fldDirty: false, relabelT: null, obsTiles: new Map(), obsPts: null, rainPts: null, windPts: null, fitDone: false, elevs: [], elevKeys: new Set(), elevBusy: false });
const lmDark = () => { const th = document.documentElement.getAttribute('data-theme'); return th === 'dark' || (th !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches); };
const lmReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || !!(navigator.connection && navigator.connection.saveData);

function lmAvail(layer) {
  if (!state.data) return false;
  if (layer === 'obs') return !!(state.local && state.local.ok && state.local.pts && state.local.pts.length);
  if (layer === 'rain') return !!(state.local && state.local.ok) && lmCells('rain').length >= 3;
  if (layer === 'wind') return !!(state.local && state.local.ok) && lmCells('wind').length >= 2;
  if (layer === 'alerts') return inNorwayLL(state.data.lat, state.data.lon);
  return true;   // the snow line: fetched when the layer is switched on
}
function lmSaveLayers() { lsSet('glett.lmap.layers', [...lm.layers].join(',')); }
function lmLayerOn(k) { lm.layers.add(k); if (k === 'obs' || k === 'rain' || k === 'wind') ['obs', 'rain', 'wind'].forEach((o) => { if (o !== k) lm.layers.delete(o); }); }   // one measured layer at a time
if (['obs', 'rain', 'wind'].filter((k) => lm.layers.has(k)).length > 1) { lm.layers.delete('rain'); lm.layers.delete('wind'); }
/* Open / close the map; `layer` (when given) is switched on as well */
function lmToggle(open, layer) {
  const el = $('heroMap');
  if (open == null) open = el.hidden;
  if (layer && open) { lmLayerOn(layer); lmSaveLayers(); }
  lm.open = open; el.hidden = !open;
  $('heroLocal').classList.toggle('open', open);
  const chev = $('heroLocal').querySelector('.lm-chev'); if (chev) chev.innerHTML = `${t(open ? 'lm.close' : 'lm.open')} <i>▾</i>`;
  if (!open) { if (bigId === 'heroMap') mapBig('heroMap', false); return; }
  lmInit(); lmRender();
}
function lmInit() {
  if (lm.map) return;
  const m = L.map('lmapCanvas', { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
  glettAttribution(m);
  const topo = new KartverketLayer({ maxZoom: 18, attribution: '<a href="https://www.kartverket.no/" target="_blank" rel="noopener">© Kartverket</a>' });
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>' });
  m._glettBase = { topo, osm };
  lm.map = m;
  // panes: base tiles 200 < temperature field 300 < overlays 400 (snow, warnings, place) < number labels 620
  [['lmField', 300, ''], ['lmLabels', 620, 'leaflet-zoom-hide']].forEach(([k, z, cls]) => { const p = m.createPane(k); p.style.zIndex = z; p.style.pointerEvents = 'none'; if (cls) p.classList.add(cls); });
  ['snow', 'alerts', 'obs', 'place'].forEach((k) => { lm.groups[k] = L.layerGroup().addTo(m); });
  m.on('zoomend', () => { lmRefitField(); lmRelabel(); lmObsExtend(); if (lm.layers.has('snow') && lm.snow && lm.elev) { lmRender(); lmSnowFollow(); } });
  m.on('moveend', () => { lmRefitField(); lmRelabel(); lmObsExtend(); if (lm.layers.has('snow') && lm.snow && lm.elev) { lmRender(); lmSnowFollow(); } });   // the fields follow the view; the snow caption describes the terrain in view
  m.on('click', lmObsTap);
}
/* The models' weighted temperature for the current hour (shown on the legend and in the readout) */
function lmModelNow() {
  const cols = columns(1), c = cols.find((x) => x.now) || cols.find((x) => !x.past) || cols[0];
  return wmean(wpairs('temperature_2m', (p) => agg(p, 'temperature_2m', c.a, c.b)));
}
const lmLocalUnix = (s, off) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13)) / 1000 - off;
const lmDayName = (unix, off) => new Date((unix + off) * 1000).toLocaleDateString(dateLocale(), { weekday: 'short', timeZone: 'UTC' });
const lmMinus = (s) => String(s).replace('-', '−');

function lmRender() {
  if (!lm.open || !lm.map || !state.data) return;
  const d = state.data, m = lm.map;
  if (!lm.center || lm.center[0] !== d.lat || lm.center[1] !== d.lon) {   // a new place: base layer, view, place marker, and every per-place layer dropped
    lm.center = [d.lat, d.lon];
    const { topo, osm } = m._glettBase, useTopo = inNorwayLL(d.lat, d.lon) && lsGet('glett.map') !== 'osm';
    if (useTopo) { if (m.hasLayer(osm)) m.removeLayer(osm); if (!m.hasLayer(topo)) topo.addTo(m); } else { if (m.hasLayer(topo)) m.removeLayer(topo); if (!m.hasLayer(osm)) osm.addTo(m); }
    m.setView([d.lat, d.lon], 10);
    lm.groups.place.clearLayers();
    lm.groups.place.addLayer(L.circleMarker([d.lat, d.lon], { radius: 7, weight: 2, className: 'lm-place', fillOpacity: 1 }).bindTooltip(esc(state.current.name.split(',')[0]), { className: 'lm-tip', direction: 'top' }));
    lm.fld = null; lm.groups.obs.clearLayers(); lm.obsTiles = new Map(); lm.obsPts = null; lm.rainPts = null; lm.windPts = null; lm.fitDone = false; lm.busyN = 0; lmBusy(0);
    $('lmRead').textContent = ''; $('lmBadge').hidden = true;
    lm.snowIdx = 0;
  }
  $('lmChips').innerHTML = LM_LAYERS.map((k) => { const ok = lmAvail(k); return `<button type="button" data-layer="${k}" aria-pressed="${ok && lm.layers.has(k) ? 'true' : 'false'}" ${ok ? '' : 'disabled'} title="${esc(t('lm.layer.' + k + '.tip'))}">${t('lm.layer.' + k)}</button>`; }).join('');
  const on = (k) => lm.layers.has(k) && lmAvail(k);
  const caps = [lmRenderField(lmMeasuredMode()), lmRenderSnow(on('snow')), lmRenderAlerts(on('alerts'))].filter(Boolean);
  $('lmapCanvas').classList.toggle('muted', !!lmMeasuredMode() || on('snow') || on('alerts'));
  // the slider steps the snow line through the hours
  const sl = $('lmSlider'), inp = sl.querySelector('input'), lab = sl.querySelector('b');
  const bd = $('lmBadge');
  if (on('snow') && lm.snow && !lm.snowErr) {
    sl.hidden = false; inp.min = '0'; inp.step = '1'; inp.max = String(lm.snowMax); inp.value = String(lm.snowIdx); lab.textContent = lm.snowLabel || '';
    sl.querySelector('.lm-sl-lbl').textContent = t('lm.layer.snow'); inp.setAttribute('aria-label', t('lm.snow.slider'));
    inp.oninput = () => { lm.snowIdx = +inp.value; lmRender(); };
    bd.hidden = false; bd.textContent = `${t('lm.layer.snow')} · ${lm.snowLabel || ''}`;
  } else { sl.hidden = true; bd.hidden = true; }
  $('lmCap').innerHTML = caps.length ? caps.map((x) => `<div>${x}</div>`).join('') : `<div>${t('lm.empty')}</div>`;
  setTimeout(() => m.invalidateSize(), 0);
}

/* --- Measured fields: temperature (fixed absolute colour scale in 1 °C classes, hairline isotherms, a heavy 0 °C line), rain last hour, wind now.
   One engine: inverse-distance weighting of the 1 km cells on a 100 m grid over the current view, class fills, numbers, tap readout --- */
const LM_T_STOPS = [[-40, '#1e0a3c'], [-30, '#2e1065'], [-25, '#4c1d95'], [-20, '#1d4ed8'], [-16, '#2563eb'], [-12, '#3b82f6'], [-8, '#60a5fa'], [-5, '#93c5fd'], [-2, '#bfdbfe'], [-0.001, '#dbeafe'],
  [0, '#ecfccb'], [3, '#d9f99d'], [6, '#bef264'], [9, '#fde047'], [12, '#fbbf24'], [15, '#fb923c'], [18, '#f97316'], [22, '#ef4444'], [26, '#dc2626'], [30, '#b91c1c'], [35, '#7f1d1d'], [45, '#450a0a']]
  .map(([v, h]) => [v, [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))]);
const LM_T_LUT = new Map();
function lmClassColour(k) {   // k = floor(T) -> [r, g, b] at the class midpoint, linear RGB between the stops
  if (LM_T_LUT.has(k)) return LM_T_LUT.get(k);
  const c = k + 0.5, s = LM_T_STOPS; let out = s[s.length - 1][1];
  if (c <= s[0][0]) out = s[0][1];
  else for (let i = 1; i < s.length; i++) if (c <= s[i][0]) { const f = (c - s[i - 1][0]) / (s[i][0] - s[i - 1][0]), A = s[i - 1][1], B = s[i][1]; out = A.map((v, j) => Math.round(v + (B[j] - v) * f)); break; }
  LM_T_LUT.set(k, out); return out;
}
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const LM_RAIN_BINS = [0.1, 0.5, 1, 2, 4, 8, 15], LM_RAIN_COL = ['#e5e7eb', '#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#1d4ed8', '#7c3aed', '#4c1d95'].map(hexRgb);
const LM_WIND_COL = ['#dcfce7', '#bbf7d0', '#86efac', '#fde047', '#fbbf24', '#fb923c', '#f97316', '#ef4444', '#dc2626', '#b91c1c', '#7f1d1d'].map(hexRgb);   // 2 m/s classes, 0-2 .. >= 20
// The three measured layers share the cell shape [lat, lon, altitude|null, value, n, ...]; value = °C, mm last hour, or km/h
const LM_MODES = {
  obs: { cls: (v) => Math.floor(v), colour: lmClassColour, iso: true, outlier: { 1: 4, 2: 5 }, fmt: (v) => lmMinus(fmt1(v)), stepWide: 8 },
  rain: { cls: (v) => LM_RAIN_BINS.filter((b) => v >= b).length, colour: (k) => LM_RAIN_COL[Math.max(0, Math.min(LM_RAIN_COL.length - 1, k))], iso: false, outlier: null, fmt: (v) => (v < 0.05 ? '0' : fmt1(v)), stepWide: 99 },
  wind: { cls: (v) => Math.max(0, Math.min(10, Math.floor(v / 3.6 / 2))), colour: (k) => LM_WIND_COL[Math.max(0, Math.min(LM_WIND_COL.length - 1, k))], iso: false, outlier: null, fmt: (v) => fmt(wv(v)), stepWide: 99 },
};
const lmCss = (mode, k) => `rgb(${LM_MODES[mode].colour(k).join(',')})`;
// R = search radius (km), IN/OUT = full / zero opacity distance from the nearest cell, CELL = grid step (km), MAX = grid side, DMIN = the weight plateaus this close to a cell
const LM_F = { R: 3.0, IN: 1.2, OUT: 2.4, CELL: 0.1, MAX: 500, ALPHA: 0.66, PAD: 2.6, DMIN: 0.35, VIEW_PAD: 0.35 };

/* Grid: modified-Shepard inverse-distance weighting (w = ((R-d)/(R·d))²·√n) over the view (padded), 100 m cells growing only when the view is huge, bucketed per 3 km */
function lmBuildField(src, mode) {
  const M = LM_MODES[mode], d = state.data, kx = 111.2 * Math.cos((d.lat * Math.PI) / 180), ky = 111.2, R = LM_F.R, R2 = R * R;
  const px_ = src.map((p) => (p[1] - d.lon) * kx), py_ = src.map((p) => (p[0] - d.lat) * ky);
  const wOf = (dd, n) => { const q = (R - dd) / (R * Math.max(dd, LM_F.DMIN)); return q * q * Math.sqrt(n); };
  const keep = src.map((p, i) => {   // leave-one-out guard (temperature only): one or two stations far off their neighbours (sun-baked wall, indoor unit) are dropped
    const lim = M.outlier && M.outlier[p[4]]; if (!lim) return true; let sw = 0, sv = 0, k = 0;
    src.forEach((q, j) => { if (j === i) return; const dd = Math.hypot(px_[j] - px_[i], py_[j] - py_[i]); if (dd >= R) return; const w = wOf(dd, q[4]); sw += w; sv += w * q[3]; k++; });
    return k < 3 || Math.abs(p[3] - sv / sw) <= lim;
  });
  const pts = src.filter((_, i) => keep[i]), xs = px_.filter((_, i) => keep[i]), ys = py_.filter((_, i) => keep[i]), ts = pts.map((p) => p[3]), ns = pts.map((p) => p[4]);
  const dataBox = { x0: Math.min(...xs) - LM_F.PAD, x1: Math.max(...xs) + LM_F.PAD, y0: Math.min(...ys) - LM_F.PAD, y1: Math.max(...ys) + LM_F.PAD };
  // the grid covers the padded view, clipped to where there are cells at all
  const vb = lm.map.getBounds().pad(LM_F.VIEW_PAD);
  const x0 = Math.max(dataBox.x0, (vb.getWest() - d.lon) * kx), x1 = Math.min(dataBox.x1, (vb.getEast() - d.lon) * kx), y0 = Math.max(dataBox.y0, (vb.getSouth() - d.lat) * ky), y1 = Math.min(dataBox.y1, (vb.getNorth() - d.lat) * ky);
  const empty = x1 <= x0 || y1 <= y0;
  const cell = empty ? LM_F.CELL : Math.max(LM_F.CELL, (x1 - x0) / LM_F.MAX, (y1 - y0) / LM_F.MAX), W = empty ? 1 : Math.ceil((x1 - x0) / cell), H = empty ? 1 : Math.ceil((y1 - y0) / cell);
  const bs = R, bw = Math.ceil((dataBox.x1 - dataBox.x0) / bs) + 2, bk = new Map();
  xs.forEach((x, i) => { const k = Math.floor((x - dataBox.x0) / bs) + bw * Math.floor((ys[i] - dataBox.y0) / bs); if (!bk.has(k)) bk.set(k, []); bk.get(k).push(i); });
  const tval = new Float32Array(W * H).fill(NaN), cls = new Int16Array(W * H), alp = new Float32Array(W * H);
  let tmin = Infinity, tmax = -Infinity;
  if (!empty) for (let j = 0; j < H; j++) {
    const y = y1 - (j + 0.5) * cell, by = Math.floor((y - dataBox.y0) / bs);   // image rows run north -> south
    for (let i = 0; i < W; i++) {
      const x = x0 + (i + 0.5) * cell, bx = Math.floor((x - dataBox.x0) / bs); let sw = 0, sv = 0, dmin = Infinity;
      for (let v = by - 1; v <= by + 1; v++) for (let u = bx - 1; u <= bx + 1; u++) {
        const b = bk.get(u + bw * v); if (!b) continue;
        for (const n of b) { const dx = xs[n] - x, dy = ys[n] - y, d2 = dx * dx + dy * dy; if (d2 >= R2) continue; const dd = Math.sqrt(d2); if (dd < dmin) dmin = dd; const w = wOf(dd, ns[n]); sw += w; sv += w * ts[n]; }
      }
      if (!sw || dmin > LM_F.OUT) continue;
      const o = j * W + i, tt = sv / sw; tval[o] = tt; cls[o] = M.cls(tt); alp[o] = dmin <= LM_F.IN ? 1 : (LM_F.OUT - dmin) / (LM_F.OUT - LM_F.IN);
      if (tt < tmin) tmin = tt; if (tt > tmax) tmax = tt;
    }
  }
  const allMin = ts.length ? Math.min(...ts) : NaN, allMax = ts.length ? Math.max(...ts) : NaN;
  return { src, mode, pts, W, H, cell, x0, x1, y0, y1, kx, ky, tval, cls, alp, min: tmin === Infinity ? allMin : tmin, max: tmax === -Infinity ? allMax : tmax, allMin, allMax,
    iso: M.iso && allMin < 0 && allMax > 0, step: allMax - allMin > M.stepWide ? 2 : 1, view: vb, zoom: lm.map.getZoom(),
    bounds: [[d.lat + y0 / ky, d.lon + x0 / kx], [d.lat + y1 / ky, d.lon + x1 / kx]], dataBounds: [[d.lat + dataBox.y0 / ky, d.lon + dataBox.x0 / kx], [d.lat + dataBox.y1 / ky, d.lon + dataBox.x1 / kx]], S: 0, overlay: null, labels: null };
}
/* Paint: class fills (nearest-neighbour upsample S), 1 px hairline where the class changes, 2 px navy line where the temperature crosses 0 */
function lmPaintField(f, S) {
  const M = LM_MODES[f.mode], W = f.W * S, H = f.H * S, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H), px = img.data, A = LM_F.ALPHA;
  const idx = (x, y) => ((y / S) | 0) * f.W + ((x / S) | 0);
  const ok = (x, y) => x >= 0 && y >= 0 && x < W && y < H && f.alp[idx(x, y)] > 0;
  const put = (x, y, c, a) => { const o = (y * W + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = Math.round(255 * a); };
  const INK = [15, 23, 42], ZERO = [30, 58, 138];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!ok(x, y)) continue;
    const o = idx(x, y), a = f.alp[o], k = f.cls[o];
    const kr = ok(x + 1, y) ? f.cls[idx(x + 1, y)] : k, kd = ok(x, y + 1) ? f.cls[idx(x, y + 1)] : k, st = f.step, band = (v) => Math.floor(v / st);
    const z = f.iso && ((k < 0) !== (kr < 0) || (k < 0) !== (kd < 0));
    if (!z && band(k) === band(kr) && band(k) === band(kd)) { put(x, y, M.colour(k), A * a); continue; }
    put(x, y, z ? ZERO : INK, (z ? 0.9 : 0.3) * a); if (z && x > 0) put(x - 1, y, ZERO, 0.9 * a);
  }
  ctx.putImageData(img, 0, 0); return cv.toDataURL();
}
function lmFieldScale(f) {   // image px per grid cell at the current zoom (1..4), image side at most 1200 px
  const mPerPx = (40075016 * Math.cos((state.data.lat * Math.PI) / 180)) / (256 * 2 ** lm.map.getZoom());
  return Math.min(4, Math.max(1, Math.round((f.cell * 1000) / mPerPx)), Math.floor(1200 / Math.max(f.W, f.H)) || 1);
}
/* After a pan or zoom: rebuild the grid when the view left the built area or the zoom changed, otherwise only repaint at the new scale */
function lmRefitField() {
  const f = lm.fld; if (!f || !f.overlay) return;
  const m = lm.map;
  if (!f.view.contains(m.getBounds()) || m.getZoom() !== f.zoom) { lm.fldDirty = true; lmRender(); return; }
  const S = lmFieldScale(f); if (S === f.S) return;
  f.S = S; f.overlay.setUrl(lmPaintField(f, S));
}
/* Numbers: the cell values, thinned per 48 x 40 px screen bucket and by box overlap; the nearest cell first, then the extremes, then by station count */
const lmMeasure = (() => { const c = document.createElement('canvas').getContext('2d'), cache = new Map(); return (txt, fs) => { const k = fs + txt; if (!cache.has(k)) { c.font = `600 ${fs}px Inter, system-ui, sans-serif`; cache.set(k, c.measureText(txt).width); } return cache.get(k); }; })();
function lmPlaceLabels(pts, mode) {
  const M = LM_MODES[mode], m = lm.map, d = state.data, size = m.getSize(), BW = 48, BH = 40, cols = Math.ceil(size.x / BW), taken = new Set(), boxes = [], out = [];
  if (!pts.length) return out;
  const dist = (p) => Math.hypot((p[0] - d.lat) * 111.2, (p[1] - d.lon) * 111.2 * Math.cos((d.lat * Math.PI) / 180));
  const pin = m.latLngToContainerPoint([d.lat, d.lon]);   // the place marker keeps a clear 24 px box around it
  let iHome = 0, iMin = 0, iMax = 0; pts.forEach((p, i) => { if (dist(p) < dist(pts[iHome])) iHome = i; if (p[3] < pts[iMin][3]) iMin = i; if (p[3] > pts[iMax][3]) iMax = i; });
  const rest = pts.map((_, i) => i).filter((i) => i !== iHome && i !== iMin && i !== iMax).sort((a, b) => pts[b][4] - pts[a][4] || dist(pts[a]) - dist(pts[b]));
  for (const i of [iHome, iMax, iMin, ...rest]) {
    if (out.length >= 48) break;
    const p = pts[i], c = m.latLngToContainerPoint([p[0], p[1]]); if (c.x < 0 || c.y < 0 || c.x > size.x || c.y > size.y) continue;
    const b = Math.floor(c.y / BH) * cols + Math.floor(c.x / BW); if (taken.has(b)) continue;
    const fs = 11.5, txt = M.fmt(p[3]), arrow = mode === 'wind' && p[5] != null, w = Math.ceil(lmMeasure(txt, fs)) + 8 + (arrow ? 14 : 0), h = Math.round(fs) + 6;
    const r = { x: c.x - w / 2 - 3, y: c.y - h / 2 - 3, w: w + 6, h: h + 6 };
    if (r.x < 2 || r.y < 2 || r.x + r.w > size.x - 2 || r.y + r.h > size.y - 2 || (r.x < 52 && r.y < 92)) continue;   // whole number inside the map, never clipped, never under the zoom buttons
    if (r.x < pin.x + 12 && r.x + r.w > pin.x - 12 && r.y < pin.y + 12 && r.y + r.h > pin.y - 12) continue;
    if (boxes.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y)) continue;
    boxes.push(r); taken.add(b);
    out.push(L.marker([p[0], p[1]], { pane: 'lmLabels', interactive: false, keyboard: false, icon: L.divIcon({ className: 'lm-lbl' + (p[4] === 1 ? ' one' : '') + (mode === 'rain' && p[3] < 0.05 ? ' dry' : ''), html: `<span>${arrow ? WI.arrow(p[5]) : ''}${txt}</span>`, iconSize: [w, h], iconAnchor: [w / 2, h / 2] }) }));
  }
  return out;
}
/* As the map is panned or zoomed out (down to zoom 8), station cells for the areas coming into view are fetched and merged into the fields.
   Netatmo thins its answer for big boxes, so the areas shrink with zoom: 55 km at zoom 8, 27 km at 9, 13 km from 10 in; at most 8 fetches per move */
const LM_TILES = [{ minZoom: 10, lat: 0.12, lon: 0.24, r: 0.06 }, { minZoom: 9, lat: 0.24, lon: 0.48, r: 0.12 }, { minZoom: 8, lat: 0.5, lon: 1.0, r: 0.25 }];
const lmMeasuredMode = () => ['obs', 'rain', 'wind'].find((k) => lm.layers.has(k) && lmAvail(k)) || null;
const lmRainShape = (r) => [r[0], r[1], null, r[2], r[3]], lmWindShape = (w) => [w[0], w[1], null, w[2], w[5], w[3], w[4]];
function lmCells(mode) {   // the cells of a mode in the shared shape [lat, lon, altitude|null, value, n, ...]; base arrays are built once per Netatmo answer
  if (lm.baseFor !== state.local) { lm.baseFor = state.local; const l = state.local || {}; lm.baseRain = (l.rain_pts || []).map(lmRainShape); lm.baseWind = (l.wind_pts || []).map(lmWindShape); }
  if (mode === 'obs') return lm.obsPts || (state.local && state.local.pts) || [];
  if (mode === 'rain') return lm.rainPts || lm.baseRain;
  if (mode === 'wind') return lm.windPts || lm.baseWind;
  return [];
}
/* A small "fetching measurements" pill on the map while areas are being loaded, so a quick pan does not look like nothing happens */
function lmBusy(delta) {
  lm.busyN = Math.max(0, (lm.busyN || 0) + delta);
  const el = $('lmBusy'); if (!el) return;
  if (lm.busyN) { el.innerHTML = `<span class="spinner small"></span> ${t('lm.fetching')}`; el.hidden = false; } else el.hidden = true;
}
async function lmObsExtend() {
  const m = lm.map; if (!m || !lmMeasuredMode() || m.getZoom() < 8) return;
  const T = LM_TILES.find((x) => m.getZoom() >= x.minZoom), b = m.getBounds(), c = m.getCenter(), want = [];
  for (let y = Math.floor(b.getSouth() / T.lat); y <= Math.floor(b.getNorth() / T.lat); y++)
    for (let x = Math.floor(b.getWest() / T.lon); x <= Math.floor(b.getEast() / T.lon); x++) {
      const key = `${T.r}:${y}:${x}`; if (lm.obsTiles.has(key)) continue;
      const lat = (y + 0.5) * T.lat, lon = (x + 0.5) * T.lon;
      want.push({ key, lat, lon, d: Math.hypot((lat - c.lat) * 111.2, (lon - c.lng) * 111.2 * Math.cos((c.lat * Math.PI) / 180)) });
    }
  want.sort((p, q) => p.d - q.d);
  const center = lm.center, batch = want.slice(0, 8);
  if (!batch.length) return;
  if (lm.busyN) return;   // one batch at a time; the next move picks up what is still missing
  batch.forEach((w) => lm.obsTiles.set(w.key, 'loading'));
  lmBusy(1);
  const got = [];
  try {
    for (const w of batch) { got.push(await WEFO.fetchLocalMap(w.lat, w.lon, T.r).catch(() => null)); if (center !== lm.center) return; }   // one at a time: gentle on the server and on Netatmo
  } finally { lmBusy(-1); }
  batch.forEach((w, i) => { if (got[i]) lm.obsTiles.set(w.key, got[i]); else lm.obsTiles.delete(w.key); });   // a failed area is tried again on the next move
  const merge = (base, key, shape) => { const seen = new Set(), out = []; const add = (p) => { const k = `${p[0]}:${p[1]}`; if (!seen.has(k)) { seen.add(k); out.push(p); } }; base.forEach(add); lm.obsTiles.forEach((tile) => { if (tile && tile !== 'loading') (tile[key] || []).map(shape).forEach(add); }); return out; };
  const before = lmCells('obs').length + lmCells('rain').length + lmCells('wind').length;
  lm.obsPts = merge((state.local && state.local.pts) || [], 'pts', (p) => p);
  lm.rainPts = merge(lm.baseRain || [], 'rain', lmRainShape);
  lm.windPts = merge(lm.baseWind || [], 'wind', lmWindShape);
  if (lm.obsPts.length + lm.rainPts.length + lm.windPts.length > before) { lm.fldDirty = true; lmRender(); }
}
function lmRelabel() {
  clearTimeout(lm.relabelT);
  lm.relabelT = setTimeout(() => { const f = lm.fld; if (!f || !f.labels || lmMeasuredMode() !== f.mode) return; f.labels.clearLayers(); lmPlaceLabels(f.pts, f.mode).forEach((l) => f.labels.addLayer(l)); }, 80);
}
/* A tap on the map: the field value there and the nearest real cell, as one line under the slider */
function lmObsTap(e) {
  const f = lm.fld, out = $('lmRead'); if (!f || lmMeasuredMode() !== f.mode) return;
  const M = LM_MODES[f.mode], m = lm.map, cp = e.containerPoint, d = state.data;
  const cellPx = Math.abs(m.latLngToContainerPoint([d.lat + 0.01, d.lon]).y - m.latLngToContainerPoint([d.lat, d.lon]).y);
  let best = null, bd = Math.max(16, cellPx / 2) ** 2;
  f.pts.forEach((p) => { const q = m.latLngToContainerPoint([p[0], p[1]]), dd = (q.x - cp.x) ** 2 + (q.y - cp.y) ** 2; if (dd < bd) { bd = dd; best = p; } });
  if (!best) { out.textContent = t('lm.obs.read.none'); return; }
  const km = fmt1(Math.hypot((best[0] - e.latlng.lat) * 111.2, (best[1] - e.latlng.lng) * f.kx));
  if (f.mode === 'rain') { out.textContent = t('lm.rain.read', { c: M.fmt(best[3]), n: best[4], km }); return; }
  if (f.mode === 'wind') { out.textContent = t('lm.wind.read', { c: M.fmt(best[3]), g: best[6] == null ? '–' : fmt(wv(best[6])), u: wu(), dir: best[5] == null ? '–' : t('dir.' + RING_DIRS8[Math.round(best[5] / 45) % 8]), n: best[4], km }); return; }
  const m0 = lmModelNow(), gx = Math.floor(((e.latlng.lng - d.lon) * f.kx - f.x0) / f.cell), gy = Math.floor((f.y1 - (e.latlng.lat - d.lat) * f.ky) / f.cell);
  const tv = gx >= 0 && gy >= 0 && gx < f.W && gy < f.H ? f.tval[gy * f.W + gx] : NaN, r = m0 == null ? 0 : best[3] - m0;
  const args = { t: lmMinus(fmt1(tv)), c: lmMinus(fmt1(best[3])), n: best[4], alt: best[2] == null ? '?' : best[2], km, d: (r >= 0 ? '+' : '−') + fmt1(Math.abs(r)) };
  out.textContent = t(Number.isNaN(tv) ? 'lm.obs.read.cell' : 'lm.obs.read', args);
}
function lmModelWindNow() {
  const cols = columns(1), c = cols.find((x) => x.now) || cols.find((x) => !x.past) || cols[0];
  return wmean(wpairs('wind', (p) => agg(p, 'wind_speed_10m', c.a, c.b)));
}
function lmRenderField(mode) {
  const g = lm.groups.obs;
  if (!mode) { g.clearLayers(); lm.fld = null; $('lmRead').textContent = ''; return null; }
  const M = LM_MODES[mode], pts = lmCells(mode);
  if (!lm.fld || lm.fld.src !== pts || lm.fld.mode !== mode || lm.fldDirty) {   // the grid is rebuilt for a new mode, new cells, or a view outside the built area
    lm.fldDirty = false;
    if (!lm.fitDone && pts.length) {   // once per place: sparse areas zoom out until the measurements are in view
      lm.fitDone = true; const f0 = lmBuildField(pts, mode); lm.map.fitBounds(L.latLngBounds(f0.dataBounds), { padding: [8, 8], maxZoom: 10, animate: false });
    }
    g.clearLayers(); const f = lm.fld = lmBuildField(pts, mode);
    f.S = lmFieldScale(f);
    f.overlay = L.imageOverlay(lmPaintField(f, f.S), f.bounds, { pane: 'lmField', interactive: false, className: 'lm-field' }); g.addLayer(f.overlay);
    f.labels = L.layerGroup().addTo(g); lmRelabel();
    $('lmRead').textContent = '';
  }
  const f = lm.fld, stations = pts.reduce((s, p) => s + p[4], 0);
  if (mode === 'rain') {
    const sw = LM_RAIN_COL.map((c, k) => `<i style="background:rgb(${c.join(',')})"></i>`).join(''), tk = ['0', ...LM_RAIN_BINS.map((b) => fmt1(b).replace(/,0$|\.0$/, ''))].map((v, k) => `<span style="left:${(k / LM_RAIN_COL.length) * 100}%">${v}</span>`).join('');
    return `<div class="lm-scale">${sw}<b class="lm-unit">mm</b></div><div class="lm-ticks lm-ticks-bins">${tk}</div><span class="lg"><i class="hatch"></i>${t('lm.obs.lg.nodata')}</span><div>${t('lm.rain.cap', { n: stations, c: pts.length })}</div>`;
  }
  if (mode === 'wind') {
    const w0 = lmModelWindNow(), n = LM_WIND_COL.length, sw = LM_WIND_COL.map((c) => `<i style="background:rgb(${c.join(',')})"></i>`).join('');
    const tk = LM_WIND_COL.map((_, k) => (k % 2 === 0 ? `<span style="left:${(k / n) * 100}%">${fmt(wv(k * 2 * 3.6))}</span>` : '')).join('');
    const tri = w0 != null ? `<em class="lm-tri" style="left:${Math.min(100, (w0 / 3.6 / 2 / n) * 100)}%"></em>` : '';
    return `<div class="lm-scale">${sw}${tri}<b class="lm-unit">${wu()}</b></div><div class="lm-ticks lm-ticks-bins">${tk}</div><span class="lg"><i class="tri"></i>${t('lm.wind.lg.model', { v: w0 == null ? '–' : fmt(wv(w0)), u: wu() })}</span><span class="lg"><i class="hatch"></i>${t('lm.obs.lg.nodata')}</span><div>${t('lm.wind.cap', { n: stations, c: pts.length, u: wu() })}</div>`;
  }
  const m0 = lmModelNow();
  let lo = Math.floor(f.allMin) - 1, hi = Math.ceil(f.allMax) + 1;   // legend window: at least 6 classes, at most 16; the colours themselves never stretch
  while (hi - lo < 6) { lo--; hi++; }
  if (hi - lo > 16) { const mid = Math.round((f.allMin + f.allMax) / 2); lo = mid - 8; hi = mid + 8; }
  const n = hi - lo, every = n <= 8 ? 1 : 2, sw = [], tk = [];
  for (let k = lo; k < hi; k++) { sw.push(`<i style="background:${lmCss('obs', k)}"></i>`); if ((k - lo) % every === 0 || k === 0) tk.push(`<span style="left:${((k - lo) / n) * 100}%">${lmMinus(String(k))}</span>`); }
  const tri = m0 != null && m0 >= lo && m0 <= hi ? `<em class="lm-tri" style="left:${((m0 - lo) / n) * 100}%" title="${esc(t('lm.obs.lg.model', { m: fmt1(m0) }))}"></em>` : '';
  const legend = `<div class="lm-scale">${sw.join('')}${tri}<b class="lm-unit">°C</b></div><div class="lm-ticks">${tk.join('')}</div>` +
    `<span class="lg"><i class="tri"></i>${t('lm.obs.lg.model', { m: m0 == null ? '–' : lmMinus(fmt1(m0)) })}</span>` +
    (f.iso ? `<span class="lg"><i class="iso"></i>${t('lm.obs.lg.zero')}</span>` : '') + `<span class="lg"><i class="hatch"></i>${t('lm.obs.lg.nodata')}</span>`;
  let words = '';   // lowland vs higher ground, split at the median altitude when the terrain spread is real (>= 100 m between the halves)
  const withAlt = f.pts.filter((p) => p[2] != null).sort((a, b) => a[2] - b[2]);
  if (withAlt.length >= 6) {
    const half = Math.floor(withAlt.length / 2), low = withAlt.slice(0, half), high = withAlt.slice(withAlt.length - half);
    const ma = (arr, i) => arr.reduce((s, p) => s + p[i], 0) / arr.length;
    const aLo = Math.round(ma(low, 2) / 10) * 10, aHi = Math.round(ma(high, 2) / 10) * 10, tLo = ma(low, 3), tHi = ma(high, 3);
    if (aHi - aLo >= 100) words = tHi - tLo >= 1 ? t('lm.obs.inv', { a: aLo, b: aHi, ta: lmMinus(fmt1(tLo)), tb: lmMinus(fmt1(tHi)) }) : t('lm.obs.lapse', { a: aLo, b: aHi, d: fmt1(tLo - tHi) });
  }
  const area = state.local.temp ? lmMinus(fmt1(state.local.temp.v)) : '–';   // the figure in the 'Målt nå' line above: the robust average of every station around the place
  return `${legend}<div>${t('lm.obs.cap', { n: stations, c: pts.length, a: area, m: m0 == null ? '–' : lmMinus(fmt1(m0)) })}</div>${words ? `<b>${words}</b>` : ''}`;
}

/* --- Snow line: terrain shaded white where every model's snow line lies below it, light blue where only some do --- */
async function lmEnsureSnow() {
  const d = state.data, key = `${d.lat}:${d.lon}`;
  if (lm.snowKey === key) return;
  lm.snowKey = key; lm.snow = null; lm.elev = null; lm.elevs = []; lm.elevKeys = new Set(); lm.snowErr = null;
  try {
    const [snow, elev] = await Promise.all([WEFO.fetchSnowline(d.lat, d.lon), WEFO.fetchElevGrid(d.lat, d.lon)]);
    if (lm.snowKey !== key) return;
    lm.snow = snow; lm.elev = elev; lm.elevs = [elev]; lm.elevKeys.add(`${Math.round(d.lat * 20) / 20}:${Math.round(d.lon * 20) / 20}`);
    if (lm.map && lm.layers.has('snow')) lm.map.fitBounds([[elev.south, elev.west], [elev.north, elev.east]], { padding: [4, 4], animate: false });   // the shaded terrain fills the map
  } catch (e) { if (lm.snowKey !== key) return; lm.snowErr = e && e.message ? e.message : String(e); }
  lmRender();
}
/* Terrain range of the grid points inside the current view, over every loaded grid (the first grid's whole range when the view holds none) */
function lmElevInView() {
  const b = lm.map.getBounds(); let mn = Infinity, mx = -Infinity;
  for (const e of lm.elevs) { const N = e.n;
    for (let i = 0; i < N; i++) { const lat = e.south + ((e.north - e.south) * i) / (N - 1); if (lat < b.getSouth() || lat > b.getNorth()) continue;
      for (let k = 0; k < N; k++) { const lon = e.west + ((e.east - e.west) * k) / (N - 1); if (lon < b.getWest() || lon > b.getEast()) continue; const z = e.elev[i * N + k]; if (z < mn) mn = z; if (z > mx) mx = z; } } }
  const e0 = lm.elevs[0] || lm.elev;
  return mn === Infinity ? { min: e0.min, max: e0.max, all: true } : { min: mn, max: mx, all: false };
}
/* When the view has moved beyond the loaded terrain, fetch the grid for the area under the map centre (4 elevation calls, stored for good) */
async function lmSnowFollow() {
  if (!lm.map || !lm.layers.has('snow') || !lm.snow || !lm.elevs.length || lm.elevBusy) return;
  const c = lm.map.getCenter(), key = `${Math.round(c.lat * 20) / 20}:${Math.round(c.lng * 20) / 20}`;
  if (lm.elevKeys.has(key) || lm.elevs.some((e) => c.lat > e.south + 0.02 && c.lat < e.north - 0.02 && c.lng > e.west + 0.04 && c.lng < e.east - 0.04)) return;
  lm.elevKeys.add(key); lm.elevBusy = true; const snowKey = lm.snowKey;
  try { const e = await WEFO.fetchElevGrid(c.lat, c.lng); if (lm.snowKey === snowKey) { lm.elevs.push(e); lmRender(); } }
  catch (err) { /* out of quota or offline: the loaded terrain stays */ }
  finally { lm.elevBusy = false; }
}
function lmRenderSnow(on) {
  const g = lm.groups.snow; g.clearLayers(); if (!on) return null;
  if (lm.snowErr) return t('lm.snow.err', { e: esc(lm.snowErr) });
  if (!lm.snow || !lm.elev) { lmEnsureSnow(); return `<span class="spinner small"></span> ${t('lm.snow.loading')}`; }
  const s = lm.snow, e = lm.elev, nowS = Date.now() / 1000, times = s.time.map((x) => lmLocalUnix(x, s.offset));
  let i0 = times.findIndex((x) => x + 3600 > nowS); if (i0 < 0) i0 = 0;
  lm.snowMax = Math.max(0, Math.min(47, times.length - 1 - i0));
  lm.snowIdx = clamp(lm.snowIdx, 0, lm.snowMax);
  const i = i0 + lm.snowIdx, lines = s.models.map((mm) => mm.fl[i]).filter((v) => v != null).map((v) => Math.max(0, v - SNOW_OFFSET_M));
  const when = lm.snowIdx === 0 ? t('lm.when.now') : t('lm.when.at', { day: lmDayName(times[i], s.offset), h: fmtTime(times[i] * 1000) });
  lm.snowLabel = lm.snowIdx === 0 ? t('lm.when.now') : `${lmDayName(times[i], s.offset)} ${fmtTime(times[i] * 1000)}`;
  if (!lines.length) return t('lm.snow.err', { e: '–' });
  const lo = Math.round(Math.min(...lines) / 10) * 10, hi = Math.round(Math.max(...lines) / 10) * 10, precip = s.models.some((mm) => (mm.pr[i] || 0) >= 0.1);
  for (const e of lm.elevs) g.addLayer(lmSnowOverlay(e, lo, hi));
  const v = lmElevInView();   // what is on screen right now, so the sentence follows the panning
  const cap = hi <= v.min ? t('lm.snow.all', { when, lo }) : lo > v.max ? t('lm.snow.none', { when, lo }) : t('lm.snow.cap', { when, lo, hi, n: lines.length });
  return `<span class="lg"><i style="background:#e2f0ff;border-color:#1e3a8a"></i>${t('lm.snow.lg.sure')}</span><span class="lg"><i style="background:#60a5fa;border-color:#1e3a8a"></i>${t('lm.snow.lg.maybe')}</span> ${cap}${precip ? '' : ' ' + t('lm.snow.noprecip')} ${t(v.all ? 'lm.snow.terrain.all' : 'lm.snow.terrain', { min: Math.round(v.min), max: Math.round(v.max) })}`;
}
/* One shaded overlay per elevation grid: snow-white where every model gives snow, medium blue where they disagree, a 2 px navy line on every boundary */
function lmSnowOverlay(e, lo, hi) {
  const N = e.n, W = N * 8, cv = document.createElement('canvas'); cv.width = W; cv.height = W;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(W, W), px = img.data, cls = new Uint8Array(W * W);
  const ev = (r, c) => e.elev[clamp(r, 0, N - 1) * N + clamp(c, 0, N - 1)];   // grid rows run south -> north, canvas rows north -> south
  for (let y = 0; y < W; y++) {
    const gr = ((W - 1 - y) * (N - 1)) / (W - 1), r0 = Math.floor(gr), fr = gr - r0;
    for (let x = 0; x < W; x++) {
      const gc = (x * (N - 1)) / (W - 1), c0 = Math.floor(gc), fc = gc - c0;
      const z = (ev(r0, c0) * (1 - fr) + ev(r0 + 1, c0) * fr) * (1 - fc) + (ev(r0, c0 + 1) * (1 - fr) + ev(r0 + 1, c0 + 1) * fr) * fc;
      cls[y * W + x] = z >= hi ? 2 : z >= lo ? 1 : 0;
    }
  }
  // fills: snow-white with a blue tint where every model gives snow, medium blue where they disagree; a 2 px navy line on every boundary
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= W ? cls[Math.min(W - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))] : cls[y * W + x]);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const k = cls[y * W + x], o = (y * W + x) * 4;
    const edge = k !== at(x + 1, y) || k !== at(x, y + 1) || k !== at(x - 1, y) || k !== at(x, y - 1);
    if (edge) { px[o] = 30; px[o + 1] = 58; px[o + 2] = 138; px[o + 3] = 235; }
    else if (k === 2) { px[o] = 226; px[o + 1] = 240; px[o + 2] = 255; px[o + 3] = 220; }
    else if (k === 1) { px[o] = 96; px[o + 1] = 165; px[o + 2] = 250; px[o + 3] = 165; }
  }
  ctx.putImageData(img, 0, 0);
  return L.imageOverlay(cv.toDataURL(), [[e.south, e.west], [e.north, e.east]], { interactive: false });
}

/* --- MET warnings: polygons near the place, and for the place itself the warning next to the model split in its window --- */
async function loadAlerts(loc, token) {
  state.alerts = null; lm.alertsHere = [];
  if (!inNorwayLL(loc.lat, loc.lon)) return;
  const j = await WEFO.fetchAlerts(LANG);
  if (token !== state.token) return;
  state.alerts = j; lmAlertsHere();
  renderSummary(); if (lm.open) lmRender();
}
function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const xi = ring[i][0], yi = ring[i][1], xk = ring[k][0], yk = ring[k][1];
    if ((yi > lat) !== (yk > lat) && lon < ((xk - xi) * (lat - yi)) / (yk - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInGeom(lat, lon, g) {
  if (!g) return false;
  if (g.type === 'Polygon') return pointInRing(lat, lon, g.coordinates[0]) && !g.coordinates.slice(1).some((h) => pointInRing(lat, lon, h));
  if (g.type === 'MultiPolygon') return g.coordinates.some((poly) => pointInRing(lat, lon, poly[0]) && !poly.slice(1).some((h) => pointInRing(lat, lon, h)));
  if (g.type === 'GeometryCollection') return (g.geometries || []).some((x) => pointInGeom(lat, lon, x));
  return false;
}
function geomBBox(g, box = [Infinity, Infinity, -Infinity, -Infinity]) {   // [minLon, minLat, maxLon, maxLat]
  const walk = (c) => { if (typeof c[0] === 'number') { box[0] = Math.min(box[0], c[0]); box[1] = Math.min(box[1], c[1]); box[2] = Math.max(box[2], c[0]); box[3] = Math.max(box[3], c[1]); } else c.forEach(walk); };
  if (g.type === 'GeometryCollection') (g.geometries || []).forEach((x) => geomBBox(x, box)); else if (g.coordinates) walk(g.coordinates);
  return box;
}
function lmAlertsHere() {
  const d = state.data, a = state.alerts;
  lm.alertsHere = d && a ? a.alerts.filter((x) => pointInGeom(d.lat, d.lon, x.geometry)).sort((p, q) => (LEVEL_RANK[q.level] || 0) - (LEVEL_RANK[p.level] || 0)) : [];
}
const lmAlertWhen = (x) => { const f = (s) => (s ? new Date(s).toLocaleString(dateLocale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '?'); return `${f(x.from)} – ${f(x.to)}`; };
/* What the active models say inside the warning window: wind (max hourly mean) or precipitation (sum), with the count above MET's trigger level */
function lmAlertModels(x) {
  const d = state.data; if (!x.from || !x.to) return '';
  const from = Date.parse(x.from) / 1000, to = Date.parse(x.to) / 1000, idx = [];
  d.time.forEach((s, i) => { const u = lmLocalUnix(s, d.utc_offset_seconds); if (u >= from && u < to) idx.push(i); });
  if (!idx.length) return '';
  const a = idx[0], b = idx[idx.length - 1] + 1, provs = activeProviders(), thr = parseFloat(String(x.trigger).replace(',', '.'));
  if (x.type === 'wind') {
    const vals = nn(provs.map((p) => { const v = nn(p.hourly.wind_speed_10m.slice(a, b)); return v.length ? Math.max(...v) : null; }));
    if (!vals.length) return '';
    const ms = vals.map((v) => v / 3.6), lo = fmt(wv(Math.min(...vals))), hi = fmt(wv(Math.max(...vals)));
    if (Number.isFinite(thr) && /m\/s/.test(x.trigger)) return t('lm.alert.wind', { lo, hi, u: wu(), k: ms.filter((v) => v >= thr).length, n: vals.length, thr: fmt(wv(thr * 3.6)) });
    const gv = nn(provs.map((p) => agg(p, 'gust', a, b)));
    return t('lm.alert.wind.nothr', { lo, hi, u: wu(), g: gv.length ? fmt(wv(Math.max(...gv))) : '–' });
  }
  if (x.type === 'rain' || x.type === 'snow' || x.type === 'snow-ice' || x.event === 'rain' || x.event === 'snow') {
    const pr = wpairs('precip', (p) => agg(p, 'precip', a, b)), vals = pr.map((p) => p.v);
    if (!vals.length) return '';
    let s = t('lm.alert.rain', { lo: fmt(Math.min(...vals)), hi: fmt(Math.max(...vals)), v: fmt(wmean(pr)) });
    if (Number.isFinite(thr) && /mm/.test(x.trigger)) s += t('lm.alert.rain.thr', { k: vals.filter((v) => v >= thr).length, n: vals.length, thr: fmt(thr) });
    return s;
  }
  return '';
}
function lmRenderAlerts(on) {
  const g = lm.groups.alerts; g.clearLayers(); if (!on) return null;
  const a = state.alerts; if (!a) return t('lm.alerts.loading');
  const d = state.data, colour = { yellow: '#eab308', orange: '#f97316', red: '#dc2626', green: '#16a34a' };
  a.alerts.forEach((x) => {   // only warnings whose extent comes within about 150 km of the place
    const bb = geomBBox(x.geometry); if (bb[0] > d.lon + 3 || bb[2] < d.lon - 3 || bb[1] > d.lat + 1.5 || bb[3] < d.lat - 1.5) return;
    const c = colour[x.level] || '#94a3b8', marine = x.domain === 'marine';
    const layer = L.geoJSON(x.geometry, { style: { color: c, weight: marine ? 2 : 3, dashArray: marine ? '6 6' : null, fillColor: c, fillOpacity: marine ? .22 : .38 } });
    layer.bindPopup(`<b>${esc(x.name)}, ${t('lm.level.' + x.level)} ${t('lm.level.word')}</b><br>${esc(x.area)}<br><small>${lmAlertWhen(x)}</small><br>${esc(x.desc)}`, { maxWidth: 280 });
    g.addLayer(layer);
  });
  const here = lm.alertsHere;
  const list = here.length
    ? here.map((x) => { const mdl = lmAlertModels(x); return `<div class="lm-alert ${esc(x.level)}"><b>${esc(x.name)}</b>, ${t('lm.level.' + x.level)} ${t('lm.level.word')} · ${lmAlertWhen(x)}${x.domain === 'marine' ? ` · ${t('lm.alert.marine')}` : ''}<small>${esc(x.desc)}</small>${mdl ? `<small><b>${esc(mdl)}</b></small>` : ''}</div>`; }).join('')
    : `<div class="lm-alert none">${t('lm.alerts.none')}</div>`;
  return `${t('lm.alerts.cap')}<div class="lm-alerts">${list}</div>`;
}
$('lmChips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-layer]'); if (!b || b.disabled) return;
  const k = b.dataset.layer;
  if (lm.layers.has(k)) lm.layers.delete(k); else lmLayerOn(k);
  lmSaveLayers(); lmRender();
});
$('heroLocal').addEventListener('click', () => { if ($('heroLocal').classList.contains('lm-link')) lmToggle(null, 'obs'); });
$('heroLocal').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && $('heroLocal').classList.contains('lm-link')) { e.preventDefault(); lmToggle(null, 'obs'); } });

/* ================= Radar map under the radar strip: MET Norway's 1 km composite (THREDDS WMS, a frame every 5 minutes) in the Nordic area,
   RainViewer's 10-minute composite elsewhere. Frames are stacked tile layers, switched by opacity; nothing is interpolated or extrapolated ================= */
const inNordic = (lat, lon) => lat >= 54 && lat <= 72.5 && lon >= -2 && lon <= 33;
const rm = { open: false, map: null, group: null, place: null, frames: [], idx: -1, timer: null, token: 0, src: null, center: null, err: false, busy: false, resume: false, visible: true, lastRefresh: 0, ncBack: 0, ncBad: new Set() };
const RM = {
  metBase: 'https://thredds.met.no/thredds/wms/remotesensing/reflectivity-nordic/latest/',
  metFile: (d) => `yrwms-nordic.mos.pcappi-0-dbz.noclass-clfilter-novpr-clcorr-block.nordiclcc-1000.${d}.nc`,
  metParams: { layers: 'lwe_precipitation_rate', styles: 'default-scalar/x-Rainbow', format: 'image/png', transparent: true, version: '1.3.0', colorscalerange: '0.1,40', logscale: true, numcolorbands: 250, belowmincolor: 'transparent' },
  ncBase: 'https://thredds.met.no/thredds/wms/radarnowcasting/',   // MET's radar nowcast: one file per 5-minute issue, 24 steps (2 h) inside, served by time
  ncFile: (d) => `yrwms-nordic.mos.pcappi-0-rr.noclass-clfilter-novpr-clcorr-block.nordiclcc-1000.${d}.nc`, ncSteps: 18,
  rvHost: 'https://tilecache.rainviewer.com', rvTile: (h, p) => `${h}${p}/512/{z}/{x}/{y}/2/1_1.png`,
  stepMs: 470, holdMs: 1600, loops: 3, staleMin: 20, lagMin: 5,   // about 45 % slower than the first cut (user's call)
  n: () => (matchMedia('(min-width: 700px)').matches && !(navigator.connection && navigator.connection.saveData) ? 12 : 7), alpha: () => (lmDark() ? 0.72 : 0.82),
};
/* MET's 90-minute nowcast for the place in one sentence (the "Radar neste 2 timer" strip stays the forecast surface) */
function lmHereLine() {
  const nc = state.nowcast; if (!nc || !nc.series || !nc.series.length) return null;
  const nowS = Date.now() / 1000, s = nc.series.filter((p) => p.t >= nowS - 300).slice(0, 19), wet = (p) => p.rate >= 0.1; if (!s.length) return null;
  const now = wet(s[0]), flip = s.find((p) => wet(p) !== now);
  return { wetNow: now, text: t(flip ? (now ? 'lm.radar.here.until' : 'lm.radar.here.from') : (now ? 'lm.radar.here.on' : 'lm.radar.here.dry'), { h: flip ? fmtTime(flip.t * 1000) : '' }) };
}
const rmSlotName = (unix) => { const d = new Date(unix * 1000); const p = (v) => String(v).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`; };
/* The entry button when the radar strip is hidden (no MET nowcast here): a plain "Vis nedbørradar" line */
function rmSyncEntry() {
  const b = $('radarOpen'); if (!b) return;
  b.hidden = !state.data || !$('radarStrip').hidden;
  b.setAttribute('aria-expanded', rm.open ? 'true' : 'false'); b.querySelector('span').textContent = t(rm.open ? 'rm.close' : 'rm.open');
  const sb = document.querySelector('#radarStrip .rs-mapbtn'); if (sb) { sb.textContent = t(rm.open ? 'rm.close' : 'rm.open'); sb.setAttribute('aria-expanded', rm.open ? 'true' : 'false'); }
}
function rmToggle(open) {
  const el = $('radarMap');
  if (open == null) open = el.hidden;
  rm.open = open; el.hidden = !open;
  rmSyncEntry();
  if (!open) { rmStop(); rm.frames.forEach((f) => { if (f.layer) { rm.group.removeLayer(f.layer); f.layer = null; } }); if (bigId === 'radarMap') mapBig('radarMap', false); return; }
  rmInit(); rmRender();
  if (open) setTimeout(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
}
function rmInit() {
  if (rm.map) return;
  const m = L.map('rmapCanvas', { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
  glettAttribution(m);
  const topo = new KartverketLayer({ maxZoom: 18, attribution: '<a href="https://www.kartverket.no/" target="_blank" rel="noopener">© Kartverket</a>' });
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>' });
  m._glettBase = { topo, osm };
  const pane = m.createPane('rmRadar'); pane.style.zIndex = 350; pane.style.pointerEvents = 'none'; pane.classList.add('lm-radar-pane');
  rm.map = m; rm.group = L.layerGroup().addTo(m); rm.place = L.layerGroup().addTo(m);
  if ('IntersectionObserver' in window) new IntersectionObserver((es) => { rm.visible = es[0].isIntersecting; if (!rm.visible) { if (rm.timer) { rm.resume = true; rmStop(); } } else if (rm.resume) { rm.resume = false; rmPlay(1); } }, { threshold: 0.2 }).observe($('rmapCanvas'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (rm.timer) { rm.resume = true; rmStop(); } } else if (rm.open) rmRefresh(); });
  setInterval(() => { if (rm.open && rm.frames.length && !document.hidden && rm.visible && Date.now() / 1000 - rm.lastRefresh > 240) rmRefresh(); }, 60000);
}
function rmRender() {
  if (!rm.open || !rm.map || !state.data) return;
  const d = state.data, m = rm.map;
  if (!rm.center || rm.center[0] !== d.lat || rm.center[1] !== d.lon) {   // a new place: base layer, view, place marker, frames dropped
    rm.center = [d.lat, d.lon];
    const { topo, osm } = m._glettBase, useTopo = inNorwayLL(d.lat, d.lon) && lsGet('glett.map') !== 'osm';
    if (useTopo) { if (m.hasLayer(osm)) m.removeLayer(osm); if (!m.hasLayer(topo)) topo.addTo(m); } else { if (m.hasLayer(topo)) m.removeLayer(topo); if (!m.hasLayer(osm)) osm.addTo(m); }
    m.setView([d.lat, d.lon], 7);   // a radar wants the region, not the town
    rm.place.clearLayers();
    rm.place.addLayer(L.circleMarker([d.lat, d.lon], { radius: 7, weight: 2, className: 'lm-place', fillOpacity: 1 }).bindTooltip(esc(state.current.name.split(',')[0]), { className: 'lm-tip', direction: 'top' }));
    rmStop(); rm.group.clearLayers(); rm.frames = []; rm.idx = -1; rm.err = false; rm.token++; rm.ncBad = new Set(); $('rmBadge').hidden = true;
  }
  $('rmapCanvas').classList.add('muted');
  // MET's 90-minute nowcast for the place as one pill, and a pulsing marker while it rains here
  const here = state.nowcast && state.nowcast.model ? null : lmHereLine();   // only the marker pulse while the radar sees rain here; the strip above says when
  rm.place.eachLayer((l) => { const el = l.getElement && l.getElement(); if (el) el.classList.toggle('wet', !!(here && here.wetNow)); });
  const met = inNordic(d.lat, d.lon);
  const lg = (met ? [['#0043ff', 'rm.lg.light'], ['#05fef9', 'rm.lg.mod'], ['#ff8300', 'rm.lg.heavy'], ['#c60000', 'rm.lg.severe']] : [['#00a3e0', 'rm.lg.light'], ['#005588', 'rm.lg.mod'], ['#ffaa00', 'rm.lg.heavy'], ['#c10000', 'rm.lg.severe']])
    .map(([c, k]) => `<span class="lg"><i style="background:${c}"></i>${t(k)}</span>`).join('');
  const near = state.nowcast && state.nowcast.series && state.nowcast.series.length ? radarNearby(Date.now() / 1000, Date.now() / 1000 + 5400) : '';
  let cap;
  if (rm.err) cap = t('rm.err');
  else if (!rm.frames.length) { rmRefresh(); if (rm.frames.length) return rmRender(); cap = `<span class="spinner small"></span> ${t('rm.loading')}`; }   // MET frames are listed synchronously
  else {
    const li = rmLastObs(), last = rm.frames[li >= 0 ? li : rm.frames.length - 1], age = Math.round((Date.now() / 1000 - last.t) / 60), fc = rm.frames.filter((f) => f.fc);
    cap = t(met ? 'rm.cap.met' : 'rm.cap.rv', { h: fmtTime(last.t * 1000), mins: Math.round((last.t - rm.frames[0].t) / 60) }) + (age > RM.staleMin ? ` <b>${t('rm.stale', { m: age })}</b>` : '')
      + (fc.length ? ` ${t('rm.cap.fc', { m: Math.round((fc[fc.length - 1].t - last.t) / 60) })}` : '');
  }
  $('rmCap').innerHTML = `${lg}<div>${cap}</div>${near ? `<div>${near}</div>` : ''}`;
  const sl = $('rmSlider'), inp = sl.querySelector('input'), play = $('rmPlay');
  play.setAttribute('aria-label', t(rm.timer ? 'lm.radar.pause' : 'lm.radar.play'));
  if (rm.frames.length > 1) { sl.hidden = false; inp.min = '0'; inp.step = '1'; inp.max = String(rm.frames.length - 1); inp.oninput = () => rmSeek(+inp.value, true); play.onclick = () => (rm.timer ? rmStop() : rmPlay()); rmSeek(rm.idx < 0 ? rm.frames.length - 1 : rm.idx); }
  else sl.hidden = true;
  setTimeout(() => m.invalidateSize(), 0);
}
/* Build (or top up) the frame list: MET slots every 5 minutes back from a few minutes ago, RainViewer's published frames elsewhere.
   A MET slot that does not exist yet answers its tiles with an error and is dropped; the newest slot that loads is "siste". */
async function rmRefresh() {
  if (rm.busy || !rm.map || !state.data) return;
  const token = ++rm.token, d = state.data, met = inNordic(d.lat, d.lon), center = rm.center; rm.busy = true;
  try {
    let wanted = [];
    if (met) {
      const slot = Math.floor(Date.now() / 1000 / 300) * 300 - RM.lagMin * 60;
      for (let i = 0; i < RM.n() + 2; i++) wanted.push({ t: slot - i * 300, key: rmSlotName(slot - i * 300) });
      wanted.reverse();
      // nowcast: the newest issue whose tiles load (issues that are not published yet are skipped), steps after the newest observed slot
      let issue = slot; while (rm.ncBad.has(rmSlotName(issue)) && slot - issue < 6 * 300) issue -= 300;
      const issueKey = rmSlotName(issue);
      if (!rm.ncBad.has(issueKey)) for (let k = 1; k <= RM.ncSteps; k++) { const tt = issue + k * 300; if (tt > slot) wanted.push({ t: tt, key: `nc:${issueKey}:${tt}`, fc: true, issueKey }); }
    }
    else {
      const meta = await WEFO.fetchRadarFrames();
      if (token !== rm.token || center !== rm.center) return;
      if (!meta || meta.host !== RM.rvHost) { rm.err = true; rm.frames = []; rm.group.clearLayers(); rmRender(); return; }
      wanted = meta.frames.slice(-RM.n()).map((f) => ({ t: f.t, key: f.path }));
    }
    rm.err = false; rm.lastRefresh = Date.now() / 1000;
    const have = new Map(rm.frames.map((f) => [f.key, f])), frames = [];
    for (const w of wanted) { const f = have.get(w.key); if (f && !f.bad) frames.push(f); else if (!f) frames.push({ t: w.t, key: w.key, fc: !!w.fc, issueKey: w.issueKey || null, met, layer: null, ok: false, bad: false }); }
    rm.frames.forEach((f) => { if (!frames.includes(f) && f.layer) { rm.group.removeLayer(f.layer); f.layer = null; } });
    const prevLast = rmLastObs(), wasLast = rm.idx < 0 || rm.idx === prevLast, keep = rm.idx;
    rm.frames = frames; rm.idx = -1;
    const nowLast = rmLastObs();
    rmSeek(wasLast ? (nowLast >= 0 ? nowLast : frames.length - 1) : Math.min(Math.max(0, keep), frames.length - 1));
    if (!have.size && !lmReduced()) {   // first load: play once the newest observed frame is in (or after 3 s)
      const t0 = Date.now(), wait = () => { if (rm.token !== token) return; const li = rmLastObs(); if ((li >= 0 && rm.frames[li].ok) || Date.now() - t0 > 3000) rmPlay(RM.loops); else setTimeout(wait, 150); };
      wait();
    }
  } finally { rm.busy = false; }
  rmRender();
}
const RM_WINDOW = 2;   // frames on each side of the current one that exist as layers
function rmLayerFor(f) {
  if (f.layer || f.bad) return;
  const attribution = f.met ? '<a href="https://www.met.no/" target="_blank" rel="noopener">© Meteorologisk institutt</a>' : '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>';
  const common = { pane: 'rmRadar', opacity: 0, keepBuffer: 0, updateWhenIdle: true, updateWhenZooming: false, attribution };
  f.layer = f.met
    ? (f.fc
      ? L.tileLayer.wms(RM.ncBase + RM.ncFile(f.issueKey), { ...RM.metParams, time: new Date(f.t * 1000).toISOString(), maxNativeZoom: 12, maxZoom: 18, ...common })
      : L.tileLayer.wms(RM.metBase + RM.metFile(f.key), { ...RM.metParams, maxNativeZoom: 12, maxZoom: 18, ...common }))
    : L.tileLayer(RM.rvTile(RM.rvHost, f.key), { tileSize: 512, zoomOffset: -1, maxNativeZoom: 8, maxZoom: 18, ...common });
  f.layer.on('tileload', () => { f.ok = true; });
  f.layer.on('tileerror', () => { if (!f.ok && !f.bad) { f.bad = true; if (f.fc) rmDropIssue(f.issueKey); else rmDrop(f); } });
  rm.group.addLayer(f.layer);
}
function rmWindow(i) {
  rm.frames.forEach((f, k) => {
    if (Math.abs(k - i) <= RM_WINDOW) rmLayerFor(f);
    else if (f.layer && Math.abs(k - i) > RM_WINDOW + 2) { rm.group.removeLayer(f.layer); f.layer = null; }
  });
}
function rmDropIssue(issueKey) {   // a nowcast issue that is not published yet: all its frames go, and the refresh falls back to the previous issue
  if (rm.ncBad.has(issueKey)) return;
  rm.ncBad.add(issueKey);
  rm.frames.filter((f) => f.fc && f.issueKey === issueKey).forEach((f) => { if (f.layer) rm.group.removeLayer(f.layer); });
  rm.frames = rm.frames.filter((f) => !(f.fc && f.issueKey === issueKey));
  if (rm.idx >= rm.frames.length) rm.idx = -1;
  setTimeout(() => rmRefresh(true), 0);
}
function rmDrop(f) {   // a frame whose tiles all fail (a MET slot that is not published yet, or is missing): removed from the sequence
  const i = rm.frames.indexOf(f); if (i < 0) return;
  if (f.layer) rm.group.removeLayer(f.layer);
  rm.frames.splice(i, 1);
  if (rm.idx >= rm.frames.length) rm.idx = -1;
  if (rm.frames.length) { rmRender(); }
}
const rmLastObs = () => { let k = -1; rm.frames.forEach((f, i) => { if (!f.fc) k = i; }); return k; };
function rmFrameLabel(i) {
  const f = rm.frames[i], last = rmLastObs(), tl = last >= 0 ? rm.frames[last].t : f.t, m = Math.round((f.t - tl) / 60);
  return `${t('lm.radar.at', { h: fmtTime(f.t * 1000) })} · ${f.fc ? t('rm.fc', { m }) : i === last ? t('lm.radar.latest') : t('lm.radar.ago', { m: -m })}`;
}
function rmSeek(i, byUser) {
  const n = rm.frames.length; if (!n) return; i = Math.min(n - 1, Math.max(0, Math.round(i)));
  rmWindow(i);
  if (i !== rm.idx) { if (rm.idx >= 0 && rm.frames[rm.idx] && rm.frames[rm.idx].layer) rm.frames[rm.idx].layer.setOpacity(0); if (rm.frames[i].layer) rm.frames[i].layer.setOpacity(RM.alpha()); rm.idx = i; }
  const last = rmLastObs(), f = rm.frames[i], stale = last >= 0 && (Date.now() / 1000 - rm.frames[last].t) / 60 > RM.staleMin, lab = rmFrameLabel(i);
  const sl = $('rmSlider'), inp = sl.querySelector('input'), b = sl.querySelector('b');
  if (!byUser) inp.value = String(i);
  b.textContent = lab; b.classList.toggle('stale', stale); b.classList.toggle('est', !!f.fc);
  const bd = $('rmBadge'); bd.hidden = false; bd.textContent = lab; bd.classList.toggle('latest', i === last); bd.classList.toggle('stale', stale); bd.classList.toggle('est', !!f.fc);
  if (byUser) rmStop();
}
function rmPlay(loops = Infinity) {
  rmStop(); if (rm.frames.length < 2) return;
  $('rmPlay').setAttribute('aria-pressed', 'true'); $('rmPlay').setAttribute('aria-label', t('lm.radar.pause'));
  let done = 0;
  let waited = 0;
  const tick = () => {
    if (!rm.open || rm.frames.length < 2) return rmStop();
    const n = rm.frames.length, i = (rm.idx + 1) % n, f = rm.frames[i];
    rmLayerFor(f);
    if (!f.ok && !f.bad && waited < 2500) { waited += 150; rm.timer = setTimeout(tick, 150); return; }   // give the next frame's tiles a moment
    waited = 0;
    rmSeek(i);
    const last = rmLastObs();
    if (i === n - 1 && ++done >= loops) { rmSeek(last >= 0 ? last : n - 1); return rmStop(); }   // rest on the newest observed frame
    rm.timer = setTimeout(tick, i === n - 1 || i === last ? RM.holdMs : RM.stepMs);
  };
  rm.timer = setTimeout(tick, rm.idx === rm.frames.length - 1 ? RM.holdMs : RM.stepMs);
}
function rmStop() { clearTimeout(rm.timer); rm.timer = null; const b = $('rmPlay'); if (b) { b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', t('lm.radar.play')); } }
$('radarOpen').addEventListener('click', () => rmToggle(null));

/* ================= "Bigger map": on wide screens an open map panel moves into the right column over the hour table, and back ================= */
const bigMQ = window.matchMedia('(min-width: 1000px)');
let bigId = null;
const BIG_ICON = { grow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>', shrink: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10h-6V4M14 10l7-7M4 14h6v6M10 14l-7 7"/></svg>' };
function mapBigLabels() {
  document.querySelectorAll('.lm-bigbtn').forEach((b) => { const on = bigId === b.dataset.big; b.innerHTML = `${BIG_ICON[on ? 'shrink' : 'grow']}<span>${t(on ? 'lm.small' : 'lm.big')}</span>`; b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.hidden = !bigMQ.matches; });
}
function mapBig(id, on) {
  const panel = $(id), host = $('bigMap');
  if (on && !bigMQ.matches) return;
  if (on && bigId && bigId !== id) mapBig(bigId, false);
  if (on) {
    if (bigId === id) return;
    panel._home = { parent: panel.parentElement, next: panel.nextSibling };
    host.appendChild(panel); host.hidden = false; $('hoursCard').hidden = true; panel.classList.add('big'); bigId = id;
  } else {
    if (bigId !== id) return;
    panel._home.parent.insertBefore(panel, panel._home.next); panel.classList.remove('big');
    host.hidden = true; $('hoursCard').hidden = false; bigId = null;
  }
  mapBigLabels();
  const m = id === 'heroMap' ? lm.map : rm.map;
  if (m) setTimeout(() => { m.invalidateSize(); if (id === 'heroMap') { lmRefitField(); lmRelabel(); lmObsExtend(); } else if (rm.frames.length) rmSeek(rm.idx); }, 60);
  if (on) setTimeout(() => window.scrollTo({ top: host.getBoundingClientRect().top + window.scrollY - 84, behavior: 'smooth' }), 80);   // keep the chips and the button below the sticky header
}
document.querySelectorAll('.lm-bigbtn').forEach((b) => b.addEventListener('click', () => mapBig(b.dataset.big, bigId !== b.dataset.big)));
bigMQ.addEventListener('change', () => { if (!bigMQ.matches && bigId) mapBig(bigId, false); mapBigLabels(); });
mapBigLabels();
