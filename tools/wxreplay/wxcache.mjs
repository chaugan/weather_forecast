// Record once, replay after: every data request a Kjørevær page makes (Open-Meteo, MET/NVE/DATEX through api/*.php, Valhalla,
// NVDB, Geonorge …) is kept on disk under ~/.cache/glett-wxreplay/<route>/, keyed by method + URL + body. Replay serves only from disk (a miss is
// aborted and logged) and freezes the page clock at the recording time, so the forecast hours line up with "Nå".
// Map tiles and images are left to the network (not weather, not Open-Meteo).
import fs from 'node:fs'; import crypto from 'node:crypto'; import path from 'node:path';
const DIR = path.join(process.env.HOME, '.cache/glett-wxreplay');   // outside the repo: ~260 MB, NVDB road data mostly
const skip = (u, type) => type === 'image' || type === 'font' || type === 'stylesheet' || /\/tiles?\/|\.pbf|\.png|\.jpe?g|\.webp|\.svg|\.woff2?/.test(u);
export async function wxCache(page, name, base, { mode = 'auto' } = {}) {
  const dir = path.join(DIR, name); fs.mkdirSync(dir, { recursive: true });
  const metaF = path.join(dir, '_meta.json');
  // fill: a replay that also records what is missing (another vehicle asks a few more things), Open-Meteo never
  const rec = mode === 'record' || (mode === 'auto' && !fs.existsSync(metaF)), fill = mode === 'fill' && fs.existsSync(metaF);
  const meta = rec ? { at: Date.now(), name } : JSON.parse(fs.readFileSync(metaF, 'utf8'));
  const stats = { hit: 0, rec: 0, miss: [], om: 0 };
  if (!rec) await page.clock.install({ time: meta.at });
  // the route itself does not change with the departure: a replay at another departure takes the recorded route
  const norm = (u) => u.replace(/([?&])start=\d+&?/, '$1');
  const byNorm = new Map(); if (!rec) fs.readdirSync(dir).filter((x) => x !== '_meta.json').forEach((x) => { try { const c = JSON.parse(fs.readFileSync(path.join(dir, x), 'utf8')); if (/api\/route\.php/.test(c.u)) byNorm.set(norm(c.u), path.join(dir, x)); } catch (e) {} });
  await page.route('**/*', async (route) => {
    const r = route.request(), u = r.url();
    const local = u.startsWith(base); if ((local && !u.includes('/api/')) || skip(u, r.resourceType()) || u.startsWith('data:')) return route.continue();
    const key = crypto.createHash('sha1').update(r.method() + ' ' + u + ' ' + (r.postData() || '')).digest('hex');
    let f = path.join(dir, key + '.json'); if (!rec && !fs.existsSync(f) && byNorm.has(norm(u))) f = byNorm.get(norm(u));
    if (/open-meteo\.com/.test(u)) stats.om++;
    if (fs.existsSync(f)) { const c = JSON.parse(fs.readFileSync(f, 'utf8')); stats.hit++; return route.fulfill({ status: c.status, headers: { 'content-type': c.ct, 'access-control-allow-origin': '*' }, body: Buffer.from(c.b, 'base64') }); }
    if (!rec && !(fill && !/open-meteo\.com/.test(u))) { stats.miss.push(u.slice(0, 160)); return route.abort(); }
    try { const resp = await route.fetch(); const body = await resp.body();
      if (resp.status() < 500 && resp.status() !== 429) { fs.writeFileSync(f, JSON.stringify({ u, status: resp.status(), ct: resp.headers()['content-type'] || '', b: body.toString('base64') })); stats.rec++; if (fill) stats.miss.push('filled ' + u.slice(0, 100)); }
      else stats.miss.push(resp.status() + ' ' + u.slice(0, 160));
      return route.fulfill({ response: resp, body });
    } catch (e) { stats.miss.push('ERR ' + u.slice(0, 160)); return route.abort(); }
  });
  return { rec, meta, stats, save: () => rec && fs.writeFileSync(metaF, JSON.stringify(meta)) };
}
