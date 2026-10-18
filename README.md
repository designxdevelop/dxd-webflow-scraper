# DXD Webflow Site Scraper

A generalized Webflow site archiver with a UI dashboard. Crawls any Webflow site and produces a static, self-contained snapshot.

## Features

- **Multi-site support**: Manage multiple Webflow sites
- **Live progress**: Watch crawl progress and logs update live in the dashboard
- **Scheduled crawls**: Set up cron-based schedules for automatic archiving
- **Asset localization**: Downloads and rewrites all JS, CSS, images, fonts
- **Webflow-specific**: Removes badges, normalizes lazy-loaded media
- **Download & Preview**: Download archives as zip or preview in-browser

## Architecture

```
dxd-webflow-scraper/
├── apps/
│   ├── web/             # Vite + TanStack Router dashboard (Cloudflare Worker static assets)
│   ├── api/             # Hono API on Cloudflare Workers; cron + crawler container
│   └── hosting-worker/  # Serves published backups on client hostnames
├── packages/
│   ├── scraper/         # Core scraping logic
│   ├── storage/         # Local/S3/R2 storage adapters
│   └── db/              # Drizzle schema + DB client
├── services/
│   └── worker/          # Crawler process, runs in a Cloudflare Container
```

- Current architecture reference: `ARCHITECTURE_CURRENT.md`
- Historical design notes: `ARCHITECTURE.md`

## Tech Stack

- **Frontend**: Vite, React, TanStack Router, TanStack Query, Tailwind CSS
- **Backend**: Hono on Cloudflare Workers, Drizzle ORM, PostgreSQL (PlanetScale via Hyperdrive)
- **Crawler**: Playwright in a Cloudflare Container; Postgres rows are the job queue (no Redis)
- **Storage**: Cloudflare R2
- **Scraper**: Playwright, Cheerio

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) >= 1.3.6
- Docker (for local PostgreSQL)
- Playwright browsers

### Setup

1. Clone and install dependencies:

```bash
bun install
```

2. Start local PostgreSQL:

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

6. Configure GitHub OAuth (required for dashboard login):

- Create a GitHub OAuth App in your org/account settings.
- Set `Authorization callback URL` to:
  - Local: `http://localhost:3001/api/auth/callback/github`
  - Production: `https://<your-api-domain>/api/auth/callback/github`
- Add these env vars for the API service:
  - `GITHUB_CLIENT_ID`
  - `GITHUB_CLIENT_SECRET`
  - `AUTH_SECRET` (random high-entropy string)
  - `FRONTEND_URL` (for redirects, e.g. `http://localhost:5173` or your web app domain)
- Add this env var for the web app:
  - `VITE_API_URL` (e.g. `http://localhost:3001` locally)

### Development

Run all services in parallel:

```bash
# Terminal 1: API server
cd apps/api && bun run dev

# Terminal 2: Web dashboard
cd apps/web && bun run dev

# Terminal 3: Crawler (drains pending crawls, then exits)
cd services/worker && CRAWLER_OWNS_QUEUE=true bun run start
```

Or use Turbo:

```bash
bun run dev
```

The API runs under `wrangler dev`; point its Hyperdrive binding at local Postgres with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://dxd:dxd@localhost:5432/scraper`.

Open http://localhost:5173 for the dashboard.

## Usage

1. **Add a site**: Go to Sites → Add Site, enter a Webflow URL
2. **Start a crawl**: Click "Start Crawl" on any site
3. **Monitor progress**: Watch real-time logs on the crawl detail page
4. **Download**: Once complete, download the archive or preview in-browser

## Configuration

### Site Settings

- **Concurrency**: Number of pages to crawl in parallel (1-30)
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
| `GET /api/crawls/:id/logs`     | Crawl logs               |
| `GET /api/crawls/:id/download` | Download archive as zip  |
| `GET /preview/:crawlId/*`      | Preview archived files   |

## Deployment

Production runs on Cloudflare (account "Design X Develop") with a PlanetScale Postgres database:

- Web (`zip.designxdevelop.com`) and API (`zip-api.designxdevelop.com`) are Workers (`dxd-archiver-web`, `dxd-archiver-api`) on Worker routes.
- Crawls run in a Cloudflare Container started on demand and by the API's cron tick; it scales to zero.
- Archives and hosted backups are in R2 (`dxd-site-scraper`); `dxd-backup-hosting` serves hosted backups.
- Database: PlanetScale `dxd-apps` cluster, database `archiver`, reached through Hyperdrive.

Deploy with `bun run deploy` in `apps/api` and `apps/web`. See `SETUP-INFRASTRUCTURE.md` for details and `ARCHITECTURE_CURRENT.md` for the current topology. Railway is no longer used.

## License

MIT
