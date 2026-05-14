import { defineConfig } from 'vite';
import path from 'node:path';

// Serve tiles/ and data/ as static directories alongside the frontend.
// The /tiles/{z}/{x}/{y}.png URL pattern maps to tiles/cache/{z}/{x}/{y}.png
// via Vite's middleware (configured below).
export default defineConfig({
  root: 'frontend',
  publicDir: false,
  server: {
    port: 5173,
    host: '127.0.0.1',
    fs: {
      // Allow Vite to serve files from the project root (tiles/ and data/ live above frontend/).
      allow: [path.resolve(__dirname)],
    },
  },
  plugins: [
    {
      name: 'static-tiles-and-data',
      configureServer(server) {
        const root = path.resolve(__dirname);
        server.middlewares.use((req, res, next) => {
          if (!req.url) return next();
          // Strip query string for path matching.
          const url = req.url.split('?')[0];
          let relPath = null;
          if (url.startsWith('/tiles/')) {
            relPath = path.join('tiles/cache', url.slice('/tiles/'.length));
          } else if (url.startsWith('/data/')) {
            relPath = path.join('data', url.slice('/data/'.length));
          }
          if (!relPath) return next();
          const absPath = path.join(root, relPath);
          // Prevent directory traversal.
          if (!absPath.startsWith(root)) {
            res.statusCode = 403;
            return res.end('Forbidden');
          }
          import('node:fs').then(({ default: fs }) => {
            fs.readFile(absPath, (err, buf) => {
              if (err) {
                res.statusCode = 404;
                return res.end('Not found');
              }
              const ext = path.extname(absPath).toLowerCase();
              const mime = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.json': 'application/json',
                '.geojson': 'application/geo+json',
              }[ext] || 'application/octet-stream';
              res.setHeader('Content-Type', mime);
              res.setHeader('Cache-Control', 'public, max-age=3600');
              res.end(buf);
            });
          });
        });
      },
    },
  ],
});
