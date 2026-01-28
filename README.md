# DXD Webflow Site Scraper

A generalized Webflow site archiver with a UI dashboard. Crawls any Webflow site and produces a static, self-contained snapshot.

## Features

- **Multi-site support**: Manage multiple Webflow sites
- **Real-time progress**: Watch crawls happen in real-time with SSE
- **Scheduled crawls**: Set up cron-based schedules for automatic archiving
- **Asset localization**: Downloads and rewrites all JS, CSS, images, fonts
- **Webflow-specific**: Removes badges, normalizes lazy-loaded media
- **Download & Preview**: Download archives as zip or preview in-browser

## Architecture

```
dxd-webflow-scraper/
├── apps/
│   ├── web/          # Vite + TanStack Router dashboard
│   └── api/          # Hono API server
├── packages/
│   └── scraper/      # Core scraping logic
├── services/
│   └── worker/       # Background job processor
```

## Tech Stack

- **Frontend**: Vite, React, TanStack Router, TanStack Query, Tailwind CSS
- **Backend**: Hono, Drizzle ORM, PostgreSQL
- **Worker**: BullMQ, Redis, Playwright
- **Scraper**: Playwright, Cheerio

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) >= 1.3.6
- Docker (for PostgreSQL and Redis)
- Playwright browsers

### Setup

1. Clone and install dependencies:

```bash
bun install
```

2. Start PostgreSQL and Redis:

```bash
docker-compose up -d
```

3. Set up environment variables:

```bash
cp .env.example .env
# Edit .env with your settings
```

4. Push database schema:

```bash
cd apps/api && bun run db:push
```

5. Install Playwright browsers:

```bash
bunx playwright install chromium
```

### Development

Run all services in parallel:

```bash
# Terminal 1: API server
cd apps/api && bun run dev

# Terminal 2: Web dashboard
cd apps/web && bun run dev

# Terminal 3: Background worker
cd services/worker && bun run dev
```

Or use Turbo:

```bash
bun run dev
```

Open http://localhost:5173 for the dashboard.

## Usage

1. **Add a site**: Go to Sites → Add Site, enter a Webflow URL
2. **Start a crawl**: Click "Start Crawl" on any site
3. **Monitor progress**: Watch real-time logs on the crawl detail page
4. **Download**: Once complete, download the archive or preview in-browser

## Configuration

### Site Settings

- **Concurrency**: Number of pages to crawl in parallel (1-20)
- **Max Pages**: Limit total pages (useful for testing)
- **Exclude Patterns**: Regex patterns to skip certain URLs
- **Remove Webflow Badge**: Strip the Webflow attribution badge

### Storage Options

- **Local**: Store archives on the server filesystem
- **S3/R2**: Store in S3-compatible storage (Cloudflare R2, AWS S3, etc.)

## API

| Endpoint                       | Description              |
| ------------------------------ | ------------------------ |
| `GET /api/sites`               | List all sites           |
| `POST /api/sites`              | Create a site            |
| `POST /api/sites/:id/crawl`    | Start a crawl            |
| `GET /api/crawls`              | List crawls              |
| `GET /api/crawls/:id`          | Get crawl details        |
| `GET /api/sse/crawls/:id`      | SSE stream for live logs |
| `GET /api/crawls/:id/download` | Download archive as zip  |
| `GET /preview/:crawlId/*`      | Preview archived files   |

## Deployment

### Railway

1. Create a new project with PostgreSQL and Redis
2. Deploy the API and worker as separate services
3. Set environment variables

### Docker

Build and run with Docker:

```bash
docker build -t dxd-scraper .
docker run -e DATABASE_URL=... -e REDIS_URL=... dxd-scraper
```

## License

MIT
