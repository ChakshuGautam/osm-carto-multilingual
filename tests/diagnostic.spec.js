import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'screenshots/diag';
fs.mkdirSync(OUT, { recursive: true });

// Diagnostic-only run: capture frames at progressive timestamps and at several zoom
// levels so we can spot any "white flash" or unfilled tile region the user reported.
test('progressive frames + zoom levels', async ({ page }) => {
  test.setTimeout(120_000);

  page.errors = [];
  page.failedRequests = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('response', (res) => {
    if (res.status() >= 400) page.failedRequests.push(`${res.status()} ${res.url()}`);
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Frame 0: just after DOMContentLoaded (before tiles definitely arrive).
  await page.screenshot({ path: path.join(OUT, 'frame-0-dom.png') });

  // Frames at 200ms, 500ms, 1s, 2s.
  for (const ms of [200, 500, 1000, 2000, 4000]) {
    await page.waitForTimeout(ms);
    await page.screenshot({ path: path.join(OUT, `frame-${ms}ms.png`) });
  }

  // Wait for map idle and snapshot.
  await page.waitForFunction(() => document.body.dataset.mapIdle === '1', null, { timeout: 30_000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, 'frame-idle.png') });

  // Now sweep through zoom levels.
  for (const zoom of [3, 4, 5, 6, 7, 8, 9, 10]) {
    await page.evaluate((z) => window.__map.setZoom(z), zoom);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `zoom-${zoom}.png`) });
  }

  // Print captured failures.
  console.log('\n--- pageerrors ---');
  for (const e of page.errors) console.log(' ', e);
  console.log(`\n--- failed requests (${page.failedRequests.length}) ---`);
  // Bucket tile failures by zoom for visibility.
  const tileFails = page.failedRequests.filter((r) => r.includes('/tiles/'));
  const otherFails = page.failedRequests.filter((r) => !r.includes('/tiles/'));
  const byZoom = {};
  for (const r of tileFails) {
    const m = /\/tiles\/(\d+)\//.exec(r);
    if (m) byZoom[m[1]] = (byZoom[m[1]] || 0) + 1;
  }
  console.log('  tile 404s by zoom:', byZoom);
  if (otherFails.length) {
    console.log('  non-tile failures:');
    for (const r of otherFails) console.log('   ', r);
  }
});
