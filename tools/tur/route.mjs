// Turvær: route between two points on the built tiles from the command line, for checks without a browser:
//   node tools/tur/route.mjs LAT,LON LAT,LON [trackCost=1.6] [winter]
// Prints the length, the climb-free summary and the share on tracks for the given cost factor of a track.
import fs from 'node:fs';
const OUT = new URL('../../data/tur/', import.meta.url).pathname;
const [A, B] = process.argv.slice(2, 4).map((s) => s.split(',').map(Number)), COST = +(process.argv[4] || 1.6), winter = process.argv[5] === 'winter';
const hav = (a, b) => { const r = Math.PI / 180, x = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(x)); };
const idx = JSON.parse(fs.readFileSync(OUT + 'index.json', 'utf8'));
const nodes = new Map(), adj = new Map();
const add = (file, k) => { if (!fs.existsSync(file)) return; JSON.parse(fs.readFileSync(file, 'utf8')).e.forEach((e) => { const c = []; for (let i = 0; i < e[3].length; i += 2) c.push([e[3][i], e[3][i + 1]]); const edge = { a: e[0], b: e[1], m: e[2], c, k }; if (!nodes.has(edge.a)) nodes.set(edge.a, c[0]); if (!nodes.has(edge.b)) nodes.set(edge.b, c[c.length - 1]); for (const [u, v] of [[edge.a, edge.b], [edge.b, edge.a]]) { if (!adj.has(u)) adj.set(u, []); adj.get(u).push([v, edge]); } }); };
const m = 0.12, la0 = Math.floor((Math.min(A[0], B[0]) - m) * 4), la1 = Math.floor((Math.max(A[0], B[0]) + m) * 4), lo0 = Math.floor((Math.min(A[1], B[1]) - 2 * m) * 2), lo1 = Math.floor((Math.max(A[1], B[1]) + 2 * m) * 2);
for (let a = la0; a <= la1; a++) for (let b = lo0; b <= lo1; b++) { const k = `${a}_${b}`; if (winter) add(`${OUT}s/${k}.json`, 1); else { add(`${OUT}g/${k}.json`, 1); add(`${OUT}t/${k}.json`, 2); } }
const nearest = (p) => { let best = -1, bd = 400; nodes.forEach((q, id) => { const d = hav(p, q); if (d < bd) { bd = d; best = id; } }); return best; };
const from = nearest(A), to = nearest(B); if (from < 0 || to < 0) { console.log('off the network'); process.exit(1); }
const dist = new Map([[from, 0]]), prev = new Map(), heap = [[0, from]];
const push = (x) => { heap.push(x); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (r < heap.length && heap[r][0] < heap[s][0]) s = r; if (s === i) break; [heap[s], heap[i]] = [heap[i], heap[s]]; i = s; } } return top; };
while (heap.length) { const [d, u] = pop(); if (u === to) break; if (d > dist.get(u)) continue; for (const [v, e] of adj.get(u) || []) { const nd = d + (e.k === 2 ? e.m * COST : e.m); if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, [u, e]); push([nd, v]); } } }
if (!dist.has(to)) { console.log('no path'); process.exit(1); }
let at = to, tot = 0, trk = 0, n = 0; while (at !== from) { const [u, e] = prev.get(at); tot += e.m; if (e.k === 2) trk += e.m; n++; at = u; }
console.log(`cost ${COST}: ${(tot / 1000).toFixed(1)} km, on tracks ${(trk / 1000).toFixed(1)} km, ${n} edges, nodes loaded ${nodes.size}`);
