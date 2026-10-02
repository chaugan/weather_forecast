// Looks up the hand-picked sights (top.txt) in Kartverket's place names, in the municipality given, and writes top.json.
// Run when top.txt changes: node tools/poi/geocode-top.mjs
import fs from 'node:fs';
const dir = new URL('.', import.meta.url).pathname;
const lines = fs.readFileSync(dir + 'top.txt', 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
const out = [], miss = [];
for (const l of lines) {
  const [kind, name, kom, shown, type] = l.split('|');
  const u = `https://ws.geonorge.no/stedsnavn/v1/navn?sok=${encodeURIComponent(name)}&fuzzy=false&treffPerSide=50&utkoordsys=4258`;
  const j = await (await fetch(u)).json();
  const hits = (j.navn || []).filter((x) => x.skrivemåte.toLowerCase() === name.toLowerCase() && (x.kommuner || []).some((k) => k.kommunenavn.toLowerCase() === kom.toLowerCase()) && (!type || x.navneobjekttype === type));
  if (!hits.length) { miss.push(`${name} (${kom}): ${(j.navn || []).slice(0, 4).map((x) => x.skrivemåte + '/' + (x.kommuner || []).map((k) => k.kommunenavn).join('+') + '/' + x.navneobjekttype).join('; ')}`); continue; }
  const h = hits[0];
  out.push({ k: kind, n: shown || name, la: +h.representasjonspunkt.nord.toFixed(5), lo: +h.representasjonspunkt.øst.toFixed(5), t: h.navneobjekttype, id: h.stedsnummer });
}
fs.writeFileSync(dir + 'top.json', JSON.stringify(out, null, 1));
console.log(out.length, 'found;', miss.length, 'missing'); miss.forEach((m) => console.log('  -', m));
console.log(out.map((o) => `${o.n}: ${o.t}`).join(', '));
