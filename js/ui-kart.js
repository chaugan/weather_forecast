/* Prototype layout "Kart først" for Kjørevær and Turvær: the page selector in the top bar, the question as one line
   with Endre, the map as the hero carrying the weather (icons with the time at a few points, a verdict card), the
   routes as tiles compared by weather first, and the now card on Været with the radar as its graphic. Real data: the
   engines render as before, this module only moves and adds. On with ?ui=kart (or #kv?…&ui=kart), kept in the
   browser; off with ?ui=std. Without the flag only the hover tip on the "when should you go" bars runs. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---- the "when should you go/drive" bars: the bar's text at once on hover, instead of the browser's slow title ---- */
  let tip = null;
  const showTip = (el, text) => {
    if (!tip) { tip = document.createElement('div'); tip.className = 'gl-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    tip.textContent = text; tip.hidden = false;
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    tip.style.left = x + 'px'; tip.style.top = (r.top + scrollY - tip.offsetHeight - 10) + 'px';
  };
  const hideTip = () => { if (tip) tip.hidden = true; };
  document.addEventListener('mouseover', (e) => {
    const b = e.target.closest('.kv-dep button'); if (!b) return;
    if (b.title) { b.dataset.tip = b.title; b.removeAttribute('title'); }
    if (b.dataset.tip) showTip(b, b.dataset.tip);
  });
  document.addEventListener('mouseout', (e) => { if (e.target.closest && e.target.closest('.kv-dep button')) hideTip(); });
  document.addEventListener('scroll', hideTip, { passive: true });

  /* ---- the flag ---- */
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
  const hm = (d) => new Date(d).toLocaleTimeString(LANG === 'nb' ? 'nb-NO' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } return v; };

  /* ---- the page selector in the top bar ---- */
  const VIEWS = [['forecast', 'ui.vaer'], ['route', 'nav.route'], ['tur', 'nav.tur']];
  const pages = document.createElement('nav'); pages.className = 'gl-pages'; pages.setAttribute('aria-label', 'Sider');
  pages.innerHTML = VIEWS.map(([v, k]) => `<button type="button" data-view="${v}">${esc(t(k))}</button>`).join('');
  pages.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showView(b.dataset.view); });
  const brand = document.querySelector('.topbar .brand'); if (brand) brand.insertAdjacentElement('afterend', pages);
  const syncPages = () => { const on = document.querySelector('.view.active'); const id = on ? on.id.replace('view-', '') : 'forecast'; pages.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === id || (id === 'places' && b.dataset.view === 'forecast'))); };
  document.querySelectorAll('.view').forEach((v) => new MutationObserver(syncPages).observe(v, { attributes: true, attributeFilter: ['class'] }));
  syncPages();

  /* ---- two real columns: the map, the tiles and the departure picker left; the chart and the stages right ---- */
  function columns(kind) {
    const view = $(kind === 'kv' ? 'view-route' : 'view-tur'), grid = view.querySelector('.kv-grid');
    const left = document.createElement('div'), right = document.createElement('div'); left.className = 'gl-left'; right.className = 'gl-right';
    const form = view.querySelector('.kv-form'), status = $(kind + 'Status'), result = $(kind + 'Result'), saved = view.querySelector('.kv-savedcard');
    const map = $(kind + 'MapWrap'), chart = $(kind + 'ChartCard'), it = view.querySelector('.kv-itcard'), src = $(kind + 'Source');
    left.append(map, result, saved, src); right.append(chart, it);
    grid.append(form, status, left, right);
    grid.querySelectorAll(':scope > .kv-col, :scope > .kv-main').forEach((c) => c.remove());   // now empty
  }

  /* ---- the question as one line, the form behind Endre ---- */
  const sum = {};
  function summaryBar(kind) {
    const view = $(kind === 'kv' ? 'view-route' : 'view-tur'), form = view.querySelector('.kv-form'), result = $(kind + 'Result');
    const bar = document.createElement('div'); bar.className = 'gl-sum'; bar.id = kind + 'Sum';
    bar.innerHTML = `<div class="gl-sum-txt"><b></b><small></small></div><div class="gl-sum-btns">${kind === 'tv' ? '<button type="button" class="kv-chip gl-ret" hidden></button>' : ''}<button type="button" class="kv-chip gl-edit" aria-expanded="true"></button></div>`;
    form.insertAdjacentElement('beforebegin', bar);
    const btn = bar.querySelector('.gl-edit'), b = bar.querySelector('b'), sm = bar.querySelector('small'), ret = bar.querySelector('.gl-ret');
    const open = (on) => { view.classList.toggle('gl-form-open', on); btn.setAttribute('aria-expanded', on ? 'true' : 'false'); btn.innerHTML = on ? esc(t('ui.close')) : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M12.5 7.5l4 4"/></svg>${esc(t('ui.edit'))}`; };
    btn.addEventListener('click', () => { const on = !view.classList.contains('gl-form-open'); open(on); if (on) form.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    if (ret) ret.addEventListener('click', () => $('tvRetOpt').click());   // the engine's own toggle: plans the return at once when a trip is shown
    const txt = (sel) => { const e = view.querySelector(sel); return e ? e.textContent.trim() : ''; };
    const val = (id) => { const e = $(id); return e ? e.value.trim() : ''; };
    const when = () => { const d = txt('#' + kind + 'Days .on'), h = $(kind + 'Hour'); const o = h && h.selectedOptions[0]; return [d, o ? o.textContent.trim() : ''].filter(Boolean).join(' '); };
    const update = () => {
      const from = val(kind + 'From'), to = val(kind + 'To');
      if (kind === 'kv') { b.textContent = from || to ? `${from || '…'} → ${to || '…'}` : t('nav.route'); sm.textContent = [txt('#kvVeh .on'), when()].filter(Boolean).join(' · '); }
      else {
        const cl = $('tvClBtn') && $('tvClBtn').classList.contains('on') ? txt('#tvClBtn span') : '', ro = $('tvRetOpt'), retOn = ro && ro.classList.contains('on');
        b.textContent = cl || (from || to ? `${from || '…'} → ${to || '…'}` : t('nav.tur'));
        sm.textContent = [cl && from ? `${from} → ${to}${retOn ? ' → ' + from : ''}` : (retOn && from ? `→ ${from}` : ''), txt('#tvSeason .on'), txt('#tvPace .on'), when()].filter(Boolean).join(' · ');
        if (ret) { ret.hidden = !ro || ro.hidden || !(from && to); ret.classList.toggle('on', !!retOn); ret.setAttribute('aria-pressed', retOn ? 'true' : 'false'); ret.textContent = '↩ ' + t(retOn ? 'ui.ret.on' : 'ui.ret'); }
      }
      open(view.classList.contains('gl-form-open'));
    };
    let tm = 0; ['input', 'change', 'click'].forEach((ev) => form.addEventListener(ev, () => { clearTimeout(tm); tm = setTimeout(update, 60); }));
    const auto = () => { open(result.hidden); update(); };   // no trip yet: the form is open; a trip arrives: it folds
    new MutationObserver(auto).observe(result, { attributes: true, attributeFilter: ['hidden'] });
    auto();
    return { update, open };
  }

  /* ---- the verdict card on the map, collapsible to one line ---- */
  function verdictCard(kind) {
    const wrap = $(kind + 'MapWrap'); let el = wrap.querySelector('.gl-verdict');
    if (!el) {
      el = document.createElement('div'); el.className = 'gl-verdict'; wrap.appendChild(el);
      el.addEventListener('click', (e) => { if (!e.target.closest('.gl-vtog')) return; const c = !el.classList.contains('min'); el.classList.toggle('min', c); ls('glett.ui.vmin', c ? '1' : null); el.querySelector('.gl-vtog').setAttribute('aria-expanded', c ? 'false' : 'true'); });
    }
    el.classList.toggle('min', ls('glett.ui.vmin') === '1');
    return el;
  }
  const vhtml = (icon, h3, p, kind) => `<span class="gl-vi">${icon}</span><h3>${esc(h3)}</h3><p>${esc(p)}</p><button type="button" class="gl-vtog" aria-expanded="${kind ? 'true' : 'true'}" title="${esc(t('ui.vtog'))}" aria-label="${esc(t('ui.vtog'))}"></button>`;
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
    el.innerHTML = vhtml(WI.svg(v.p.code, !v.p.day), v.text, chips.join(' · '));
    sum.kv && sum.kv.update();
  }
  function renderTv(s) {
    const el = verdictCard('tv'), h = document.querySelector('#tvHead .tv-headline'), kind = h ? [...h.classList].find((c) => /^(good|ok|mid|bad)$/.test(c)) || '' : '';
    const chips = [...document.querySelectorAll('#tvHead .kv-badges .kv-badge')].map((b) => b.textContent.trim()).slice(0, 3);
    const p = s.pts[Math.floor(s.pts.length / 2)] || s.pts[0];
    el.className = 'gl-verdict ' + kind + (el.classList.contains('min') ? ' min' : '');
    el.innerHTML = vhtml(WI.svg(p.code, !p.day), h ? h.textContent : '', chips.join(' · '));
    sum.tv && sum.tv.update();
  }

  /* ---- the weather on the map: an icon with the time and the temperature at a few points; hover for the details ---- */
  function detail(kind, p) {
    const rows = [`<b>${esc(hm(p.at))}</b> · ${esc(WI.label(p.code))}`, `${Math.round(p.t)}°${kind === 'tv' && Number.isFinite(p.app) ? ' · ' + esc(t('ui.feels', { t: Math.round(p.app) })) : ''}`];
    if (p.g >= 1) rows.push(esc(t('ui.gust', { g: Math.round(p.g) })));
    if (p.mm >= 0.1) rows.push(esc(t('ui.mm', { mm: p.mm.toFixed(1).replace('.', LANG === 'nb' ? ',' : '.') })));
    if (p.dark) rows.push(esc(t('ui.dark')));
    if (p.z != null) rows.push(`${Math.round(p.z)} ${esc(t('kv.masl'))}`);
    return rows.join('<br>');
  }
  function mapMarks(kind, m, s, marks) {
    if (!s || !s.pts || typeof maplibregl === 'undefined') return;
    const small = innerWidth <= 700, pts = s.pts, n = Math.min(pts.length, kind === 'kv' ? (small ? 4 : 6) : (small ? 3 : 4)), picks = new Set();
    for (let i = 0; i < n; i++) picks.add(Math.round(i * (pts.length - 1) / Math.max(1, n - 1)));
    let pop = null;
    [...picks].forEach((i) => {
      const p = pts[i]; if (!Number.isFinite(p.t)) return;
      const el = document.createElement('div'); el.className = 'gl-wxmk';
      el.innerHTML = `<span class="i">${WI.svg(p.code, !p.day)}</span><span class="l">${esc(hm(p.at))} · ${Math.round(p.t)}°</span>`;
      const show = () => { m.getContainer().querySelectorAll('.maplibregl-popup:not(.gl-pop)').forEach((e) => e.remove()); if (pop) pop.remove(); pop = new maplibregl.Popup({ closeButton: false, closeOnClick: true, anchor: 'bottom', offset: innerWidth <= 700 ? 60 : 70, className: 'gl-pop' }).setLngLat([p.lon, p.lat]).setHTML(detail(kind, p)).addTo(m); };
      el.addEventListener('mouseenter', show); el.addEventListener('mousemove', (e) => e.stopPropagation());   // the route's own hover popup (street view) gives way to the weather el.addEventListener('mouseleave', () => { if (pop) { pop.remove(); pop = null; } });
      el.addEventListener('click', (e) => { e.stopPropagation(); if (pop) { pop.remove(); pop = null; } else show(); });
      marks.push(new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat([p.lon, p.lat]).addTo(m));
    });
  }

  window.GlettUI = {
    render(kind, S, sel) { if (kind === 'kv') renderKv(S, sel); else renderTv(S); },
    map: mapMarks,
  };
  columns('kv'); columns('tv');
  sum.kv = summaryBar('kv'); sum.tv = summaryBar('tv');
  document.addEventListener('glett:lang', () => { pages.querySelectorAll('button').forEach((b, i) => { b.textContent = t(VIEWS[i][1]); }); sum.kv.update(); sum.tv.update(); });
})();
