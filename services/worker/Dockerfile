# Crawler image for the Cloudflare Container (build context: repo root).
FROM node:22-bookworm-slim

COPY --from=oven/bun:1.3.9 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json bun.lock turbo.json tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/hosting-worker/package.json apps/hosting-worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/scraper/package.json packages/scraper/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/db/package.json packages/db/package.json
COPY services/worker/package.json services/worker/package.json

RUN bun install --frozen-lockfile --ignore-scripts
# Install the browser with Node: Bun's fetch fails Playwright's CDN TLS check (ERR_TLS_CERT_ALTNAME_INVALID).
# Headless launches only need chromium-headless-shell.
RUN node packages/scraper/node_modules/playwright/cli.js install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/*

COPY . .

RUN cd packages/scraper && bun run build

WORKDIR /app/services/worker

CMD ["bun", "run", "src/index.ts"]
