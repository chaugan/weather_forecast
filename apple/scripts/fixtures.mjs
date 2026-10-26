#!/usr/bin/env node
// Golden fixtures for GlettKit: the web's own forecast maths run under node on recorded API responses.
// Usage: node scripts/fixtures.mjs                 (= expect) read Fixtures/raw/*, write Fixtures/expected/*.json
//        node scripts/fixtures.mjs record          fetch fresh responses from Open-Meteo and MET into Fixtures/raw/
//        node scripts/fixtures.mjs record-verify   record only the reliability runs (raw/verify/), keep the rest
// Nothing here re-implements the maths: js/data.js and js/icons.js are loaded whole in a node 'vm' context with a stub
// browser, and the pieces of js/app.js (top-level functions, and statements inside renderHero/buildRows/renderSummary)
// are cut out of the file by name or by anchor text and evaluated in the same context. If an anchor no longer
// matches, the script stops with the anchor that failed: update the anchor, never copy the formula here.
// Fixtures/README.md describes the output format.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const JS = path.join(ROOT, 'js');
const FIX = path.join(ROOT, 'apple/GlettKit/Tests/GlettKitTests/Fixtures');
const RAW = path.join(FIX, 'raw');
const EXP = path.join(FIX, 'expected');
const UA = 'Glett-iOS/0.1 (+https://glett.no; mail@hauganmg.no)';
const FORMAT = 1;

const PLACES = [
  { slug: 'oslo', name: 'Oslo', lat: 59.91, lon: 10.75 },
  { slug: 'bergen', name: 'Bergen', lat: 60.39, lon: 5.32 },
  { slug: 'tromso', name: 'Tromsø', lat: 69.65, lon: 18.96 },
  { slug: 'finse', name: 'Finse', lat: 60.60, lon: 7.50 },
  { slug: 'london', name: 'London', lat: 51.51, lon: -0.13 },
];
const NOWCAST_ORDER = ['bergen', 'oslo', 'tromso', 'finse'];   // the first one where it rains at the centre is recorded
const NOWCAST_ABROAD = 'london';                                  // outside MET's radar: the Open-Meteo 15-minute fallback
const STEPS = [1, 3, 6, 12];
const AGG_FIELDS = ['temperature_2m', 'apparent_temperature', 'precip', 'wind_speed_10m', 'gust', 'dir', 'cloud_cover', 'relative_humidity_2m', 'pressure_msl', 'cape', 'code'];
const AGREE_PARAMS = ['temperature_2m', 'wind_speed_10m', 'cloud_cover', 'relative_humidity_2m', 'pressure_msl'];
const WEIGHT_KEYS = ['weather', 'temperature_2m', 'precip', 'wind', 'storm', 'cloud_cover', 'relative_humidity_2m', 'pressure_msl'];
const VERIFY_PLACES = ['oslo', 'london'];   // Frost + Netatmo in Norway; ERA5 + METAR elsewhere
const DAY_OFFSETS = [0, 7, 15];             // hours after the forecast's 'now' at which the day cards and today's lines are evaluated
const GLETT = 'https://glett.no/';          // data.js calls glett.no with relative URLs (api/frost.php …)

/* ================= Cutting pieces out of the JS files ================= */
const readJs = (f) => fs.readFileSync(path.join(JS, f), 'utf8');
const APP = readJs('app.js').split('\n');
const ICONS = readJs('icons.js').split('\n');
const sources = {};   // name -> "js/app.js:123-130", written next to the expected files
const ref = (file, a, b) => `js/${file}:${a + 1}${b - 1 > a ? '-' + b : ''}`;

