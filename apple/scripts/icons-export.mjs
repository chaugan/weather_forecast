#!/usr/bin/env node
// js/icons.js -> Shared/Assets.xcassets/Weather/<name>.imageset/<name>.svg (+ <name>-dark.svg), vector preserved,
// and css/style.css:2-21 colour tokens -> Shared/Assets.xcassets/Colors/<token>.colorset (light + dark).
// Usage: node scripts/icons-export.mjs
// The web styles the icons with classes and page-wide gradients (css/style.css:104-111, :1178-1197); an asset
// catalog SVG has no stylesheet, so each file gets its own gradients and the CSS as presentation attributes.
// Night icons use a static moon (MOON_PHASE) instead of the real phase the web draws.
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../js/icons.js');
const OUT = resolve(here, '../Shared/Assets.xcassets/Weather');

/** Representative WMO code + day/night for each of the 14 icons (icons.js:80-95 `key`). */
const ICONS = {
  'clear-day': [0, false], 'clear-night': [0, true], 'partly-day': [2, false], 'partly-night': [2, true],
  cloudy: [3, false], fog: [45, false], drizzle: [53, false], rain: [63, false], 'heavy-rain': [65, false],
  'showers-day': [80, false], 'showers-night': [80, true], sleet: [66, false], snow: [73, false], thunder: [95, false],
};
/** 0 new, .5 full: a waxing crescent reads as "night" at any size and is not mistaken for the sun. */
const MOON_PHASE = 0.2;
const SYNODIC = 29.530588853, NEW_MOON_2000 = Date.UTC(2000, 0, 6, 18, 14);   // icons.js:13

// css/style.css:2-21 tokens the icons use
const THEME = {
  light: { cloudTop: '#eef3fb', cloudBot: '#8fa2c0', moonDarkOpacity: '.16' },
  dark: { cloudTop: '#e4ebf7', cloudBot: '#6b7b96', moonDarkOpacity: '.28' },
};
// icons.js:110-117 gradients, with the CSS variables resolved per theme
const defs = (th) => `<defs>
<radialGradient id="g-sun" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff3a6"/><stop offset=".45" stop-color="#ffc21a"/><stop offset="1" stop-color="#f08a00"/></radialGradient>
<radialGradient id="g-moon" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="#fffbe8"/><stop offset=".55" stop-color="#f6e2a0"/><stop offset="1" stop-color="#dcb95e"/></radialGradient>
<linearGradient id="g-cloud" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${th.cloudTop}"/><stop offset="1" stop-color="${th.cloudBot}"/></linearGradient>
<linearGradient id="g-drop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8fd0ff"/><stop offset="1" stop-color="#1d6fe0"/></linearGradient>
<radialGradient id="g-snow" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#8ecdf5"/></radialGradient>
<linearGradient id="g-bolt" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe66b"/><stop offset="1" stop-color="#f57c00"/></linearGradient>
</defs>`;
// The final cascade of css/style.css for `.wi .<class>`, as attributes (rgba split into colour + opacity)
const STYLE = (th) => ({
  sun: 'fill="url(#g-sun)"',
  ray: 'stroke="#ffb800" stroke-width="3.5" stroke-linecap="round" fill="none"',
  moon: 'fill="url(#g-moon)" stroke="#967328" stroke-opacity=".45" stroke-width="1"',
  'moon-dark': `fill="#b99a4e" opacity="${th.moonDarkOpacity}" stroke="#967328" stroke-opacity=".3" stroke-width="1"`,
  crater: 'fill="#c9a24c" opacity=".3"',
  cloud: 'fill="url(#g-cloud)" stroke="#506487" stroke-opacity=".45" stroke-width="1"',
  'cloud back': 'fill="url(#g-cloud)" stroke="#506487" stroke-opacity=".45" stroke-width="1" opacity=".82"',
  drop: 'fill="url(#g-drop)"',
  bolt: 'fill="url(#g-bolt)" stroke="#ffd54a" stroke-width=".8" stroke-linejoin="round"',
  fogl: 'fill="url(#g-cloud)"',
  snowc: 'fill="url(#g-snow)"',   // the group: its circles inherit the fill
});

function loadWI() {
  const ctx = vm.createContext({
    document: { body: { insertAdjacentHTML: () => {} } },
    t: (k) => k, hasT: () => true, Date, Math, console,
  });
  vm.runInContext(readFileSync(SRC, 'utf8') + '\n;globalThis.WI = WI;', ctx, { filename: SRC });
  return ctx.WI;
}

