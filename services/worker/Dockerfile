FROM oven/bun:1.3.9

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN mkdir -p /ms-playwright

COPY package.json bun.lock turbo.json tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/scraper/package.json packages/scraper/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/db/package.json packages/db/package.json
COPY services/worker/package.json services/worker/package.json

RUN bun install --frozen-lockfile
RUN bunx playwright install --with-deps chromium

COPY . .

RUN cd packages/scraper && bun run build

WORKDIR /app/services/worker

CMD ["bun", "run", "src/index.ts"]
