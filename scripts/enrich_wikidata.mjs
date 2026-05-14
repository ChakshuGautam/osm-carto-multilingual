#!/usr/bin/env node
// Enrich Kenya admin features (county / sub-county / ward) with multilingual labels
// (en/sw/fr) from Wikidata.
//
// Two passes:
//   Pass A — exact Q-id lookup: for features whose OSM `wikidata` tag is set, batch-fetch
//            labels via the wbgetentities API (50 ids per call).
//   Pass B — name+proximity match against a SPARQL dump of all Kenyan administrative
//            territorial entities with coords + labels.
//
// Output: rewrites data/kenya_admin.geojson in place.
// Cache:  data/wikidata_cache.json (reruns are cheap; delete to force refetch).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA, 'wikidata_cache.json');

const UA = 'kenya-map-bootstrap/0.1 (local dev; contact: kanav11dwevedi@gmail.com)';
const LANGS = ['en', 'sw', 'fr'];
const PROXIMITY_KM = 8;
const BUCKET_DEG = 0.2;

// ---- helpers ---------------------------------------------------------------
function normName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(county|sub-?county|constituency|ward|division|location|sublocation|sub-?location)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]), lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { /* fall through */ }
  }
  return { wbentities: {}, sparql: null };
}
function saveCache(c) { fs.writeFileSync(CACHE_FILE, JSON.stringify(c)); }

// ---- Pass A ----------------------------------------------------------------
async function fetchEntitiesBatch(ids) {
  const url = new URL('https://www.wikidata.org/w/api.php');
  url.searchParams.set('action', 'wbgetentities');
  url.searchParams.set('format', 'json');
  url.searchParams.set('props', 'labels');
  url.searchParams.set('languages', LANGS.join('|'));
  url.searchParams.set('ids', ids.join('|'));
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`wbgetentities ${res.status}`);
  const json = await res.json();
  const out = {};
  for (const [qid, ent] of Object.entries(json.entities || {})) {
    if (ent.missing !== undefined) { out[qid] = null; continue; }
    const labels = {};
    for (const lang of LANGS) if (ent.labels && ent.labels[lang]) labels[lang] = ent.labels[lang].value;
    out[qid] = labels;
  }
  return out;
}

async function passA(features, cache) {
  const all = new Set();
  for (const f of features) {
    const q = f.properties.wikidata;
    if (q && /^Q\d+$/.test(q)) all.add(q);
  }
  const ids = [...all].filter((q) => !(q in cache.wbentities));
  console.log(`  Pass A: ${all.size} unique Q-ids on features, ${ids.length} not in cache`);
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    process.stdout.write(`\r    batch ${Math.floor(i / 50) + 1}/${Math.ceil(ids.length / 50)}   `);
    const got = await fetchEntitiesBatch(batch);
    Object.assign(cache.wbentities, got);
    saveCache(cache);
  }
  if (ids.length) process.stdout.write('\n');

  let filled = { en: 0, sw: 0, fr: 0 };
  for (const f of features) {
    const q = f.properties.wikidata;
    if (!q) continue;
    const labels = cache.wbentities[q];
    if (!labels) continue;
    for (const lang of LANGS) {
      const key = `name:${lang}`;
      if (!f.properties[key] && labels[lang]) {
        f.properties[key] = labels[lang];
        filled[lang]++;
      }
    }
  }
  console.log(`  Pass A filled: name:en=${filled.en}, name:sw=${filled.sw}, name:fr=${filled.fr}`);
}

// ---- Pass B ----------------------------------------------------------------
// Admin entities in Kenya: counties (Q1462963 = county of Kenya), constituencies
// (Q11183799 = constituency of Kenya), wards. We use a broad set of relevant classes.
const ADMIN_TYPES = [
  'Q1462963',  // county of Kenya
  'Q11183799', // constituency of Kenya
  'Q56061',    // administrative territorial entity (catch-all parent)
  'Q15634554', // ward of Kenya (if such Q exists)
  'Q15903247', // sub-county of Kenya
];

const SPARQL_QUERY = `
SELECT ?item ?coord (LANG(?label) AS ?lang) ?label WHERE {
  VALUES ?type { ${ADMIN_TYPES.map((q) => `wd:${q}`).join(' ')} }
  ?item wdt:P17 wd:Q114 ;
        wdt:P31 ?type ;
        rdfs:label ?label .
  OPTIONAL { ?item wdt:P625 ?coord . }
  FILTER(LANG(?label) IN ("en", "sw", "fr"))
}
`;