// A top-level statement starts in column 0 and runs until the next line that starts in column 0 with anything but a closer
const isTopStart = (l) => /^[^\s})\]]/.test(l);
function topEnd(lines, s) { let e = s + 1; while (e < lines.length && !isTopStart(lines[e])) e++; while (e > s + 1 && !lines[e - 1].trim()) e--; return e; }
function topDecl(name) {
  const exact = new RegExp(`^(?:(?:async\\s+)?function\\s+${name}\\b|(?:const|let)\\s+${name}\\b)`);
  const multi = new RegExp(`^(?:const|let)\\s.*,\\s*${name}\\s*=`);
  let hits = APP.map((l, i) => (exact.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!hits.length) hits = APP.map((l, i) => (multi.test(l) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) throw new Error(`app.js: top-level '${name}' found ${hits.length} times`);
  const s = hits[0], e = topEnd(APP, s);
  sources[name] = ref('app.js', s, e);
  return { s, e, text: APP.slice(s, e).join('\n') };
}
function fnRange(name) {
  const s = APP.findIndex((l) => new RegExp(`^(?:async\\s+)?function\\s+${name}\\b`).test(l));
  if (s < 0) throw new Error(`app.js: function ${name} not found`);
  return [s, topEnd(APP, s)];
}
// One statement line inside a function, found by anchor text (optionally the first one after another anchor)
function lineIn(fn, anchor, after = null, label = null) {
  const [s, e] = fnRange(fn);
  let from = s;
  if (after) { from = APP.findIndex((l, i) => i >= s && i < e && l.includes(after)); if (from < 0) throw new Error(`app.js ${fn}: anchor '${after}' not found`); }
  const hits = [];
  for (let i = from; i < e; i++) if (APP[i].includes(anchor)) hits.push(i);
  if (!hits.length || (!after && hits.length > 1)) throw new Error(`app.js ${fn}: anchor '${anchor}' found ${hits.length} times`);
  const i = hits[0];
  if (label) sources[label] = ref('app.js', i, i + 1);
  return { i, text: APP[i] };
}
// A multi-line block inside a function: from the anchor line to the closing line at the same indentation
function blockIn(fn, anchor, label) {
  const { i } = lineIn(fn, anchor);
  const ind = APP[i].match(/^\s*/)[0];
  let e = i + 1; while (e < APP.length && !(APP[e].startsWith(ind + '}'))) e++;
  sources[label] = ref('app.js', i, e + 1);
  return APP.slice(i, e + 1).join('\n');
}
// A function nested in an IIFE (icons.js): from its 'function' line to the matching closing brace
function nestedFn(lines, file, name) {
  const s = lines.findIndex((l) => new RegExp(`^\\s*function\\s+${name}\\(`).test(l));
  if (s < 0) throw new Error(`${file}: function ${name} not found`);
  const ind = lines[s].match(/^\s*/)[0];
  let e = s + 1; while (e < lines.length && lines[e] !== ind + '}') e++;
  sources[`WI.${name}`] = ref(file, s, e + 1);
  return lines.slice(s, e + 1).join('\n');
}
const span = (a, b) => `js/app.js:${Math.min(a, b) + 1}-${Math.max(a, b) + 1}`;

/* ================= A browser, just enough of one ================= */
function makeContext(fetchImpl) {
  const clock = { ms: Date.now() };
  const RealDate = Date;
  class FixedDate extends RealDate {   // 'now' is whatever the fixture says it is
    constructor(...a) { if (a.length) super(...a); else super(clock.ms); }
    static now() { return clock.ms; }
  }
  const store = new Map(), elements = {}, tlog = [];
  const el = () => ({ innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {}, title: '', classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }) });
  const document = { body: { insertAdjacentHTML() {}, appendChild() {} }, getElementById: (id) => (elements[id] ||= el()), createElement: () => el(),
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
  const sandbox = {
    console, URL, Response, Date: FixedDate, document, navigator: {}, location: { href: 'https://glett.no/', hash: '' },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    fetch: fetchImpl, setTimeout: () => 0, clearTimeout() {},
    // i18n: every t() call is recorded as {key, params} and returns '{key}', so the fixtures carry keys, not texts
    t: (key, params) => { tlog.push({ key, params: params ? { ...params } : null }); return `{${key}}`; },
    hasT: () => false, dateLocale: () => 'nb-NO',
    // app.js:930 formats with toLocaleTimeString; here the "formatted" time is the unix second, so params.h is a number
    fmtTime: (ms) => ms / 1000,
    cell: (html) => html,
    __tlog: tlog,
  };
  sandbox.window = sandbox;   // no window.indexedDB: data.js keeps its cache in memory; no window.OMGate: plain fetch
  sandbox.$ = (id) => document.getElementById(id);
  const ctx = vm.createContext(sandbox);
  const run = (code, filename) => vm.runInContext(code, ctx, { filename });
  run(readJs('icons.js'), 'js/icons.js');
  run(readJs('data.js'), 'js/data.js');
  sources['WEFO.fetchForecast'] = 'js/data.js:176-207 (yrCode :125-137, yrProvider :140-173)';
  sources['WEFO.fetchNowcast'] = 'js/data.js:677-718';
  sources['WEFO.fetchVerify'] = 'js/data.js:295-373';
  sources['WI.category'] = 'js/icons.js:64-75';
  sources['WI.CAT_CODE'] = 'js/icons.js:76';
  const wanted = ['clamp', 'nn', 'mean', 'fmt', 'uniqueProviders', 'activeProviders', 'deriveCode', 'prepare', 'circMean', 'agg', 'TOL', 'RAIN_THR', 'WIND_THR', 'GUST_THR',
    'STRONG_GUST', 'agreementPill', 'columns', 'weightsOn', 'W', 'SHORT_BOOST_IDS', 'aggLastA', 'nowIdx', 'shortBoost', 'wpairs', 'wsum', 'wmean', 'wshare',
    'weatherShares', 'rainChance', 'gustMean', 'lmHereLine', 'windMs', 'wv', 'wu', 'todayIndex', 'dayCategory', 'timeOfDay'];
  const seen = new Set(), parts = [];
  for (const n of wanted) { const d = topDecl(n); if (!seen.has(d.s)) { seen.add(d.s); parts.push(d.text); } }
  run('var state = { data: null, verify: null, weighted: true, disabled: new Set(), step: 1, nowcast: null, windUnit: "kmh" };\n' + parts.join('\n'), 'js/app.js (extracted)');
  run(`var __iconKey = (${nestedFn(ICONS, 'icons.js', 'key')});`, 'js/icons.js key()');

  // renderHero (app.js ~1070-1085): the now column, the weighted means and the five-dot verdict, statement for statement
  const H = (a, label) => lineIn('renderHero', a, null, label);
  const hCol = H('const cols = columns(1), c = cols.find', 'heroColumn');
  const h1 = H('const shares = weatherShares(c), temp', 'shares+temp'), h2 = H('g = gustMean(c), dd = nn(activeProviders()', 'wind+gust+dirs');
  const h3 = H('const top = shares ? shares[0] : null;'), h4 = H('const feels = wmean(', 'feels'), h5 = H('kTop = top ? Math.round(');
  const v1 = H('const nAll = activeProviders().length, k = Math.round(top[1] * nAll)', 'verdict.level'), v2 = H('const tv = nn(activeProviders()', 'verdict.temps');
  const v3 = H("$('heroVerdict').innerHTML =", 'verdict.dots');
  sources.verdict = span(v1.i, v3.i);
  run(`var __heroCol = function () { ${hCol.text}\n return c; };
var __hero = function (c) {
${h1.text}\n${h2.text}\n${h3.text}\n${h4.text}\n${h5.text}
  let verdict = null;
  if (top) {
    __tlog.length = 0;
${v1.text}\n${v2.text}\n${v3.text}
    verdict = { level, k, nAll, tv, html: $('heroVerdict').innerHTML, t: __tlog.slice() };
  }
  return { shares, temp, ws, g, dd, top, feels, nAll0, kTop, verdict };
};`, 'js/app.js renderHero (extracted)');

  // buildRows (app.js ~277-410): rain mean, wind chance + gust %, thunder signal + chance, agreement of continuous parameters
  const B = (a, after, label) => lineIn('buildRows', a, after, label);
  const mm = B("const pr = rainChance(c), mm = wmean(wpairs('precip'", "summaryLabel = t('g.twr')", 'precipMean');
  const wAfter = "probLabel = t('g.prob_wind'";
  const w1 = B('const v = nn(P.map', wAfter), w2 = B('if (!v.length) return', wAfter), w3 = B("const pr = wshare(wpairs('wind'", wAfter, 'windChance'),
    w4 = B("const g = nn(P.map((p) => agg(p, 'gust'", wAfter), w5 = B('const gp = ', wAfter, 'gustPct');
  const signal = blockIn('buildRows', 'const signal = (p, c) => {', 'thunderSignal');
  const sAfter = "probLabel = t('g.prob_storm')";
  const s1 = B("const pw = wpairs('storm'", sAfter), s2 = B('if (!pw.length) return', sAfter), s3 = B('const pr = wmean(pw);', sAfter, 'thunderChance');
  const aAfter = "probLabel = t('g.agree')";
  const a1 = B('const v = nn(P.map((p) => agg(p, param, c.a, c.b)));', aAfter), a2 = B('const sd = v.length > 1', aAfter, 'agreement.sd'),
    a3 = B('agreementPill(v, TOL[param])', aAfter, 'agreement.pill');
  run(`var __precipMean = function (c) { ${mm.text}\n return mm; };
var __wind = function (c) { const P = activeProviders(); __tlog.length = 0;
${w1.text}\n${w2.text}\n${w3.text}\n${w4.text}\n${w5.text}
  return { pr, g, t: __tlog.slice() };
};
var __signal = (function () { ${signal}\n return signal; })();
var __storm = function (c) { const signal = __signal;
${s1.text}\n${s2.text}\n${s3.text}
  return pr;
};
var __agree = function (c, param) { const P = activeProviders();
${a1.text}\n${a2.text}
  const html = (() => { ${a3.text} })();
  return { v, sd, html };
};`, 'js/app.js buildRows (extracted)');

  // renderSummary (app.js ~955-962): the "Neste glett" radar sentence
  const R = (a, label) => lineIn('renderSummary', a, null, label);
  const n0 = R('const nc = state.nowcast && state.nowcast.series;'), n1 = R('const nowS = Date.now() / 1000, s = nc.filter'), n2 = R('const wet = (p) => p.rate >= 0.1, rainingNow'),
    n3 = R('const change = s.findIndex('), n4 = R('const blip = '), n5 = R('const txt = rainingNow ?');
  sources.nowcastSummary = span(n0.i, n5.i);
  run(`var __ncSummary = function () { __tlog.length = 0;
${n0.text}\n  if (!(nc && nc.length)) return null;
${n1.text}\n  if (!s.length) return null;
${n2.text}\n${n3.text}\n${n4.text}\n${n5.text}
  return { rainingNow, change, changeT: change > 0 ? s[change].t : null, blipT: blip ? blip.t : null, t: __tlog.slice() };
};
var __ncHere = function () { __tlog.length = 0; const r = lmHereLine(); return r && { wetNow: r.wetNow, t: __tlog.slice() }; };`, 'js/app.js renderSummary (extracted)');

  // renderDays (app.js ~890-921): one day card's values, statement for statement
  const D = (a) => lineIn('renderDays', a);
  const dl = ['const a = d * 24, b = Math.min(a + 24', 'const ni = nowIdx(), r0 = ', 'const cnt = {};', "wpairs('weather', (p) => dayCategory(", 'const top = Object.entries(cnt)',
    'const ext = (fn) => wmean(', 'const hi = ext(Math.max), lo = ext(Math.min);', "const rp = wshare(wpairs('precip'", 'const rain = rp == null ? null', "const sp = wshare(wpairs('storm'",
    'const storm = sp == null ? 0', "const mm = wmean(wpairs('precip'", "const gust = wmean(wpairs('wind'", 'const dry = mm == null || mm < 0.5;'].map(D);
  sources.dayCard = span(dl[0].i, dl[dl.length - 1].i);
  run(`var __day = function (d) { const { data } = state;
${dl.map((x) => x.text).join('\n')}
  return { top: top ? top[0] : null, hi, lo, rp, rain, sp, storm, mm, gust, rest, dry };
};`, 'js/app.js renderDays (extracted)');

  // renderSummary (app.js ~931-953): today's rain line and gust line
  const O = (a) => lineIn('renderSummary', a);
  const o0 = O('const sumDay = todayIndex();'), o1 = O('const all = columns(1, sumDay), cols = '), o2 = O('const partial = cols.length < all.length;'),
    o3 = O('const rain = cols.map((c) => ({ c, p: rainChance(c) }))'), o4 = O('const maxP = Math.max(...rain.map'), o5 = O('const first = rain.find((x) => x.p >= 0.5);'),
    o6 = O('if (maxP < 0.2) txt = t(partial'), o7 = O('else if (first && first === rain[0]) txt'), o8 = O("else if (first) txt = t('s.rain.from'"), o9 = O("else txt = t('s.rain', { p: pct });"),
    o10 = O('const gusts = cols.map((c) => ({ c, g: gustMean(c) }))'), o11 = O('const top = gusts.reduce('), o12 = O('if (top.g >= STRONG_GUST) items.push(');
  sources.todayOutlook = span(o0.i, o12.i);
  run(`var __outlook = function () { const items = []; let rainOut = null, gustOut = null;
${o0.text}\n${o1.text}\n${o2.text}
  if (cols.length) {
${o3.text}
    if (rain.length) { __tlog.length = 0;
${o4.text}\n${o5.text}
      let txt;
${o6.text}\n${o7.text}\n${o8.text}\n${o9.text}
      const tx = __tlog[__tlog.length - 1];
      rainOut = { maxP, pct, firstA: first ? first.c.a : null, firstHour: first ? first.c.hour : null, key: tx.key, h: tx.params && tx.params.h != null ? tx.params.h : null };
    }
${o10.text}
    if (gusts.length) { __tlog.length = 0;
${o11.text}\n${o12.text}
      const tx = __tlog.find((x) => x.key === 's.wind'), tod = __tlog.find((x) => x.key.startsWith('s.tod.'));
      gustOut = { g: top.g, a: top.c.a, hour: top.c.hour, shown: !!tx, strong: top.g >= GUST_THR, v: tx ? tx.params.v : null, tod: tod ? tod.key : null };
    }
  }
  return { partial, rain: rainOut, gust: gustOut };
};`, 'js/app.js renderSummary outlook (extracted)');

  const get = (name) => run(name, 'get');
  return { ctx, clock, run, get, elements };
}

/* ================= record ================= */
const writeJson = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj) + '\n'); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const unixOf = (iso) => Date.parse(iso) / 1000;

