# MINT React UI container image.
#
# Build stage produces the static bundle; the runtime stage serves it with nginx
# and regenerates env-config.js at container startup from environment variables,
# using the same generator Vercel runs at build time.

FROM --platform=$BUILDPLATFORM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vercel-only generator step inside `npm run build` is a no-op here (VERCEL
# unset); the committed public/env-config.js is copied into dist/ by Vite and
# then overwritten at startup by the entrypoint.
RUN npm run build

FROM nginx:1.27-alpine AS runtime

LABEL org.opencontainers.image.title="MINT UI (React)" \
      org.opencontainers.image.source="https://github.com/mintproject/monorepo" \
      org.opencontainers.image.licenses="MIT"

# Node runtime for the entrypoint, so the container and Vercel run the same
# configuration-building code rather than two implementations that can drift.
RUN apk add --no-cache nodejs

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY scripts/generate-env-config.mjs /opt/mint/generate-env-config.mjs
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
