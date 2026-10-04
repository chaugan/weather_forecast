/* Prototype layout "Kart først" for Kjørevær and Turvær: the page selector in the top bar, the question as one line
   with Endre, the map as the hero carrying the weather (icons with the time at a few points, a verdict card), the
   routes as tiles compared by weather first. Real data: the engines render as before, this module only moves and
   adds. On with ?ui=kart (or #kv?…&ui=kart), kept in the browser; off with ?ui=std. Nothing runs without the flag. */
(() => {
  const flag = () => {
    try {
      const q = new URLSearchParams(location.search.slice(1) + '&' + (location.hash.split('?')[1] || ''));
      const u = q.get('ui');
      if (u === 'kart') localStorage.setItem('glett.ui', 'kart'); else if (u) localStorage.removeItem('glett.ui');
      return localStorage.getItem('glett.ui') === 'kart';
    } catch (e) { return false; }
  };
  if (!flag()) return;
  document.documentElement.dataset.ui = 'kart';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hm = (d) => new Date(d).toLocaleTimeString(LANG === 'nb' ? 'nb-NO' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

  /* ---- the page selector in the top bar ---- */
  const VIEWS = [['forecast', 'ui.vaer'], ['route', 'nav.route'], ['tur', 'nav.tur']];
  const pages = document.createElement('nav'); pages.className = 'gl-pages'; pages.setAttribute('aria-label', 'Sider');
  pages.innerHTML = VIEWS.map(([v, k]) => `<button type="button" data-view="${v}">${esc(t(k))}</button>`).join('');
  pages.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showView(b.dataset.view); });
  const brand = document.querySelector('.topbar .brand'); if (brand) brand.insertAdjacentElement('afterend', pages);
  const syncPages = () => { const on = document.querySelector('.view.active'); const id = on ? on.id.replace('view-', '') : 'forecast'; pages.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === id || (id === 'places' && b.dataset.view === 'forecast'))); };
  document.querySelectorAll('.view').forEach((v) => new MutationObserver(syncPages).observe(v, { attributes: true, attributeFilter: ['class'] }));
  syncPages();
  document.addEventListener('glett:lang', () => { pages.querySelectorAll('button').forEach((b, i) => { b.textContent = t(VIEWS[i][1]); }); sum.kv && sum.kv.update(); sum.tv && sum.tv.update(); });

  /* ---- the question as one line, the form behind Endre ---- */
  const sum = {};
  function summaryBar(kind) {
    const view = $(kind === 'kv' ? 'view-route' : 'view-tur'), form = view.querySelector('.kv-form'), result = $(kind + 'Result');
    const bar = document.createElement('div'); bar.className = 'gl-sum'; bar.id = kind + 'Sum';
    bar.innerHTML = `<div class="gl-sum-txt"><b></b><small></small></div><button type="button" class="kv-chip gl-edit" aria-expanded="true"></button>`;
    form.insertAdjacentElement('beforebegin', bar);
    const btn = bar.querySelector('.gl-edit'), b = bar.querySelector('b'), sm = bar.querySelector('small');
    const open = (on) => { view.classList.toggle('gl-form-open', on); btn.setAttribute('aria-expanded', on ? 'true' : 'false'); btn.textContent = t(on ? 'ui.close' : 'ui.edit'); };
    btn.addEventListener('click', () => open(!view.classList.contains('gl-form-open')));
    const txt = (sel) => { const e = view.querySelector(sel); return e ? e.textContent.trim() : ''; };
    const val = (id) => { const e = $(id); return e ? e.value.trim() : ''; };
    const when = () => { const d = txt('#' + kind + 'Days .on'), h = $(kind + 'Hour'); const o = h && h.selectedOptions[0]; return [d, o ? o.textContent.trim() : ''].filter(Boolean).join(' '); };
    const update = () => {
      const from = val(kind + 'From'), to = val(kind + 'To');
      if (kind === 'kv') { b.textContent = from || to ? `${from || '…'} → ${to || '…'}` : t('nav.route'); sm.textContent = [txt('#kvVeh .on'), when()].filter(Boolean).join(' · '); }
      else { const cl = $('tvClBtn') && $('tvClBtn').classList.contains('on') ? txt('#tvClBtn span') : ''; b.textContent = cl || (from || to ? `${from || '…'} → ${to || '…'}` : t('nav.tur')); sm.textContent = [cl && from ? `${from} → ${to}` : '', txt('#tvSeason .on'), txt('#tvPace .on'), when()].filter(Boolean).join(' · '); }
      btn.textContent = t(view.classList.contains('gl-form-open') ? 'ui.close' : 'ui.edit');
    };
    let tm = 0; ['input', 'change', 'click'].forEach((ev) => form.addEventListener(ev, () => { clearTimeout(tm); tm = setTimeout(update, 60); }));
    // no trip yet: the form is open; a trip arrives: it folds
    const auto = () => { const none = result.hidden; if (none) open(true); else if (!bar.dataset.seen) { bar.dataset.seen = '1'; open(false); } else open(false); update(); };
    new MutationObserver(auto).observe(result, { attributes: true, attributeFilter: ['hidden'] });
    auto();
    return { update, open };
  }

  /* ---- the verdict card on the map ---- */
  function verdictCard(kind) {
    const wrap = $(kind + 'MapWrap'); let el = wrap.querySelector('.gl-verdict');
    if (!el) { el = document.createElement('div'); el.className = 'gl-verdict'; wrap.appendChild(el); }
    return el;
  }
  const minutesOf = (pts, g) => (pts[Math.min(g.b + 1, pts.length - 1)].at - pts[g.a].at) / 60e3;
  function kvSentence(s) {   // "Regn fra kl. 10:18, ellers opphold." from the chosen route's weather stretches
    const pts = s.pts, wet = s.seg.filter((g) => g.cls !== 'dry' && minutesOf(pts, g) >= 5);
    if (!wet.length) return { text: t('ui.dry'), p: pts[Math.floor(pts.length / 2)] };
    const worst = wet.slice().sort((a, b) => minutesOf(pts, b) - minutesOf(pts, a))[0];
    const first = wet[0], w = t('kv.c.' + worst.cls), again = wet.find((g) => g !== first && pts[g.a].at - pts[Math.min(first.b + 1, pts.length - 1)].at > 30 * 60e3);
    const total = wet.reduce((m, g) => m + minutesOf(pts, g), 0), all = total >= (s.end - pts[0].at) / 60e3 - 10;
    if (all) return { text: t('ui.wetall', { w }), p: pts[worst.a] };
    return { text: again ? t('ui.wet2', { w, h: hm(pts[first.a].at), h2: hm(pts[again.a].at) }) : t('ui.wet', { w, h: hm(pts[first.a].at) }), p: pts[worst.a] };
  }
  function renderKv(S, sel) {
    const s = S[sel]; if (!s) return;
    const v = kvSentence(s), el = verdictCard('kv');
    const chips = [...document.querySelectorAll('#kvCards .kv-rc.sel .kv-badge')].map((b) => b.textContent.trim()).filter((x) => x && x !== t('kv.b.dry')).slice(0, 4);
    el.innerHTML = `<span class="gl-vi">${WI.svg(v.p.code, !v.p.day)}</span><h3>${esc(v.text)}</h3><p>${esc(chips.join(' · '))}</p>`;
    sum.kv && sum.kv.update();
  }
  function renderTv(s) {
    const el = verdictCard('tv'), h = document.querySelector('#tvHead .tv-headline'), kind = h ? [...h.classList].find((c) => /^(good|ok|mid|bad)$/.test(c)) || '' : '';
    const chips = [...document.querySelectorAll('#tvHead .kv-badges .kv-badge')].map((b) => b.textContent.trim()).slice(0, 3);
    const p = s.pts[Math.floor(s.pts.length / 2)] || s.pts[0];
    el.className = 'gl-verdict ' + kind;
    el.innerHTML = `<span class="gl-vi">${WI.svg(p.code, !p.day)}</span><h3>${esc(h ? h.textContent : '')}</h3><p>${esc(chips.join(' · '))}</p>`;
    sum.tv && sum.tv.update();
  }

  /* ---- the weather on the map: an icon with the time and the temperature at a few points along the way ---- */
  function mapMarks(kind, m, s, marks) {
    if (!s || !s.pts || typeof maplibregl === 'undefined') return;
    const small = innerWidth <= 700, pts = s.pts, n = Math.min(pts.length, kind === 'kv' ? (small ? 4 : 6) : (small ? 3 : 4)), picks = new Set();
    for (let i = 0; i < n; i++) picks.add(Math.round(i * (pts.length - 1) / Math.max(1, n - 1)));
    [...picks].forEach((i) => {
      const p = pts[i]; if (!Number.isFinite(p.t)) return;
      const el = document.createElement('div'); el.className = 'gl-wxmk';
      el.innerHTML = `<span class="i">${WI.svg(p.code, !p.day)}</span><span class="l">${esc(hm(p.at))} · ${Math.round(p.t)}°</span>`;
      marks.push(new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat([p.lon, p.lat]).addTo(m));
    });
  }

  window.GlettUI = {
    render(kind, S, sel) { if (kind === 'kv') renderKv(S, sel); else renderTv(S); },
    map: mapMarks,
  };
  sum.kv = summaryBar('kv'); sum.tv = summaryBar('tv');
})();