async function record() {
  const log = [];
  const live = async (url) => {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const text = await res.text();
    log.push({ url, status: res.status, text });
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
  };
  const env = makeContext(live);
  const recordedAt = new Date();
  const forecastNow = Math.floor(recordedAt.getTime() / 3600e3) * 3600;   // the hour the forecast was fetched in
  env.clock.ms = recordedAt.getTime();
  fs.rmSync(RAW, { recursive: true, force: true });
  const manifest = { format: FORMAT, recordedAt: recordedAt.toISOString(), userAgent: UA, forecastNow, places: [], nowcast: [] };
  const WEFO = env.get('WEFO');
  for (const pl of PLACES) {
    log.length = 0;
    const data = await WEFO.fetchForecast(pl.lat, pl.lon);
    const om = log.find((x) => x.url.startsWith('https://api.open-meteo.com/v1/forecast'));
    const met = log.find((x) => x.url.startsWith('https://api.met.no/weatherapi/locationforecast'));
    if (!om || om.status !== 200) throw new Error(`${pl.slug}: Open-Meteo failed`);
    const omFile = `${pl.slug}.openmeteo.json`, metFile = `${pl.slug}.met.json`;
    fs.mkdirSync(RAW, { recursive: true });
    fs.writeFileSync(path.join(RAW, omFile), om.text.trim() + '\n');
    const entry = { ...pl, openMeteo: { url: om.url, status: om.status, file: omFile }, met: null };
    if (met && met.status >= 200 && met.status < 300) {
      // trim MET's ~10 days to the 7-day axis (entries after the last hour of the axis are never read by yrProvider)
      const j = JSON.parse(met.text), last = Math.max(...data.time.map((s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13)) / 1000 - data.utc_offset_seconds));
      const before = j.properties.timeseries.length;
      j.properties.timeseries = j.properties.timeseries.filter((p) => unixOf(p.time) <= last + 6 * 3600);
      writeJson(path.join(RAW, metFile), j);
      entry.met = { url: met.url, status: met.status, file: metFile, trimmedFrom: before, kept: j.properties.timeseries.length };
    } else console.warn(`${pl.slug}: MET locationforecast ${met ? met.status : 'missing'}; Yr left out`);
    manifest.places.push(entry);
    console.log(`recorded ${pl.slug}: ${data.providers.length} providers, ${data.time.length} hours`);
  }
  // Nowcast: probe the centres, then record the whole fetchNowcast (centre + 8 ring points) for the first wet one
  let pick = null;
  for (const slug of NOWCAST_ORDER) {
    const pl = PLACES.find((p) => p.slug === slug);
    const r = await fetch(`https://api.met.no/weatherapi/nowcast/2.0/complete?lat=${pl.lat.toFixed(4)}&lon=${pl.lon.toFixed(4)}`, { headers: { 'User-Agent': UA } });
    if (!r.ok) continue;
    const j = await r.json(), wet = j.properties.timeseries.some((p) => (p.data.instant.details.precipitation_rate ?? 0) >= 0.1);
    console.log(`nowcast probe ${slug}: ${wet ? 'wet' : 'dry'}`);
    if (wet) { pick = slug; break; }
  }
  const ncPlaces = [pick || NOWCAST_ORDER[0], NOWCAST_ABROAD];
  for (const slug of ncPlaces) {
    const pl = PLACES.find((p) => p.slug === slug);
    log.length = 0;
    const t0 = new Date();
    env.clock.ms = t0.getTime();
    const nc = await WEFO.fetchNowcast(pl.lat, pl.lon);
    const files = log.map((x, k) => {   // bodies verbatim (a 422 outside the radar may not be JSON)
      let isJson = true; try { JSON.parse(x.text); } catch (e) { isJson = false; }
      const file = `nowcast/${slug}.${k}.${isJson ? 'json' : 'txt'}`;
      fs.mkdirSync(path.join(RAW, 'nowcast'), { recursive: true });
      fs.writeFileSync(path.join(RAW, file), x.text.trim() + '\n');
      return { url: x.url, status: x.status, file };
    });
    manifest.nowcast.push({ ...pl, now: Math.floor(t0.getTime() / 60e3) * 60, wet: slug === pick || (nc && nc.series.some((p) => p.rate >= 0.1)), model: !!(nc && nc.model), requests: files });
    console.log(`recorded nowcast ${slug}: ${files.length} requests, ${nc ? nc.series.length : 0} points${nc && nc.model ? ' (model fallback)' : ''}`);
  }
  if (!pick) console.warn('no rain at any Nordic centre: the recorded nowcast is dry; the synthetic series cover the wet cases');
  writeJson(path.join(RAW, 'manifest.json'), manifest);
  await recordVerify();
}

