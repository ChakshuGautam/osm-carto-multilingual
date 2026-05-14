#!/usr/bin/env node
// Mechanical translation filler for Kenya admin labels in en/sw/fr.
//
// Most counties already have multilingual labels from Wikidata. Sub-counties and wards
// almost never do. Kenyan admin-unit naming is highly formulaic, so we apply a per-level
// suffix template per language. The proper noun (e.g., "Westlands") doesn't translate;
// only the administrative type word does.
//
// Templates per (admin_level, language):
//   L4 County     en: "{base} County"           sw: "Kaunti ya {base}"     fr: "Comté de {base}"
//   L6 Sub-county en: "{base}"                  sw: "{base}"               fr: "{base}"
//      (in standard Kenyan usage, sub-counties are referred to by the proper noun alone)
//   L8 Ward       en: "{base} Ward"             sw: "Kata ya {base}"       fr: "Quartier de {base}"
//
// "base" is the OSM `name` with any English admin-type suffix stripped
// ("Foo County" → "Foo", "Bar ward" → "Bar", "Baz Sub-county" → "Baz").
//
// Only fills slots that are currently empty — won't overwrite Wikidata/OSM data.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');

const LANGS = ['en', 'sw', 'fr'];

// Strip common admin-type suffixes/prefixes from the OSM name.
const SUFFIX_RE = /\s+(county|sub-?county|constituency|ward|division|location|sub-?location|district)$/i;
const PREFIX_RE = /^(kaunti ya|comté de|comte de|quartier de|kata ya)\s+/i;
function strip(name) {
  if (!name) return name;
  return name.replace(SUFFIX_RE, '').replace(PREFIX_RE, '').trim();
}

const TEMPLATES = {
  4: { en: (b) => `${b} County`,     sw: (b) => `Kaunti ya ${b}`,    fr: (b) => `Comté de ${b}` },
  6: { en: (b) => `${b}`,            sw: (b) => `${b}`,              fr: (b) => `${b}` },
  8: { en: (b) => `${b} Ward`,       sw: (b) => `Kata ya ${b}`,      fr: (b) => `Quartier de ${b}` },
};

function summarize(features, label) {
  const byLevel = {};
  for (const f of features) {
    if (f.properties.kind !== 'label') continue;
    const lvl = f.properties.admin_level;
    if (!byLevel[lvl]) byLevel[lvl] = { total: 0, en: 0, sw: 0, fr: 0 };
    byLevel[lvl].total++;
    for (const l of LANGS) if (f.properties[`name:${l}`]) byLevel[lvl][l]++;
  }
  const levelName = { 4: 'County', 6: 'Sub-county', 8: 'Ward' };
  console.log(`  ${label}`);
  for (const lvl of [4, 6, 8]) {
    const v = byLevel[lvl];
    if (!v) continue;
    console.log(`    L${lvl} ${levelName[lvl].padEnd(10)} total=${String(v.total).padStart(4)}   en=${String(v.en).padStart(4)}   sw=${String(v.sw).padStart(4)}   fr=${String(v.fr).padStart(4)}`);
  }
}

function main() {
  const file = path.join(DATA, 'kenya_admin.geojson');
  const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('Before:');
  summarize(fc.features, 'admin');

  const filled = { 4: { en: 0, sw: 0, fr: 0 }, 6: { en: 0, sw: 0, fr: 0 }, 8: { en: 0, sw: 0, fr: 0 } };
  for (const f of fc.features) {
    const props = f.properties;
    const lvl = props.admin_level;
    const tmpl = TEMPLATES[lvl];
    if (!tmpl) continue;
    const base = strip(props.name);
    if (!base) continue;
    for (const lang of LANGS) {
      const key = `name:${lang}`;
      if (props[key]) continue;
      props[key] = tmpl[lang](base);
      if (f.properties.kind === 'label') filled[lvl][lang]++;
    }
  }

  // Also fill boundary features (for consistent property data, even though only the label
  // features carry text in the renderer).
  console.log('\nFormula fills (label features only counted):');
  const levelName = { 4: 'County', 6: 'Sub-county', 8: 'Ward' };
  for (const lvl of [4, 6, 8]) {
    console.log(`    L${lvl} ${levelName[lvl].padEnd(10)} +en=${filled[lvl].en}  +sw=${filled[lvl].sw}  +fr=${filled[lvl].fr}`);
  }

  console.log('\nAfter:');
  summarize(fc.features, 'admin');

  fs.writeFileSync(file, JSON.stringify(fc));
  console.log('\nWrote data/kenya_admin.geojson.');

  // Show some samples so the user can sanity-check the formula output.
  console.log('\nSamples (first 3 per level):');
  for (const lvl of [4, 6, 8]) {
    const samples = fc.features.filter(f => f.properties.kind === 'label' && f.properties.admin_level === lvl).slice(0, 3);
    for (const s of samples) {
      console.log(`  L${lvl}  ${s.properties.name}  →  en="${s.properties['name:en']}"  sw="${s.properties['name:sw']}"  fr="${s.properties['name:fr']}"`);
    }
  }
}

main();
