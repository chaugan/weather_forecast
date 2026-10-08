// Replays the cached routes at several departures in several variants of the weather split, 4 pages at a time; prints the stage lists.
import { chromium } from '/opt/code/tools/browser/node_modules/playwright/index.mjs';
import { wxCache } from './wxcache.mjs';
import fs from 'node:fs';
const ROUTES = { bergen: '#kv?a=59.9139,10.7522,Oslo&b=60.3913,5.3221,Bergen&p=car', trondheim: '#kv?a=59.9139,10.7522,Oslo&b=63.4305,10.3951,Trondheim&p=car', tromso: '#kv?a=59.9139,10.7522,Oslo&b=69.6492,18.9553,Troms%C3%B8&p=car' };
const VARS = { today: [null], cls20: ['1', 20], cls30: ['1', 30], fam20: ['fam', 20], fam30: ['fam', 30] };
const [base = 'http://127.0.0.1:4680/', deps = '2026100808,2026100815,2026100907,2026101007', vars = 'today,cls20,cls30,fam20,fam30', veh = 'car', shots = ''] = process.argv.slice(2);
const b = await chromium.launch(), jobs = [], res = {};
for (const name of Object.keys(ROUTES)) for (const d of deps.split(',')) for (const v of vars.split(',')) jobs.push([name, d, v]);
const run = async ([name, d, v]) => {
  const p = await b.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Europe/Oslo' });
  await p.addInitScript(([on, min]) => { localStorage.setItem('glett.consent', JSON.stringify({ v: 'no', at: '2026-10-04' })); localStorage.setItem('glett.lang', 'nb'); if (on) { localStorage.setItem('glett.kv.wxsplit', on); localStorage.setItem('glett.kv.wxsmin', String(min)); } }, VARS[v]);
  await wxCache(p, name, base, { mode: 'replay' });
  await p.goto(base + ROUTES[name].replace('p=car', 'p=' + veh) + '&d=' + d);
  await p.waitForSelector('#kvSum .gl-sum-meta:not([hidden])', { timeout: 240000 }); await p.waitForTimeout(4000);
  const rows = await p.evaluate(() => [...document.querySelectorAll('#kvIt li')].filter((li) => li.classList.contains('kv-stage') || li.parentElement.id === 'kvIt').map((li) => {
    const sp = li.children; return [sp[0]?.textContent.trim(), (sp[1]?.textContent || '').replace(/\s+/g, ' ').trim(), (li.querySelector('.kv-wx')?.textContent || '').replace(/\s+/g, ' ').replace('Temperatur: ', ' T ').trim()].join(' | ');
  }));
  (res[`${name} ${d}`] ||= {})[v] = rows;
  if (shots.split(',').includes(`${name}:${d}:${v}`)) { await p.addStyleTag({ content: '.kv-it li.kv-stage{transition:none}' }); const el = await p.$('#kvIt'); await el.screenshot({ path: `it_${veh}_${name}_${d}_${v}.png` }); }
  await p.close();
};
const q = [...jobs]; await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) await run(q.shift()); }));
fs.writeFileSync(`sim2_${veh}.json`, JSON.stringify(res, null, 1));
for (const [k, o] of Object.entries(res)) { console.log(`\n### ${k}  rows: ${Object.entries(o).map(([v, r]) => `${v} ${r.length - 1}`).join(', ')}`); for (const [v, r] of Object.entries(o)) { console.log(`  -- ${v}`); r.forEach((x) => console.log('    ' + x)); } }
await b.close();