// The reliability check (WEFO.fetchVerify) for VERIFY_PLACES, every request it makes recorded verbatim into raw/verify/
async function recordVerify() {
  const file = path.join(RAW, 'manifest.json'), manifest = readJson(file);
  fs.rmSync(path.join(RAW, 'verify'), { recursive: true, force: true });
  manifest.verify = [];
  for (const slug of VERIFY_PLACES) {
    const pl = PLACES.find((p) => p.slug === slug), log = [];
    const live = async (url) => {
      const abs = new URL(url, GLETT);
      const headers = { 'User-Agent': UA, Accept: 'application/json', ...(abs.host === 'glett.no' ? { 'X-Glett-Client': 'ios/fixtures' } : {}) };
      const res = await fetch(abs.href, { headers });
      const text = await res.text();
      log.push({ url: abs.href, status: res.status, text });
      console.log(`  ${res.status} ${abs.href.slice(0, 120)} (${text.length} bytes)`);
      return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
    };
    const env = makeContext(live);
    const now = Math.floor(Date.now() / 1000);
    env.clock.ms = now * 1000;
    const result = await env.get('WEFO').fetchVerify(pl.lat, pl.lon);
    fs.mkdirSync(path.join(RAW, 'verify'), { recursive: true });
    const requests = log.map((x, k) => {
      const f = `verify/${slug}.${k}.json`;
      fs.writeFileSync(path.join(RAW, f), x.text.trim() + '\n');
      return { url: x.url, status: x.status, file: f };
    });
    manifest.verify.push({ ...pl, now, truth: result.truth, requests });
    console.log(`recorded verify ${slug}: ${result.truth}, ${result.hours} hours, ${Object.keys(result.models).length} models, ${requests.length} requests`);
  }
  writeJson(file, manifest);
}