function toSvg(WI, name, theme) {
  const [code, night] = ICONS[name];
  const when = NEW_MOON_2000 + MOON_PHASE * SYNODIC * 86400e3;
  const html = WI.svg(code, night, '', when);
  const m = /^<svg[^>]*>(?:<title>[^<]*<\/title>)?([\s\S]*)<\/svg>$/.exec(html);
  if (!m) throw new Error(`${name}: unexpected markup from WI.svg`);
  const th = THEME[theme], st = STYLE(th);
  let body = m[1].replace(/ class="([^"]+)"/g, (all, cls) => {
    if (st[cls]) return ' ' + st[cls];
    return '';   // structural groups (rays, cloudg, drops, dropg, fogg, moong, cloudg2) only carry animations on the web
  });
  // clip ids are per phase on the web; one file has one moon, so a fixed id is enough
  body = body.replace(/id="mc\d+"/g, 'id="moonclip"').replace(/url\(#mc\d+\)/g, 'url(#moonclip)');
  if (/class=|var\(/.test(body)) throw new Error(`${name}: unresolved class or CSS variable`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">\n${defs(th)}\n${body}\n</svg>\n`;
}

// Minimal well-formedness check: balanced tags, every url(#id) defined
function validate(name, svg) {
  const stack = [];
  for (const m of svg.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, close, tag, , self] = m;
    if (self) continue;
    if (close) { if (stack.pop() !== tag) throw new Error(`${name}: mismatched </${tag}>`); } else stack.push(tag);
  }
  if (stack.length) throw new Error(`${name}: unclosed <${stack.join('>, <')}>`);
  const ids = new Set([...svg.matchAll(/id="([^"]+)"/g)].map((x) => x[1]));
  for (const [, ref] of svg.matchAll(/url\(#([^)]+)\)/g)) if (!ids.has(ref)) throw new Error(`${name}: url(#${ref}) undefined`);
  if (/NaN|undefined/.test(svg)) throw new Error(`${name}: NaN/undefined in output`);
}

const WI = loadWI();
mkdirSync(OUT, { recursive: true });
for (const d of readdirSync(OUT)) if (d.endsWith('.imageset') && !ICONS[d.replace(/\.imageset$/, '')]) rmSync(resolve(OUT, d), { recursive: true });
writeFileSync(resolve(OUT, 'Contents.json'), JSON.stringify({ info: { author: 'xcode', version: 1 }, properties: { 'provides-namespace': true } }, null, 2) + '\n');
for (const name of Object.keys(ICONS)) {
  const dir = resolve(OUT, `${name}.imageset`);
  mkdirSync(dir, { recursive: true });
  const light = toSvg(WI, name, 'light'), dark = toSvg(WI, name, 'dark');
  validate(name, light); validate(name, dark);
  writeFileSync(resolve(dir, `${name}.svg`), light);
  const images = [{ filename: `${name}.svg`, idiom: 'universal' }];
  if (dark !== light) {
    writeFileSync(resolve(dir, `${name}-dark.svg`), dark);
    images.push({ appearances: [{ appearance: 'luminosity', value: 'dark' }], filename: `${name}-dark.svg`, idiom: 'universal' });
  } else rmSync(resolve(dir, `${name}-dark.svg`), { force: true });
  const contents = { images, info: { author: 'xcode', version: 1 }, properties: { 'preserves-vector-representation': true, 'template-rendering-intent': 'original' } };
  writeFileSync(resolve(dir, 'Contents.json'), JSON.stringify(contents, null, 2) + '\n');
}
console.log(`wrote ${Object.keys(ICONS).length} icons to ${OUT}`);

// Colours: the light tokens of the first :root block, overridden by the explicit dark theme block (style.css:18-21)
const CSS = resolve(here, '../../css/style.css');
const COLORS = resolve(here, '../Shared/Assets.xcassets/Colors');
const css = readFileSync(CSS, 'utf8');
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)].map((m) => [m[1], m[2]]));
const lightBlock = /:root\s*\{([^}]*)\}/.exec(css)?.[1], darkBlock = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)?.[1];
if (!lightBlock || !darkBlock) throw new Error('colour tokens not found in css/style.css');
const light = tokens(lightBlock), dark = { ...light, ...tokens(darkBlock) };
const hex = (h) => { h = h.slice(1); if (h.length === 3) h = [...h].map((c) => c + c).join(''); return h.toUpperCase(); };
const comp = (h) => { const x = hex(h); return { alpha: '1.000', red: '0x' + x.slice(0, 2), green: '0x' + x.slice(2, 4), blue: '0x' + x.slice(4, 6) }; };
mkdirSync(COLORS, { recursive: true });
for (const d of readdirSync(COLORS)) if (d.endsWith('.colorset') && !light[d.replace(/\.colorset$/, '')]) rmSync(resolve(COLORS, d), { recursive: true });
writeFileSync(resolve(COLORS, 'Contents.json'), JSON.stringify({ info: { author: 'xcode', version: 1 }, properties: { 'provides-namespace': true } }, null, 2) + '\n');
for (const name of Object.keys(light)) {
  const dir = resolve(COLORS, `${name}.colorset`);
  mkdirSync(dir, { recursive: true });
  const colors = [{ color: { 'color-space': 'srgb', components: comp(light[name]) }, idiom: 'universal' },
    { appearances: [{ appearance: 'luminosity', value: 'dark' }], color: { 'color-space': 'srgb', components: comp(dark[name]) }, idiom: 'universal' }];
  writeFileSync(resolve(dir, 'Contents.json'), JSON.stringify({ colors, info: { author: 'xcode', version: 1 } }, null, 2) + '\n');
}
console.log(`wrote ${Object.keys(light).length} colours to ${COLORS}: ${Object.keys(light).join(', ')}`);
