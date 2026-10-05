'use strict';
/* ================= Open-Meteo's free limits, kept by the browser =================
   The free API allows 600 calls a minute, 5 000 an hour and 10 000 a day for each connection (open-meteo.com/en/pricing),
   and a request weighs locations × max(1, days ÷ 14) × max(1, variables × models ÷ 10). The browser calls Open-Meteo
   itself (the server never proxies it), so the visitor's connection carries the quota and the page has to keep it:
     - every Open-Meteo request on the site goes through OMGate.fetch: it is weighed and written in a log that the open
       tabs share (localStorage), and held while the last 60 seconds hold more than MINUTE of weight; the page is told
       how long (the 'glett:omwait' event), so it can say so instead of failing
     - a 429 says which limit was hit: a minute is waited out and the same request sent again (so a long plan resumes
       where it stopped, never from the start); an hour or a day is an error that says so, and the other tabs wait too
   The hour and the day are not held back in advance: the weights are Open-Meteo's published rule, not their meter. */
(function () {
  const MINUTE = 500;                 // under 600, for the other things on the same connection
  const KEY = 'glett.om', WIN = 60e3;
  let mem = { log: [], until: 0, why: '' };   // used when localStorage is not available (private mode)
  const load = () => { try { const j = JSON.parse(localStorage.getItem(KEY) || 'null'); if (j && Array.isArray(j.log)) mem = { log: j.log, until: j.until || 0, why: j.why || '' }; } catch (e) { /* keep mem */ } return mem; };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch (e) { /* mem only */ } };
  const prune = (now) => { mem.log = mem.log.filter((x) => now - x[0] < WIN); };

  function weight(url) {
    const u = new URL(url, location.href), q = u.searchParams;
    if (/geocoding/.test(u.host)) return 1;
    const n = Math.max(1, (q.get('latitude') || '').split(',').filter(Boolean).length);
    if (/elevation/.test(u.pathname)) return n;
    const vars = ['hourly', 'daily', 'current', 'minutely_15'].reduce((a, k) => a + (q.get(k) || '').split(',').filter(Boolean).length, 0);
    const models = Math.max(1, (q.get('models') || '').split(',').filter(Boolean).length);
    let days = (+q.get('forecast_days') || 7) + (+q.get('past_days') || 0);
    const a = q.get('start_date'), b = q.get('end_date'); if (a && b) days = Math.max(1, (Date.parse(b) - Date.parse(a)) / 864e5 + 1);
    return n * Math.max(1, days / 14) * Math.max(1, (vars * models) / 10);
  }
  const used = () => mem.log.reduce((s, x) => s + x[1], 0);
  const say = (until, why) => window.dispatchEvent(new CustomEvent('glett:omwait', { detail: { until, why } }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = (url) => new URL(url, location.href).host;
  function limitError(url, why) {   // an hour or a day: the visitor is told which, and roughly when to try again
    const e = new Error(t(why === 'd' ? 'om.day' : 'om.hour', { host: host(url) })); e.om = why; return e;
  }

  // wait for room in the last minute, then write this request's weight in the log
  async function take(url) {
    const w = weight(url); let told = false;
    for (;;) {
      const now = Date.now(); load(); prune(now);
      if (mem.until > now) {
        if (mem.why !== 'm') throw limitError(url, mem.why);
        say(mem.until, 'm'); told = true; await sleep(Math.min(mem.until - now, 1000) + 50); continue;
      }
      const u = used();
      // a request heavier than the whole minute (a long history) goes alone: holding it back would never end
      if (!u || u + w <= MINUTE) { mem.log.push([now, w]); save(); if (told) say(0, ''); return w; }
      let s = u, at = now; for (const x of mem.log) { s -= x[1]; at = x[0] + WIN; if (s + w <= MINUTE) break; }
      say(at, 'm'); told = true; await sleep(Math.min(at - now, 1000) + 50);
    }
  }
  // a 429: read which limit, and remember it for the other tabs
  async function refused(url, res) {
    let reason = ''; try { reason = String((await res.clone().json()).reason || ''); } catch (e) { /* no body */ }
    const why = /minut/i.test(reason) ? 'm' : /hour/i.test(reason) ? 'h' : /day|daily/i.test(reason) ? 'd' : 'm';
    load(); mem.until = Date.now() + (why === 'm' ? 61e3 : why === 'h' ? 10 * 60e3 : 60 * 60e3); mem.why = why; save();
    return why;
  }
  // fetch through the gate: doFetch is the caller's own fetch (with its time limit)
  async function gateFetch(url, doFetch) {
    for (let tries = 0; ; tries++) {
      await take(url);
      const res = await doFetch();
      if (res.status !== 429) return res;
      const why = await refused(url, res);
      if (why !== 'm' || tries >= 2) { if (why !== 'm') throw limitError(url, why); const e = new Error(t('err.quota', { host: host(url) })); e.om = 'm'; throw e; }
    }
  }
  const isOM = (url) => { try { return /(^|\.)open-meteo\.com$/.test(host(url)); } catch (e) { return false; } };
  window.OMGate = { fetch: gateFetch, weight, isOM };
})();