async function fetchSparql() {
  const endpoints = [
    'https://query.wikidata.org/sparql',
    'https://query-main.wikidata.org/sparql',
  ];
  let lastErr;
  for (const ep of endpoints) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 90000);
        const res = await fetch(ep + '?format=json&query=' + encodeURIComponent(SPARQL_QUERY), {
          headers: { 'User-Agent': UA, 'Accept': 'application/sparql-results+json' },
          signal: ctrl.signal,
        });
        clearTimeout(to);
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`${res.status}: ${body.slice(0, 200)}`);
        }
        const json = await res.json();
        const byQ = new Map();
        for (const b of json.results.bindings) {
          const qid = b.item.value.split('/').pop();
          if (!byQ.has(qid)) {
            let lon = null, lat = null;
            if (b.coord) {
              const m = /^Point\(([-\d.]+) ([-\d.]+)\)$/.exec(b.coord.value);
              if (m) { lon = Number(m[1]); lat = Number(m[2]); }
            }
            byQ.set(qid, { qid, lon, lat, labels: {} });
          }
          byQ.get(qid).labels[b.lang.value] = b.label.value;
        }
        return [...byQ.values()];
      } catch (e) {
        console.warn(`     SPARQL attempt failed (${ep}, try ${attempt + 1}): ${e.message}`);
        lastErr = e;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

function buildSpatialIndex(items) {
  const byCoord = new Map();
  const byName = new Map(); // normalized-name -> [items]
  for (const it of items) {
    if (it.lat != null && it.lon != null) {
      const key = `${Math.floor(it.lat / BUCKET_DEG)}:${Math.floor(it.lon / BUCKET_DEG)}`;
      if (!byCoord.has(key)) byCoord.set(key, []);
      byCoord.get(key).push(it);
    }
    for (const lang of LANGS) {
      const lbl = it.labels[lang];
      if (!lbl) continue;
      const n = normName(lbl);
      if (!n) continue;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(it);
    }
  }
  return { byCoord, byName };
}

function nearbyByCoord(lat, lon, idx) {
  const out = [];
  const ly = Math.floor(lat / BUCKET_DEG);
  const lx = Math.floor(lon / BUCKET_DEG);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = idx.byCoord.get(`${ly + dy}:${lx + dx}`);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

async function passB(features, cache) {
  if (!cache.sparql) {
    console.log('  Pass B: querying SPARQL for Kenyan admin entities...');
    cache.sparql = await fetchSparql();
    saveCache(cache);
  }
  const items = cache.sparql;
  console.log(`  Pass B: ${items.length} Wikidata admin entities`);
  const idx = buildSpatialIndex(items);

  let filled = { en: 0, sw: 0, fr: 0 };
  let matched = 0;
  for (const f of features) {
    if (f.properties.kind !== 'label') continue;
    const stillNeeds = LANGS.some((l) => !f.properties[`name:${l}`]);
    if (!stillNeeds) continue;
    const name = f.properties.name;
    if (!name) continue;
    const target = normName(name);
    if (!target) continue;
    const [lon, lat] = f.geometry.coordinates;

    // Two strategies, take the best:
    //   (i)  nearby items whose any-language label normalizes to our name
    //   (ii) any item whose any-language label normalizes to our name (proximity-free fallback)
    let best = null;
    for (const cand of nearbyByCoord(lat, lon, idx)) {
      const candNames = LANGS.map((l) => cand.labels[l]).filter(Boolean).map(normName);
      if (!candNames.includes(target)) continue;
      const d = (cand.lat != null) ? haversineKm([lon, lat], [cand.lon, cand.lat]) : 0;
      if (d > PROXIMITY_KM) continue;
      if (!best || d < best.d) best = { cand, d };
    }
    if (!best) {
      // Name-only fallback — only safe when the name is unique among Kenya admin entities.
      const byName = idx.byName.get(target);
      if (byName && byName.length === 1) {
        best = { cand: byName[0], d: null };
      }
    }
    if (!best) continue;
    matched++;
    for (const lang of LANGS) {
      const key = `name:${lang}`;
      if (!f.properties[key] && best.cand.labels[lang]) {
        f.properties[key] = best.cand.labels[lang];
        filled[lang]++;
      }
    }
  }
  console.log(`  Pass B matched ${matched} features; filled: name:en=${filled.en}, name:sw=${filled.sw}, name:fr=${filled.fr}`);
}

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

async function main() {
  const cache = loadCache();
  const fc = JSON.parse(fs.readFileSync(path.join(DATA, 'kenya_admin.geojson'), 'utf8'));
  console.log('Before:');
  summarize(fc.features, 'admin');

  await passA(fc.features, cache);
  await passB(fc.features, cache);

  console.log('\nAfter:');
  summarize(fc.features, 'admin');

  fs.writeFileSync(path.join(DATA, 'kenya_admin.geojson'), JSON.stringify(fc));
  console.log('\nWrote data/kenya_admin.geojson.');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
