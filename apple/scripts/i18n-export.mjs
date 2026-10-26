#!/usr/bin/env node
// js/i18n.js -> apple/Shared/Localizable.xcstrings (the web's strings are the source of truth).
// Usage: node scripts/i18n-export.mjs          write the catalog
//        node scripts/i18n-export.mjs check    exit 1 if js/i18n.js has keys or values the catalog lacks
// Same key names as the web, values verbatim with their {name} placeholders. Keys whose value holds HTML get the
// comment "HTML: ..." so they can be found (render them with L10n.attributed / L10n.stripped).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../js/i18n.js');
const OUT = resolve(here, '../Shared/Localizable.xcstrings');
const LANGS = ['nb', 'en'];
const HTML_RE = /<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>|&[a-z]+;|&#\d+;/i;

function loadI18N() {
  // i18n.js is a browser script: give it just enough of a browser to load, then read its top-level const
  const ctx = vm.createContext({
    navigator: { languages: ['nb-NO'], language: 'nb-NO' },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { querySelectorAll: () => [], documentElement: {}, addEventListener: () => {}, dispatchEvent: () => {} },
    CustomEvent: class {},
    console,
  });
  vm.runInContext(readFileSync(SRC, 'utf8'), ctx, { filename: SRC });
  return vm.runInContext('I18N', ctx);
}

function build(I18N) {
  const keys = new Set();
  for (const l of LANGS) for (const k of Object.keys(I18N[l] || {})) keys.add(k);
  const strings = {};
  for (const k of [...keys].sort()) {
    const entry = { extractionState: 'manual', localizations: {} };
    const html = LANGS.some((l) => typeof I18N[l]?.[k] === 'string' && HTML_RE.test(I18N[l][k]));
    if (html) entry.comment = 'HTML: render with L10n.attributed(key) or L10n.stripped(key), not as plain text.';
    for (const l of LANGS) {
      const v = I18N[l]?.[k];
      if (typeof v === 'string') entry.localizations[l] = { stringUnit: { state: 'translated', value: v } };
    }
    if (!entry.comment) delete entry.comment;
    strings[k] = entry;
  }
  return { sourceLanguage: 'nb', strings, version: '1.0' };
}

// Xcode writes catalogs with " : " separators and two-space indent; match it so a save in Xcode gives no noise
const serialize = (obj) => JSON.stringify(obj, null, 2).replace(/^(\s*"(?:[^"\\]|\\.)*"): /gm, '$1 : ') + '\n';

const I18N = loadI18N();
const fresh = build(I18N);

if (process.argv[2] === 'check') {
  let cat;
  try { cat = JSON.parse(readFileSync(OUT, 'utf8')); } catch (e) { console.error(`cannot read ${OUT}: ${e.message}`); process.exit(1); }
  const problems = [];
  for (const [k, e] of Object.entries(fresh.strings)) {
    const c = cat.strings?.[k];
    if (!c) { problems.push(`missing key: ${k}`); continue; }
    for (const [l, u] of Object.entries(e.localizations)) {
      const have = c.localizations?.[l]?.stringUnit?.value;
      if (have !== u.stringUnit.value) problems.push(`${have == null ? 'missing' : 'changed'} ${l}: ${k}`);
    }
  }
  for (const k of Object.keys(cat.strings || {})) if (!fresh.strings[k]) problems.push(`stale key (not in js/i18n.js): ${k}`);
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`${problems.length} difference(s); run: node apple/scripts/i18n-export.mjs`);
    process.exit(1);
  }
  console.log(`catalog up to date (${Object.keys(fresh.strings).length} keys)`);
} else {
  writeFileSync(OUT, serialize(fresh));
  const n = Object.keys(fresh.strings).length;
  const html = Object.entries(fresh.strings).filter(([, e]) => e.comment).map(([k]) => k);
  const onlyNb = Object.entries(fresh.strings).filter(([, e]) => !e.localizations.en).map(([k]) => k);
  const onlyEn = Object.entries(fresh.strings).filter(([, e]) => !e.localizations.nb).map(([k]) => k);
  console.log(`wrote ${OUT}: ${n} keys, ${html.length} with HTML (${html.join(', ')})`);
  if (onlyNb.length) console.log(`nb only (en falls back to the key): ${onlyNb.join(', ')}`);
  if (onlyEn.length) console.log(`en only (nb falls back to en): ${onlyEn.join(', ')}`);
}