/* ================= expect ================= */
// Synthetic reliability weights: deterministic, inside the web's [0.5, 1.8], one model without an entry and one weight 0
// (W() in app.js:204 treats both as 1).
function syntheticWeights(ids) {
  const LADDER = [0.5, 0.62, 0.75, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8], models = {};
  ids.forEach((id, i) => {
    if (id === 'cma_grapes_global') return;
    models[id] = { weights: Object.fromEntries(WEIGHT_KEYS.map((k, j) => [k, LADDER[(i * 3 + j * 7) % LADDER.length]])) };
  });
  if (models.gfs_seamless) models.gfs_seamless.weights.precip = 0;
  return { models };
}
const ALL_IDS = ['ecmwf_aifs025_single', 'ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'gem_seamless', 'meteofrance_seamless', 'ukmo_seamless', 'jma_seamless',
  'cma_grapes_global', 'bom_access_global', 'knmi_seamless', 'dmi_seamless', 'metno_seamless', 'yr'];
const SYNTH = syntheticWeights(ALL_IDS);

function replayFetch(requests) {
  const byUrl = new Map(requests.map((r) => [r.url, r]));
  return async (url) => {
    const r = byUrl.get(new URL(url, GLETT).href);
    if (!r) throw new Error(`fixtures: no recorded response for ${url}`);
    const text = fs.readFileSync(path.join(RAW, r.file), 'utf8');
    return new Response(text, { status: r.status, headers: { 'content-type': 'application/json' } });
  };
}
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const num = (x) => (x == null || Number.isNaN(x) ? null : x);

