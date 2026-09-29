/* Google Analytics (GA4) only after the visitor says yes. Norwegian ekomloven § 3-15 / GDPR: analytics cookies need
   prior consent, and saying no must be as easy as saying yes. Until "Godta" nothing is loaded from Google.
   Choice stored in localStorage 'glett.consent' = 'yes' | 'no' (with a date); "Informasjonskapsler" in the footer reopens it. */
(function () {
  const GA_ID = 'G-K9YMVETZ46', KEY = 'glett.consent';
  const T = {
    nb: { text: 'Glett vil gjerne bruke Google Analytics for å se hvor mange som bruker siden og hva som brukes, så vi kan gjøre den bedre. Det setter informasjonskapsler. Vi selger ingen data og viser ingen reklame.', yes: 'Godta', no: 'Avslå', more: 'Les mer' },
    en: { text: 'Glett would like to use Google Analytics to see how many people use the site and which parts, so we can improve it. This sets cookies. We sell no data and show no ads.', yes: 'Accept', no: 'Decline', more: 'Read more' },
  };
  const get = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
  const set = (v) => { try { localStorage.setItem(KEY, JSON.stringify({ v, at: new Date().toISOString().slice(0, 10) })); } catch (e) { /* private mode: ask again next time */ } };
  let loaded = false;
  function loadGA() {
    if (loaded) return; loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, { anonymize_ip: true });
    const s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
  }
  function clearGA() {   // withdrawing consent: remove Google's cookies for this site
    document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter((n) => /^_ga/.test(n)).forEach((n) => {
      [location.hostname, '.' + location.hostname.replace(/^www\./, '')].forEach((d) => { document.cookie = `${n}=; Max-Age=0; path=/; domain=${d}`; });
      document.cookie = `${n}=; Max-Age=0; path=/`;
    });
  }
  function lang() { return (document.documentElement.lang || 'nb').startsWith('en') ? 'en' : 'nb'; }
  function banner() {
    let el = document.getElementById('consent');
    if (el) el.remove();
    const L = T[lang()];
    el = document.createElement('div'); el.id = 'consent'; el.className = 'consent'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-live', 'polite');
    el.innerHTML = `<p>${L.text} <a href="privacy.html#analyse">${L.more}</a></p><div class="cs-btns"><button type="button" class="btn cs-no">${L.no}</button><button type="button" class="btn cs-yes">${L.yes}</button></div>`;
    document.body.appendChild(el);
    el.querySelector('.cs-yes').addEventListener('click', () => { set('yes'); el.remove(); loadGA(); });
    el.querySelector('.cs-no').addEventListener('click', () => { set('no'); el.remove(); clearGA(); });
  }
  window.glettConsent = { open: banner };
  document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('[data-consent]'); if (a) { e.preventDefault(); banner(); } });
  const c = get();
  if (c && c.v === 'yes') loadGA();
  else if (!c) (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', banner) : banner());
})();
