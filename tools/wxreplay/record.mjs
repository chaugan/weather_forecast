import { chromium } from '/opt/code/tools/browser/node_modules/playwright/index.mjs';
import { wxCache } from './wxcache.mjs';
export const ROUTES = {
  bergen: '#kv?a=59.9139,10.7522,Oslo&b=60.3913,5.3221,Bergen&p=car',
  trondheim: '#kv?a=59.9139,10.7522,Oslo&b=63.4305,10.3951,Trondheim&p=car',
  tromso: '#kv?a=59.9139,10.7522,Oslo&b=69.6492,18.9553,Troms%C3%B8&p=car',
};
const [base = 'http://127.0.0.1:4680/', mode = 'auto', only] = process.argv.slice(2);
const b = await chromium.launch();
for (const [name, hash] of Object.entries(ROUTES)) {
  if (only && only !== name) continue;
  const p = await b.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Europe/Oslo' });
  await p.addInitScript(() => { localStorage.setItem('glett.consent', JSON.stringify({ v: 'no', at: '2026-10-04' })); localStorage.setItem('glett.lang', 'nb'); });
  const c = await wxCache(p, name, base, { mode });
  let last = Date.now(); p.on('request', () => { last = Date.now(); });
  const t0 = Date.now(); await p.goto(base + hash);
  await p.waitForSelector('#kvSum .gl-sum-meta:not([hidden])', { timeout: 240000 });
  while (Date.now() - last < 25000 && Date.now() - t0 < 300000) await new Promise((r) => setTimeout(r, 2000));
  const n = await p.evaluate(() => document.querySelectorAll('#kvIt .kv-stage').length);
  console.log(name, c.rec ? 'RECORDED' : 'replayed', new Date(c.meta.at).toISOString(), 'stages', n, JSON.stringify({ ...c.stats, miss: c.stats.miss.length }), ((Date.now() - t0) / 1000).toFixed(0) + 's');
  if (c.stats.miss.length) console.log('  miss:', c.stats.miss.slice(0, 8).join('\n        '));
  c.save(); await p.close();
}
await b.close();