async function expectPlace(manifest, pl) {
  const reqs = [pl.openMeteo, ...(pl.met ? [pl.met] : [])];
  const env = makeContext(replayFetch(reqs));
  const { get, run } = env;
  env.clock.ms = manifest.forecastNow * 1000;
  const data = await get('WEFO').fetchForecast(pl.lat, pl.lon);
  const yr = data.providers.find((p) => p.id === 'yr');
  const yrHourly = yr ? JSON.parse(JSON.stringify(yr.hourly)) : null;
  get('prepare')(data);
  const state = get('state');
  state.data = data; state._nowKey = null; state.disabled = new Set();
  const out = {
    format: FORMAT, place: pick(pl, ['slug', 'name', 'lat', 'lon']), now: manifest.forecastNow, nowIso: new Date(manifest.forecastNow * 1000).toISOString(),
    source: { openMeteo: 'raw/' + pl.openMeteo.file, met: pl.met ? 'raw/' + pl.met.file : null },
    data: pick(data, ['lat', 'lon', 'timezone', 'utc_offset_seconds', 'elevation', 'time', 'dates', 'isDay']),
    nowIdx: get('nowIdx')(),
    providers: data.providers.map((p) => ({ id: p.id, dupOf: p.dupOf || null, code: p.hourly.code })),
    dupOf: Object.fromEntries(data.providers.filter((p) => p.dupOf).map((p) => [p.id, p.dupOf])),
    active: get('activeProviders')().map((p) => p.id),
    yr: yrHourly,
    weights: { unweighted: null, synthetic: SYNTH },
    steps: {},
  };
  const heroCol = get('__heroCol')();
  out.heroColumn = { step: 1, a: heroCol.a };
  const agg = get('agg'), category = get('WI').category, CAT_CODE = get('WI').CAT_CODE, iconKey = get('__iconKey'), circMean = get('circMean');
  const signal = get('__signal'), shortBoost = get('shortBoost');
  for (const step of STEPS) {
    state.step = step;
    const cols = get('columns')(step);
    const S = { columns: cols.map((c) => pick(c, ['a', 'b', 'day', 'first', 'label', 'hour', 'past', 'now', 'night'])), boost: {}, agg: {}, agreement: {}, sd: {}, runs: {} };
    for (const p of data.providers) {
      const A = {};
      for (const f of AGG_FIELDS) A[f] = cols.map((c) => num(agg(p, f, c.a, c.b)));
      A.category = A.code.map((code) => category(code));
      A.icon = A.code.map((code, k) => iconKey(code, cols[k].night));
      A.thunder = cols.map((c) => signal(p, c).s);
      S.agg[p.id] = A;
      if (p.id === 'metno_seamless' || p.id === 'yr') S.boost[p.id] = cols.map((c) => shortBoost(p, c.a));
    }
    for (const param of AGREE_PARAMS) {
      const r = cols.map((c) => get('__agree')(c, param));
      S.agreement[param] = r.map((x) => { const m = /class="pill [a-z]+">(\d+)%</.exec(x.html); return m ? +m[1] : null; });
      S.sd[param] = r.map((x) => (x.v.length > 1 ? x.sd : null));
    }
    for (const [run_, verify] of [['unweighted', null], ['synthetic', SYNTH]]) {
      state.verify = verify; state.weighted = true;
      const R = { shares: [], icon: [], rainChance: [], windChance: [], gustPct: [], thunderChance: [], temp: [], feels: [], wind: [], gust: [], precip: [], dir: [], verdict: [] };
      for (const c of cols) {
        const h = get('__hero')(c);
        R.shares.push(h.shares && h.shares.map(([cat, share]) => ({ cat, share })));
        R.icon.push(h.top ? iconKey(CAT_CODE[h.top[0]], c.night) : null);
        R.rainChance.push(num(get('rainChance')(c)));
        const w = get('__wind')(c);
        R.windChance.push(w === '–' ? null : num(w.pr));
        const gt = w === '–' ? null : w.t.find((x) => x.key === 'g.gusts');
        R.gustPct.push(gt ? gt.params.v : null);
        const th = get('__storm')(c);
        R.thunderChance.push(th === '–' ? null : num(th));
        R.temp.push(num(h.temp)); R.feels.push(num(h.feels)); R.wind.push(num(h.ws)); R.gust.push(num(h.g));
        R.precip.push(num(get('__precipMean')(c)));
        R.dir.push(h.dd.length ? circMean(h.dd, h.dd.map(() => 1)) : null);
        if (h.verdict) {
          const v = h.verdict, det = v.t.find((x) => x.key === 'hero.verdict.detail').params, dots = +/aria-label="(\d+) \/ 5"/.exec(v.html)[1];
          R.verdict.push({ level: v.level, dots, k: det.k, n: det.n, cat: h.top[0], minT: Math.min(...v.tv), maxT: Math.max(...v.tv), min: det.min, max: det.max });
        } else R.verdict.push(null);
      }
      S.runs[run_] = R;
    }
    state.verify = null;
    out.steps[step] = S;
  }
  // the day cards and today's lines at a few times of the day, without and with weights
  out.daily = [];
  for (const h of DAY_OFFSETS) {
    const now = manifest.forecastNow + h * 3600;
    env.clock.ms = now * 1000; state._nowKey = null;
    const runs = {};
    for (const [run_, verify] of [['unweighted', null], ['synthetic', SYNTH]]) {
      state.verify = verify; state.weighted = true;
      runs[run_] = { days: data.dates.map((_, d) => { const x = get('__day')(d); return { ...x, hi: num(x.hi), lo: num(x.lo), rp: num(x.rp), sp: num(x.sp), mm: num(x.mm), gust: num(x.gust) }; }),
        outlook: get('__outlook')() };
    }
    state.verify = null;
    out.daily.push({ now, nowIdx: get('nowIdx')(), todayIdx: get('todayIndex')(), runs });
  }
  env.clock.ms = manifest.forecastNow * 1000; state._nowKey = null;
  return out;
}

