#!/usr/bin/env node
// Download CARTO voyager_nolabels raster tiles for the Kenya bounding box and cache
// them on disk at tiles/cache/{z}/{x}/{y}.png. Resumable: existing files are skipped.
//
// CARTO basemaps are free for use under attribution (see https://carto.com/attributions).
// This script identifies itself with a User-Agent and limits concurrency to be polite.
//
// Run: node scripts/fetch_tiles.mjs [--minzoom 4] [--maxzoom 10]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILE_DIR = path.resolve(__dirname, '..', 'tiles', 'cache');
fs.mkdirSync(TILE_DIR, { recursive: true });

// Kenya bbox (a hair larger than the country to give edge tiles).
const BBOX = { west: 33.5, south: -5.0, east: 42.2, north: 5.5 };

const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
const MIN_Z = Number(argVal('--minzoom', 4));
const MAX_Z = Number(argVal('--maxzoom', 10));
const CONCURRENCY = Number(argVal('--concurrency', 6));

// CARTO basemap subdomains. voyager_nolabels: minimalist basemap without text labels —
// we render our own multilingual labels as a vector overlay on top.
const STYLE = 'dark_nolabels';
const SUBDOMAINS = ['a', 'b', 'c', 'd'];
function tileUrl(z, x, y) {
  const s = SUBDOMAINS[(x + y) % SUBDOMAINS.length];
  return `https://${s}.basemaps.cartocdn.com/rastertiles/${STYLE}/${z}/${x}/${y}.png`;
}

function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z)
  );
}

function tilesForZoom(z) {
  const xMin = Math.max(0, lonToTileX(BBOX.west, z));
  const xMax = Math.min(Math.pow(2, z) - 1, lonToTileX(BBOX.east, z));
  // Note: latToTileY decreases as lat increases (y=0 is north).
  const yMin = Math.max(0, latToTileY(BBOX.north, z));
  const yMax = Math.min(Math.pow(2, z) - 1, latToTileY(BBOX.south, z));
  const out = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      out.push({ z, x, y });
    }
  }
  return out;
}

async function fetchTile({ z, x, y }) {
  const dir = path.join(TILE_DIR, String(z), String(x));
  const file = path.join(dir, `${y}.png`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    return { z, x, y, skipped: true };
  }
  fs.mkdirSync(dir, { recursive: true });
  const url = tileUrl(z, x, y);
  // Retry with backoff for transient errors.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'kenya-map-bootstrap/0.1 (local dev cache)',
          'Accept': 'image/png,image/*;q=0.8',
        },
      });
      if (res.status === 404) {
        // Some tiles legitimately don't exist (ocean-only or outside coverage). Skip silently.
        fs.writeFileSync(file + '.404', '');
        return { z, x, y, missing: true };
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      return { z, x, y, bytes: buf.length };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw new Error(`tile ${z}/${x}/${y}: ${lastErr.message}`);
}

async function runPool(jobs, concurrency, onResult) {
  let i = 0;
  let done = 0;
  const total = jobs.length;
  async function worker() {
    while (i < total) {
      const idx = i++;
      try {
        const r = await fetchTile(jobs[idx]);
        done++;
        onResult(r, done, total);
      } catch (e) {
        done++;
        onResult({ error: e.message, ...jobs[idx] }, done, total);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function main() {
  console.log(`CARTO ${STYLE} tile fetch for Kenya bbox, zooms ${MIN_Z}-${MAX_Z}`);
  let allJobs = [];
  for (let z = MIN_Z; z <= MAX_Z; z++) {
    const t = tilesForZoom(z);
    console.log(`  z${z}: ${t.length} tiles`);
    allJobs = allJobs.concat(t);
  }
  console.log(`Total: ${allJobs.length} tiles, concurrency ${CONCURRENCY}\n`);

  let downloaded = 0, skipped = 0, missing = 0, errors = 0, bytes = 0;
  const t0 = Date.now();
  await runPool(allJobs, CONCURRENCY, (r, done, total) => {
    if (r.error) errors++;
    else if (r.skipped) skipped++;
    else if (r.missing) missing++;
    else { downloaded++; bytes += r.bytes; }
    if (done % 25 === 0 || done === total) {
      const pct = ((done / total) * 100).toFixed(1);
      const mb = (bytes / 1024 / 1024).toFixed(2);
      process.stdout.write(`\r  ${done}/${total} (${pct}%)  dl=${downloaded} skip=${skipped} 404=${missing} err=${errors}  ${mb} MB   `);
    }
  });
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s. Cache: ${TILE_DIR}`);
  if (errors) console.log(`WARNING: ${errors} tiles failed; rerun the script to retry.`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
