// Εικονίδια καιρού (inline SVG, χωρίς εξωτερικές εξαρτήσεις)
const WI = (() => {
  const rays = (cx, cy, r) => {
    let s = '';
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4, c = Math.cos(a), n = Math.sin(a);
      s += `M${(cx + c * (r + 4)).toFixed(1)} ${(cy + n * (r + 4)).toFixed(1)}L${(cx + c * (r + 9)).toFixed(1)} ${(cy + n * (r + 9)).toFixed(1)}`;
    }
    return `<path class="ray" d="${s}"/>`;
  };
  const sun = (cx, cy, r) => `<circle class="sun" cx="${cx}" cy="${cy}" r="${r}"/><g class="rays">${rays(cx, cy, r)}</g>`;
  /* Moon with the real phase for a moment in time (Northern Hemisphere view: waxing lit on the right).
     Phase from the mean synodic month since the new moon of 6 Jan 2000 18:14 UTC; accurate to well within a day. */
  const SYNODIC = 29.530588853, NEW_MOON_2000 = Date.UTC(2000, 0, 6, 18, 14);
  const moonPhase = (ms) => { const d = ((ms - NEW_MOON_2000) / 86400e3) % SYNODIC; return (d < 0 ? d + SYNODIC : d) / SYNODIC; };   // 0 new, .5 full
  let phaseAt = Date.now();
  const moon = (t = '') => {
    const p = moonPhase(phaseAt), cx = 31, cy = 31, R = 17, k = Math.cos(2 * Math.PI * p), rx = (R * Math.abs(k)).toFixed(2);
    const waxing = p < 0.5, crescent = k > 0;
    // lit limb (semicircle on the lit side) + terminator (half-ellipse) back to the top
    const limb = waxing ? `A${R} ${R} 0 0 1 ${cx} ${cy + R}` : `A${R} ${R} 0 0 0 ${cx} ${cy + R}`;
    const term = `A${rx} ${R} 0 0 ${waxing ? (crescent ? 0 : 1) : (crescent ? 1 : 0)} ${cx} ${cy - R}`;
    if (p < 0.015 || p > 0.985) return `<g class="moong" ${t}><circle class="moon-dark" cx="${cx}" cy="${cy}" r="${R}"/></g>`;
    const d = `M${cx} ${cy - R}${limb}${term}z`, id = 'mc' + Math.round(p * 400);   // same phase = same clip, so a shared id is harmless
    // craters (maria) only where the moon is lit
    const craters = [[-5, -6, 3.4], [5, 3, 2.6], [-4, 7, 2.1], [6, -7, 1.7], [1, -1, 1.3], [-9, 1, 1.2], [9, 9, 1.1]]
      .map(([x, y, r]) => `<circle class="crater" cx="${cx + x}" cy="${cy + y}" r="${r}"/>`).join('');
    return `<g class="moong" ${t}><clipPath id="${id}"><path d="${d}"/></clipPath><circle class="moon-dark" cx="${cx}" cy="${cy}" r="${R}"/><path class="moon" d="${d}"/><g clip-path="url(#${id})">${craters}</g></g>`;
  };
  const cloud = (t = '') => `<g class="cloudg"><path class="cloud" ${t} d="M19 50h27a10 10 0 0 0 2-19.8A15 15 0 0 0 19.5 33 8.7 8.7 0 0 0 19 50z"/></g>`;
  const drop = (x, y, k = 1) => `<path class="drop" transform="translate(${x} ${y}) scale(${k})" d="M0 0c2.6 3.6 3.8 5.8 3.8 7.6a3.8 3.8 0 0 1-7.6 0C-3.8 5.8-2.6 3.6 0 0z"/>`;
  const drops = (heavy) => '<g class="drops">' + (heavy ? [22, 30, 38, 46] : [26, 36, 46]).map((x, i) => `<g class="dropg">${drop(x, 51 + (i % 2) * 3)}</g>`).join('') + '</g>';
  const flakes = '<g class="snowc"><circle cx="24" cy="56" r="2.6"/><circle cx="34" cy="60" r="2.6"/><circle cx="44" cy="56" r="2.6"/></g>';
  const bolt = '<path class="bolt" d="M35 42l-9 14h7l-3 9 12-15h-7z"/>';
  const fogLines = '<g class="fogg"><rect class="fogl" x="12" y="52" width="38" height="4.5" rx="2.2"/><rect class="fogl" x="20" y="59" width="32" height="4.5" rx="2.2"/></g>';
  const up = 'transform="translate(0 -6)"';
  const small = 'transform="translate(8 4) scale(.88)"';
  const showerCloud = 'transform="translate(8 -2) scale(.88)"';
  const showerDrops = '<g class="drops">' + [drop(28, 49, .9), drop(38, 51, .9), drop(48, 49, .9)].map((d) => `<g class="dropg">${d}</g>`).join('') + '</g>';

  const icons = {
    'clear-day': sun(32, 32, 12),
    'clear-night': moon(),
    'partly-day': sun(25, 24, 9) + cloud(small),
    'partly-night': moon('transform="translate(-6 -6) scale(.7)"') + cloud(small),
    cloudy: `<g class="cloudg2"><path class="cloud back" transform="translate(-9 -9) scale(.72)" d="M19 50h27a10 10 0 0 0 2-19.8A15 15 0 0 0 19.5 33 8.7 8.7 0 0 0 19 50z"/></g>` + cloud('transform="translate(2 3)"'),
    fog: cloud('transform="translate(0 -8) scale(.95)"') + fogLines,
    drizzle: cloud(up) + '<g class="drops">' + [drop(26, 52, .6), drop(36, 54, .6), drop(46, 52, .6)].map((d) => `<g class="dropg">${d}</g>`).join('') + '</g>',
    rain: cloud(up) + drops(false),
    'heavy-rain': cloud(up) + drops(true),
    'showers-day': sun(22, 20, 8) + cloud(showerCloud) + showerDrops,
    'showers-night': moon('transform="translate(-6 -8) scale(.65)"') + cloud(showerCloud) + showerDrops,
    sleet: cloud(up) + '<g class="drops"><g class="dropg">' + drop(26, 52, .9) + '</g><g class="dropg">' + drop(46, 52, .9) + '</g></g><g class="snowc"><circle cx="36" cy="58" r="2.6"/></g>',
    snow: cloud(up) + flakes,
    thunder: cloud(up) + bolt,
  };

  const NIGHT = {   // built per call, because the moon depends on the date
    'clear-night': () => moon(),
    'partly-night': () => moon('transform="translate(-4 -5) scale(.72)"') + cloud(small),
    'showers-night': () => moon('transform="translate(-4 -7) scale(.66)"') + cloud(showerCloud) + showerDrops,
  };
  // Ομαδοποίηση κωδικών WMO σε κατηγορίες
  function category(code) {
    if (code == null) return null;
    if (code <= 1) return 'clear';
    if (code === 2) return 'partly';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 57) return 'drizzle';
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'thunder';
    return 'cloudy';
  }
  const CAT_CODE = { clear: 0, partly: 2, cloudy: 3, fog: 45, drizzle: 51, rain: 63, snow: 73, thunder: 95 };

  const label = (code) => (hasT('wx.' + code) ? t('wx.' + code) : t('wx.unknown'));

  function key(code, night) {
    if (code == null) return null;
    const n = night ? 'night' : 'day';
    if (code === 0 || code === 1) return 'clear-' + n;
    if (code === 2) return 'partly-' + n;
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 57) return 'drizzle';
    if (code === 66 || code === 67) return 'sleet';
    if (code === 65 || code === 82) return 'heavy-rain';
    if (code >= 80 && code <= 81) return 'showers-' + n;
    if (code >= 61 && code <= 64) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'thunder';
    return 'cloudy';
  }

  function svg(code, night = false, cls = '', when = null) {
    const k = key(code, night);
    if (!k) return '<span class="na">–</span>';
    let body = icons[k];
    if (night && /night/.test(k)) { phaseAt = when == null ? Date.now() : +when; body = NIGHT[k](); }   // night icons: moon drawn for that moment
    return `<svg class="wi ${cls}" viewBox="0 0 64 64" role="img" aria-label="${label(code)}"><title>${label(code)}</title>${body}</svg>`;
  }
  // Βέλος προς την κατεύθυνση που φυσά ο άνεμος (deg = από πού φυσά)
  const arrow = (deg) => `<svg class="arrow" viewBox="0 0 24 24" style="transform:rotate(${Math.round(deg + 180)}deg)"><path d="M12 3l6 15-6-4-6 4z"/></svg>`;
  const bolt24 = '<svg class="bolt-i" viewBox="0 0 24 24"><path d="M13 2L5 14h6l-1 8 8-12h-6z"/></svg>';
  // Κοινά gradients για την τρισδιάστατη όψη (ορίζονται μία φορά στη σελίδα)
  const defs = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <radialGradient id="g-sun" cx=".35" cy=".3" r=".8"><stop offset="0" style="stop-color:#fff3a6"/><stop offset=".45" style="stop-color:#ffc21a"/><stop offset="1" style="stop-color:#f08a00"/></radialGradient>
    <radialGradient id="g-moon" cx=".35" cy=".3" r=".85"><stop offset="0" style="stop-color:#fffbe8"/><stop offset=".55" style="stop-color:#f6e2a0"/><stop offset="1" style="stop-color:#dcb95e"/></radialGradient>
    <linearGradient id="g-cloud" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--cloud-top)"/><stop offset="1" style="stop-color:var(--cloud-bot)"/></linearGradient>
    <linearGradient id="g-drop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:#8fd0ff"/><stop offset="1" style="stop-color:#1d6fe0"/></linearGradient>
    <radialGradient id="g-snow" cx=".35" cy=".3" r=".8"><stop offset="0" style="stop-color:#fff"/><stop offset="1" style="stop-color:#8ecdf5"/></radialGradient>
    <linearGradient id="g-bolt" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:#ffe66b"/><stop offset="1" style="stop-color:#f57c00"/></linearGradient>
  </defs></svg>`;
  document.body.insertAdjacentHTML('afterbegin', defs);
  return { svg, category, CAT_CODE, label, arrow, bolt24, moonPhase };
})();
