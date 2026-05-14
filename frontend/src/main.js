import maplibregl from 'maplibre-gl';

// Kenya bbox
const KENYA_CENTER = [37.9, 0.2];
const KENYA_BOUNDS = [[33.5, -5.0], [42.2, 5.5]];

// Saffron palette borrowed from kaun-city/kaun (Bengaluru wards).
const SAFFRON = '#FF9933';
const LABEL_COLOR = 'rgba(255, 255, 255, 0.78)';
const LABEL_HALO = 'rgba(0, 0, 0, 0.85)';

// Label expression: prefer the requested language, fall back to en, then to the raw name.
function labelExpr(lang) {
  return ['coalesce', ['get', `name:${lang}`], ['get', 'name:en'], ['get', 'name']];
}

const isLabel    = (level) => ['all', ['==', ['get', 'admin_level'], level], ['==', ['get', 'kind'], 'label']];
const isBoundary = (level) => ['all', ['==', ['get', 'admin_level'], level], ['==', ['get', 'kind'], 'boundary']];

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    // Protomaps glyph hosting — openmaptiles.org's CDN currently returns HTML.
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sources: {
      'carto-basemap': {
        type: 'raster',
        tiles: ['/tiles/{z}/{x}/{y}.png'],
        tileSize: 256,
        // Cache only contains z4-z10. minzoom prevents requests below that range, and
        // maxzoom enables MapLibre to overzoom (scale up z10 tiles) for z11-z13 instead
        // of issuing 404s.
        minzoom: 4,
        maxzoom: 10,
        attribution: '© CARTO, © OSM contributors',
      },
      admin: {
        type: 'geojson',
        data: '/data/kenya_admin.geojson',
      },
    },
    layers: [
      // Solid dark background fills space when tiles are missing (edge of bbox).
      { id: 'bg', type: 'background', paint: { 'background-color': '#1a1a1a' } },

      { id: 'basemap', type: 'raster', source: 'carto-basemap' },

      // -- Boundaries (saffron, thin, low opacity — matches kaun aesthetic) --
      {
        id: 'ward-line', type: 'line', source: 'admin',
        minzoom: 7,
        filter: isBoundary(8),
        paint: {
          'line-color': SAFFRON,
          'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.3, 12, 0.9],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 8, 0.5, 12, 0.7],
        },
      },
      {
        id: 'subcounty-line', type: 'line', source: 'admin',
        minzoom: 5,
        filter: isBoundary(6),
        paint: {
          'line-color': SAFFRON,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 10, 1.2],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0, 6, 0.55, 10, 0.75],
        },
      },
      {
        id: 'county-line', type: 'line', source: 'admin',
        filter: isBoundary(4),
        paint: {
          'line-color': SAFFRON,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.0, 10, 2.4],
          'line-opacity': 0.9,
        },
      },

      // -- Labels --
      {
        id: 'ward-label', type: 'symbol', source: 'admin',
        minzoom: 9,
        filter: isLabel(8),
        layout: {
          'text-field': labelExpr('en'),
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9, 12, 11],
          'text-allow-overlap': false,
          'text-padding': 4,
          'text-letter-spacing': 0.02,
        },
        paint: {
          'text-color': LABEL_COLOR,
          'text-halo-color': LABEL_HALO,
          'text-halo-width': 1.2,
          'text-halo-blur': 0.5,
        },
      },
      {
        id: 'subcounty-label', type: 'symbol', source: 'admin',
        minzoom: 7,
        maxzoom: 11,
        filter: isLabel(6),
        layout: {
          'text-field': labelExpr('en'),
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 7, 10, 10, 13],
          'text-allow-overlap': false,
          'text-padding': 6,
          'text-letter-spacing': 0.04,
        },
        paint: {
          'text-color': 'rgba(255, 255, 255, 0.85)',
          'text-halo-color': LABEL_HALO,
          'text-halo-width': 1.3,
          'text-halo-blur': 0.5,
        },
      },
      {
        id: 'county-label', type: 'symbol', source: 'admin',
        filter: isLabel(4),
        layout: {
          'text-field': labelExpr('en'),
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 9, 17],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.12,
          'text-allow-overlap': false,
          'text-padding': 8,
        },
        paint: {
          'text-color': SAFFRON,
          'text-halo-color': LABEL_HALO,
          'text-halo-width': 1.6,
          'text-halo-blur': 0.6,
        },
      },
    ],
  },
  center: KENYA_CENTER,
  zoom: 5.5,
  minZoom: 4,
  maxZoom: 13,
  maxBounds: [[30, -8], [46, 8]],
});

map.fitBounds(KENYA_BOUNDS, { padding: 20, duration: 0 });
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

// Language switcher.
const buttons = document.querySelectorAll('#lang-switcher button');
const LABEL_LAYERS = ['county-label', 'subcounty-label', 'ward-label'];
function setLanguage(lang) {
  buttons.forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
  if (!map.isStyleLoaded()) {
    map.once('idle', () => setLanguage(lang));
    return;
  }
  for (const id of LABEL_LAYERS) map.setLayoutProperty(id, 'text-field', labelExpr(lang));
}
buttons.forEach((b) => b.addEventListener('click', () => setLanguage(b.dataset.lang)));

// Expose the map for end-to-end tests and ad-hoc debugging in the console.
window.__map = map;

// Mark when the map is fully idle (used by playwright).
map.on('idle', () => {
  document.body.dataset.mapIdle = '1';
});

// Click any admin label to inspect its multilingual names.
map.on('load', () => {
  for (const id of LABEL_LAYERS) {
    map.on('click', id, (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties || {};
      const level = p.admin_level;
      const levelName = { 4: 'County', 6: 'Sub-county', 8: 'Ward' }[level] || `Level ${level}`;
      const rows = [
        ['level', levelName],
        ['name', p.name],
        ['name:en', p['name:en']],
        ['name:sw', p['name:sw']],
        ['name:fr', p['name:fr']],
      ].filter(([, v]) => v);
      const html = rows.map(([k, v]) => `<div><b>${k}</b>: ${v}</div>`).join('');
      new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
});
