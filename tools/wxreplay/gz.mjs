// MC grip stretches on the recorded trips: the chart's shaded areas and the stage list's bracket; screenshots and the texts.
import { chromium } from '/opt/code/tools/browser/node_modules/playwright/index.mjs';
import { wxCache } from './wxcache.mjs';
const ROUTES = { bergen: '#kv?a=59.9139,10.7522,Oslo&b=60.3913,5.3221,Bergen&p=mc', trondheim: '#kv?a=59.9139,10.7522,Oslo&b=63.4305,10.3951,Trondheim&p=mc', tromso: '#kv?a=59.9139,10.7522,Oslo&b=69.6492,18.9553,Troms%C3%B8&p=mc' };
const [base = 'http://127.0.0.1:4680/', jobs = 'trondheim:2026100815,tromso:2026100808', W = '1280', scheme = 'light', out = '.'] = process.argv.slice(2);
const b = await chromium.launch();
for (const j of jobs.split(',')) {
  const [name, d] = j.split(':');
  const p = await b.newPage({ viewport: { width: +W, height: 900 }, colorScheme: scheme, timezoneId: 'Europe/Oslo' });
  const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.addInitScript(() => { localStorage.setItem('glett.consent', JSON.stringify({ v: 'no', at: '2026-10-04' })); localStorage.setItem('glett.lang', 'nb'); });
  const c = await wxCache(p, name, base, { mode: process.env.FILL ? 'fill' : 'replay' });
  await p.goto(base + ROUTES[name] + '&d=' + d);
  await p.waitForSelector('#kvSum .gl-sum-meta:not([hidden])', { timeout: 240000 }); await p.waitForTimeout(4000);
  const r = await p.evaluate(() => ({
    areas: document.querySelectorAll('#kvChart .kv-gz-area').length, labels: [...document.querySelectorAll('#kvChart .kv-gz-t')].map((x) => x.textContent),
    heads: [...document.querySelectorAll('#kvIt .kv-gzhead')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
    bracketed: document.querySelectorAll('#kvIt li.kv-gz').length, stageGrip: [...document.querySelectorAll('#kvIt .kv-gripst')].map((x) => x.textContent),
    badges: [...document.querySelectorAll('.kv-badge, .kv-b')].map((x) => x.textContent).filter((x) => /grep/.test(x)).slice(0, 3) }));
  console.log(name, d, W, scheme, JSON.stringify(r, null, 1), 'errors', errs, 'misses', c.stats.miss.filter((u) => !/datex|roads\.php|historical/.test(u)));
  await p.locator('#kvChartCard').screenshot({ path: `${out}/gz_chart_${name}_${d}_${W}_${scheme}.png` });
  await p.locator('#view-route .kv-itcard').screenshot({ path: `${out}/gz_it_${name}_${d}_${W}_${scheme}.png` });
  await p.close();
}
await b.close();
