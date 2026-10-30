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

# Static user guide; Python and documentation dependencies stay in this stage.
FROM python:3.12-slim AS docs
WORKDIR /docs
COPY docs/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY docs/mkdocs.yml ./mkdocs.yml
COPY docs/docs/ ./docs/
RUN mkdocs build --strict

FROM nginx:1.27-alpine AS runtime

LABEL org.opencontainers.image.title="MINT UI (React)" \
      org.opencontainers.image.source="https://github.com/mintproject/mint" \
      org.opencontainers.image.licenses="MIT"

# Node runtime for the entrypoint, so the container and Vercel run the same
# configuration-building code rather than two implementations that can drift.
RUN apk add --no-cache nodejs

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY scripts/generate-env-config.mjs /opt/mint/generate-env-config.mjs
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=docs /docs/site /usr/share/nginx/html/docs

EXPOSE 80

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