// Synthetic radar series (5-minute steps from 'now') for the sentence cases the recorded weather may not show
function syntheticNowcasts(t0) {
  const ser = (rates) => rates.map((r, i) => ({ t: t0 + i * 300, rate: r }));
  const n = 24, fill = (f) => Array.from({ length: n }, (_, i) => f(i));
  return [
    { name: 'dry-all', series: ser(fill(() => 0)) },
    { name: 'wet-all', series: ser(fill(() => 1.2)) },
    { name: 'starts-at-6', series: ser(fill((i) => (i >= 6 ? 0.8 : 0))) },
    { name: 'stops-at-8', series: ser(fill((i) => (i < 8 ? 2.5 : 0))) },
    { name: 'blip-at-4', series: ser(fill((i) => (i === 4 ? 0.4 : 0))) },
    { name: 'wet-one-dry-gap', series: ser(fill((i) => (i === 3 ? 0 : 0.6))) },
    { name: 'threshold-edge', series: ser(fill((i) => (i < 5 ? 0.09 : 0.1))) },
    { name: 'late-change-after-90min', series: ser(fill((i) => (i >= 20 ? 1 : 0))) },
    { name: 'past-only', series: ser(fill(() => 1)).map((p) => ({ ...p, t: p.t - 3 * 3600 })) },
    { name: 'starts-in-past-window', series: ser(fill((i) => (i >= 3 ? 0.5 : 0))).map((p) => ({ ...p, t: p.t - 240 })) },
  ];
}

