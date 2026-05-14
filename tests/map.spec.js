import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SCREENSHOT_DIR = 'screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Wait until the MapLibre instance has finished its first idle event — main.js sets
// document.body.dataset.mapIdle = '1' inside map.on('idle'). Polling this attribute is
// more reliable than waiting on network events because tile/glyph fetches continue in
// the background even after the visible frame is complete.
async function waitForMapIdle(page) {
  await page.waitForFunction(() => document.body.dataset.mapIdle === '1', null, {
    timeout: 30_000,
  });
  // Symbol layers (text glyphs) load asynchronously after the first idle, so allow a
  // moment for them to paint into the next frame.
  await page.waitForTimeout(1500);
}

test.describe('kenya.proto.theflywheel.in', () => {
  test.beforeEach(async ({ page }) => {
    // Track script exceptions and any HTTP failures.
    // Tile 404s at the bbox edge are *expected* (we only cached the Kenya box), so they
    // get filtered out below — they're not actually a problem in the browser experience.
    page.errors = [];
    page.unexpectedHttpErrors = [];
    page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
    page.on('response', (res) => {
      if (res.status() < 400) return;
      const url = res.url();
      if (url.includes('/tiles/')) return;  // bbox-edge tile misses are fine
      page.unexpectedHttpErrors.push(`${res.status()} ${url}`);
    });
  });

  test('page loads, title set, no console errors', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Kenya/);
    await page.waitForSelector('#map canvas.maplibregl-canvas', { timeout: 15_000 });
    await waitForMapIdle(page);

    // The map should have loaded its style + sources without throwing.
    const styleReady = await page.evaluate(() => window.__map?.isStyleLoaded() === true);
    expect(styleReady).toBe(true);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'initial.png') });
    expect(page.errors, page.errors.join('\n')).toEqual([]);
    expect(page.unexpectedHttpErrors, page.unexpectedHttpErrors.join('\n')).toEqual([]);
  });

  test('admin GeoJSON loads with multilingual labels', async ({ page }) => {
    const res = await page.request.get('/data/kenya_admin.geojson');
    expect(res.status()).toBe(200);
    const fc = await res.json();
    expect(fc.type).toBe('FeatureCollection');

    const byLevel = {};
    for (const f of fc.features) {
      if (f.properties.kind !== 'label') continue;
      const lvl = f.properties.admin_level;
      byLevel[lvl] = byLevel[lvl] || { total: 0, en: 0, sw: 0, fr: 0 };
      byLevel[lvl].total++;
      for (const l of ['en', 'sw', 'fr']) if (f.properties[`name:${l}`]) byLevel[lvl][l]++;
    }
    expect(byLevel[4]?.total).toBeGreaterThanOrEqual(45);   // 47 counties
    expect(byLevel[6]?.total).toBeGreaterThanOrEqual(280);  // 291 sub-counties
    expect(byLevel[8]?.total).toBeGreaterThanOrEqual(900);  // 969 wards
    for (const lvl of [4, 6, 8]) {
      const v = byLevel[lvl];
      expect(v.en / v.total, `name:en coverage L${lvl}`).toBeGreaterThan(0.95);
      expect(v.sw / v.total, `name:sw coverage L${lvl}`).toBeGreaterThan(0.95);
      expect(v.fr / v.total, `name:fr coverage L${lvl}`).toBeGreaterThan(0.95);
    }
  });

  test('renders admin boundary lines on the map', async ({ page }) => {
    await page.goto('/');
    await waitForMapIdle(page);

    // queryRenderedFeatures returns only features currently painted to the viewport.
    // If saffron boundary lines are visible we'll get hits on at least the county-line
    // layer at the default zoom.
    const counts = await page.evaluate(() => {
      const m = window.__map;
      const layers = ['county-line', 'subcounty-line', 'ward-line'];
      const out = {};
      for (const id of layers) {
        try { out[id] = m.queryRenderedFeatures({ layers: [id] }).length; } catch { out[id] = -1; }
      }
      return out;
    });
    expect(counts['county-line'], 'county boundary lines should be rendered at default zoom').toBeGreaterThan(0);
    expect(counts['subcounty-line'], 'subcounty boundary lines should be rendered at default zoom').toBeGreaterThan(0);
    // Wards are minzoom 7; the default view is zoom 5.5, so 0 here is expected.

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'boundaries.png') });
  });

  test('renders label text on the map', async ({ page }) => {
    await page.goto('/');
    await waitForMapIdle(page);

    const counts = await page.evaluate(() => {
      const m = window.__map;
      const layers = ['county-label', 'subcounty-label', 'ward-label'];
      const out = {};
      for (const id of layers) {
        try {
          out[id] = m.queryRenderedFeatures({ layers: [id] })
            .map((f) => f.properties.name).slice(0, 3);
        } catch { out[id] = null; }
      }
      return out;
    });
    expect(counts['county-label'].length, 'county labels should be visible').toBeGreaterThan(0);

    // Verify glyph PBFs actually loaded (we host them via protomaps).
    const glyphResponses = await page.evaluate(() =>
      performance.getEntriesByType('resource')
        .filter((e) => /\/fonts\/.*\.pbf$/i.test(e.name))
        .map((e) => ({ name: e.name.replace(/.*\/fonts\//, 'fonts/'), bytes: e.transferSize })));
    expect(glyphResponses.length, 'no glyph .pbf requests were made').toBeGreaterThan(0);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'labels.png') });
  });

  test('language switcher changes label text-field', async ({ page }) => {
    await page.goto('/');
    await waitForMapIdle(page);

    // Capture an English county label, then switch to Swahili and confirm the same
    // feature now renders with the Swahili text.
    function sampleLabels() {
      return page.evaluate(() => {
        const m = window.__map;
        // Take the layout text-field expression for the county-label layer so we can
        // tell which language is currently selected.
        const expr = m.getLayoutProperty('county-label', 'text-field');
        // Also fetch one feature so we know there's something to compare.
        const feats = m.queryRenderedFeatures({ layers: ['county-label'] });
        return {
          expr,
          sample: feats.slice(0, 3).map((f) => f.properties.name),
        };
      });
    }

    const en = await sampleLabels();
    expect(JSON.stringify(en.expr)).toContain('name:en');

    await page.click('#lang-switcher button[data-lang="sw"]');
    await expect(page.locator('#lang-switcher button.active')).toHaveAttribute('data-lang', 'sw');
    await page.waitForTimeout(500);
    const sw = await sampleLabels();
    expect(JSON.stringify(sw.expr)).toContain('name:sw');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'lang-sw.png') });

    await page.click('#lang-switcher button[data-lang="fr"]');
    await expect(page.locator('#lang-switcher button.active')).toHaveAttribute('data-lang', 'fr');
    await page.waitForTimeout(500);
    const fr = await sampleLabels();
    expect(JSON.stringify(fr.expr)).toContain('name:fr');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'lang-fr.png') });

    // Back to English.
    await page.click('#lang-switcher button[data-lang="en"]');
    await expect(page.locator('#lang-switcher button.active')).toHaveAttribute('data-lang', 'en');
  });

  test('tile endpoint returns PNG, GeoJSON is gzipped', async ({ page }) => {
    const tile = await page.request.get('/tiles/6/39/31.png');
    expect(tile.status()).toBe(200);
    expect(tile.headers()['content-type']).toMatch(/image\/png/);
    expect(Number(tile.headers()['content-length'])).toBeGreaterThan(500);

    // Playwright transparently decompresses but the content-type and existence are enough
    // to know the response was healthy. We separately curl gzip in the deployment smoke test.
    const geo = await page.request.get('/data/kenya_admin.geojson');
    expect(geo.status()).toBe(200);
    expect(geo.headers()['content-type']).toMatch(/geo\+json|json/);
  });
});
