#!/usr/bin/env node
// Fetch Kenya administrative boundaries from Overpass API and emit GeoJSON.
//
// Levels:
//   admin_level=4  → County (47)
//   admin_level=6  → Sub-county / constituency (~291)
//   admin_level=8  → Ward (~969 in OSM; official count is 1,450 — coverage is partial)
//
// For each admin relation we emit two kinds of features:
//   1. LineString boundary segments (one per outer way member).
//   2. A Point label feature, preferring a role="label" node, else role="admin_centre" node,
//      else the centroid of the relation's boundary nodes.
//
// Output: data/kenya_admin.geojson  (FeatureCollection with both lines and points).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const UA = 'kenya-map-bootstrap/0.1 (local dev; contact: kanav11dwevedi@gmail.com)';

const LEVELS = [4, 6, 8];

async function overpassQuery(query) {
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`  → POST ${endpoint}`);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (e) {
      console.warn(`     failed: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr;
}

const query = `
[out:json][timeout:300];
area["ISO3166-1"="KE"][admin_level=2]->.ke;
(
  ${LEVELS.map((l) => `relation["boundary"="administrative"]["admin_level"="${l}"](area.ke);`).join('\n  ')}
);
out body;
>;
out skel qt;
`;

function buildFeatures(json) {
  const nodes = new Map();
  const ways = new Map();
  const rels = [];
  for (const el of json.elements) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'way') ways.set(el.id, el);
    else if (el.type === 'relation') rels.push(el);
  }

  const features = [];
  for (const rel of rels) {
    const tags = rel.tags || {};
    const adminLevel = Number(tags.admin_level);
    if (!LEVELS.includes(adminLevel)) continue;

    const baseProps = {
      osm_id: `r${rel.id}`,
      admin_level: adminLevel,
      name: tags.name,
      'name:en': tags['name:en'],
      'name:sw': tags['name:sw'],
      'name:fr': tags['name:fr'],
      border_type: tags.border_type,
      wikidata: tags.wikidata,
    };

    // 1) Boundary line segments. Don't polygonize — line rendering is fine and avoids
    //    the way-stitching complexity.
    const allBoundaryCoords = [];
    for (const m of rel.members || []) {
      if (m.type !== 'way' || (m.role && m.role !== 'outer' && m.role !== '')) continue;
      const w = ways.get(m.ref);
      if (!w || !w.nodes || w.nodes.length < 2) continue;
      const coords = [];
      for (const nid of w.nodes) {
        const n = nodes.get(nid);
        if (n) {
          coords.push([n.lon, n.lat]);
          allBoundaryCoords.push([n.lon, n.lat]);
        }
      }
      if (coords.length < 2) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { ...baseProps, kind: 'boundary' },
      });
    }

    // 2) Label point: prefer role="label", then role="admin_centre", then boundary-node
    //    average. The average is rough but adequate for label placement.
    let labelLon = null, labelLat = null;
    for (const m of rel.members || []) {
      if (m.type === 'node' && m.role === 'label') {
        const n = nodes.get(m.ref);
        if (n) { labelLon = n.lon; labelLat = n.lat; break; }
      }
    }
    if (labelLon === null) {
      for (const m of rel.members || []) {
        if (m.type === 'node' && m.role === 'admin_centre') {
          const n = nodes.get(m.ref);
          if (n) { labelLon = n.lon; labelLat = n.lat; break; }
        }
      }
    }
    if (labelLon === null && allBoundaryCoords.length) {
      let sx = 0, sy = 0;
      for (const [x, y] of allBoundaryCoords) { sx += x; sy += y; }
      labelLon = sx / allBoundaryCoords.length;
      labelLat = sy / allBoundaryCoords.length;
    }
    if (labelLon !== null) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [labelLon, labelLat] },
        properties: { ...baseProps, kind: 'label' },
      });
    }
  }
  return features;
}

function summarize(features) {
  const counts = {};
  const labelCounts = {};
  for (const f of features) {
    const lvl = f.properties.admin_level;
    counts[lvl] = counts[lvl] || { boundary: 0, label: 0 };
    counts[lvl][f.properties.kind]++;
    if (f.properties.kind === 'label') {
      labelCounts[lvl] = labelCounts[lvl] || { en: 0, sw: 0, fr: 0 };
      for (const l of ['en', 'sw', 'fr']) if (f.properties[`name:${l}`]) labelCounts[lvl][l]++;
    }
  }
  const levelName = { 4: 'County', 6: 'Sub-county', 8: 'Ward' };
  console.log('\nAdmin features fetched:');
  for (const lvl of [4, 6, 8]) {
    const c = counts[lvl] || { boundary: 0, label: 0 };
    const lc = labelCounts[lvl] || { en: 0, sw: 0, fr: 0 };
    console.log(`  L${lvl} ${levelName[lvl].padEnd(10)} ${c.label} polygons (${c.boundary} segments)   name:en=${lc.en}  name:sw=${lc.sw}  name:fr=${lc.fr}`);
  }
}

async function main() {
  console.log(`Fetching Kenya admin levels ${LEVELS.join(', ')} from Overpass...`);
  const json = await overpassQuery(query);
  const features = buildFeatures(json);
  const fc = { type: 'FeatureCollection', features };
  fs.writeFileSync(path.join(DATA_DIR, 'kenya_admin.geojson'), JSON.stringify(fc));
  const size = (fs.statSync(path.join(DATA_DIR, 'kenya_admin.geojson')).size / 1024).toFixed(1);
  console.log(`Wrote data/kenya_admin.geojson (${size} KB, ${features.length} features)`);
  summarize(features);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
