FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY openapi.yaml ./
RUN npm run build

FROM node:24-alpine

LABEL org.opencontainers.image.title="MINT Model Catalog API" \
      org.opencontainers.image.source="https://github.com/mintproject/mint" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY --from=builder /app/dist ./dist
COPY openapi.yaml ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
