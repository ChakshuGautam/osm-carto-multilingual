# --- Stage 1: fetch data + tiles, build the frontend -------------------------
# Single npm run that:
#   1. Queries Overpass for Kenya admin boundaries (counties / sub-counties / wards).
#   2. Enriches multilingual labels from Wikidata.
#   3. Applies mechanical Swahili/French translations for the long tail.
#   4. Downloads CARTO dark_nolabels raster tiles for the Kenya bbox (z4-z10).
#   5. Builds the Vite frontend.
#
# All network fetches are inside the build, so the resulting image is self-contained.
FROM node:22-alpine AS build
WORKDIR /app

# Install deps first for layer caching.
COPY package*.json ./
RUN npm ci --no-audit --no-fund

# Now bring in the source.
COPY . .

# Fetch everything and build. Skip if the cached files are already present (in case the
# host bind-mounted data/ and tiles/cache/ from a previous run).
RUN npm run bootstrap && npm run build

# --- Stage 2: serve via nginx ------------------------------------------------
FROM nginx:1.27-alpine

# Drop nginx's default conf and install ours.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Built site + fetched data.
COPY --from=build /app/frontend/dist        /usr/share/nginx/html/
COPY --from=build /app/tiles/cache          /usr/share/nginx/html/tiles/
COPY --from=build /app/data/kenya_admin.geojson  /usr/share/nginx/html/data/kenya_admin.geojson

EXPOSE 80