async function expectNowcast(manifest) {
  const out = { format: FORMAT, recorded: [], synthetic: [] };
  const evaluate = (env, nc, now) => {
    env.clock.ms = now * 1000;
    env.get('state').nowcast = nc;
    return { now, summary: env.get('__ncSummary')(), here: env.get('__ncHere')() };
  };
  for (const nc of manifest.nowcast) {
    const env = makeContext(replayFetch(nc.requests));
    env.clock.ms = nc.now * 1000;
    const data = await env.get('WEFO').fetchNowcast(nc.lat, nc.lon);
    const offsets = [0, 600, 1200, 1800, 2700, 3600];
    out.recorded.push({ place: pick(nc, ['slug', 'name', 'lat', 'lon']), now: nc.now, model: nc.model, sources: nc.requests.map((r) => ({ url: r.url, status: r.status, file: 'raw/' + r.file })),
      nowcast: data, evaluations: offsets.map((d) => evaluate(env, data, nc.now + d)) });
  }
  const env = makeContext(async () => { throw new Error('no fetch'); });
  const t0 = manifest.forecastNow;
  for (const s of syntheticNowcasts(t0)) {
    const nc = { series: s.series, ring: [], km: 5, fetched: t0 };
    out.synthetic.push({ name: s.name, now: t0, nowcast: nc, evaluations: [evaluate(env, nc, t0), evaluate(env, nc, t0 + 1500)] });
  }
  return out;
}

async function expectVerify(manifest) {
  const out = { format: FORMAT, places: [] };
  for (const v of manifest.verify || []) {
    const env = makeContext(replayFetch(v.requests));
    env.clock.ms = v.now * 1000;
    const result = await env.get('WEFO').fetchVerify(v.lat, v.lon);
    out.places.push({ place: pick(v, ['slug', 'name', 'lat', 'lon']), now: v.now, sources: v.requests.map((r) => ({ ...r, file: 'raw/' + r.file })), result });
  }
  return out;
}

async function expect() {
  const manifest = readJson(path.join(RAW, 'manifest.json'));
  fs.rmSync(EXP, { recursive: true, force: true });
  for (const pl of manifest.places) {
    const out = await expectPlace(manifest, pl);
    writeJson(path.join(EXP, `${pl.slug}.json`), out);
    const kb = (fs.statSync(path.join(EXP, `${pl.slug}.json`)).size / 1024).toFixed(0);
    console.log(`expected ${pl.slug}: ${out.providers.length} providers (${Object.keys(out.dupOf).length} duplicates), nowIdx ${out.nowIdx}, ${kb} KB`);
  }
  const nc = await expectNowcast(manifest);
  writeJson(path.join(EXP, 'nowcast.json'), nc);
  console.log(`expected nowcast: ${nc.recorded.length} recorded, ${nc.synthetic.length} synthetic`);
  const vf = await expectVerify(manifest);
  writeJson(path.join(EXP, 'verify.json'), vf);
  console.log(`expected verify: ${vf.places.map((p) => `${p.place.slug} (${p.result.truth}, ${Object.keys(p.result.models).length} models)`).join(', ') || 'none recorded'}`);
  // where each piece came from, and a hash of the JS files, so a test can tell when the web changed under the fixtures
  const sha = (f) => createHash('sha256').update(readJs(f)).digest('hex');
  writeJson(path.join(EXP, 'sources.json'), { js: { 'app.js': sha('app.js'), 'data.js': sha('data.js'), 'icons.js': sha('icons.js') }, pieces: Object.fromEntries(Object.entries(sources).sort()) });
}

const mode = process.argv[2] || 'expect';
if (mode === 'record') await record();
else if (mode === 'record-verify') await recordVerify();
else if (mode === 'expect') await expect();
else { console.error('usage: node scripts/fixtures.mjs [expect|record|record-verify]'); process.exit(2); }
